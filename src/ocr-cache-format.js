const OCR_CACHE_FORMAT_VERSION = 1;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function cacheFileName(frameName) {
  const name = String(frameName ?? "");
  if (!/^f_\d{4}\.(?:jpe?g|png)$/i.test(name)) {
    throw new Error(`OCR 缓存帧名无效：${name || "（空）"}`);
  }
  return name.replace(/\.(?:jpe?g|png)$/i, ".json");
}

function toCacheLine(line) {
  const output = {
    text: String(line?.text ?? ""),
    x: finiteOrNull(line?.x),
    y: finiteOrNull(line?.y),
    w: finiteOrNull(line?.w),
    h: finiteOrNull(line?.h),
    // The install-time Android bridge patch exposes ML Kit's real value. Keep
    // null as an explicit fallback rather than inventing confidence.
    conf: finiteOrNull(line?.conf),
  };
  if (!output.text || [output.x, output.y, output.w, output.h].includes(null)) {
    throw new Error("OCR 缓存行缺少 text/x/y/w/h");
  }
  return output;
}

function buildOcrCacheExport(capture, runSummary = {}) {
  if (!capture || !Array.isArray(capture.frames) || !capture.frames.length) {
    throw new Error("没有可导出的逐帧 OCR 数据");
  }
  const seen = new Set();
  const frames = capture.frames.map(frame => {
    const file = cacheFileName(frame.name);
    if (seen.has(file)) throw new Error(`OCR 缓存帧名重复：${file}`);
    seen.add(file);
    return {
      file,
      sourceIndex: frame.sourceIndex,
      timeMs: frame.timeMs,
      lines: (frame.lines ?? []).map(toCacheLine),
    };
  });
  const allLines = frames.flatMap(frame => frame.lines);
  const confidenceNullCount = allLines.filter(line => line.conf === null).length;
  const stats = {
    formatVersion: OCR_CACHE_FORMAT_VERSION,
    cacheLayout: "one-json-array-per-frame",
    confidence: confidenceNullCount
      ? "partial-or-unavailable-null"
      : "mlkit-line-confidence",
    confidenceNullCount,
    ocrLineCount: allLines.length,
    fps: capture.fps,
    sourceFrameCount: capture.sourceFrameCount,
    capturedFrameCount: frames.length,
    capturesEverySourceFrame: frames.length === capture.sourceFrameCount,
    frameWidth: capture.frameWidth,
    frameHeight: capture.frameHeight,
    app: runSummary.app,
    processingStride: runSummary.stride,
    timings: runSummary.timings,
    resultStats: runSummary.stats,
    warnings: runSummary.warnings ?? [],
  };
  const bundle = {
    formatVersion: OCR_CACHE_FORMAT_VERSION,
    stats,
    frames,
  };
  const entries = frames.map(frame => ({
    directory: "ocr",
    name: frame.file,
    content: `${JSON.stringify(frame.lines, null, 2)}\n`,
  }));
  entries.push({
    directory: "meta",
    name: "stats.json",
    content: `${JSON.stringify(stats, null, 2)}\n`,
  });
  entries.push({
    directory: "",
    name: "M3-OCR-BUNDLE.json",
    content: `${JSON.stringify(bundle, null, 2)}\n`,
  });
  return { bundle, entries };
}

module.exports = {
  OCR_CACHE_FORMAT_VERSION,
  buildOcrCacheExport,
  cacheFileName,
  toCacheLine,
  utf8ByteLength,
};
