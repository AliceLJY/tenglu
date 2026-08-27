const { dedupeLines } = require("./stitcher");

const SPATIAL_Y = 20;
const SPATIAL_X = 40;
const PLAIN_ROW_Y = 18;
const WECHAT_BUBBLE_Y = 62;
const WECHAT_BUBBLE_X = 60;
const WECHAT_TIME = /^(昨天\s*)?\d{1,2}[:：]\d{2}$/;

function normalizeLine(line) {
  if (!line || typeof line.text !== "string") return null;
  const text = line.text.trim();
  if (!text) return null;
  const x = Number(line.x);
  const y = Number(line.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { ...line, text, x, y };
}

function textLength(line) {
  return Array.from(line.text).length;
}

/**
 * Remove duplicate OCR lines created by the 200px overlap between OCR segments.
 * Position, not text equality, defines a duplicate; the longer recognition wins.
 */
function dedupeSpatialLines(lines) {
  const sorted = (lines ?? [])
    .map(normalizeLine)
    .filter(Boolean)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const line of sorted) {
    const hit = out.findIndex(existing =>
      Math.abs(existing.y - line.y) < SPATIAL_Y &&
      Math.abs(existing.x - line.x) < SPATIAL_X,
    );
    if (hit < 0) {
      out.push(line);
    } else if (textLength(line) > textLength(out[hit])) {
      out[hit] = line;
    }
  }
  return out;
}

function rgbChannels(rgb) {
  if (Array.isArray(rgb) || ArrayBuffer.isView(rgb)) {
    return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
  }
  if (rgb && typeof rgb === "object") {
    return [Number(rgb.r), Number(rgb.g), Number(rgb.b)];
  }
  return [NaN, NaN, NaN];
}

/** Classify the median bright-pixel RGB sampled from behind an OCR text block. */
function classifyBubbleColor(rgb, opts = {}) {
  const [r, g, b] = rgbChannels(rgb);
  if (![r, g, b].every(Number.isFinite)) return "system";
  if (g - b > 40) return "self";

  // The verified reference uses a strict >245 check on every channel.
  // A looser neutral-gray rule turns WeChat timestamps into fake messages.
  const whiteFloor = opts.whiteFloor ?? 245;
  if (r > whiteFloor && g > whiteFloor && b > whiteFloor) {
    return "other";
  }
  return "system";
}

/** Group plain-mode OCR blocks into visual rows. */
function groupPlainLines(lines) {
  const sorted = (lines ?? [])
    .map(normalizeLine)
    .filter(Boolean)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const line of sorted) {
    const row = rows[rows.length - 1];
    if (!row || Math.abs(line.y - row.anchorY) >= PLAIN_ROW_Y) {
      rows.push({ anchorY: line.y, parts: [line] });
    } else {
      row.parts.push(line);
    }
  }
  return rows.map(row => row.parts.sort((a, b) => a.x - b.x).map(part => part.text).join(" "));
}

function formatPlainMarkdown(lines) {
  const spatiallyDeduped = dedupeSpatialLines(lines);
  return dedupeLines(groupPlainLines(spatiallyDeduped)).join("\n");
}

/** Classify and merge consecutive OCR lines that belong to the same WeChat bubble. */
function groupWechatMessages(lines) {
  const sorted = (lines ?? [])
    .map(normalizeLine)
    .filter(Boolean)
    .map(line => ({ ...line, side: classifyBubbleColor(line.rgb) }))
    .filter(line => line.side !== "system" && !WECHAT_TIME.test(line.text))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const messages = [];
  for (const line of sorted) {
    const current = messages[messages.length - 1];
    const dy = current ? line.y - current.lastY : Infinity;
    const dx = current ? Math.abs(line.x - current.x) : Infinity;
    if (current && current.side === line.side && dy >= 0 && dy < WECHAT_BUBBLE_Y && dx < WECHAT_BUBBLE_X) {
      current.text += line.text;
      current.lastY = line.y;
    } else {
      messages.push({
        side: line.side,
        text: line.text,
        x: line.x,
        y: line.y,
        lastY: line.y,
      });
    }
  }
  return messages;
}

function formatWechatMarkdown(lines) {
  const messages = groupWechatMessages(dedupeSpatialLines(lines));

  // Include a one-character side key so dedupeLines never removes the same text
  // spoken by different people. Raising minLen by one preserves its 8-char rule.
  const deduped = dedupeLines(
    messages.map(message => `${message.side === "self" ? "M" : "T"}${message.text}`),
    { minLen: 9 },
  );
  return deduped.map(encoded => {
    const who = encoded[0] === "M" ? "我" : "对方";
    return `[${who}] ${encoded.slice(1)}`;
  }).join("\n");
}

module.exports = {
  classifyBubbleColor,
  dedupeSpatialLines,
  formatPlainMarkdown,
  formatWechatMarkdown,
  groupPlainLines,
  groupWechatMessages,
};
