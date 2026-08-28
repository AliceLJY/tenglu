function uniformTimes(durationMs, count) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("durationMs must be positive");
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("count must be a positive integer");
  }
  const last = Math.max(0, durationMs - 1);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * last) / (count - 1)),
  );
}

/** Match the frame counts produced by ffmpeg's fps filter for the same duration. */
function fixedFpsTimes(durationMs, fps) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("durationMs must be positive");
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError("fps must be positive");
  }
  const step = 1000 / fps;
  const count = Math.max(1, Math.round(durationMs / step));
  return Array.from({ length: count }, (_, index) =>
    Math.min(durationMs - 1, Math.round(index * step)),
  );
}

/** Generate the same requested timestamps as ffmpeg fps=N plus index stride. */
function fixedFpsStrideTimes(durationMs, fps, stride) {
  if (!Number.isInteger(stride) || stride < 1) {
    throw new RangeError("stride must be a positive integer");
  }
  return fixedFpsTimes(durationMs, fps).filter((_, index) => index % stride === 0);
}

/** Separate the fast algorithm frame plan from the optional full diagnostic capture. */
function anchorFramePlan(durationMs, fps, stride, captureEverySourceFrame = false) {
  if (!Number.isInteger(stride) || stride < 1) {
    throw new RangeError("stride must be a positive integer");
  }
  const sourceTimes = fixedFpsTimes(durationMs, fps);
  const selectedTimes = sourceTimes.filter((_, index) => index % stride === 0);
  return {
    sourceTimes,
    selectedTimes,
    extractionTimes: captureEverySourceFrame ? sourceTimes : selectedTimes,
  };
}

/** Choose a temporal sampling stride from the maximum allowed frame gap. */
function strideForMaxGap(fps, maxGapMs) {
  if (!Number.isFinite(fps) || fps <= 0 ||
      !Number.isFinite(maxGapMs) || maxGapMs <= 0) {
    throw new RangeError("fps and maxGapMs must be positive finite numbers");
  }
  return Math.max(1, Math.floor(fps * maxGapMs / 1000));
}

const THUMBNAIL_QUALITY = Object.freeze({
  prescan: 0.4,
  shift: 0.4,
  keyframe: 1,
});

/** Keep thumbnail quality explicit for every pipeline purpose. */
function thumbnailOptions(timeMs, purpose) {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    throw new RangeError("timeMs must be a non-negative finite number");
  }
  const quality = THUMBNAIL_QUALITY[purpose];
  if (quality === undefined) {
    throw new RangeError(`unknown thumbnail purpose: ${purpose}`);
  }
  return { time: timeMs, quality };
}

function ocrSegmentRanges(totalHeight, segmentHeight, overlap) {
  if (!Number.isInteger(totalHeight) || totalHeight < 1 ||
      !Number.isInteger(segmentHeight) || segmentHeight < 1 ||
      !Number.isInteger(overlap) || overlap < 0 || overlap >= segmentHeight) {
    throw new RangeError("invalid OCR segment dimensions");
  }
  const step = segmentHeight - overlap;
  const ranges = [];
  for (let top = 0; top < totalHeight; top += step) {
    ranges.push({ top, height: Math.min(segmentHeight, totalHeight - top) });
  }
  return ranges;
}

const FRAME_SHIFT_DETAIL_KEYS = [
  "shiftThumbMs",
  "decodeMs",
  "grayMs",
  "shiftMs",
  "keyframeMs",
  "pauseMs",
];

/** Compare the phase wall time with its six mutually exclusive measurements. */
function reconcileFrameShiftTiming(frameShiftMs, details) {
  if (!Number.isFinite(frameShiftMs) || frameShiftMs < 0) {
    throw new RangeError("frameShiftMs must be a non-negative finite number");
  }
  let accountedMs = 0;
  for (const key of FRAME_SHIFT_DETAIL_KEYS) {
    const value = details?.[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${key} must be a non-negative finite number`);
    }
    accountedMs += value;
  }
  const unclassifiedMs = frameShiftMs - accountedMs;
  const thresholdMs = Math.max(100, frameShiftMs * 0.01);
  return {
    accountedMs,
    shouldWarn: Math.abs(unclassifiedMs) > thresholdMs,
    thresholdMs,
    unclassifiedMs,
  };
}

const ANCHOR_TIMING_KEYS = [
  "frameExtract",
  "frameOcr",
  "uiPause",
  "anchorLayout",
  "speakerSampling",
  "markdown",
  "cleanup",
];

/** Reconcile mutually exclusive M3 stages against the end-to-end wall time. */
function reconcileAnchorTiming(totalMs, details) {
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    throw new RangeError("totalMs must be a non-negative finite number");
  }
  let accountedMs = 0;
  for (const key of ANCHOR_TIMING_KEYS) {
    const value = details?.[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${key} must be a non-negative finite number`);
    }
    accountedMs += value;
  }
  const unclassifiedMs = totalMs - accountedMs;
  const thresholdMs = Math.max(100, totalMs * 0.01);
  return {
    accountedMs,
    shouldWarn: Math.abs(unclassifiedMs) > thresholdMs,
    thresholdMs,
    unclassifiedMs,
  };
}

module.exports = {
  anchorFramePlan,
  fixedFpsTimes,
  fixedFpsStrideTimes,
  ocrSegmentRanges,
  reconcileAnchorTiming,
  reconcileFrameShiftTiming,
  strideForMaxGap,
  thumbnailOptions,
  uniformTimes,
};
