const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectRecognizedLines,
  copyRgbaRows,
  sampleBrightMedianRgb,
} = require("../src/ocr-utils");

function canvasOf(width, height, rgba = [0, 0, 0, 255]) {
  const canvas = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    canvas.set(rgba, pixel * 4);
  }
  return canvas;
}

function setPixel(canvas, width, x, y, rgba) {
  canvas.set(rgba, (y * width + x) * 4);
}

test("copyRgbaRows copies exactly the requested complete rows without aliasing", () => {
  const canvas = Uint8Array.from({ length: 3 * 4 * 4 }, (_, index) => index);
  const copied = copyRgbaRows(canvas, 3, 1, 2);

  assert.deepEqual(copied, canvas.slice(3 * 4, 3 * 4 * 3));
  canvas[3 * 4] = 255;
  assert.equal(copied[0], 12);
  copied[1] = 254;
  assert.equal(canvas[3 * 4 + 1], 13);
});

test("sampleBrightMedianRgb clips the frame and returns channel medians", () => {
  const canvas = canvasOf(3, 3);
  setPixel(canvas, 3, 0, 0, [180, 220, 179, 255]);
  setPixel(canvas, 3, 1, 0, [200, 240, 199, 255]);
  setPixel(canvas, 3, 0, 1, [190, 230, 189, 255]);
  setPixel(canvas, 3, 2, 2, [255, 255, 255, 255]);

  assert.deepEqual(
    sampleBrightMedianRgb(canvas, 3, 3, { left: -1, top: -1, width: 3, height: 3 }),
    [185, 225, 184],
  );
});

test("sampleBrightMedianRgb uses arithmetic RGB mean and a strict threshold", () => {
  const canvas = canvasOf(21, 1, [255, 0, 255, 255]);
  setPixel(canvas, 21, 0, 0, [150, 150, 150, 255]);

  assert.deepEqual(
    sampleBrightMedianRgb(canvas, 21, 1, { left: 0, top: 0, width: 21, height: 1 }),
    [255, 0, 255],
  );
});

test("sampleBrightMedianRgb falls back to all pixels when fewer than 20 are bright", () => {
  const canvas = canvasOf(2, 1);
  setPixel(canvas, 2, 0, 0, [40, 50, 60, 255]);
  setPixel(canvas, 2, 1, 0, [200, 210, 220, 255]);

  assert.deepEqual(
    sampleBrightMedianRgb(canvas, 2, 1, { left: 0, top: 0, width: 2, height: 1 }),
    [120, 130, 140],
  );
  assert.equal(
    sampleBrightMedianRgb(canvas, 2, 1, { left: 2, top: 0, width: 1, height: 1 }),
    null,
  );
});

test("sampleBrightMedianRgb uses the whole frame when it has no bright pixels", () => {
  assert.deepEqual(
    sampleBrightMedianRgb(
      canvasOf(2, 2, [40, 50, 60, 255]),
      2,
      2,
      { left: 0, top: 0, width: 2, height: 2 },
    ),
    [40, 50, 60],
  );
});

test("collectRecognizedLines translates segment coordinates and falls back to block frame", () => {
  const canvas = canvasOf(4, 6);
  setPixel(canvas, 4, 2, 3, [180, 220, 179, 255]);
  setPixel(canvas, 4, 0, 4, [250, 250, 250, 255]);
  const result = {
    blocks: [{
      frame: { left: 0, top: 2, width: 1, height: 1 },
      lines: [
        { text: "  自己  ", frame: { left: 2, top: 1, width: 1, height: 1 } },
        { text: "对方" },
        { text: "   ", frame: { left: 1, top: 1, width: 1, height: 1 } },
        { text: "坏框", frame: { left: 1, top: 1, width: 0, height: 1 } },
      ],
    }],
  };

  assert.deepEqual(collectRecognizedLines(result, 2, canvas, 4, 6), [
    { text: "自己", x: 2, y: 3, rgb: [180, 220, 179] },
    { text: "对方", x: 0, y: 4, rgb: [250, 250, 250] },
  ]);
});
