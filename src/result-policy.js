const DEFAULT_ANDROID_ENGINE = "anchor";
const FALLBACK_ENGINE = "stitch";
const ANCHOR_WARNING_TITLE = "部分内容可能缺失";
const ANCHOR_WARNING_MESSAGE =
  "这次还原可能漏掉内容或无法确定发言人，建议用拼接路径重新处理。";

function defaultEngineForPlatform(platform) {
  return platform === "android" ? DEFAULT_ANDROID_ENGINE : FALLBACK_ENGINE;
}

function shouldOfferStitchRetry(result) {
  if (!result || result.engine !== "anchor") return false;
  return result.status === "warning" ||
    Number(result.stats?.sampleUnresolvedCount) > 0;
}

function anchorWarningNotice(result) {
  if (!shouldOfferStitchRetry(result)) return null;
  return {
    title: ANCHOR_WARNING_TITLE,
    message: ANCHOR_WARNING_MESSAGE,
  };
}

function stitchRetryRequest(lastRun) {
  if (!lastRun?.asset || !lastRun?.mode) return null;
  return {
    asset: lastRun.asset,
    mode: lastRun.mode,
    engine: FALLBACK_ENGINE,
  };
}

function shouldFailEmptyAnchorOutput(markdown, speakerWarnings) {
  return !String(markdown ?? "").trim() && !(speakerWarnings?.length > 0);
}

function anchorResultStatus(warnings, timingWarning) {
  return warnings?.length || timingWarning ? "warning" : "ok";
}

module.exports = {
  ANCHOR_WARNING_MESSAGE,
  ANCHOR_WARNING_TITLE,
  DEFAULT_ANDROID_ENGINE,
  FALLBACK_ENGINE,
  anchorResultStatus,
  anchorWarningNotice,
  defaultEngineForPlatform,
  shouldFailEmptyAnchorOutput,
  shouldOfferStitchRetry,
  stitchRetryRequest,
};
