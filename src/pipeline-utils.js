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

module.exports = {
  fixedFpsTimes,
  ocrSegmentRanges,
  reconcileFrameShiftTiming,
  uniformTimes,
};
