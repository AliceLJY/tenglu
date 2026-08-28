const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyBubbleColor } = require("../src/postprocess");

const {
  analyzeAnchorFrames,
  attachWechatNicknameFields,
  checkAnchors,
  clusterVote,
  collectFrameLines,
  dedupePlacedLines,
  dedupePlacedLineGroups,
  estimateShift,
  finalizeWechatMessages,
  findAlignPeaks,
  findFixedBands,
  makeRegionRequests,
  prepareWechatMessages,
  renderPlain,
  textSimilarity,
} = require("../src/anchor-utils");

function line(text, x, y, w = 100, h = 30, frameIndex = 0, gy = y) {
  return { text, x, y, w, h, frameIndex, gy };
}

test("ML Kit collector keeps local x/y/w/h and the compact frame index", () => {
  const lines = collectFrameLines({
    blocks: [{
      frame: { left: 1, top: 2, width: 3, height: 4 },
      lines: [
        {
          text: " 第一行 ",
          confidence: 0.875,
          frame: { left: 10, top: 20, width: 30, height: 40 },
        },
        { text: "回退 block frame" },
      ],
    }],
  }, 2);

  assert.deepEqual(lines, [
    {
      text: "第一行", x: 10, y: 20, w: 30, h: 40,
      conf: 0.875, frameIndex: 2,
    },
    {
      text: "回退 block frame", x: 1, y: 2, w: 3, h: 4,
      conf: null, frameIndex: 2,
    },
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

test("fuzzy anchors require mutual best text and the exact displacement cluster", () => {
  const fixed = new Set();
  const previous = [
    line("完全相同甲乙", 10, 500),
    line("完全相同丙丁", 10, 650),
    line("完全相同戊己", 10, 800),
    line("这是稍微抖动的一条足够长文本", 10, 950),
    line("昨天18:12四川回复", 10, 1100),
  ];
  const current = [
    line("完全相同甲乙", 10, 400, 100, 30, 1),
    line("完全相同丙丁", 10, 550, 100, 30, 1),
    line("完全相同戊己", 10, 700, 100, 30, 1),
    line("这是稍微抖动的二条足够长文本", 10, 850, 100, 30, 1),
    line("昨天18:15四川回复", 10, 821, 100, 30, 1),
  ];
  const result = estimateShift(previous, current, fixed);

  assert.equal(textSimilarity("昨天18:12四川回复", "昨天18:15四川回复") >= 0.9, true);
  assert.equal(result.shift, 100);
  assert.equal(result.exactTotal, 3);
  assert.equal(result.fuzzyCandidates, 2);
  assert.equal(result.fuzzyAccepted, 1);
  assert.equal(result.fuzzyRejected, 1);
  assert.equal(result.total, 4);
  assert.equal(result.votes, 4);
});

test("fuzzy-only shift needs three agreeing candidates and rejects a two-line guess", () => {
  const fixed = new Set();
  const previous = [
    line("苹果这条识别文本足够长甲", 10, 500),
    line("香蕉这条识别文本足够长乙", 10, 650),
    line("葡萄这条识别文本足够长丙", 10, 800),
  ];
  const current = previous.map((item, index) => ({
    ...item,
    text: item.text.replace("识", "辨"),
    y: item.y - 120,
    frameIndex: 1,
  }));
  const rescued = estimateShift(previous, current, fixed);
  const insufficient = estimateShift(previous.slice(0, 2), current.slice(0, 2), fixed);
  const exactOnly = estimateShift(previous, current, fixed, { fuzzy: false });

  assert.equal(rescued.shift, 120);
  assert.equal(rescued.fuzzyRescue, true);
  assert.equal(rescued.total, 3);
  assert.equal(insufficient.shift, 0);
  assert.equal(insufficient.total, 0);
  assert.equal(insufficient.fuzzyAccepted, 0);
  assert.equal(exactOnly.total, 0);
});

test("fuzzy-only rescue reports its raw candidate ratio instead of a filtered 100 percent", () => {
  const fixed = new Set();
  const previous = [
    line("苹果这条识别文本足够长甲", 10, 500),
    line("香蕉这条识别文本足够长乙", 10, 650),
    line("葡萄这条识别文本足够长丙", 10, 800),
    line("西瓜这条识别文本足够长丁", 10, 950),
  ];
  const current = previous.map((item, index) => ({
    ...item,
    text: item.text.replace("识", "辨"),
    y: item.y - (index === 3 ? 500 : 120),
    frameIndex: 1,
  }));

  const rescued = estimateShift(previous, current, fixed);

  assert.equal(rescued.shift, 120);
  assert.equal(rescued.fuzzyRescue, true);
  assert.equal(rescued.votes, 3);
  assert.equal(rescued.total, 4);
  assert.equal(rescued.fuzzyCandidateVotes, 3);
  assert.equal(rescued.fuzzyCandidateTotal, 4);
});

test("anchor self-check distinguishes zero, sparse, and dispersed votes", () => {
  const warnings = checkAnchors([
    { from: "a", to: "b", total: 0, votes: 0 },
    { from: "b", to: "c", total: 2, votes: 2 },
    { from: "c", to: "d", total: 5, votes: 1 },
    { from: "d", to: "e", total: 5, votes: 2 },
    {
      from: "e",
      to: "f",
      total: 0,
      votes: 0,
      fuzzyCandidateVotes: 2,
      fuzzyCandidateTotal: 2,
    },
  ]);

  assert.equal(warnings.length, 4);
  assert.match(warnings[0].reasons[0], /锚点 0/);
  assert.match(warnings[1].reasons[0], /锚点仅 2/);
  assert.match(warnings[2].reasons[0], /20%/);
  assert.match(warnings[3].reasons[0], /模糊候选 2 个/);
  assert.doesNotMatch(warnings[3].reasons[0], /明确无重叠/);
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

test("three-frame text consensus can reject a longer insertion without filtering short text", () => {
  const shifts = [
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
  ];
  const noisy = [
    line("连续找我两个", 100, 100, 160, 24, 0, 300),
    line("连续找我两个", 100, 80, 160, 24, 1, 300),
    line("连续找我两个", 100, 60, 160, 24, 2, 300),
    line("连续找我两个的", 100, 40, 170, 24, 3, 300),
  ];
  const consensus = dedupePlacedLineGroups(noisy, shifts);
  const longer = dedupePlacedLineGroups(noisy, shifts, {
    majorityConsensus: false,
  });
  const short = dedupePlacedLines([
    line("牛", 100, 100, 30, 24, 0, 500),
    line("牛", 100, 80, 30, 24, 1, 500),
    line("牛", 100, 60, 30, 24, 2, 500),
    line("牛", 100, 40, 30, 24, 3, 500),
  ], shifts);

  assert.deepEqual(consensus.lines.map(item => item.text), ["连续找我两个"]);
  assert.deepEqual(longer.lines.map(item => item.text), ["连续找我两个的"]);
  assert.equal(consensus.stats.majorityChosen, 1);
  assert.equal(consensus.stats.changedSelection, 1);
  assert.deepEqual(short.map(item => item.text), ["牛"]);
});

test("text consensus cannot replace a longer candidate with an unrelated majority", () => {
  const shifts = [
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
  ];
  const lines = [
    line("展开127条回复", 100, 100, 180, 24, 0, 300),
    line("喵酱爱喝冰雪碧", 100, 80, 180, 24, 1, 300),
    line("喵酱爱喝冰雪碧", 100, 60, 180, 24, 2, 300),
    line("喵酱爱喝冰雪碧", 100, 40, 180, 24, 3, 300),
  ];

  const result = dedupePlacedLineGroups(lines, shifts);

  assert.deepEqual(result.lines.map(item => item.text), ["展开127条回复"]);
  assert.equal(result.stats.majorityChosen, 0);
  assert.equal(result.stats.majorityRejectedUnrelated, 1);
  assert.equal(result.details[0].variantSimilarity, 0);
});

test("text consensus still replaces a one-character insertion in the same line", () => {
  const shifts = [
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
  ];
  const lines = [
    line("张继科也是个渣子", 100, 100, 180, 24, 0, 300),
    line("张继科也是个渣子", 100, 80, 180, 24, 1, 300),
    line("张继科也是个渣子", 100, 60, 180, 24, 2, 300),
    line("张继科料也是个渣子", 100, 40, 190, 24, 3, 300),
  ];

  const result = dedupePlacedLineGroups(lines, shifts);

  assert.deepEqual(result.lines.map(item => item.text), ["张继科也是个渣子"]);
  assert.equal(result.stats.majorityChosen, 1);
  assert.ok(result.details[0].variantSimilarity > 0.8);
  assert.equal(result.details[0].variantEditDistance, 1);
});

test("one-character messages are not treated as a text family by edit distance", () => {
  const shifts = [
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
  ];
  const lines = [
    line("牛", 100, 100, 30, 24, 0, 300),
    line("羊", 100, 80, 30, 24, 1, 300),
    line("羊", 100, 60, 30, 24, 2, 300),
    line("羊", 100, 40, 30, 24, 3, 300),
  ];

  const result = dedupePlacedLineGroups(lines, shifts);

  assert.deepEqual(result.lines.map(item => item.text), ["牛"]);
  assert.equal(result.stats.majorityRejectedUnrelated, 1);
});

test("two of three observations are not enough to replace longer-wins", () => {
  const result = dedupePlacedLineGroups([
    line("是", 100, 100, 40, 20, 0, 100),
    line("是", 100, 80, 40, 20, 1, 100),
    line("是的", 100, 60, 50, 20, 2, 100),
  ], [
    { total: 3, votes: 3 },
    { total: 3, votes: 3 },
  ]);

  assert.deepEqual(result.lines.map(item => item.text), ["是的"]);
  assert.equal(result.stats.majorityChosen, 0);
});

test("same-frame split fragments count as one composed consensus observation", () => {
  const shifts = Array.from({ length: 3 }, () => ({ total: 3, votes: 3 }));
  const result = dedupePlacedLineGroups([
    line("完整回复文本", 100, 100, 160, 20, 0, 300),
    line("完整回复", 100, 80, 80, 20, 1, 300),
    line("文本", 180, 80, 80, 20, 1, 300),
    line("完整回复文本", 100, 60, 160, 20, 2, 300),
    line("完整回复文本", 100, 40, 160, 20, 3, 300),
  ], shifts);

  assert.deepEqual(result.lines.map(item => item.text), ["完整回复文本"]);
  assert.equal(result.stats.frameComposedClusters, 1);
  assert.equal(result.stats.frameObservationCount, 4);
  assert.equal(result.stats.majorityChosen, 1);
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

test("alignment peaks reject middle-screen repeats and one-character fragments", () => {
  const leftMessages = Array.from({ length: 4 }, (_, index) =>
    line(`左侧消息${index}`, 134, 100 + index * 40, 100));
  const rightMessages = Array.from({ length: 4 }, (_, index) =>
    line(`右侧消息${index}`, 485, 300 + index * 40, 100));
  const repeatedMiddleRight = Array.from({ length: 9 }, (_, index) =>
    line(`噪声${index}`, 10 + index, 500 + index * 20, 113 - index));
  const oneCharacterFragments = Array.from({ length: 12 }, (_, index) =>
    line("噪", 250, 700 + index * 20, 20 + index));
  const screenWidthMarker = line("屏幕宽度标尺", 680, 60, 40);

  assert.deepEqual(findAlignPeaks([
    ...leftMessages,
    ...rightMessages,
    ...repeatedMiddleRight,
    ...oneCharacterFragments,
    screenWidthMarker,
  ]), { left: 134, right: 585 });
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

test("group-chat top-row geometry keeps nickname and body as lossless fields", () => {
  const original = {
    rows: [
      line("示例群昵称", 118, 344, 162, 20, 0, 344),
      line("这里是正文", 135, 390, 232, 36, 0, 390),
    ],
    text: "示例群昵称这里是正文",
  };
  const result = attachWechatNicknameFields([original], {
    left: 136,
    right: 585,
  });

  assert.equal(result.candidateCount, 1);
  assert.deepEqual(result.groups[0].nickname, {
    text: "示例群昵称",
    bodyText: "这里是正文",
    kind: "separate-top-line",
  });
  assert.equal(
    result.groups[0].nickname.text + result.groups[0].nickname.bodyText,
    original.text,
  );
});

test("nickname formatting applies only to an independently resolved incoming bubble", () => {
  const groups = attachWechatNicknameFields([{
    rows: [
      line("群昵称", 118, 100, 80, 20),
      line("正文", 136, 150, 80, 28),
    ],
    text: "群昵称正文",
  }], { left: 136, right: 585 }).groups;
  const prepared = {
    groups,
    labels: [null],
    kinds: ["pixel-pending"],
    sampleRows: [{ id: "bubble-0", groupIndex: 0, row: groups[0].rows[1] }],
    nicknameCandidateCount: 1,
  };

  const incoming = finalizeWechatMessages(prepared, [{
    id: "bubble-0", side: "them",
  }]);
  const outgoing = finalizeWechatMessages(prepared, [{
    id: "bubble-0", side: "me",
  }]);

  assert.equal(incoming.markdown, "[群昵称] 正文");
  assert.equal(incoming.speakerStats.nicknameApplied, 1);
  assert.equal(outgoing.markdown, "[我] 群昵称正文");
  assert.equal(outgoing.speakerStats.nicknameApplied, 0);
});

test("nickname metadata leaves the original double-peak sampling box unchanged", () => {
  const prepared = prepareWechatMessages([
    line("左侧基准一", 136, 10, 100, 28),
    line("群昵称", 118, 100, 100, 20),
    line("满宽正文", 136, 150, 449, 34),
    line("左侧基准二", 136, 300, 100, 28),
    line("右侧基准", 485, 400, 100, 28),
  ]);
  const pending = prepared.sampleRows.find(sample =>
    sample.row.text === "满宽正文"
  );
  const requests = makeRegionRequests(prepared, ["file:///frame.jpg"]);

  assert.equal(prepared.nicknameCandidateCount, 1);
  assert.equal(prepared.groups[pending.groupIndex].rows.length, 2);
  assert.equal(pending.row.text, "满宽正文");
  assert.deepEqual(requests.find(request => request.id === pending.id), {
    id: pending.id,
    groupIndex: pending.groupIndex,
    frameIndex: 0,
    uri: "file:///frame.jpg",
    x: 136,
    y: 150,
    width: 449,
    height: 34,
  });
});

test("unclear nickname layouts preserve the complete legacy message", () => {
  const cases = [
    {
      name: "ordinary wrapped body",
      rows: [
        line("正文第一行", 136, 100, 180, 28),
        line("正文第二行", 136, 130, 180, 28),
      ],
    },
    {
      name: "OCR combined nickname and body",
      rows: [line("群昵称正文", 129, 100, 300, 25)],
    },
    {
      name: "tiny OCR fragment before body",
      rows: [
        line("残片", 113, 100, 80, 14),
        line("正文", 136, 143, 80, 28),
      ],
    },
  ];

  for (const sample of cases) {
    const text = sample.rows.map(row => row.text).join("");
    const [annotated] = attachWechatNicknameFields(
      [{ rows: sample.rows, text }],
      { left: 136, right: 585 },
    ).groups;
    assert.equal(annotated.nickname, null, sample.name);
    assert.equal(annotated.text, text, sample.name);
  }
});

test("an internal high-confidence nickname starts a new lossless message group", () => {
  const rows = [
    line("前一条第一行", 129, 100, 449, 23),
    line("前一条第二行", 129, 132, 120, 27),
    line("群昵称", 117, 193, 80, 24),
    line("新正文", 136, 246, 80, 28),
  ];
  const text = rows.map(row => row.text).join("");
  const result = attachWechatNicknameFields(
    [{ rows, text }],
    { left: 136, right: 585 },
  );

  assert.equal(result.internalSplitCount, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].nickname, null);
  assert.equal(result.groups[0].messageSegments.length, 2);
  assert.deepEqual(result.groups[0].messageSegments[1].nickname, {
    text: "群昵称",
    bodyText: "新正文",
    kind: "separate-top-line",
  });
  assert.equal(
    result.groups[0].messageSegments.map(segment => segment.text).join(""),
    text,
  );
  const rendered = finalizeWechatMessages({
    groups: result.groups,
    labels: ["them"],
    kinds: ["definite-left"],
    sampleRows: [],
    nicknameCandidateCount: result.candidateCount,
    nicknameHighConfidenceCount: result.highConfidenceCount,
    nicknameWideBodyCount: result.wideBodyCount,
    nicknameInternalSplitCount: result.internalSplitCount,
  }, []);
  assert.equal(rendered.markdown, [
    "[对方] 前一条第一行前一条第二行",
    "[群昵称] 新正文",
  ].join("\n"));
  assert.equal(attachWechatNicknameFields(
    [{ rows, text }],
    { left: 136, right: 585 },
    { internal: false },
  ).candidateCount, 0);
});

test("wide body boxes use a stricter second geometry tier", () => {
  const rows = [
    line("群昵称", 118, 100, 80, 20),
    line("很长的正文首行", 126, 150, 449, 34),
  ];
  const result = attachWechatNicknameFields(
    [{ rows, text: "群昵称很长的正文首行" }],
    { left: 136, right: 585 },
  );

  assert.equal(result.highConfidenceCount, 0);
  assert.equal(result.wideBodyCount, 1);
  assert.equal(result.groups[0].nickname.kind, "separate-top-line-wide-body");
  assert.equal(attachWechatNicknameFields(
    [{ rows, text: "群昵称很长的正文首行" }],
    { left: 136, right: 585 },
    { wideBody: false },
  ).candidateCount, 0);
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
  assert.equal(rendered.markdown.includes("[我] 双贴峰消息"), false);
  assert.equal(rendered.markdown.includes("[对方] 双贴峰消息"), false);
  assert.equal(rendered.speakerWarnings.length, 1);
  assert.match(rendered.speakerWarnings[0], /底色未判定/);
  assert.equal(rendered.speakerStats.pixelUnresolved, 1);
});

test("dark RGB samples omit every unresolved bubble and emit explicit warnings", () => {
  const darkRgb = [
    [32, 32, 32],
    [24, 48, 31],
    [62, 73, 80],
  ];
  const groups = darkRgb.map((rgb, index) => ({
    rows: [line(`深色消息${index + 1}`, 134, 100 + index * 100, 451, 40)],
    text: `深色消息${index + 1}`,
  }));
  const prepared = {
    groups,
    labels: Array(groups.length).fill(null),
    kinds: Array(groups.length).fill("pixel-pending"),
    sampleRows: groups.map((group, index) => ({
      id: `bubble-${index}`,
      groupIndex: index,
      row: group.rows[0],
    })),
  };
  const samples = darkRgb.map((rgb, index) => {
    const color = classifyBubbleColor(rgb);
    assert.equal(color, "system");
    return {
      id: `bubble-${index}`,
      side: color === "self" ? "me" : color === "other" ? "them" : null,
      rgb,
      decodedPixels: 100,
    };
  });

  const rendered = finalizeWechatMessages(prepared, samples);

  assert.equal(rendered.markdown, "");
  assert.equal(rendered.markdown.includes("[我]"), false);
  assert.equal(rendered.markdown.includes("[对方]"), false);
  assert.equal(rendered.speakerWarnings.length, 3);
  assert.equal(rendered.speakerStats.dual, 3);
  assert.equal(rendered.speakerStats.pixelResolved, 0);
  assert.equal(rendered.speakerStats.pixelUnresolved, 3);
});

test("plain output groups only rows whose global y gap is below 18px", () => {
  assert.equal(renderPlain([
    line("先", 10, 0, 10, 10, 0, 100),
    line("后", 80, 0, 10, 10, 0, 117),
    line("新行", 5, 0, 10, 10, 0, 118),
  ]), "先 后\n新行");
});
