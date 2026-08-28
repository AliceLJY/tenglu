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
  anchorFramePlan,
  reconcileAnchorTiming,
} = require("./pipeline-utils");
const {
  anchorResultStatus,
  shouldFailEmptyAnchorOutput,
} = require("./result-policy");
const { PRESETS } = require("./stitcher");

const FPS = 4;

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

async function cleanupTempUris(tempUris, attempts = 3) {
  let attemptCount = 0;
  while (tempUris.size && attemptCount < attempts) {
    attemptCount += 1;
    for (const uri of [...tempUris]) {
      if (safeDelete(uri)) tempUris.delete(uri);
    }
    if (tempUris.size && attemptCount < attempts) await pauseForUi();
  }
  return { attemptCount, remaining: tempUris.size };
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

async function cleanupFramesNative() {
  const { cleanupFrames } = require(
    "../modules/tenglu-region-sampler/src/TengluRegionSamplerModule"
  );
  return cleanupFrames();
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
 * M3: OCR source frames directly, then reconstruct global text geometry.
 * With diagnostic capture enabled every 4fps frame is recognized and retained as
 * JSON; the algorithm still receives only the configured stride subsequence.
 * JPEGs stay encoded; only ambiguous WeChat text boxes reach BitmapRegionDecoder.
 */
export async function processAnchorRecording(
  asset,
  app = "wechat",
  onProgress,
  options = {},
) {
  if (!asset?.uri) throw new Error("没有拿到录屏文件。");
  const durationMs = Number(asset.duration);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("无法读取录屏时长，请换一段本机相册里的录屏重试。");
  }
  const preset = PRESETS[app] || PRESETS.generic;
  const stride = preset.anchorStride;
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`模式 ${app} 缺少有效的文本锚点 stride。`);
  }
  const maxAnchorGapMs = stride * 1000 / FPS;

  const state = { cleanupRecorded: false, tempUris: new Set() };
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
    const captureOcrCache = options.captureOcrCache === true;
    const {
      sourceTimes,
      selectedTimes,
      extractionTimes: ocrTimes,
    } = anchorFramePlan(durationMs, FPS, stride, captureOcrCache);
    if (selectedTimes.length < 2) {
      throw new Error("录屏太短，文本锚点路径至少需要 2 帧。");
    }

    report(
      onProgress,
      captureOcrCache
        ? `M3 诊断导出：精确抽取完整 4fps 共 ${ocrTimes.length} 帧`
        : `M3 精确抽取 ${ocrTimes.length} 帧`,
    );
    let started = now();
    const extracted = await extractFramesNative(asset.uri, ocrTimes);
    rawTimings.frameExtract += now() - started;
    const extractedFrames = extracted?.frames ?? [];
    for (const frame of extractedFrames) {
      if (frame?.uri) state.tempUris.add(frame.uri);
    }
    if (extractedFrames.length !== ocrTimes.length) {
      throw new Error(
        `M3 抽帧数量不符：请求 ${ocrTimes.length}，实际 ${extractedFrames.length}。`,
      );
    }

    const capturedFrames = [];
    let frameWidth = 0;
    let frameHeight = 0;
    for (let index = 0; index < ocrTimes.length; index++) {
      const sourceIndex = captureOcrCache ? index : index * stride;
      const thumbnail = extractedFrames[index];
      if (!thumbnail?.uri || !Number.isFinite(thumbnail.width) ||
          !Number.isFinite(thumbnail.height)) {
        throw new Error(`M3 第 ${index + 1} 个抽帧结果无效。`);
      }
      if (thumbnail.requestedTimeMs !== ocrTimes[index]) {
        throw new Error(
          `M3 第 ${index + 1} 帧时刻不符：请求 ${ocrTimes[index]}ms，` +
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

      report(onProgress, `M3 OCR ${index + 1}/${ocrTimes.length}`);
      started = now();
      const recognized = await TextRecognition.recognize(
        thumbnail.uri,
        TextRecognitionScript.CHINESE,
      );
      const lines = collectFrameLines(recognized, index);
      rawTimings.frameOcr += now() - started;
      capturedFrames.push({
        name: `f_${String(sourceIndex + 1).padStart(4, "0")}.jpg`,
        sourceIndex,
        timeMs: ocrTimes[index],
        uri: thumbnail.uri,
        lines,
      });

      started = now();
      await pauseForUi();
      rawTimings.uiPause += now() - started;

      if (captureOcrCache && sourceIndex % stride !== 0) {
        started = now();
        if (safeDelete(thumbnail.uri)) state.tempUris.delete(thumbnail.uri);
        rawTimings.cleanup += now() - started;
      }
    }

    if (!capturedFrames.some(frame => frame.lines.length)) {
      throw new Error("OCR 没有识别到任何文字，请确认录屏内容清晰后重试。");
    }

    const frames = capturedFrames
      .filter(frame => frame.sourceIndex % stride === 0)
      .map((frame, compactIndex) => ({
        ...frame,
        lines: frame.lines.map(line => ({ ...line, frameIndex: compactIndex })),
      }));
    const frameUris = frames.map(frame => frame.uri);
    if (frames.length !== selectedTimes.length) {
      throw new Error(
        `M3 stride 子序列数量不符：预期 ${selectedTimes.length}，实际 ${frames.length}。`,
      );
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

    if (shouldFailEmptyAnchorOutput(
      rendered.markdown,
      rendered.speakerWarnings,
    )) {
      throw new Error("OCR 没有识别到可输出的正文，请确认模式和录屏内容后重试。");
    }

    started = now();
    const cleanup = await cleanupTempUris(state.tempUris);
    rawTimings.cleanup += now() - started;
    state.cleanupRecorded = true;

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
    const cleanupWarnings = cleanup.remaining
      ? [`临时 JPEG 连续清理 ${cleanup.attemptCount} 次后仍残留 ${cleanup.remaining} 个。`]
      : [];
    const allWarnings = [
      ...anchorWarnings,
      ...rendered.speakerWarnings,
      ...cleanupWarnings,
    ];

    return {
      engine: "anchor",
      status: anchorResultStatus(allWarnings, timingWarning),
      markdown: rendered.markdown,
      timingWarning,
      warnings: allWarnings,
      timings: roundTimings(rawTimings, totalRaw),
      stats: {
        app,
        fps: FPS,
        stride,
        maxAnchorGapMs,
        sourceFrameCount: sourceTimes.length,
        ocrCaptureEnabled: captureOcrCache,
        ocrCapturedFrameCount: capturedFrames.length,
        extractedFrameCount: extractedFrames.length,
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
        dedupeCandidateGroups: analysis.dedupeStats.candidateGroups,
        dedupeFrameComposedClusters: analysis.dedupeStats.frameComposedClusters,
        dedupeMajorityEligible: analysis.dedupeStats.majorityEligible,
        dedupeMajorityChosen: analysis.dedupeStats.majorityChosen,
        dedupeMajorityRejectedUnrelated:
          analysis.dedupeStats.majorityRejectedUnrelated,
        dedupeVariantSimilarityThreshold:
          analysis.dedupeStats.variantSimilarityThreshold,
        dedupeChangedSelection: analysis.dedupeStats.changedSelection,
        dedupeNormalizedChangedSelection:
          analysis.dedupeStats.normalizedChangedSelection,
        dedupeLongerFallback: analysis.dedupeStats.longerFallback,
        sampleRegionCount: rendered.speakerStats.dual,
        sampleResolvedCount: rendered.speakerStats.pixelResolved,
        sampleUnresolvedCount: rendered.speakerStats.pixelUnresolved,
        sampleErrorCount: rendered.speakerStats.pixelErrors,
        nicknameCandidateCount: rendered.speakerStats.nicknameCandidates ?? 0,
        nicknameHighConfidenceCount:
          rendered.speakerStats.nicknameHighConfidence ?? 0,
        nicknameWideBodyCount: rendered.speakerStats.nicknameWideBody ?? 0,
        nicknameInternalSplitCount:
          rendered.speakerStats.nicknameInternalSplits ?? 0,
        nicknameAppliedCount: rendered.speakerStats.nicknameApplied ?? 0,
        decodedPixels: rendered.speakerStats.decodedPixels,
        sampledPixels: rendered.speakerStats.sampledPixels,
        nativeDecoderCount: sampleBatch.decoderCount,
        frameExtractionMethod: extracted.method,
        nativeStaleTempFileCount: extracted.staleFileCount ?? 0,
        nativeStaleTempFileDeletedCount: extracted.staleDeletedCount ?? 0,
        nativeFrameExtractMs: Math.round(extracted.elapsedMs),
        nativeFrameExtractPerFrameMs: extractedFrames.length
          ? Math.round(extracted.elapsedMs * 10 / extractedFrames.length) / 10
          : null,
        nativeSamplingMs: Math.round(sampleBatch.elapsedMs),
        timingAccountedMs: Math.round(reconciliation.accountedMs),
        timingDeltaMs: Math.round(reconciliation.unclassifiedMs),
        timingThresholdMs: Math.round(reconciliation.thresholdMs),
        cleanupAttemptCount: cleanup.attemptCount,
        remainingTempFileCount: cleanup.remaining,
        anchorDetails: analysis.shifts.map(shift => ({
          pair: `${shift.from}→${shift.to}`,
          shift: shift.shift,
          votes: shift.votes,
          total: shift.total,
          voteRatio: shift.total ? shift.votes / shift.total : 0,
          cumulativeShift: shift.cumulativeShift,
          exactTotal: shift.exactTotal,
          fuzzyCandidates: shift.fuzzyCandidates,
          fuzzyAccepted: shift.fuzzyAccepted,
          fuzzyRejected: shift.fuzzyRejected,
          fuzzyRescue: shift.fuzzyRescue,
          fuzzyCandidateVotes: shift.fuzzyCandidateVotes ?? 0,
          fuzzyCandidateTotal: shift.fuzzyCandidateTotal ?? 0,
          fuzzyCandidateVoteRatio: shift.fuzzyCandidateTotal
            ? shift.fuzzyCandidateVotes / shift.fuzzyCandidateTotal
            : null,
        })),
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
      ocrCache: captureOcrCache
        ? {
            fps: FPS,
            sourceFrameCount: sourceTimes.length,
            frameWidth,
            frameHeight,
            frames: capturedFrames.map(frame => ({
              name: frame.name,
              sourceIndex: frame.sourceIndex,
              timeMs: frame.timeMs,
              lines: frame.lines,
            })),
          }
        : null,
    };
  } catch (caught) {
    const cleanupStarted = now();
    const jsCleanup = await cleanupTempUris(state.tempUris);
    let nativeCleanup = null;
    let nativeCleanupError = "";
    try {
      nativeCleanup = await cleanupFramesNative();
      if (nativeCleanup.remainingCount === 0) state.tempUris.clear();
    } catch (cleanupError) {
      nativeCleanupError = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    }
    rawTimings.cleanup += now() - cleanupStarted;
    state.cleanupRecorded = true;

    const original = caught instanceof Error ? caught : new Error(String(caught));
    const remainingTempFileCount = nativeCleanup
      ? nativeCleanup.remainingCount
      : null;
    let message = original.message;
    if (nativeCleanupError) {
      message += `；异常后的 native 临时 JPEG 清理状态未知：${nativeCleanupError}`;
    } else if (remainingTempFileCount) {
      message += `；异常后连续清理仍残留 ${remainingTempFileCount} 个临时 JPEG`;
    }
    const error = new Error(message);
    error.m3FailureStats = {
      cleanupAttemptCount: jsCleanup.attemptCount,
      jsRemainingTempFileCount: jsCleanup.remaining,
      nativeCleanupFoundCount: nativeCleanup?.foundCount ?? null,
      nativeCleanupDeletedCount: nativeCleanup?.deletedCount ?? null,
      nativeCleanupError: nativeCleanupError || null,
      remainingTempFileCount,
    };
    throw error;
  } finally {
    if (!state.cleanupRecorded) await cleanupTempUris(state.tempUris);
  }
}

export const ANCHOR_PIPELINE_CONSTANTS = { FPS };
