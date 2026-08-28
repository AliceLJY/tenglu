import { File } from "expo-file-system";
import TextRecognition, {
  TextRecognitionScript,
} from "@react-native-ml-kit/text-recognition";

const {
  analyzeAnchorFrames,
  collectFrameLines,
  finalizeWechatMessages,
  makeRegionRequests,
  prepareWechatMessages,
  renderPlain,
} = require("./anchor-utils");
const {
  fixedFpsTimes,
  fixedFpsStrideTimes,
  reconcileAnchorTiming,
} = require("./pipeline-utils");

const FPS = 4;
const STRIDE = 7;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
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
    return false;
  }
}

async function sampleRegionsNative(requests) {
  // The local module is Android-only. Delaying require keeps the existing iOS
  // stitching app loadable and leaves the independent iOS M3 line untouched.
  const { sampleRegions } = require(
    "../modules/tenglu-region-sampler/src/TengluRegionSamplerModule"
  );
  return sampleRegions(requests);
}

async function extractFramesNative(sourceUri, timesMs) {
  // OPTION_CLOSEST is deliberate. expo-video-thumbnails uses
  // OPTION_CLOSEST_SYNC on Android, which can repeat a keyframe across a real
  // scroll and let a false zero shift pass the text-anchor self-check.
  const { extractFrames } = require(
    "../modules/tenglu-region-sampler/src/TengluRegionSamplerModule"
  );
  return extractFrames(sourceUri, timesMs);
}

function roundTimings(raw, total) {
  return {
    frameExtract: Math.round(raw.frameExtract),
    frameOcr: Math.round(raw.frameOcr),
    uiPause: Math.round(raw.uiPause),
    anchorLayout: Math.round(raw.anchorLayout),
    speakerSampling: Math.round(raw.speakerSampling),
    markdown: Math.round(raw.markdown),
    cleanup: Math.round(raw.cleanup),
    total: Math.round(total),
  };
}

/**
 * M3: OCR selected source frames directly, then reconstruct global text geometry.
 * JPEGs stay encoded; only ambiguous WeChat text boxes reach BitmapRegionDecoder.
 */
