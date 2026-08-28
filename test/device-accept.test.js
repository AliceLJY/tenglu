const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(process.cwd(), "verify", "device-accept.mjs");
const TIMINGS = [
  "选定帧抽取: 100 ms",
  "逐帧 ML Kit OCR: 200 ms",
  "UI 让出: 1 ms",
  "固定 UI / 锚点 / 去重: 2 ms",
  "歧义气泡局部采样: 3 ms",
  "Markdown: 1 ms",
  "临时文件清理: 1 ms",
  "总耗时: 310 ms",
].join("\n");

function report(mode, markdown = "hello") {
  return [
    "路径: 文本锚点（M3）",
    "请求路径: 文本锚点（M3）",
    "状态: ok",
    `模式: ${mode}`,
    "",
    "耗时:",
    TIMINGS,
    "计时对账: 通过",
    "",
    "统计:",
    JSON.stringify({
      app: mode === "微信" ? "wechat" : "generic",
      durationMs: 1000,
      screenAwakeRequested: true,
      anchorPairCount: 15,
      anchorPassedCount: 15,
      sampleRegionCount: 13,
      sampleUnresolvedCount: 0,
      decodedPixels: 200000,
      frameExtractionMethod: "MediaMetadataRetriever.OPTION_CLOSEST",
      timingDeltaMs: 2,
      timingThresholdMs: 100,
    }, null, 2),
    "",
    "还原告警:",
    "无",
    "",
    "----- BEGIN MARKDOWN -----",
    markdown,
    "----- END MARKDOWN -----",
  ].join("\n");
}

function tempFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test("device acceptance validates a full M3 report before byte comparison", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenglu-accept-"));
  const baseline = tempFile(dir, "baseline.md", "hello");
  const candidate = tempFile(dir, "report.txt", report("微信"));
  const output = path.join(dir, "candidate.md");
  const run = spawnSync(process.execPath, [
    SCRIPT,
    baseline,
    candidate,
    "--expect-mode",
    "wechat",
    "--out",
    output,
  ], { encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /candidate_source: full-report/);
  assert.match(run.stdout, /report_status: ok/);
  assert.match(run.stdout, /anchor_selfcheck: 15\/15/);
  assert.match(run.stdout, /byte_equal: true/);
  assert.equal(fs.readFileSync(output, "utf8"), "hello");
});

test("device acceptance rejects a bare Markdown paste by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenglu-accept-"));
  const baseline = tempFile(dir, "baseline.md", "hello");
  const candidate = tempFile(dir, "candidate.md", "hello");
  const run = spawnSync(process.execPath, [SCRIPT, baseline, candidate], {
    encoding: "utf8",
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /不是完整验收报告/);
});

test("device acceptance can extract XHS without inventing a byte baseline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenglu-accept-"));
  const candidate = tempFile(dir, "report.txt", report("通用", "甲\n乙"));
  const run = spawnSync(process.execPath, [
    SCRIPT,
    candidate,
    "--extract-only",
    "--expect-mode",
    "generic",
  ], { encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /candidate_lines: 2/);
  assert.match(run.stdout, /candidate_characters: 3/);
  assert.doesNotMatch(run.stdout, /byte_equal:/);
});
