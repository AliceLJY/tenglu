#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

const BEGIN = "----- BEGIN MARKDOWN -----\n";
const END = "\n----- END MARKDOWN -----";

function usage() {
  console.error(
    "用法:\n" +
    "  node device-accept.mjs <基线.md> <M3完整报告> [--expect-mode wechat|generic] [--out M3.md]\n" +
    "  node device-accept.mjs <M3完整报告> --extract-only [--expect-mode wechat|generic] [--out M3.md]\n" +
    "  裸 Markdown、warning/failed 报告仅供调试，须显式加对应 --allow-* 参数。",
  );
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function extractMarkdown(buffer, allowMarkdown) {
  const text = buffer.toString("utf8");
  const start = text.indexOf(BEGIN);
  if (start < 0) {
    if (allowMarkdown) return { buffer, fromReport: false, reportText: null };
    throw new Error("候选文件不是完整验收报告；请用 App 的“复制完整验收报告”。");
  }
  const contentStart = start + BEGIN.length;
  const end = text.indexOf(END, contentStart);
  if (end < 0) throw new Error("验收报告缺少 Markdown 结束标记");
  return {
    buffer: Buffer.from(text.slice(contentStart, end), "utf8"),
    fromReport: true,
    reportText: text,
  };
}

function validateReport(text, expectedMode, allowWarning, allowFailed) {
  const field = name => text.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
  const path = field("路径");
  const requestedPath = field("请求路径");
  const status = field("状态");
  const mode = field("模式");
  if (path !== "文本锚点（M3）" || requestedPath !== "文本锚点（M3）") {
    throw new Error("报告不是 M3 文本锚点路径的结果");
  }
  if (!new Set(["ok", "warning", "failed"]).has(status)) {
    throw new Error("报告缺少有效状态");
  }
  if (status === "failed" && !allowFailed) {
    throw new Error("报告状态为 failed；验收默认拒绝，诊断解析须显式加 --allow-failed");
  }
  if (status === "warning" && !allowWarning) {
    throw new Error("报告状态为 warning；验收默认拒绝，诊断解析须显式加 --allow-warning");
  }
  const expectedLabel = expectedMode === "wechat"
    ? "微信"
    : expectedMode === "generic" ? "通用" : null;
  if (expectedMode && !expectedLabel) {
    throw new Error("--expect-mode 只接受 wechat 或 generic");
  }
  if (!mode || (expectedLabel && mode !== expectedLabel)) {
    throw new Error(`报告模式不符：预期 ${expectedLabel ?? "微信/通用"}，实际 ${mode ?? "缺失"}`);
  }

  const timingLabels = [
    "精确帧抽取",
    "逐帧 ML Kit OCR",
    "UI 让出",
    "固定 UI / 锚点 / 去重",
    "歧义气泡局部采样",
    "Markdown",
    "临时文件清理",
    "总耗时",
  ];
  for (const label of timingLabels) {
    if (!new RegExp(`^${label}: (?:\\d+ ms|未完成)$`, "m").test(text)) {
      throw new Error(`报告缺少耗时项：${label}`);
    }
  }
  if (!/^计时(?:对账: 通过|告警: .+)$/m.test(text)) {
    throw new Error("报告缺少计时对账结果");
  }

  const statsMatch = text.match(/\n统计:\n([\s\S]*?)\n\n还原告警:\n/);
  if (!statsMatch) throw new Error("报告缺少统计 JSON 或告警段");
  let stats;
  try {
    stats = JSON.parse(statsMatch[1]);
  } catch {
    throw new Error("报告统计 JSON 无法解析");
  }
  for (const key of ["app", "durationMs", "screenAwakeRequested"]) {
    if (!(key in stats)) throw new Error(`报告统计缺少 ${key}`);
  }
  if (status !== "failed") {
    for (const key of [
      "fps",
      "anchorPairCount",
      "anchorPassedCount",
      "anchorDetails",
      "stride",
      "maxAnchorGapMs",
      "sourceFrameCount",
      "extractedFrameCount",
      "frameCount",
      "ocrCaptureEnabled",
      "ocrCapturedFrameCount",
      "dedupeCandidateGroups",
      "dedupeMajorityChosen",
      "dedupeChangedSelection",
      "sampleRegionCount",
      "sampleUnresolvedCount",
      "decodedPixels",
      "frameExtractionMethod",
      "nativeFrameExtractMs",
      "nativeFrameExtractPerFrameMs",
      "timingDeltaMs",
      "timingThresholdMs",
      "cleanupAttemptCount",
      "remainingTempFileCount",
      "nativeStaleTempFileCount",
      "nativeStaleTempFileDeletedCount",
    ]) {
      if (!(key in stats)) throw new Error(`报告统计缺少 ${key}`);
    }
    const expectedApp = mode === "微信" ? "wechat" : "generic";
    const expectedStride = expectedApp === "wechat" ? 5 : 3;
    const expectedGapMs = expectedStride * 1000 / 4;
    if (stats.app !== expectedApp) {
      throw new Error(`报告统计模式不符：预期 ${expectedApp}，实际 ${stats.app}`);
    }
    if (stats.screenAwakeRequested !== true) {
      throw new Error("报告没有证明处理期间已请求保持屏幕常亮");
    }
    if (stats.frameExtractionMethod !==
        "MediaMetadataRetriever.OPTION_CLOSEST") {
      throw new Error("报告没有使用 MediaMetadataRetriever.OPTION_CLOSEST 精确抽帧");
    }
    if (stats.fps !== 4 || stats.stride !== expectedStride ||
        stats.maxAnchorGapMs !== expectedGapMs) {
      throw new Error(
        `报告不是本批 ${expectedApp} 的 4fps / stride=${expectedStride} / ` +
        `最大间隔 ${expectedGapMs}ms 候选`,
      );
    }
    const expectedSourceFrameCount = Math.max(
      1,
      Math.round(stats.durationMs * stats.fps / 1000),
    );
    if (!Number.isFinite(stats.durationMs) || stats.durationMs <= 0 ||
        stats.sourceFrameCount !== expectedSourceFrameCount) {
      throw new Error(
        `源帧数不符：按 ${stats.durationMs}ms / ${stats.fps}fps 应为 ` +
        `${expectedSourceFrameCount}，实际 ${stats.sourceFrameCount}`,
      );
    }
    const expectedFrameCount = Math.ceil(stats.sourceFrameCount / stats.stride);
    if (stats.frameCount !== expectedFrameCount) {
      throw new Error(
        `处理帧数不符：预期 ${expectedFrameCount}，实际 ${stats.frameCount}`,
      );
    }
    if (stats.ocrCaptureEnabled !== false ||
        stats.extractedFrameCount !== stats.frameCount ||
        stats.ocrCapturedFrameCount !== stats.frameCount) {
      throw new Error("最终性能报告混入了完整 4fps 诊断采集成本");
    }
    const expectedPerFrameMs = stats.extractedFrameCount
      ? Math.round(stats.nativeFrameExtractMs * 10 / stats.extractedFrameCount) / 10
      : null;
    if (!Number.isFinite(stats.nativeFrameExtractPerFrameMs) ||
        Math.abs(stats.nativeFrameExtractPerFrameMs - expectedPerFrameMs) > 0.11) {
      throw new Error("抽帧单帧耗时没有使用实际 native 抽取帧数作分母");
    }
    if (!Array.isArray(stats.anchorDetails) ||
        stats.anchorDetails.length !== stats.anchorPairCount) {
      throw new Error("报告的逐对锚点统计不完整");
    }
    const expectedAnchorPairCount = Math.max(0, stats.frameCount - 1);
    if (stats.anchorPairCount !== expectedAnchorPairCount) {
      throw new Error(
        `相邻帧锚点对数不符：预期 ${expectedAnchorPairCount}，` +
        `实际 ${stats.anchorPairCount}`,
      );
    }
    if (!stats.anchorDetails.every(detail =>
      "fuzzyCandidateVotes" in detail &&
      "fuzzyCandidateTotal" in detail &&
      "fuzzyCandidateVoteRatio" in detail
    )) {
      throw new Error("报告缺少模糊救援的原始候选簇占比");
    }
    if (stats.anchorPassedCount !== stats.anchorPairCount) {
      throw new Error(
        `锚点自检未全过：${stats.anchorPassedCount}/${stats.anchorPairCount}`,
      );
    }
    if (expectedApp === "wechat" &&
        (stats.sampleRegionCount < 1 || stats.sampleUnresolvedCount !== 0)) {
      throw new Error("微信局部采样没有触发，或仍有未定气泡");
    }
    if (stats.remainingTempFileCount !== 0) {
      throw new Error(`报告显示仍残留 ${stats.remainingTempFileCount} 个临时 JPEG`);
    }
    if (stats.nativeStaleTempFileCount !==
        stats.nativeStaleTempFileDeletedCount) {
      throw new Error("报告显示流程启动前的旧临时 JPEG 未全部清理");
    }
  }
  const totalMatch = text.match(/^总耗时: (\d+) ms$/m);
  const totalMs = Number(totalMatch?.[1]);
  if (status !== "failed" && (!Number.isFinite(totalMs) || totalMs > 40_000)) {
    throw new Error(`总耗时 ${totalMs}ms 超过 40000ms 验收线`);
  }
  return { mode, path, requestedPath, stats, status, totalMs };
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function firstDifference(left, right) {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index++) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : common;
}

function lineCount(buffer) {
  if (!buffer.length) return 0;
  return buffer.toString("utf8").split("\n").length -
    (buffer.at(-1) === 0x0a ? 1 : 0);
}

function characterCount(buffer) {
  return Array.from(buffer.toString("utf8")).length;
}

const extractOnly = process.argv.includes("--extract-only");
const allowMarkdown = process.argv.includes("--allow-markdown");
const allowWarning = process.argv.includes("--allow-warning");
const allowFailed = process.argv.includes("--allow-failed");
const baselinePath = extractOnly ? null : process.argv[2];
const candidatePath = extractOnly ? process.argv[2] : process.argv[3];
if (!candidatePath || candidatePath.startsWith("--") ||
    (!extractOnly && (!baselinePath || baselinePath.startsWith("--")))) usage();

try {
  const candidateSource = fs.readFileSync(candidatePath);
  const candidate = extractMarkdown(candidateSource, allowMarkdown);
  const report = candidate.reportText
    ? validateReport(
        candidate.reportText,
        argument("--expect-mode"),
        allowWarning,
        allowFailed,
      )
    : null;
  const outputPath = argument("--out");
  if (outputPath) fs.writeFileSync(outputPath, candidate.buffer);

  console.log(`candidate_source: ${candidate.fromReport ? "full-report" : "markdown"}`);
  if (report) {
    console.log(`report_status: ${report.status}`);
    console.log(`report_mode: ${report.mode}`);
    console.log(`report_total_ms: ${report.totalMs}`);
    if (report.status !== "failed") {
      console.log(
        `anchor_selfcheck: ${report.stats.anchorPassedCount}/${report.stats.anchorPairCount}`,
      );
      console.log(`sample_regions: ${report.stats.sampleRegionCount}`);
      console.log(`sample_unresolved: ${report.stats.sampleUnresolvedCount}`);
      console.log(`decoded_pixels: ${report.stats.decodedPixels}`);
      console.log(`ocr_capture_enabled: ${report.stats.ocrCaptureEnabled}`);
      console.log(`ocr_captured_frames: ${report.stats.ocrCapturedFrameCount}`);
      console.log(`extracted_frames: ${report.stats.extractedFrameCount}`);
      console.log(
        `native_extract_ms_per_frame: ${report.stats.nativeFrameExtractPerFrameMs}`,
      );
      console.log(`dedupe_consensus_changed: ${report.stats.dedupeChangedSelection}`);
      console.log(`timing_delta_ms: ${report.stats.timingDeltaMs}`);
      console.log(`timing_threshold_ms: ${report.stats.timingThresholdMs}`);
      console.log(`remaining_temp_files: ${report.stats.remainingTempFileCount}`);
      console.log(`stale_temp_files_removed: ${report.stats.nativeStaleTempFileDeletedCount}`);
    }
  }
  console.log(`candidate_bytes: ${candidate.buffer.length}`);
  console.log(`candidate_sha256: ${digest(candidate.buffer)}`);
  console.log(`candidate_lines: ${lineCount(candidate.buffer)}`);
  console.log(`candidate_characters: ${characterCount(candidate.buffer)}`);
  if (!extractOnly) {
    const baseline = fs.readFileSync(baselinePath);
    const same = baseline.equals(candidate.buffer);
    console.log(`byte_equal: ${same}`);
    console.log(`baseline_bytes: ${baseline.length}`);
    console.log(`baseline_sha256: ${digest(baseline)}`);
    console.log(`first_diff_byte: ${firstDifference(baseline, candidate.buffer)}`);
  }
  if (outputPath) console.log(`extracted_markdown: ${outputPath}`);
} catch (error) {
  console.error(`验收比对失败：${error.message}`);
  process.exit(1);
}
