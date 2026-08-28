const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fixedFpsTimes,
  ocrSegmentRanges,
  reconcileFrameShiftTiming,
  thumbnailOptions,
  uniformTimes,
} = require("../src/pipeline-utils");

test("fixed 4fps produces the two verified recording frame counts", () => {
  const wechat = fixedFpsTimes(26980.356, 4);
  const xiaohongshu = fixedFpsTimes(32030.989, 4);

  assert.equal(wechat.length, 108);
  assert.equal(wechat[0], 0);
  assert.equal(wechat.at(-1), 26750);
  assert.equal(xiaohongshu.length, 128);
  assert.equal(xiaohongshu.at(-1), 31750);
});

test("uniform pre-scan includes both ends and the requested count", () => {
  assert.deepEqual(uniformTimes(1001, 3), [0, 500, 1000]);
  assert.deepEqual(uniformTimes(1001, 1), [0]);
});

test("L4 analysis frames stay low-quality while source frames stay full-quality", () => {
  assert.deepEqual(thumbnailOptions(250, "prescan"), {
    time: 250,
    quality: 0.4,
  });
  assert.deepEqual(thumbnailOptions(500, "shift"), {
    time: 500,
    quality: 0.4,
  });
  assert.deepEqual(thumbnailOptions(750, "keyframe"), {
    time: 750,
    quality: 1,
  });
  assert.throws(
    () => thumbnailOptions(1000, "unknown"),
    /unknown thumbnail purpose/,
  );
});

test("5107px OCR ranges use 1400px segments with 200px overlap", () => {
  assert.deepEqual(ocrSegmentRanges(5107, 1400, 200), [
    { top: 0, height: 1400 },
    { top: 1200, height: 1400 },
    { top: 2400, height: 1400 },
    { top: 3600, height: 1400 },
    { top: 4800, height: 307 },
  ]);
});

test("13558px OCR ranges end exactly at the long-image boundary", () => {
  const ranges = ocrSegmentRanges(13558, 1400, 200);
  assert.equal(ranges.length, 12);
  assert.deepEqual(ranges.at(-1), { top: 13200, height: 358 });
  assert.equal(ranges.at(-1).top + ranges.at(-1).height, 13558);
});

test("frame-shift timing reconciliation uses all six exclusive details", () => {
  const result = reconcileFrameShiftTiming(1000, {
    shiftThumbMs: 100,
    decodeMs: 200,
    grayMs: 100,
    shiftMs: 300,
    keyframeMs: 100,
    pauseMs: 50,
  });

  assert.equal(result.accountedMs, 850);
  assert.equal(result.unclassifiedMs, 150);
  assert.equal(result.thresholdMs, 100);
  assert.equal(result.shouldWarn, true);
});

test("frame-shift timing reconciliation accepts a difference at the threshold", () => {
  const result = reconcileFrameShiftTiming(20_000, {
    shiftThumbMs: 1_000,
    decodeMs: 4_000,
    grayMs: 2_000,
    shiftMs: 10_000,
    keyframeMs: 1_500,
    pauseMs: 1_300,
  });

  assert.equal(result.unclassifiedMs, 200);
  assert.equal(result.thresholdMs, 200);
  assert.equal(result.shouldWarn, false);
});
