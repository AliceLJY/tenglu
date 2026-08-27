import { File, Paths } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";
import TextRecognition, {
  TextRecognitionScript,
} from "@react-native-ml-kit/text-recognition";

const jpeg = require("jpeg-js");
const {
  PRESETS,
  cropRows,
  detectScrollRegion,
  encodeBMP,
  estimateShiftCoarse,
  pickKeyframes,
  stitch,
  toGray,
} = require("./stitcher");
const {
  formatPlainMarkdown,
  formatWechatMarkdown,
} = require("./postprocess");
const {
  collectRecognizedLines,
  copyRgbaRows,
} = require("./ocr-utils");
const {
  fixedFpsTimes,
  ocrSegmentRanges,
  uniformTimes,
} = require("./pipeline-utils");

const FPS = 4;
const OCR_HEIGHT = 1400;
const OCR_OVERLAP = 200;
const SLOW_THUMBNAIL_MS = 2000;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function elapsed(start) {
  return Math.round(now() - start);
}

function pauseForUi() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function report(onProgress, message) {
  onProgress?.(message);
}

function safeDelete(uri) {
  if (!uri) return true;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
    return true;
  } catch {
    // Cache cleanup must not hide a completed transcription or the original error.
    return false;
  }
}

async function decodeJpeg(uri) {
  const bytes = await new File(uri).bytes();
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  if (!image?.data || !image.width || !image.height) {
    throw new Error("抽出的帧无法解码，请换一段录屏重试。");
  }
  return image;
}

async function grabFrame(videoUri, timeMs, state) {
  const started = now();
  const thumbnail = await VideoThumbnails.getThumbnailAsync(videoUri, {
    time: timeMs,
    quality: 1,
  });
  const took = now() - started;
  state.thumbnailMs += took;
  state.tempUris.add(thumbnail.uri);
  if (took > SLOW_THUMBNAIL_MS) {
    throw new Error(
      `单帧抽取耗时 ${Math.round(took)}ms，超过 2000ms 停止线；请保留现场定位后再决定是否优化。`,
    );
  }
  return thumbnail;
}

function assertSameFrameSize(image, width, height) {
  if (image.width !== width || image.height !== height) {
    throw new Error(
      `录屏帧尺寸中途变化：预期 ${width}x${height}，实际 ${image.width}x${image.height}。`,
    );
  }
}

function writeBytes(file, bytes) {
  file.create({ overwrite: true, intermediates: true });
  file.write(bytes);
}

async function recognizeLongImage(out, state, onProgress) {
  const lines = [];
  const ranges = ocrSegmentRanges(out.height, OCR_HEIGHT, OCR_OVERLAP);

  for (let index = 0; index < ranges.length; index++) {
    const segmentIndex = index + 1;
    const { top, height } = ranges[index];
    report(onProgress, `OCR ${segmentIndex}/${ranges.length}`);
    await pauseForUi();

    const rgba = copyRgbaRows(out.canvas, out.width, top, height);
    const bmp = encodeBMP(rgba, out.width, height);
    const file = new File(
      Paths.cache,
      `tenglu-ocr-${Date.now()}-${segmentIndex}.bmp`,
    );
    state.tempUris.add(file.uri);
    writeBytes(file, bmp);

    try {
      const result = await TextRecognition.recognize(
        file.uri,
        TextRecognitionScript.CHINESE,
      );
      lines.push(
        ...collectRecognizedLines(
          result,
          top,
          out.canvas,
          out.width,
          out.height,
        ),
      );
    } finally {
      if (safeDelete(file.uri)) state.tempUris.delete(file.uri);
    }
  }
  return lines;
}

/**
 * Run the complete on-device M1 pipeline for one selected ImagePicker asset.
 * The caller owns UI state; this function owns every temporary frame/BMP file.
 */