export async function processAnchorRecording(asset, app = "wechat", onProgress) {
  if (!asset?.uri) throw new Error("没有拿到录屏文件。");
  const durationMs = Number(asset.duration);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("无法读取录屏时长，请换一段本机相册里的录屏重试。");
  }

  const state = { tempUris: new Set() };
  const rawTimings = {
    frameExtract: 0,
    frameOcr: 0,
    uiPause: 0,
    anchorLayout: 0,
    speakerSampling: 0,
    markdown: 0,
    cleanup: 0,
  };
  const totalStarted = now();

  try {
    const sourceTimes = fixedFpsTimes(durationMs, FPS);
    const selectedTimes = fixedFpsStrideTimes(durationMs, FPS, STRIDE);
    if (selectedTimes.length < 2) {
      throw new Error("录屏太短，文本锚点路径至少需要 2 帧。");
    }

    report(onProgress, `M3 精确抽取 ${selectedTimes.length} 帧`);
    let started = now();
    const extracted = await extractFramesNative(asset.uri, selectedTimes);
    rawTimings.frameExtract += now() - started;
    const extractedFrames = extracted?.frames ?? [];
    for (const frame of extractedFrames) {
      if (frame?.uri) state.tempUris.add(frame.uri);
    }
    if (extractedFrames.length !== selectedTimes.length) {
      throw new Error(
        `M3 抽帧数量不符：请求 ${selectedTimes.length}，实际 ${extractedFrames.length}。`,
      );
    }

    const frames = [];
    const frameUris = extractedFrames.map(frame => frame.uri);
    let frameWidth = 0;
    let frameHeight = 0;
    for (let index = 0; index < selectedTimes.length; index++) {
      const sourceIndex = index * STRIDE;
      const thumbnail = extractedFrames[index];
      if (!thumbnail?.uri || !Number.isFinite(thumbnail.width) ||
          !Number.isFinite(thumbnail.height)) {
        throw new Error(`M3 第 ${index + 1} 个抽帧结果无效。`);
      }
      if (thumbnail.requestedTimeMs !== selectedTimes[index]) {
        throw new Error(
          `M3 第 ${index + 1} 帧时刻不符：请求 ${selectedTimes[index]}ms，` +
          `返回 ${thumbnail.requestedTimeMs}ms。`,
        );
      }

      if (index === 0) {
        frameWidth = thumbnail.width;
        frameHeight = thumbnail.height;
      } else if (thumbnail.width !== frameWidth || thumbnail.height !== frameHeight) {
        throw new Error(
          `录屏帧尺寸中途变化：预期 ${frameWidth}x${frameHeight}，` +
          `实际 ${thumbnail.width}x${thumbnail.height}。`,
        );
      }

      report(onProgress, `M3 OCR ${index + 1}/${selectedTimes.length}`);
      started = now();
      const recognized = await TextRecognition.recognize(
        thumbnail.uri,
        TextRecognitionScript.CHINESE,
      );
      const lines = collectFrameLines(recognized, index);
      rawTimings.frameOcr += now() - started;
      frames.push({
        name: `f_${String(sourceIndex + 1).padStart(4, "0")}.jpg`,
        sourceIndex,
        timeMs: selectedTimes[index],
        lines,
      });

      started = now();
      await pauseForUi();
      rawTimings.uiPause += now() - started;
    }

    if (!frames.some(frame => frame.lines.length)) {
      throw new Error("OCR 没有识别到任何文字，请确认录屏内容清晰后重试。");
    }

    report(onProgress, "M3 计算文本锚点与全局位置");
    started = now();
    const analysis = analyzeAnchorFrames(frames);
    const prepared = app === "wechat"
      ? prepareWechatMessages(analysis.uniqueLines)
      : null;
    rawTimings.anchorLayout += now() - started;

    let sampleBatch = { samples: [], decoderCount: 0, elapsedMs: 0 };
    if (prepared?.sampleRows.length) {
      report(onProgress, `M3 局部采样 ${prepared.sampleRows.length} 个气泡`);
      const requests = makeRegionRequests(prepared, frameUris);
      started = now();
      sampleBatch = await sampleRegionsNative(requests);
      rawTimings.speakerSampling += now() - started;
    }

    report(onProgress, "M3 整理 Markdown");
    started = now();
    const rendered = prepared
      ? finalizeWechatMessages(prepared, sampleBatch.samples)
      : {
          markdown: renderPlain(analysis.uniqueLines),
          speakerWarnings: [],
          speakerSamples: [],
          speakerStats: {
            dual: 0,
            pixelResolved: 0,
            pixelMe: 0,
            pixelThem: 0,
            pixelUnresolved: 0,
            pixelErrors: 0,
            decodedPixels: 0,
            sampledPixels: 0,
          },
        };
    rawTimings.markdown += now() - started;

    if (!rendered.markdown.trim()) {
      throw new Error(
        rendered.speakerWarnings.length
          ? `所有可输出气泡的底色都无法判定：${rendered.speakerWarnings.join("；")}`
          : "OCR 没有识别到可输出的正文，请确认模式和录屏内容后重试。",
      );
    }

    started = now();
    for (const uri of [...state.tempUris]) {
      if (safeDelete(uri)) state.tempUris.delete(uri);
    }
    rawTimings.cleanup += now() - started;

    const totalRaw = now() - totalStarted;
    const reconciliation = reconcileAnchorTiming(totalRaw, rawTimings);
    const timingWarning = reconciliation.shouldWarn
      ? `M3 总耗时对账差额 ${Math.round(reconciliation.unclassifiedMs)}ms，` +
        `超过 ${Math.round(reconciliation.thresholdMs)}ms 告警阈值；` +
        "可能存在尚未归因的开销或计时范围重叠。"
      : "";
    const anchorWarnings = analysis.anchorWarnings.map(warning =>
      `${warning.pair}: ${warning.reasons.join("；")}`,
    );
    const allWarnings = [...anchorWarnings, ...rendered.speakerWarnings];

    return {
      engine: "anchor",
      status: allWarnings.length || timingWarning ? "warning" : "ok",
      markdown: rendered.markdown,
      timingWarning,
      warnings: allWarnings,
      timings: roundTimings(rawTimings, totalRaw),
      stats: {
        app,
        fps: FPS,
        stride: STRIDE,
        sourceFrameCount: sourceTimes.length,
        frameCount: frames.length,
        frameWidth,
        frameHeight,
        fixedBandCount: analysis.fixedBands.size,
        anchorPairCount: analysis.shifts.length,
        anchorPassedCount: analysis.shifts.length - analysis.anchorWarnings.length,
        cumulativeShift: analysis.cumulativeShift,
        ocrLineCount: frames.reduce((sum, frame) => sum + frame.lines.length, 0),
        contentLineCount: analysis.contentLineCount,
        uniqueLineCount: analysis.uniqueLines.length,
        sampleRegionCount: rendered.speakerStats.dual,
        sampleResolvedCount: rendered.speakerStats.pixelResolved,
        sampleUnresolvedCount: rendered.speakerStats.pixelUnresolved,
        sampleErrorCount: rendered.speakerStats.pixelErrors,
        decodedPixels: rendered.speakerStats.decodedPixels,
        sampledPixels: rendered.speakerStats.sampledPixels,
        nativeDecoderCount: sampleBatch.decoderCount,
        frameExtractionMethod: extracted.method,
        nativeFrameExtractMs: Math.round(extracted.elapsedMs),
        nativeSamplingMs: Math.round(sampleBatch.elapsedMs),
        timingAccountedMs: Math.round(reconciliation.accountedMs),
        timingDeltaMs: Math.round(reconciliation.unclassifiedMs),
        timingThresholdMs: Math.round(reconciliation.thresholdMs),
        sampleDetails: rendered.speakerSamples.map(sample => ({
          id: sample.id,
          frameIndex: sample.frameIndex,
          side: sample.side,
          rgb: sample.rgb,
          brightPixels: sample.brightPixels,
          decodedPixels: sample.decodedPixels,
          rect: sample.rect,
          frameWidth: sample.frameWidth,
          frameHeight: sample.frameHeight,
          errorCode: sample.errorCode,
          error: sample.error,
        })),
      },
    };
  } finally {
    for (const uri of state.tempUris) safeDelete(uri);
  }
}

export const ANCHOR_PIPELINE_CONSTANTS = { FPS, STRIDE };
