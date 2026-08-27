const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectScrollRegion,
  dedupeLines,
  encodeBMP,
  pickKeyframes,
  stitch,
} = require("../src/stitcher");

function solidRgba(width, height, value) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  return rgba;
}

test("encodeBMP writes a valid 24-bit, bottom-up BGR bitmap", () => {
  const rgba = new Uint8Array([
    // Top row: red, green.
    255, 0, 0, 255, 0, 255, 0, 255,
    // Bottom row: blue, white.
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);

  const bmp = encodeBMP(rgba, 2, 2);
  const header = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);

  assert.equal(bmp.byteLength, 70); // 54-byte header + two 8-byte padded rows.
  assert.deepEqual(Array.from(bmp.subarray(0, 2)), [0x42, 0x4d]);
  assert.equal(header.getUint32(2, true), bmp.byteLength);
  assert.equal(header.getUint32(10, true), 54);
  assert.equal(header.getUint32(14, true), 40);
  assert.equal(header.getInt32(18, true), 2);
  assert.equal(header.getInt32(22, true), 2);
  assert.equal(header.getUint16(26, true), 1);
  assert.equal(header.getUint16(28, true), 24);
  assert.equal(header.getUint32(34, true), 16);

  // A positive BMP height stores the bottom source row first, in BGR order.
  assert.deepEqual(
    Array.from(bmp.subarray(54, 62)),
    [255, 0, 0, 255, 255, 255, 0, 0],
  );
  assert.deepEqual(
    Array.from(bmp.subarray(62, 70)),
    [0, 0, 255, 0, 255, 0, 0, 0],
  );
});

test("dedupeLines removes only nearby duplicate long lines", () => {
  const repeatedLong = "这是一条足够长的重复内容";
  const lines = [
    repeatedLong,
    "第一条不同的足够长内容",
    repeatedLong, // Within the last two retained lines: remove.
    "第二条不同的足够长内容",
    "第三条不同的足够长内容",
    repeatedLong, // Outside the retained-line window: keep.
    "哈哈",
    "哈哈", // Short repeated lines are legitimate conversation content.
  ];

  assert.deepEqual(dedupeLines(lines, { minLen: 8, window: 2 }), [
    repeatedLong,
    "第一条不同的足够长内容",
    "第二条不同的足够长内容",
    "第三条不同的足够长内容",
    repeatedLong,
    "哈哈",
    "哈哈",
  ]);
});

test("pickKeyframes excludes rebound frames from both threshold candidates and tail", () => {
  const shifts = [
    { dy: 40, conf: 1 },  // frame 1: solid
    { dy: -5, conf: 1 },  // frame 2: rebound; threshold candidate at k=3
    { dy: 30, conf: 1 },  // frame 3: cumulative movement crosses 60 px
    { dy: 30, conf: 1 },  // frame 4: last solid frame
    { dy: -3, conf: 1 },  // frame 5: rebound tail
  ];

  const result = pickKeyframes(shifts, 100, 0.6);

  assert.deepEqual(result.keep, [0, 1, 4]);
  assert.equal(result.dropped, 2);
  assert.equal(result.tooFar, 0);
  assert.ok(!result.keep.includes(2), "rebound threshold candidate must be excluded");
  assert.ok(!result.keep.includes(5), "rebound tail must be excluded");
});

test("detectScrollRegion reports ok:false when static frames contain no seed", () => {
  const width = 8;
  const height = 12;
  const staticGray = new Uint8Array(width * height).fill(128);
  const result = detectScrollRegion(
    [staticGray, staticGray.slice(), staticGray.slice()],
    width,
    height,
  );

  assert.deepEqual(result, {
    top: 0,
    bottom: height,
    threshold: 10,
    seed: [0, height],
    ok: false,
  });
});

test("stitch handles a low-confidence jump before considering its negative dy", () => {
  const width = 8;
  const viewHeight = 400;
  const black = solidRgba(width, viewHeight, 0);
  const white = solidRgba(width, viewHeight, 255);

  const result = stitch([black, white], [0, 1], width, viewHeight);

  assert.deepEqual(result.offsets, [0, 380]);
  assert.equal(result.height, 780);
  assert.equal(result.skipped, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /匹配置信度仅 0\.00/);
  assert.match(result.warnings[0], /按 0\.95 屏保守推进/);
});

test("stitch skips a reliably matched frame with no positive advance", () => {
  const width = 8;
  const viewHeight = 400;
  const frame = solidRgba(width, viewHeight, 80);

  const result = stitch([frame, frame.slice()], [0, 1], width, viewHeight);

  assert.deepEqual(result.offsets, [0]);
  assert.equal(result.height, viewHeight);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.canvas, frame);
});
