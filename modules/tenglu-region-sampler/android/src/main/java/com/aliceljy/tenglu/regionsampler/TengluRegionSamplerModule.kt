package com.aliceljy.tenglu.regionsampler

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import java.io.File
import java.io.FileOutputStream

class TengluRegionSamplerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TengluRegionSampler")

    AsyncFunction("sampleRegions") { requestsJson: String ->
      sampleRegions(requestsJson)
    }

    AsyncFunction("extractFrames") { sourceUri: String, timesJson: String ->
      extractFrames(sourceUri, timesJson)
    }

    AsyncFunction("cleanupFrames") {
      cleanupFrames()
    }
  }

  private data class RegionRequest(
    val id: String,
    val frameIndex: Int,
    val uri: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
  )

  /**
   * ExpoVideoThumbnails uses OPTION_CLOSEST_SYNC on Android. That can return the
   * same keyframe for adjacent M3 timestamps and hide a missing scroll behind a
   * plausible zero shift. M3 therefore owns this exact-timestamp extractor and
   * keeps the resulting full frame encoded as JPEG for ML Kit.
   */
  private fun extractFrames(sourceUri: String, timesJson: String): String {
    val started = System.nanoTime()
    val input = JSONArray(timesJson)
    require(input.length() >= 2) { "文本锚点路径至少需要 2 个抽帧时刻" }
    val timesMs = (0 until input.length()).map { index -> input.getLong(index) }
    require(timesMs.all { it >= 0 }) { "抽帧时刻不能为负数" }
    require(timesMs.all { it <= Long.MAX_VALUE / 1000L }) { "抽帧时刻超出支持范围" }
    require(timesMs.zipWithNext().all { (left, right) -> left < right }) {
      "抽帧时刻必须严格递增"
    }

    val context = appContext.reactContext
      ?: throw IllegalStateException("Android context 已失效")
    val outputDir = File(context.cacheDir, "tenglu-anchor")
    if (!outputDir.exists() && !outputDir.mkdirs()) {
      throw IllegalStateException("无法创建 M3 抽帧缓存目录")
    }
    val staleFiles = outputDir.listFiles { file ->
      file.isFile && file.name.startsWith("frame-") && file.name.endsWith(".jpg")
    }?.toList() ?: emptyList()
    val staleRemaining = deleteFilesWithRetries(staleFiles)
    if (staleRemaining > 0) {
      throw IllegalStateException(
        "M3 抽帧前发现 ${staleFiles.size} 个旧临时 JPEG，连续清理 3 次后仍残留 " +
          "$staleRemaining 个"
      )
    }

    val retriever = MediaMetadataRetriever()
    val outputFiles = mutableListOf<File>()
    try {
      setVideoSource(retriever, sourceUri)
      val frames = JSONArray()
      for ((index, timeMs) in timesMs.withIndex()) {
        var bitmap: Bitmap? = null
        val output = File.createTempFile("frame-${index}-", ".jpg", outputDir)
        outputFiles.add(output)
        try {
          val frameBitmap = retriever.getFrameAtTime(
            timeMs * 1000L,
            MediaMetadataRetriever.OPTION_CLOSEST,
          ) ?: throw IllegalStateException("时刻 ${timeMs}ms 没有返回视频帧")
          bitmap = frameBitmap
          FileOutputStream(output).use { stream ->
            check(frameBitmap.compress(Bitmap.CompressFormat.JPEG, 100, stream)) {
              "时刻 ${timeMs}ms 的 JPEG 编码失败"
            }
          }
          frames.put(
            JSONObject()
              .put("uri", Uri.fromFile(output).toString())
              .put("width", frameBitmap.width)
              .put("height", frameBitmap.height)
              .put("requestedTimeMs", timeMs)
          )
        } finally {
          bitmap?.recycle()
        }
      }
      return JSONObject()
        .put("frames", frames)
        .put("method", "MediaMetadataRetriever.OPTION_CLOSEST")
        .put("staleFileCount", staleFiles.size)
        .put("staleDeletedCount", staleFiles.size - staleRemaining)
        .put("elapsedMs", (System.nanoTime() - started) / 1_000_000.0)
        .toString()
    } catch (error: Exception) {
      val remaining = deleteFilesWithRetries(outputFiles)
      if (remaining > 0) {
        throw IllegalStateException(
          "${error.message ?: error.javaClass.simpleName}；抽帧失败后连续清理 3 次仍残留 " +
            "$remaining 个临时 JPEG",
          error,
        )
      }
      throw error
    } finally {
      try {
        retriever.release()
      } catch (_: RuntimeException) {
        // Extraction results are already durable JPEGs; a release failure must
        // not discard a complete batch or hide the original exception.
      }
    }
  }

  private fun deleteFilesWithRetries(files: List<File>, attempts: Int = 3): Int {
    var remaining = files.filter { it.exists() }
    repeat(attempts) { attempt ->
      if (remaining.isEmpty()) return 0
      remaining = remaining.filter { file -> file.exists() && !file.delete() }
      if (remaining.isNotEmpty() && attempt + 1 < attempts) Thread.sleep(10L)
    }
    return remaining.count { it.exists() }
  }

  private fun cleanupFrames(): String {
    val context = appContext.reactContext
      ?: throw IllegalStateException("Android context 已失效")
    val outputDir = File(context.cacheDir, "tenglu-anchor")
    val files = outputDir.listFiles { file ->
      file.isFile && file.name.startsWith("frame-") && file.name.endsWith(".jpg")
    }?.toList() ?: emptyList()
    val remaining = deleteFilesWithRetries(files)
    return JSONObject()
      .put("foundCount", files.size)
      .put("deletedCount", files.size - remaining)
      .put("remainingCount", remaining)
      .toString()
  }

  private fun setVideoSource(
    retriever: MediaMetadataRetriever,
    sourceUri: String,
  ) {
    val uri = Uri.parse(sourceUri)
    when (uri.scheme) {
      null -> {
        val path = uri.path ?: throw IllegalArgumentException("视频路径为空")
        if (!File(path).isAbsolute) throw IllegalArgumentException("只支持本机绝对视频路径")
        retriever.setDataSource(path)
      }
      "file" -> {
        val path = uri.path ?: throw IllegalArgumentException("file URI 没有路径")
        retriever.setDataSource(path)
      }
      "content" -> {
        val context = appContext.reactContext
          ?: throw IllegalStateException("Android context 已失效")
        retriever.setDataSource(context, uri)
      }
      else -> throw IllegalArgumentException("只支持本机 file/content 视频 URI")
    }
  }

  @Suppress("DEPRECATION")
  private fun sampleRegions(requestsJson: String): String {
    val started = System.nanoTime()
    val input = JSONArray(requestsJson)
    val ids = mutableSetOf<String>()
    val requests = (0 until input.length()).map { index ->
      val item = input.getJSONObject(index)
      val id = item.getString("id")
      require(id.isNotBlank() && ids.add(id)) { "采样请求 id 为空或重复" }
      RegionRequest(
        id = id,
        frameIndex = item.getInt("frameIndex"),
        uri = item.getString("uri"),
        x = item.getInt("x"),
        y = item.getInt("y"),
        width = item.getInt("width"),
        height = item.getInt("height"),
      )
    }
    val results = mutableMapOf<String, JSONObject>()

    for ((uri, frameRequests) in requests.groupBy { it.uri }) {
      var decoder: BitmapRegionDecoder? = null
      try {
        val path = filePath(uri)
        val frameDecoder = newDecoder(path)
        decoder = frameDecoder
        for (request in frameRequests) {
          results[request.id] = decodeOne(frameDecoder, request)
        }
      } catch (error: Exception) {
        val message = error.message ?: error.javaClass.simpleName
        for (request in frameRequests) {
          results[request.id] = errorResult(request.id, "E_DECODER", message)
        }
      } finally {
        decoder?.recycle()
      }
    }

    val samples = JSONArray()
    for (request in requests) {
      samples.put(
        results[request.id] ?:
          errorResult(request.id, "E_RESULT_MISSING", "采样结果缺失")
      )
    }
    return JSONObject()
      .put("samples", samples)
      .put("decoderCount", requests.map { it.uri }.distinct().size)
      .put("elapsedMs", (System.nanoTime() - started) / 1_000_000.0)
      .toString()
  }

  private fun filePath(uriString: String): String {
    val uri = Uri.parse(uriString)
    if (uri.scheme != null && uri.scheme != "file") {
      throw IllegalArgumentException("只支持本机 file URI")
    }
    val path = uri.path ?: throw IllegalArgumentException("file URI 没有路径")
    if (!File(path).isAbsolute) throw IllegalArgumentException("只支持绝对文件路径")
    return path
  }

  @Suppress("DEPRECATION")
  private fun newDecoder(path: String): BitmapRegionDecoder =
    requireNotNull(
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        BitmapRegionDecoder.newInstance(path)
      } else {
        BitmapRegionDecoder.newInstance(path, false)
      }
    ) {
      "BitmapRegionDecoder 未创建"
    }

  @Suppress("DEPRECATION")
  private fun decodeOne(
    decoder: BitmapRegionDecoder,
    request: RegionRequest,
  ): JSONObject {
    if (request.width <= 0 || request.height <= 0) {
      return errorResult(request.id, "E_RECT", "文本框尺寸无效")
    }
    val left = max(0, request.x)
    val top = max(0, request.y)
    val right = min(
      decoder.width.toLong(),
      request.x.toLong() + request.width.toLong(),
    ).toInt()
    val bottom = min(
      decoder.height.toLong(),
      request.y.toLong() + request.height.toLong(),
    ).toInt()
    if (right <= left || bottom <= top) {
      return errorResult(request.id, "E_RECT", "文本框超出图片范围")
    }
    if (left == 0 && top == 0 && right == decoder.width && bottom == decoder.height) {
      return errorResult(
        request.id,
        "E_FULL_FRAME_FORBIDDEN",
        "拒绝整帧像素解码",
      )
    }

    val options = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inSampleSize = 1
    }
    var bitmap: Bitmap? = null
    try {
      bitmap = decoder.decodeRegion(Rect(left, top, right, bottom), options)
        ?: return errorResult(
          request.id,
          "E_DECODE",
          "BitmapRegionDecoder 未返回像素",
        )
      if (bitmap.config != Bitmap.Config.ARGB_8888) {
        return errorResult(request.id, "E_CONFIG", "区域像素不是 ARGB_8888")
      }

      val pixels = IntArray(bitmap.width * bitmap.height)
      bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
      val median = brightMedian(pixels)
      val side = classify(median.rgb)
      return JSONObject()
        .put("id", request.id)
        .put("frameIndex", request.frameIndex)
        .put("side", side ?: JSONObject.NULL)
        .put("rgb", JSONArray(median.rgb.toList()))
        .put("brightPixels", median.brightPixels)
        .put("decodedPixels", pixels.size)
        .put("sampledPixels", pixels.size)
        .put("width", bitmap.width)
        .put("height", bitmap.height)
        .put("rect", JSONObject()
          .put("x", left)
          .put("y", top)
          .put("width", right - left)
          .put("height", bottom - top))
        .put("frameWidth", decoder.width)
        .put("frameHeight", decoder.height)
    } catch (error: Exception) {
      return errorResult(
        request.id,
        "E_DECODE",
        error.message ?: error.javaClass.simpleName,
      )
    } finally {
      bitmap?.recycle()
    }
  }

  private data class MedianResult(
    val rgb: DoubleArray,
    val brightPixels: Int,
  )

  private fun brightMedian(pixels: IntArray): MedianResult {
    var brightCount = 0
    for (pixel in pixels) {
      val red = pixel shr 16 and 0xff
      val green = pixel shr 8 and 0xff
      val blue = pixel and 0xff
      if (red + green + blue > 450) brightCount++
    }

    val useBright = brightCount >= 20
    val selectedCount = if (useBright) brightCount else pixels.size
    val redValues = IntArray(selectedCount)
    val greenValues = IntArray(selectedCount)
    val blueValues = IntArray(selectedCount)
    var selectedIndex = 0
    for (pixel in pixels) {
      val red = pixel shr 16 and 0xff
      val green = pixel shr 8 and 0xff
      val blue = pixel and 0xff
      if (!useBright || red + green + blue > 450) {
        redValues[selectedIndex] = red
        greenValues[selectedIndex] = green
        blueValues[selectedIndex] = blue
        selectedIndex++
      }
    }
    redValues.sort()
    greenValues.sort()
    blueValues.sort()
    return MedianResult(
      rgb = doubleArrayOf(
        median(redValues),
        median(greenValues),
        median(blueValues),
      ),
      brightPixels = brightCount,
    )
  }

  private fun median(values: IntArray): Double {
    val middle = values.size / 2
    return if (values.size % 2 == 1) {
      values[middle].toDouble()
    } else {
      (values[middle - 1] + values[middle]) / 2.0
    }
  }

  private fun classify(rgb: DoubleArray): String? {
    val (red, green, blue) = rgb
    return when {
      green - blue > 40 -> "me"
      red > 245 && green > 245 && blue > 245 -> "them"
      else -> null
    }
  }

  private fun errorResult(
    id: String,
    errorCode: String,
    message: String,
  ): JSONObject =
    JSONObject()
      .put("id", id)
      .put("side", JSONObject.NULL)
      .put("errorCode", errorCode)
      .put("error", message)
}
