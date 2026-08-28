const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeAnchorFrames,
  checkAnchors,
  clusterVote,
  collectFrameLines,
  dedupePlacedLines,
  finalizeWechatMessages,
  findFixedBands,
  makeRegionRequests,
  prepareWechatMessages,
  renderPlain,
} = require("../src/anchor-utils");

function line(text, x, y, w = 100, h = 30, frameIndex = 0, gy = y) {
  return { text, x, y, w, h, frameIndex, gy };
}

test("ML Kit collector keeps local x/y/w/h and the compact frame index", () => {
  const lines = collectFrameLines({
    blocks: [{
      frame: { left: 1, top: 2, width: 3, height: 4 },
      lines: [
        { text: " 第一行 ", frame: { left: 10, top: 20, width: 30, height: 40 } },
        { text: "回退 block frame" },
      ],
    }],
  }, 2);

  assert.deepEqual(lines, [
    { text: "第一行", x: 10, y: 20, w: 30, h: 40, frameIndex: 2 },
    { text: "回退 block frame", x: 1, y: 2, w: 3, h: 4, frameIndex: 2 },
  ]);
});

test("fixed UI uses 20px bands and includes the exact 80 percent boundary", () => {
  const frames = Array.from({ length: 5 }, (_, index) => ({
    lines: index < 4 ? [line("标题", 10, 101 + index)] : [],
  }));
  const fixed = findFixedBands(frames);

  assert.equal(fixed.has(5), true);
});

test("shift voting chains adjacent differences within 3px and uses the median", () => {
  assert.deepEqual(clusterVote([20, 26, 23, 100]), {
    shift: 23,
    votes: 3,
    total: 4,
  });
});

test("anchor self-check distinguishes zero, sparse, and dispersed votes", () => {
  const warnings = checkAnchors([
    { from: "a", to: "b", total: 0, votes: 0 },
    { from: "b", to: "c", total: 2, votes: 2 },
    { from: "c", to: "d", total: 5, votes: 1 },
    { from: "d", to: "e", total: 5, votes: 2 },
  ]);

  assert.equal(warnings.length, 3);
  assert.match(warnings[0].reasons[0], /锚点 0/);
  assert.match(warnings[1].reasons[0], /锚点仅 2/);
  assert.match(warnings[2].reasons[0], /20%/);
});

test("unreliable shift paths prevent cross-frame box dedupe", () => {
  const lines = [
    line("是", 100, 100, 40, 20, 0, 100),
    line("是的", 100, 80, 40, 20, 1, 100),
  ];
  const reliable = dedupePlacedLines(lines, [
    { total: 3, votes: 2 },
  ]);
  const unreliable = dedupePlacedLines(lines, [
    { total: 2, votes: 2 },
  ]);

  assert.deepEqual(reliable.map(item => item.text), ["是的"]);
  assert.deepEqual(unreliable.map(item => item.text), ["是", "是的"]);
});

test("full analysis keeps compact frame indexes across a reliable shift", () => {
  const fixed = line("固定标题", 10, 100, 100, 20);
  const first = [
    fixed,
    line("共同文本甲乙", 100, 500, 100, 20),
    line("共同文本丙丁", 100, 650, 100, 20),
    line("共同文本戊己", 100, 800, 100, 20),
  ];
  const second = first.map(item => ({
    ...item,
    y: item.y === 100 ? 100 : item.y - 100,
    frameIndex: 1,
  }));
  const result = analyzeAnchorFrames([
    { name: "f_0001.jpg", lines: first },
    { name: "f_0008.jpg", lines: second },
  ]);

  assert.equal(result.shifts[0].shift, 100);
  assert.equal(result.anchorWarnings.length, 0);
  assert.equal(result.uniqueLines.length, 3);
});

test("double-peak bubble requests only its largest row using local y", () => {
  const lines = [
    line("左侧消息", 134, 100, 100, 30, 0, 100),
    line("双贴峰消息", 134, 200, 451, 40, 1, 900),
    line("右侧消息", 485, 300, 100, 30, 1, 1000),
  ];
  const prepared = prepareWechatMessages(lines);
  const requests = makeRegionRequests(prepared, ["file:///f1.jpg", "file:///f2.jpg"]);

  assert.equal(prepared.sampleRows.length, 1);
  assert.deepEqual(requests, [{
    id: "bubble-1",
    groupIndex: 1,
    frameIndex: 1,
    uri: "file:///f2.jpg",
    x: 134,
    y: 200,
    width: 451,
    height: 40,
  }]);
});

test("pixel result resolves a double peak without coordinate priors", () => {
  const prepared = prepareWechatMessages([
    line("左侧消息", 134, 100, 100, 30),
    line("双贴峰消息", 134, 200, 451, 40),
    line("右侧消息", 485, 300, 100, 30),
  ]);
  const rendered = finalizeWechatMessages(prepared, [{
    id: "bubble-1",
    side: "me",
    rgb: [180, 220, 170],
    decodedPixels: 18040,
    sampledPixels: 18040,
  }]);

  assert.equal(rendered.markdown, [
    "[对方] 左侧消息",
    "[我] 双贴峰消息",
    "[我] 右侧消息",
  ].join("\n"));
  assert.equal(rendered.speakerStats.pixelResolved, 1);
  assert.equal(rendered.speakerStats.decodedPixels, 18040);
});

test("unknown bubble color emits a warning and never guesses a speaker", () => {
  const prepared = prepareWechatMessages([
    line("左侧消息", 134, 100, 100, 30),
    line("双贴峰消息", 134, 200, 451, 40),
    line("右侧消息", 485, 300, 100, 30),
  ]);
  const rendered = finalizeWechatMessages(prepared, [{
    id: "bubble-1",
    side: null,
    rgb: [230, 230, 230],
    decodedPixels: 18040,
  }]);

  assert.equal(rendered.markdown.includes("双贴峰消息"), false);
  assert.equal(rendered.speakerWarnings.length, 1);
  assert.match(rendered.speakerWarnings[0], /底色未判定/);
  assert.equal(rendered.speakerStats.pixelUnresolved, 1);
});

test("plain output groups only rows whose global y gap is below 18px", () => {
  assert.equal(renderPlain([
    line("先", 10, 0, 10, 10, 0, 100),
    line("后", 80, 0, 10, 10, 0, 117),
    line("新行", 5, 0, 10, 10, 0, 118),
  ]), "先 后\n新行");
});