export async function processRecording(asset, app = "wechat", onProgress) {
  if (!asset?.uri) throw new Error("没有拿到录屏文件。");
  const durationMs = Number(asset.duration);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("无法读取录屏时长，请换一段本机相册里的录屏重试。");
  }

  const preset = PRESETS[app] || PRESETS.generic;
  const state = {
    tempUris: new Set(),
    thumbnailMs: 0,
  };
  const timings = {
    prescan: 0,
    frameShift: 0,
    thumbnail: 0,
    stitch: 0,
    bmp: 0,
    ocr: 0,
    total: 0,
  };
  const totalStarted = now();

  try {
    // 1) App-specific uniform pre-scan.
    let phaseStarted = now();
    const preGrays = [];
    let width = 0;
    let height = 0;
    const preTimes = uniformTimes(durationMs, preset.preScan);
    for (let index = 0; index < preTimes.length; index++) {
      report(onProgress, `预扫 ${index + 1}/${preTimes.length}`);
      const thumb = await grabFrame(asset.uri, preTimes[index], state);
      const image = await decodeJpeg(thumb.uri);
      if (index === 0) {
        width = image.width;
        height = image.height;
      } else {
        assertSameFrameSize(image, width, height);
      }
      preGrays.push(toGray(image.data, width, height));
      if (safeDelete(thumb.uri)) state.tempUris.delete(thumb.uri);
      await pauseForUi();
    }

    const region = detectScrollRegion(preGrays, width, height);
    preGrays.length = 0;
    if (!region.ok) {
      const ratio = (((region.bottom - region.top) / height) * 100).toFixed(1);
      throw new Error(
        `滚动区检测失败：y${region.top}~${region.bottom} 只占屏高 ${ratio}%；请按提示重新录制。`,
      );
    }
    const viewHeight = region.bottom - region.top;
    timings.prescan = elapsed(phaseStarted);

    // 2) Fixed 4fps extraction and adjacent-frame shifts.
    phaseStarted = now();
    const frameTimes = fixedFpsTimes(durationMs, FPS);
    const frameUris = [];
    const shifts = [];
    let previousGray = null;

    for (let index = 0; index < frameTimes.length; index++) {
      report(onProgress, `取帧与位移 ${index + 1}/${frameTimes.length}`);
      const thumb = await grabFrame(asset.uri, frameTimes[index], state);
      frameUris.push(thumb.uri);
      const image = await decodeJpeg(thumb.uri);
      assertSameFrameSize(image, width, height);
      const regionRgba = cropRows(image.data, width, region.top, region.bottom);
      const gray = toGray(regionRgba, width, viewHeight);
      if (previousGray) shifts.push(estimateShiftCoarse(previousGray, gray, width, viewHeight));
      previousGray = gray;
      if ((index + 1) % 4 === 0) await pauseForUi();
    }

    const keyframes = pickKeyframes(shifts, viewHeight);
    previousGray = null;
    const regions = new Array(frameUris.length);
    for (let index = 0; index < keyframes.keep.length; index++) {
      report(onProgress, `准备关键帧 ${index + 1}/${keyframes.keep.length}`);
      const frameIndex = keyframes.keep[index];
      const image = await decodeJpeg(frameUris[frameIndex]);
      assertSameFrameSize(image, width, height);
      regions[frameIndex] = copyRgbaRows(
        image.data,
        width,
        region.top,
        viewHeight,
      );
      await pauseForUi();
    }
    timings.frameShift = elapsed(phaseStarted);
    timings.thumbnail = Math.round(state.thumbnailMs);

    // 3) The verified stitcher receives only the selected full-resolution regions.
    report(onProgress, "拼接长图");
    phaseStarted = now();
    const stitched = stitch(regions, keyframes.keep, width, viewHeight);
    timings.stitch = elapsed(phaseStarted);
    regions.fill(null);

    // JPEG thumbnails are no longer needed once the long RGBA canvas exists.
    for (const uri of frameUris) {
      if (safeDelete(uri)) state.tempUris.delete(uri);
    }

    // 4) Required lossless intermediate long image.
    report(onProgress, "BMP 编码");
    phaseStarted = now();
    let longBmp = encodeBMP(stitched.canvas, stitched.width, stitched.height);
    const longFile = new File(Paths.cache, `tenglu-long-${Date.now()}.bmp`);
    state.tempUris.add(longFile.uri);
    writeBytes(longFile, longBmp);
    longBmp = null;
    timings.bmp = elapsed(phaseStarted);

    // 5) 1400px OCR slices with 200px overlap; spatial dedupe happens in formatter.
    phaseStarted = now();
    const recognizedLines = await recognizeLongImage(stitched, state, onProgress);
    timings.ocr = elapsed(phaseStarted);
    if (safeDelete(longFile.uri)) state.tempUris.delete(longFile.uri);

    report(onProgress, "整理 Markdown");
    if (recognizedLines.length === 0) {
      throw new Error("OCR 没有识别到任何文字，请确认录屏内容清晰后重试。");
    }
    const markdown = preset.mode === "wechat"
      ? formatWechatMarkdown(recognizedLines)
      : formatPlainMarkdown(recognizedLines);
    if (!markdown.trim()) {
      throw new Error("OCR 没有识别到可输出的正文，请确认模式和录屏内容后重试。");
    }

    timings.total = elapsed(totalStarted);
    const warnings = [...(stitched.warnings || [])];
    if (keyframes.tooFar) {
      warnings.unshift(
        `${keyframes.tooFar} 处滑动过快、相邻关键帧没有重叠，该段内容可能缺失。`,
      );
    }

    return {
      markdown,
      warnings,
      timings,
      stats: {
        app,
        fps: FPS,
        preScanFrames: preset.preScan,
        scrollTop: region.top,
        scrollBottom: region.bottom,
        frameCount: frameTimes.length,
        keyframeCount: keyframes.keep.length,
        droppedReboundFrames: keyframes.dropped,
        width: stitched.width,
        height: stitched.height,
        ocrLineCount: recognizedLines.length,
      },
    };
  } finally {
    for (const uri of state.tempUris) safeDelete(uri);
  }
}

export const PIPELINE_CONSTANTS = {
  FPS,
  OCR_HEIGHT,
  OCR_OVERLAP,
  SLOW_THUMBNAIL_MS,
};
