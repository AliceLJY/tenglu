# Android 局部气泡采样设计（M3）

## 目的与边界

文本锚点仍只使用 OCR 文本及其 `x/y/w/h` 计算滚动位移。只有微信满宽气泡同时贴住左右对齐峰、纯坐标无法判断发言人时，才读取原始帧中一个 OCR 文本框的小区域，借气泡底色判断方向。

这份设计现已实现为 App 内可切换的 M3 独立路径；现有拼接处理器仍完整保留且默认选中。
Mac 验证器使用 `djpeg -crop`；Android 对应实现位于
`modules/tenglu-region-sampler`，使用
[`BitmapRegionDecoder`](https://developer.android.com/reference/android/graphics/BitmapRegionDecoder)，
不把整张 JPEG 展开成 RGBA。

同一模块还负责 M3 的视频抽帧：使用 `MediaMetadataRetriever.OPTION_CLOSEST` 取得请求时刻
的实际邻近帧，再编码为 JPEG 交给 ML Kit。不能复用 `expo-video-thumbnails` 的 Android
实现，因为它采用 `OPTION_CLOSEST_SYNC`；真实小红书素材上 8.75s 和 10.5s 会落到同一
关键帧，近似复现会从 202 行降到 175 行，并出现 1 对锚点 0 告警。这里的全帧视频解码是
OCR 必需的抽帧步骤；JavaScript 仍不读取整帧 RGBA，气泡颜色仍只由区域解码取得。

## 输入与判定

每个歧义气泡只取一个观测框：选择组内 `w × h` 最大的 OCR 行。坐标必须来自该行在原始帧中的局部 `x/y/w/h`；`gy` 是长文本排序坐标，不能用于图片寻址。`frameIndex` 也不是文件编号，必须先映射回抽帧记录中的原始文件名。

像素算法与现有已验证实现保持一致：

1. 只解码 OCR 行矩形，不扩边。
2. 使用 `ARGB_8888`，逐像素读取 R、G、B。亮像素条件是 `R + G + B > 450`。
3. 亮像素不少于 20 个时，只使用亮像素；否则使用框内全部像素。三个通道分别取中位数；样本数为偶数时，取中间两个值的算术平均，保留可能出现的 `.5`。
4. `G - B > 40` 判为“我”；否则 R、G、B 都严格大于 245 时判为“对方”；其余结果为“未定”。

“未定”必须作为显式失败返回，不能继续用相邻消息或回复关系猜测。本批 Mac 数据的 13 个歧义气泡全部得到确定结果：7 个“我”、6 个“对方”。

## Android 调用方式

实现采用一个 Kotlin 批量接口，把同一帧的多个矩形一次传入；模块按图片路径分组，每张原始帧创建一个 decoder，并在该帧的所有矩形完成后释放。这样既避免整帧 Bitmap，也避免为同一 JPEG 重复解析文件头和重复跨 JS bridge。

下列代码只展示资源与区域解码关系；中位数函数和结果类型从现有 JS 逻辑逐项移植：

```kotlin
@Suppress("DEPRECATION")
private fun openDecoder(path: String): BitmapRegionDecoder =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    BitmapRegionDecoder.newInstance(path)
  } else {
    BitmapRegionDecoder.newInstance(path, false)
  }

private fun sampleRegion(
  decoder: BitmapRegionDecoder,
  x: Double,
  y: Double,
  w: Double,
  h: Double,
): SampleResult {
  require(x.isFinite() && y.isFinite() && w.isFinite() && h.isFinite()) {
    "non-finite OCR region"
  }
  require(w > 0.0 && h > 0.0) { "non-positive OCR region" }
  val left = floor(x).toInt().coerceIn(0, decoder.width)
  val top = floor(y).toInt().coerceIn(0, decoder.height)
  val right = ceil(x + w).toInt().coerceIn(left, decoder.width)
  val bottom = ceil(y + h).toInt().coerceIn(top, decoder.height)
  require(right > left && bottom > top) { "empty OCR region" }

  val options = BitmapFactory.Options().apply {
    inPreferredConfig = Bitmap.Config.ARGB_8888
  }
  val bitmap = requireNotNull(
    decoder.decodeRegion(Rect(left, top, right, bottom), options)
  ) { "decodeRegion returned null" }

  return try {
    require(bitmap.config == Bitmap.Config.ARGB_8888) {
      "unexpected bitmap config: ${bitmap.config}"
    }
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    classifyBrightMedian(pixels) // 严格执行本节的 20 / 450 / 40 / 245 判据
  } finally {
    bitmap.recycle()
  }
}

private fun sampleFrame(path: String, regions: List<OcrRegion>): List<SampleResult> {
  val decoder = openDecoder(path)
  return try {
    regions.map { region ->
      sampleRegion(decoder, region.x, region.y, region.w, region.h)
    }
  } finally {
    decoder.recycle()
  }
}
```

Android 12（API 31）增加了不带 `isShareable` 的 `newInstance(path)`；旧重载在 API 31 被标记为 deprecated，因此示例按系统版本分支。`decodeRegion(Rect, Options)` 只返回指定矩形的 Bitmap，`BitmapFactory.Options` 控制输出配置。`inPreferredConfig` 只表示 decoder 会尝试采用指定配置，所以返回后还要检查 `bitmap.config`，不符合 `ARGB_8888` 就显式失败。这里不用 `RGB_565`：它虽只占 2 bytes/px，但官方文档明确提示会有颜色失真，而本判据依赖通道差与接近白色的严格阈值；应保留 [`ARGB_8888`](https://developer.android.com/reference/android/graphics/Bitmap.Config#ARGB_8888)。

## 开销预算

M3 微信素材的实测如下，计时包含每次启动一个 `djpeg` 子进程，因此也包含了 Mac 验证器特有的进程开销：

| 项目 | 实测 |
| --- | ---: |
| 歧义气泡 | 13 个 |
| OCR 文本框像素合计 | 232,783 px |
| `djpeg` 输出缓冲（含水平 MCU 对齐余量） | 235,734 px |
| 最大单块 | 457 × 49 = 22,393 px |
| 13 次 `djpeg -crop` 合计 | 39.6–55.8 ms |
| 平均每块 | 3.0–3.7 ms |

13 块按确认返回 `ARGB_8888` 计算，累计 Bitmap 像素缓冲约 0.90 MiB；按块顺序处理时，最大单块 Bitmap 约 87.5 KiB，不会同时常驻 13 份。示例还会同时分配同尺寸的 `IntArray`，仅这两份的瞬时占用至少约 175 KiB，另有中位数统计工作区。这里的“区域解码”保证不分配整帧 Bitmap，但 JPEG 解码器内部仍可能读取额外 MCU 或扫描数据，不能把像素面积比例直接当成耗时比例。

OPPO 真机已经测到这条路径：13 块共 **60 ms**，解码 **172,339 px**，按原图复用后
创建 10 个 decoder，未定 0、错误 0。它占当次 M3 总耗时 4,501 ms 的 1.3%，只用了
原 1 s 保守预算的 6%。计时覆盖 decoder 创建、全部 `decodeRegion`、`getPixels`、中位数
分类和 native 调度，不只记录 `decodeRegion()`。后续报告继续单列区域数、解码像素数和未定数；
若某段素材明显超过这组实测，先检查 decoder 是否按帧复用以及 JS bridge 是否批量调用，
不以扩大区域或整帧解码换取方便。

完整 4fps 诊断开关会额外对每个源帧执行 ML Kit OCR，并只导出文本、几何和统计 JSON；
不导出视频或 JPEG，也不把整帧解码成 JavaScript RGBA。第五轮性能验收默认关闭这项诊断，
只精确抽取算法需要的帧：微信根据真机字符级横扫使用 stride=5（最大间隔 1250 ms），通用
根据锚点自检和位移横扫使用 stride=3（最大间隔 750 ms）。开关开启时仍会采集完整 4fps，
随后才按当前模式的 stride 选算法子序列；未被选中的临时 JPEG 在 OCR 后立即删除，歧义气泡
对应的选中帧保留到局部采样结束再清理。删除失败会连续尝试最多 3 次；仍有残留时报告
`remainingTempFileCount` 并显式告警，验收脚本要求该值为 0，不能让完整聊天截图在私有缓存中
静默累积。native 抽帧中途失败时也会重试清理已经写出的半批 JPEG；每次新流程开始前扫描
专用的 `tenglu-anchor/frame-*.jpg`，先清完旧文件再抽帧，并把发现数与删除数写入验收统计。

## 失败与降级

- 没有原始帧：保留纯坐标路径，能力基线约为 35/41，不把它报告成像素验证结果。
- 提供了帧但文件缺失、区域无效、解码失败或颜色未定：返回显式告警；不能静默改用已删除的“中点二分传播”或“孤立回复先验”。
- 局部像素只解决发言人歧义，不参与文本锚点位移、跨帧去重或内容生成。

Android API 依据：[`BitmapRegionDecoder`](https://developer.android.com/reference/android/graphics/BitmapRegionDecoder)、[`BitmapFactory.Options`](https://developer.android.com/reference/android/graphics/BitmapFactory.Options)、[`Bitmap.Config`](https://developer.android.com/reference/android/graphics/Bitmap.Config)。
