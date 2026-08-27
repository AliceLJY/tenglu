const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyBubbleColor,
  dedupeSpatialLines,
  formatPlainMarkdown,
  formatWechatMarkdown,
  groupPlainLines,
  groupWechatMessages,
} = require("../src/postprocess");

test("spatial dedupe uses strict position thresholds and keeps longer OCR text", () => {
  const duplicate = dedupeSpatialLines([
    { text: "是", x: 100, y: 100 },
    { text: "是的", x: 139, y: 119 },
  ]);
  const yBoundary = dedupeSpatialLines([
    { text: "first", x: 100, y: 100 },
    { text: "second", x: 100, y: 120 },
  ]);
  const xBoundary = dedupeSpatialLines([
    { text: "first", x: 100, y: 100 },
    { text: "second", x: 140, y: 100 },
  ]);

  assert.deepEqual(duplicate.map(line => line.text), ["是的"]);
  assert.equal(yBoundary.length, 2);
  assert.equal(xBoundary.length, 2);
});

test("plain mode groups only rows with |dy| < 18 and sorts each row by x", () => {
  const grouped = groupPlainLines([
    { text: "后", x: 80, y: 117 },
    { text: "先", x: 10, y: 100 },
    { text: "新行", x: 5, y: 118 },
  ]);

  assert.deepEqual(grouped, ["先 后", "新行"]);
});

test("plain Markdown applies spatial and final textual dedupe", () => {
  const markdown = formatPlainMarkdown([
    { text: "一条足够长的重复内容", x: 10, y: 0 },
    { text: "一条足够长的重复内容", x: 10, y: 40 },
    { text: "保留", x: 10, y: 80 },
  ]);

  assert.equal(markdown, "一条足够长的重复内容\n保留");
});

test("bubble color accepts array/object RGB and keeps strict green threshold", () => {
  assert.equal(classifyBubbleColor([180, 220, 179]), "self");
  assert.equal(classifyBubbleColor({ r: 180, g: 220, b: 180 }), "system");
  assert.equal(classifyBubbleColor({ r: 250, g: 249, b: 247 }), "other");
  assert.equal(classifyBubbleColor({ r: 245, g: 255, b: 255 }), "system");
  assert.equal(classifyBubbleColor({ r: 237, g: 237, b: 237 }), "system");
  assert.equal(classifyBubbleColor(null), "system");
});

test("WeChat drops system lines and merges same bubble inside strict bounds", () => {
  const messages = groupWechatMessages([
    { text: "第一", x: 400, y: 100, rgb: [180, 220, 179] },
    { text: "行", x: 459, y: 161, rgb: [180, 220, 179] },
    { text: "系统时间", x: 300, y: 180, rgb: [210, 210, 210] },
    { text: "昨天 12:34", x: 300, y: 185, rgb: [250, 250, 250] },
    { text: "对方", x: 30, y: 200, rgb: [250, 250, 250] },
  ]);

  assert.deepEqual(messages.map(({ side, text }) => ({ side, text })), [
    { side: "self", text: "第一行" },
    { side: "other", text: "对方" },
  ]);
});

test("WeChat multiline x distance stays anchored to the bubble's first line", () => {
  const messages = groupWechatMessages([
    { text: "A", x: 400, y: 100, rgb: [180, 220, 179] },
    { text: "B", x: 450, y: 130, rgb: [180, 220, 179] },
    { text: "C", x: 500, y: 160, rgb: [180, 220, 179] },
  ]);

  assert.deepEqual(messages.map(message => message.text), ["AB", "C"]);
});

test("WeChat bubble merge does not include dy=62 or |dx|=60", () => {
  const messages = groupWechatMessages([
    { text: "A", x: 400, y: 100, rgb: [180, 220, 179] },
    { text: "B", x: 400, y: 162, rgb: [180, 220, 179] },
    { text: "C", x: 460, y: 170, rgb: [180, 220, 179] },
  ]);

  assert.deepEqual(messages.map(message => message.text), ["A", "B", "C"]);
});

test("WeChat Markdown emits score.py speaker labels and dedupes only within a side", () => {
  const longText = "同一句足够长的消息";
  const markdown = formatWechatMarkdown([
    { text: longText, x: 400, y: 0, rgb: [180, 220, 179] },
    { text: longText, x: 400, y: 100, rgb: [180, 220, 179] },
    { text: longText, x: 20, y: 200, rgb: [250, 250, 250] },
  ]);

  assert.equal(markdown, `[我] ${longText}\n[对方] ${longText}`);
});
