const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOcrCacheExport,
  cacheFileName,
  toCacheLine,
  utf8ByteLength,
} = require("../src/ocr-cache-format");

test("device OCR cache uses the verifier's per-frame JSON shape", () => {
  const built = buildOcrCacheExport({
    fps: 4,
    sourceFrameCount: 2,
    frameWidth: 720,
    frameHeight: 1600,
    frames: [
      {
        name: "f_0001.jpg",
        sourceIndex: 0,
        timeMs: 0,
        lines: [{ text: "牛", x: 10, y: 20, w: 30, h: 40, conf: null }],
      },
      {
        name: "f_0002.jpg",
        sourceIndex: 1,
        timeMs: 250,
        lines: [{ text: "第二帧", x: 11, y: 21, w: 31, h: 41 }],
      },
    ],
  }, {
    app: "wechat",
    stride: 3,
    timings: { total: 1234 },
    stats: { anchorPassedCount: 1 },
    warnings: [],
  });

  assert.deepEqual(JSON.parse(built.entries[0].content), [{
    text: "牛", x: 10, y: 20, w: 30, h: 40, conf: null,
  }]);
  assert.deepEqual(built.entries.map(entry => [entry.directory, entry.name]), [
    ["ocr", "f_0001.json"],
    ["ocr", "f_0002.json"],
    ["meta", "stats.json"],
    ["", "M3-OCR-BUNDLE.json"],
  ]);
  assert.equal(built.bundle.stats.capturesEverySourceFrame, true);
  assert.equal(built.bundle.stats.confidence, "partial-or-unavailable-null");
  assert.equal(built.bundle.stats.confidenceNullCount, 2);
});

test("cache formatter rejects invalid geometry and keeps one-character messages", () => {
  assert.deepEqual(toCacheLine({
    text: "牛", x: 1, y: 2, w: 3, h: 4, conf: 0.75,
  }), {
    text: "牛", x: 1, y: 2, w: 3, h: 4, conf: 0.75,
  });
  assert.throws(
    () => toCacheLine({ text: "缺坐标", x: 1, y: 2, w: 3 }),
    /缺少 text\/x\/y\/w\/h/,
  );
  assert.equal(cacheFileName("f_0128.jpg"), "f_0128.json");
});

test("utf8ByteLength counts ASCII, CJK, and supplementary code points", () => {
  assert.equal(utf8ByteLength("A牛😀"), 8);
});

test("device bundle importer accepts the generated schema", async () => {
  const { validateDeviceOcrBundle } = await import(
    "../verify/import-device-ocr.mjs"
  );
  const built = buildOcrCacheExport({
    fps: 4,
    sourceFrameCount: 1,
    frameWidth: 720,
    frameHeight: 1600,
    frames: [{
      name: "f_0001.jpg",
      sourceIndex: 0,
      timeMs: 0,
      lines: [{ text: "牛", x: 1, y: 2, w: 3, h: 4, conf: 0.9 }],
    }],
  }, { app: "wechat", stride: 3 });

  assert.equal(validateDeviceOcrBundle(built.bundle).frames.length, 1);
});

test("device bundle importer rejects an incomplete or discontinuous capture", async () => {
  const { validateDeviceOcrBundle } = await import(
    "../verify/import-device-ocr.mjs"
  );
  const built = buildOcrCacheExport({
    fps: 4,
    sourceFrameCount: 2,
    frameWidth: 720,
    frameHeight: 1600,
    frames: [
      {
        name: "f_0001.jpg",
        sourceIndex: 0,
        timeMs: 0,
        lines: [{ text: "第一帧", x: 1, y: 2, w: 3, h: 4, conf: 0.9 }],
      },
      {
        name: "f_0002.jpg",
        sourceIndex: 1,
        timeMs: 250,
        lines: [{ text: "第二帧", x: 1, y: 2, w: 3, h: 4, conf: 0.9 }],
      },
    ],
  }, { app: "plain", stride: 3 });
  const incomplete = structuredClone(built.bundle);
  incomplete.frames.pop();
  incomplete.stats.capturedFrameCount = 1;
  incomplete.stats.capturesEverySourceFrame = false;

  assert.throws(
    () => validateDeviceOcrBundle(incomplete),
    /完整连续/,
  );

  const discontinuous = structuredClone(built.bundle);
  discontinuous.frames[1].sourceIndex = 2;
  discontinuous.frames[1].file = "f_0003.json";
  assert.throws(
    () => validateDeviceOcrBundle(discontinuous),
    /帧序列不连续/,
  );
});
