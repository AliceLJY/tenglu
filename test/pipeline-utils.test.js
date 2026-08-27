const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fixedFpsTimes,
  ocrSegmentRanges,
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
