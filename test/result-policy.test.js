const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANCHOR_WARNING_MESSAGE,
  ANCHOR_WARNING_TITLE,
  anchorResultStatus,
  anchorWarningNotice,
  defaultEngineForPlatform,
  shouldFailEmptyAnchorOutput,
  shouldOfferStitchRetry,
  stitchRetryRequest,
} = require("../src/result-policy");

test("Android defaults to text anchors while iOS remains on stitching", () => {
  assert.equal(defaultEngineForPlatform("android"), "anchor");
  assert.equal(defaultEngineForPlatform("ios"), "stitch");
});

test("anchor warning offers a plain-language stitching retry", () => {
  const result = { engine: "anchor", status: "warning", stats: {} };

  assert.equal(shouldOfferStitchRetry(result), true);
  assert.deepEqual(anchorWarningNotice(result), {
    title: ANCHOR_WARNING_TITLE,
    message: ANCHOR_WARNING_MESSAGE,
  });
  assert.match(ANCHOR_WARNING_TITLE, /部分内容可能缺失/);
  assert.match(ANCHOR_WARNING_MESSAGE, /建议用拼接路径重新处理/);
  assert.doesNotMatch(
    `${ANCHOR_WARNING_TITLE}${ANCHOR_WARNING_MESSAGE}`,
    /锚点|投票|占比|RGB/,
  );
});

test("unresolved speakers offer the retry even if status aggregation regresses", () => {
  assert.equal(shouldOfferStitchRetry({
    engine: "anchor",
    status: "ok",
    stats: { sampleUnresolvedCount: 2 },
  }), true);
});

test("healthy anchor and stitching results do not offer a stitching retry", () => {
  assert.equal(shouldOfferStitchRetry({
    engine: "anchor",
    status: "ok",
    stats: { sampleUnresolvedCount: 0 },
  }), false);
  assert.equal(shouldOfferStitchRetry({
    engine: "stitch",
    status: "warning",
    stats: { sampleUnresolvedCount: 2 },
  }), false);
});

test("stitch retry preserves the original asset and mode", () => {
  const asset = { uri: "file:///recording.mp4", duration: 27000 };

  assert.deepEqual(stitchRetryRequest({ asset, mode: "wechat" }), {
    asset,
    mode: "wechat",
    engine: "stitch",
  });
  assert.equal(stitchRetryRequest(null), null);
});

test("all unresolved bubbles stay a warning instead of becoming a failure", () => {
  const warnings = ["气泡 1 底色未判定，该气泡未输出。"];

  assert.equal(shouldFailEmptyAnchorOutput("", warnings), false);
  assert.equal(anchorResultStatus(warnings, ""), "warning");
  assert.equal(shouldFailEmptyAnchorOutput("", []), true);
});
