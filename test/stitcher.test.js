const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectScrollRegion,
  dedupeLines,
  encodeBMP,
  estimateShift,
  estimateShiftCoarse,
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

function texturedGray(width, height) {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = 128
        + 52 * Math.sin(y * 0.113 + x * 0.037)
        + 39 * Math.sin(y * 0.041 - x * 0.083)
        + 24 * Math.sin((x + y) * 0.071);
      gray[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return gray;
}

function shiftGray(gray, width, height, dy) {
  const shifted = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const sourceY = y + dy;
    if (sourceY < 0 || sourceY >= height) continue;
    shifted.set(
      gray.subarray(sourceY * width, (sourceY + 1) * width),
      y * width,
    );
  }
  return shifted;
}

function grayToRgba(gray) {
  const rgba = new Uint8Array(gray.length * 4);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    rgba[p] = gray[i];
    rgba[p + 1] = gray[i];
    rgba[p + 2] = gray[i];
    rgba[p + 3] = 255;
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

test("coarse shift stays within 4px while full shift remains pixel-accurate", () => {
  const width = 64;
  const height = 400;
  const expected = 13;
  const oldGray = texturedGray(width, height);
  const newGray = shiftGray(oldGray, width, height, expected);

  const coarse = estimateShiftCoarse(oldGray, newGray, width, height);
  const full = estimateShift(oldGray, newGray, width, height);

  assert.ok(Math.abs(coarse.dy - expected) <= 4);
  assert.equal((coarse.dy + 60) % 4, 0);
  assert.ok(coarse.conf >= 0 && coarse.conf <= 1);
  assert.equal(full.dy, expected);
});

test("coarse shift preserves the sign of a clear rebound", () => {
  const width = 64;
  const height = 400;
  const expected = -5;
  const oldGray = texturedGray(width, height);
  const newGray = shiftGray(oldGray, width, height, expected);

  const coarse = estimateShiftCoarse(oldGray, newGray, width, height);

  assert.ok(coarse.dy < 0);
  assert.ok(Math.abs(coarse.dy - expected) <= 4);
});

test("coarse shift may quantize a sub-DS rebound to zero", () => {
  const width = 64;
  const height = 400;
  const oldGray = texturedGray(width, height);
  const newGray = shiftGray(oldGray, width, height, -1);

  const coarse = estimateShiftCoarse(oldGray, newGray, width, height);

  assert.equal(coarse.dy, 0);
});

test("stitch still rematches keyframes at full pixel precision", () => {
  const width = 64;
  const height = 400;
  const expected = 13;
  const oldGray = texturedGray(width, height);
  const newGray = shiftGray(oldGray, width, height, expected);

  const result = stitch(
    [grayToRgba(oldGray), grayToRgba(newGray)],
    [0, 1],
    width,
    height,
  );

  assert.deepEqual(result.offsets, [0, expected]);
  assert.equal(result.height, height + expected);
  assert.equal(result.warnings.length, 0);
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
