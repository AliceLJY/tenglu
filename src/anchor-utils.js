const ANCHOR_CONFIG = Object.freeze({
  shiftTolerance: 3,
  fixedBand: 20,
  fixedRatio: 0.8,
  dedupWindow: 90,
  sameBoxOverlap: 0.6,
  alignTolerance: 30,
  mergeDy: 62,
  mergeDx: 60,
  minAnchor: 3,
  minVote: 0.4,
  fuzzySimilarity: 0.9,
  fuzzyRescueVote: 0.6,
  dedupeVariantSimilarity: 0.8,
});

const WECHAT_TIME = /^(昨天\s*)?\d{1,2}[:：]\d{2}$/;

function normalizeText(text) {
  return text.replace(/[\s，。、,.…"']/g, "");
}

function charLength(text) {
  return Array.from(text).length;
}

function levenshteinDistance(leftText, rightText) {
  const left = Array.from(leftText);
  const right = Array.from(rightText);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] +
          (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function textSimilarity(left, right) {
  const longest = Math.max(charLength(left), charLength(right));
  return longest
    ? 1 - levenshteinDistance(left, right) / longest
    : 1;
}

function validFrame(frame) {
  return frame &&
    [frame.left, frame.top, frame.width, frame.height].every(Number.isFinite) &&
    frame.width > 0 && frame.height > 0;
}

/** Convert one ML Kit result into the line geometry used by the M3 reference. */
function collectFrameLines(result, frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("frameIndex must be a non-negative integer");
  }

  const lines = [];
  for (const block of result?.blocks ?? []) {
    for (const line of block?.lines ?? []) {
      if (typeof line?.text !== "string") continue;
      const text = line.text.trim();
      if (!text) continue;
      const frame = line.frame == null ? block.frame : line.frame;
      if (!validFrame(frame)) continue;
      lines.push({
        text,
        x: frame.left,
        y: frame.top,
        w: frame.width,
        h: frame.height,
        conf: Number.isFinite(line.confidence) ? line.confidence : null,
        frameIndex,
      });
    }
  }
  return lines;
}

function bandForY(y) {
  return Math.round(y / ANCHOR_CONFIG.fixedBand);
}

function findFixedBands(frames) {
  const hits = new Map();
  for (const frame of frames) {
    for (const band of new Set(frame.lines.map(line => bandForY(line.y)))) {
      hits.set(band, (hits.get(band) ?? 0) + 1);
    }
  }
  const fixed = new Set();
  for (const [band, count] of hits) {
    if (count / frames.length >= ANCHOR_CONFIG.fixedRatio) fixed.add(band);
  }
  return fixed;
}

function clusterDiffs(diffs) {
  const sorted = [...diffs].sort((a, b) => a - b);
  const clusters = [];
  for (const diff of sorted) {
    const last = clusters.at(-1);
    if (last && diff - last.at(-1) <= ANCHOR_CONFIG.shiftTolerance) {
      last.push(diff);
    } else {
      clusters.push([diff]);
    }
  }
  clusters.sort((a, b) => b.length - a.length || a[0] - b[0]);
  return clusters;
}

function clusterVote(diffs) {
  if (!diffs.length) return { shift: 0, votes: 0, total: 0 };
  const clusters = clusterDiffs(diffs);
  const top = clusters[0];
  return {
    shift: top[Math.floor(top.length / 2)],
    votes: top.length,
    total: diffs.length,
  };
}

function anchorLines(lines, fixedBands) {
  const isFixed = line => fixedBands.has(bandForY(line.y));
  return lines.map(line => ({ ...line, anchorKey: normalizeText(line.text) }))
    .filter(line => !isFixed(line) && charLength(line.anchorKey) >= 4);
}

function uniqueBest(candidates, side) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const line = candidate[side];
    if (!grouped.has(line)) grouped.set(line, []);
    grouped.get(line).push(candidate);
  }
  const best = new Map();
  for (const [line, values] of grouped) {
    values.sort((a, b) => b.similarity - a.similarity);
    if (values.length === 1 || values[0].similarity > values[1].similarity) {
      best.set(line, values[0]);
    }
  }
  return best;
}

function anchorPairs(
  previous,
  current,
  fixedBands,
  fuzzySimilarity = ANCHOR_CONFIG.fuzzySimilarity,
) {
  const previousLines = anchorLines(previous, fixedBands);
  const currentLines = anchorLines(current, fixedBands);
  const previousByText = new Map();
  const currentByText = new Map();
  for (const line of previousLines) {
    if (!previousByText.has(line.anchorKey)) previousByText.set(line.anchorKey, []);
    previousByText.get(line.anchorKey).push(line);
  }
  for (const line of currentLines) {
    if (!currentByText.has(line.anchorKey)) currentByText.set(line.anchorKey, []);
    currentByText.get(line.anchorKey).push(line);
  }

  const exact = [];
  const usedPrevious = new Set();
  const usedCurrent = new Set();
  // Preserve the verified exact behavior: one unique previous line can anchor
  // multiple identical current observations. Fuzzy additions alone are 1:1.
  for (const [key, previousMatches] of previousByText) {
    const currentMatches = currentByText.get(key);
    if (previousMatches.length !== 1 || !currentMatches?.length) continue;
    for (const currentLine of currentMatches) {
      exact.push({
        previous: previousMatches[0],
        current: currentLine,
        similarity: 1,
      });
      usedCurrent.add(currentLine);
    }
    usedPrevious.add(previousMatches[0]);
  }

  const candidates = [];
  for (const previousLine of previousLines) {
    if (usedPrevious.has(previousLine)) continue;
    for (const currentLine of currentLines) {
      if (usedCurrent.has(currentLine)) continue;
      const similarity = textSimilarity(
        previousLine.anchorKey,
        currentLine.anchorKey,
      );
      if (similarity >= fuzzySimilarity) {
        candidates.push({
          previous: previousLine,
          current: currentLine,
          similarity,
        });
      }
    }
  }
  const bestPrevious = uniqueBest(candidates, "previous");
  const bestCurrent = uniqueBest(candidates, "current");
  const fuzzy = candidates.filter(candidate =>
    bestPrevious.get(candidate.previous) === candidate &&
    bestCurrent.get(candidate.current) === candidate
  );
  return { exact, fuzzy };
}

function estimateShift(previous, current, fixedBands, options = {}) {
  const useFuzzy = options.fuzzy !== false;
  const fuzzySimilarity = options.fuzzySimilarity ?? ANCHOR_CONFIG.fuzzySimilarity;
  if (!Number.isFinite(fuzzySimilarity) || fuzzySimilarity < 0 ||
      fuzzySimilarity > 1) {
    throw new RangeError("fuzzySimilarity must be between 0 and 1");
  }
  const { exact, fuzzy: fuzzyMatches } = anchorPairs(
    previous,
    current,
    fixedBands,
    fuzzySimilarity,
  );
  const fuzzy = useFuzzy ? fuzzyMatches : [];
  const diff = pair => pair.previous.y - pair.current.y;
  const exactDiffs = exact.map(diff);
  const exactVote = clusterVote(exactDiffs);
  const exactClusters = clusterDiffs(exactDiffs);
  const exactReliable = exactVote.total >= ANCHOR_CONFIG.minAnchor &&
    exactVote.votes / (exactVote.total || 1) >= ANCHOR_CONFIG.minVote;

  if (exactReliable) {
    const top = exactClusters[0];
    const accepted = fuzzy.filter(pair =>
      top.some(value => Math.abs(value - diff(pair)) <= ANCHOR_CONFIG.shiftTolerance)
    );
    const vote = clusterVote([...exactDiffs, ...accepted.map(diff)]);
    return {
      ...vote,
      // Fuzzy evidence may increase the vote count but cannot move a shift that
      // the exact anchors already established on both independent Mac datasets.
      shift: exactVote.shift,
      exactTotal: exact.length,
      fuzzyCandidates: fuzzy.length,
      fuzzyAccepted: accepted.length,
      fuzzyRejected: fuzzy.length - accepted.length,
      fuzzyRescue: false,
    };
  }

  const allDiffs = [...exactDiffs, ...fuzzy.map(diff)];
  const candidateVote = clusterVote(allDiffs);
  const candidateClusters = clusterDiffs(allDiffs);
  const top = candidateClusters[0] ?? [];
  const hasUniqueTop = !candidateClusters[1] ||
    top.length > candidateClusters[1].length;
  const canRescue = top.length >= ANCHOR_CONFIG.minAnchor &&
    top.length / (allDiffs.length || 1) >= ANCHOR_CONFIG.fuzzyRescueVote &&
    hasUniqueTop;
  if (!canRescue) {
    return {
      ...exactVote,
      exactTotal: exact.length,
      fuzzyCandidates: fuzzy.length,
      fuzzyAccepted: 0,
      fuzzyRejected: fuzzy.length,
      fuzzyRescue: false,
      fuzzyCandidateVotes: candidateVote.votes,
      fuzzyCandidateTotal: candidateVote.total,
    };
  }

  const acceptedFuzzy = fuzzy.filter(pair =>
    top.some(value => Math.abs(value - diff(pair)) <= ANCHOR_CONFIG.shiftTolerance)
  );
  return {
    ...candidateVote,
    exactTotal: exact.length,
    fuzzyCandidates: fuzzy.length,
    fuzzyAccepted: acceptedFuzzy.length,
    fuzzyRejected: fuzzy.length - acceptedFuzzy.length,
    fuzzyRescue: true,
    fuzzyCandidateVotes: candidateVote.votes,
    fuzzyCandidateTotal: candidateVote.total,
  };
}

function checkAnchors(shifts) {
  return shifts.map((shift, index) => {
    const ratio = shift.total ? shift.votes / shift.total : 0;
    const fuzzyCandidateTotal = shift.fuzzyCandidateTotal ?? 0;
    const fuzzyCandidateVotes = shift.fuzzyCandidateVotes ?? 0;
    const reasons = [];
    if (shift.total === 0) {
      reasons.push(
        fuzzyCandidateTotal
          ? `有模糊候选 ${fuzzyCandidateTotal} 个（最大簇 ${fuzzyCandidateVotes}），` +
            "但未达独立救援门禁；无可采信锚点"
          : "无共同文本（锚点 0，明确无重叠）",
      );
    } else if (shift.total < ANCHOR_CONFIG.minAnchor) {
      reasons.push(
        `精确锚点仅 ${shift.total} 个（1–2，不可单独采信）` +
        (fuzzyCandidateTotal
          ? `；另有模糊候选 ${fuzzyCandidateTotal} 个未达独立救援门禁`
          : ""),
      );
    } else if (ratio < ANCHOR_CONFIG.minVote) {
      reasons.push(
        `位移投票分散（最大簇 ${(ratio * 100).toFixed(0)}% < ` +
        `${ANCHOR_CONFIG.minVote * 100}%）`,
      );
    }
    return reasons.length
      ? { pair: `${shift.from}→${shift.to}`, index, reasons }
      : null;
  }).filter(Boolean);
}

function placeFrames(frames, fixedBands, options = {}) {
  const shifts = [];
  let cumulativeShift = 0;
  const placed = frames[0].lines.map(line => ({ ...line, gy: line.y }));
  for (let index = 1; index < frames.length; index++) {
    const estimate = estimateShift(
      frames[index - 1].lines,
      frames[index].lines,
      fixedBands,
      options,
    );
    cumulativeShift += estimate.shift;
    shifts.push({
      from: frames[index - 1].name,
      to: frames[index].name,
      ...estimate,
      cumulativeShift,
    });
    for (const line of frames[index].lines) {
      placed.push({ ...line, gy: line.y + cumulativeShift });
    }
  }
  return { cumulativeShift, placed, shifts };
}

function boxContainment(a, b) {
  const overlapX = Math.max(
    0,
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
  );
  const overlapY = Math.max(
    0,
    Math.min(a.gy + a.h, b.gy + b.h) - Math.max(a.gy, b.gy),
  );
  const smallerArea = Math.min(a.w * a.h, b.w * b.h);
  return smallerArea ? (overlapX * overlapY) / smallerArea : 0;
}

function hasReliableShiftPath(a, b, shifts) {
  const low = Math.min(a.frameIndex, b.frameIndex);
  const high = Math.max(a.frameIndex, b.frameIndex);
  return shifts.slice(low, high).every(shift =>
    shift.total >= ANCHOR_CONFIG.minAnchor &&
    shift.votes / (shift.total || 1) >= ANCHOR_CONFIG.minVote
  );
}

function composeFrameObservations(observations) {
  const byFrame = new Map();
  for (const observation of observations) {
    if (!byFrame.has(observation.frameIndex)) byFrame.set(observation.frameIndex, []);
    byFrame.get(observation.frameIndex).push(observation);
  }
  return [...byFrame.values()].map(parts => {
    if (parts.length === 1) return parts[0];
    const ordered = [...parts].sort((left, right) => left.x - right.x);
    const left = Math.min(...ordered.map(line => line.x));
    const right = Math.max(...ordered.map(line => line.x + line.w));
    const top = Math.min(...ordered.map(line => line.y));
    const bottom = Math.max(...ordered.map(line => line.y + line.h));
    const globalTop = Math.min(...ordered.map(line => line.gy));
    const globalBottom = Math.max(...ordered.map(line => line.gy + line.h));
    return {
      ...ordered[0],
      text: ordered.map(line => line.text).join(""),
      x: left,
      y: top,
      w: right - left,
      h: Math.max(bottom - top, globalBottom - globalTop),
      gy: globalTop,
      dedupeParts: ordered.map(line => line.text),
    };
  });
}

function chooseDedupeObservation(
  group,
  majorityConsensus,
  variantSimilarityThreshold,
) {
  const observations = composeFrameObservations(group.observations);
  if (!majorityConsensus || observations.length < 3) {
    return {
      line: group.longerSelected,
      kind: "longer-fallback",
      observations,
    };
  }
  const variants = new Map();
  for (const observation of observations) {
    const key = normalizeText(observation.text);
    if (!variants.has(key)) variants.set(key, []);
    variants.get(key).push(observation);
  }
  const ranked = [...variants.values()].sort((left, right) =>
    right.length - left.length ||
    Math.min(...left.map(line => line.frameIndex)) -
      Math.min(...right.map(line => line.frameIndex))
  );
  const winner = ranked[0];
  if (!winner || winner.length < 3 || winner.length <= observations.length / 2) {
    return {
      line: group.longerSelected,
      kind: "longer-fallback",
      observations,
    };
  }
  const proposedLine = [...winner].sort((left, right) =>
      Number(Boolean(left.dedupeParts)) - Number(Boolean(right.dedupeParts)) ||
      left.frameIndex - right.frameIndex
    )[0];
  const variantSimilarity = textSimilarity(
    normalizeText(proposedLine.text),
    normalizeText(group.longerSelected.text),
  );
  const variantEditDistance = levenshteinDistance(
    normalizeText(proposedLine.text),
    normalizeText(group.longerSelected.text),
  );
  if (normalizeText(proposedLine.text) !==
        normalizeText(group.longerSelected.text) &&
      variantSimilarity < variantSimilarityThreshold) {
    return {
      line: group.longerSelected,
      kind: "unrelated-majority-rejected",
      observations,
      proposedLine,
      variantSimilarity,
      variantEditDistance,
    };
  }
  return {
    line: proposedLine,
    kind: "strict-majority",
    observations,
    proposedLine,
    variantSimilarity,
    variantEditDistance,
  };
}

function dedupePlacedLineGroups(lines, shifts, options = {}) {
  const majorityConsensus = options.majorityConsensus !== false;
  const variantSimilarityThreshold = options.dedupeVariantSimilarity ??
    ANCHOR_CONFIG.dedupeVariantSimilarity;
  if (!Number.isFinite(variantSimilarityThreshold) ||
      variantSimilarityThreshold < 0 || variantSimilarityThreshold > 1) {
    throw new RangeError("dedupeVariantSimilarity must be between 0 and 1");
  }
  const sorted = [...lines].sort((a, b) => a.gy - b.gy || a.x - b.x);
  const groups = [];
  for (const line of sorted) {
    if (!normalizeText(line.text)) continue;
    let merged = false;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      const previous = group.longerSelected;
      if (Math.abs(previous.gy - line.gy) > ANCHOR_CONFIG.dedupWindow) continue;
      if (previous.frameIndex === line.frameIndex ||
          !hasReliableShiftPath(previous, line, shifts)) continue;
      if (boxContainment(previous, line) < ANCHOR_CONFIG.sameBoxOverlap) continue;
      group.observations.push(line);
      if (charLength(line.text) > charLength(previous.text)) {
        group.longerSelected = line;
      }
      merged = true;
      break;
    }
    if (!merged) groups.push({ observations: [line], longerSelected: line });
  }

  const selections = groups.map(group => ({
    group,
    ...chooseDedupeObservation(
      group,
      majorityConsensus,
      variantSimilarityThreshold,
    ),
  }));
  return {
    lines: selections.map(selection => selection.line)
      .sort((a, b) => a.gy - b.gy || a.x - b.x),
    stats: {
      candidateGroups: groups.filter(group => group.observations.length > 1).length,
      observationCount: groups.reduce(
        (sum, group) => sum + group.observations.length,
        0,
      ),
      frameObservationCount: selections.reduce(
        (sum, selection) => sum + selection.observations.length,
        0,
      ),
      frameComposedClusters: selections.filter(selection =>
        selection.observations.some(line => line.dedupeParts)
      ).length,
      majorityEligible: selections.filter(
        selection => selection.observations.length >= 3,
      ).length,
      majorityChosen: selections.filter(
        selection => selection.kind === "strict-majority",
      ).length,
      majorityRejectedUnrelated: selections.filter(
        selection => selection.kind === "unrelated-majority-rejected",
      ).length,
      changedSelection: selections.filter(selection =>
        selection.kind === "strict-majority" &&
        selection.line.text !== selection.group.longerSelected.text
      ).length,
      normalizedChangedSelection: selections.filter(selection =>
        selection.kind === "strict-majority" &&
        normalizeText(selection.line.text) !==
          normalizeText(selection.group.longerSelected.text)
      ).length,
      longerFallback: selections.filter(selection =>
        selection.group.observations.length > 1 &&
        selection.kind !== "strict-majority"
      ).length,
      variantSimilarityThreshold,
    },
    details: selections.filter(selection =>
      selection.kind === "strict-majority" ||
      selection.kind === "unrelated-majority-rejected"
    ).map(selection => ({
      kind: selection.kind,
      selectedText: selection.line.text,
      longerText: selection.group.longerSelected.text,
      proposedText: selection.proposedLine.text,
      variantSimilarity: selection.variantSimilarity,
      variantEditDistance: selection.variantEditDistance,
      observationCount: selection.observations.length,
    })),
  };
}

function dedupePlacedLines(lines, shifts, options = {}) {
  return dedupePlacedLineGroups(lines, shifts, options).lines;
}

function analyzeAnchorFrames(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new RangeError("文本锚点路径至少需要 2 帧");
  }
  const fixedBands = findFixedBands(frames);
  const placedResult = placeFrames(frames, fixedBands, options);
  const isFixed = line => fixedBands.has(bandForY(line.y));
  const content = placedResult.placed.filter(
    line => !isFixed(line) && normalizeText(line.text),
  );
  const deduped = dedupePlacedLineGroups(content, placedResult.shifts);
  return {
    ...placedResult,
    fixedBands,
    contentLineCount: content.length,
    uniqueLines: deduped.lines,
    dedupeStats: deduped.stats,
    dedupeDetails: deduped.details,
    anchorWarnings: checkAnchors(placedResult.shifts),
  };
}

function findAlignPeaks(lines) {
  // Alignment peaks must be geometrically plausible: left-aligned text begins
  // in the left half, while right-aligned text ends in the right half.
  // Dense ML Kit sampling otherwise lets repeated middle-screen fragments win.
  const width = Math.max(...lines.map(line => line.x + line.w), 1);
  const midpoint = width / 2;
  const leftCounts = new Map();
  const rightCounts = new Map();
  for (const line of lines) {
    if (Array.from(line.text).length < 2) continue;
    if (line.x < midpoint) {
      leftCounts.set(line.x, (leftCounts.get(line.x) ?? 0) + 1);
    }
    const right = line.x + line.w;
    if (right > midpoint) {
      rightCounts.set(right, (rightCounts.get(right) ?? 0) + 1);
    }
  }
  const peak = counts =>
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [NaN, 0];
  return { left: peak(leftCounts)[0], right: peak(rightCounts)[0] };
}

/**
 * Keep a group-chat display name separate from the message body when Vision / ML
 * Kit returned it as its own top row. This is deliberately geometry-only: no
 * name dictionaries, punctuation guesses, or text normalization are involved.
 *
 * `group.text` remains the lossless legacy representation. Callers may use the
 * optional nickname field only after the bubble is independently classified as
 * an incoming message; every rejected layout therefore falls back byte-for-byte.
 */
function attachWechatNicknameFields(groups, peaks, options = {}) {
  const leftHit = line =>
    Math.abs(line.x - peaks.left) <= ANCHOR_CONFIG.alignTolerance;
  const rightHit = line =>
    Math.abs(line.x + line.w - peaks.right) <= ANCHOR_CONFIG.alignTolerance;

  const pairKind = (nicknameRow, bodyRow) => {
    if (!nicknameRow || !bodyRow ||
        !leftHit(nicknameRow) || rightHit(nicknameRow) ||
        !leftHit(bodyRow)) {
      return null;
    }
    const nicknameInset = peaks.left - nicknameRow.x;
    const bodyDelta = bodyRow.x - peaks.left;
    const dx = bodyRow.x - nicknameRow.x;
    const dy = bodyRow.gy - nicknameRow.gy;
    const common =
      nicknameInset >= 14 && nicknameInset <= 30 &&
      nicknameRow.h >= 16 && nicknameRow.h <= 27 &&
      dy >= 44 && dy <= 56;
    if (!common) return null;
    if (bodyDelta >= -2 && bodyDelta <= 2 &&
        bodyRow.h >= 26 && bodyRow.h <= 37 && dx >= 14) {
      return "separate-top-line";
    }
    // A long body line can make ML Kit extend its box 3–11px left of the
    // normal body peak. Its much larger glyph box keeps this second tier from
    // accepting the small quote/OCR fragments seen in the device bundle.
    if (options.wideBody !== false &&
        bodyDelta >= -11 && bodyDelta <= -3 &&
        bodyRow.h >= 31 && bodyRow.h <= 37 &&
        bodyRow.h - nicknameRow.h >= 5 && dx >= 7) {
      return "separate-top-line-wide-body";
    }
    return null;
  };

  let highConfidenceCount = 0;
  let wideBodyCount = 0;
  let internalSplitCount = 0;
  const annotated = groups.map(group => {
    const matches = new Map();
    for (let index = 0; index < group.rows.length - 1; index++) {
      if (index > 0 && options.internal === false) continue;
      const kind = pairKind(group.rows[index], group.rows[index + 1]);
      if (kind) matches.set(index, kind);
    }
    const starts = [
      0,
      ...[...matches.keys()].filter(index => index > 0),
      group.rows.length,
    ].sort((left, right) => left - right);
    const messageSegments = [];
    for (let index = 0; index < starts.length - 1; index++) {
      const start = starts[index];
      const rows = group.rows.slice(start, starts[index + 1]);
      const segment = {
        rows,
        text: rows.map(row => row.text).join(""),
        nickname: null,
      };
      const kind = matches.get(start);
      if (kind) {
        const bodyText = rows.slice(1).map(row => row.text).join("");
        segment.nickname = {
          text: rows[0].text,
          bodyText,
          kind,
        };
        if (segment.nickname.text + segment.nickname.bodyText !== segment.text) {
          segment.nickname = null;
        } else if (kind === "separate-top-line-wide-body") {
          wideBodyCount += 1;
        } else {
          highConfidenceCount += 1;
        }
      }
      messageSegments.push(segment);
    }
    if (messageSegments.map(segment => segment.text).join("") !== group.text) {
      return {
        ...group,
        nickname: null,
        messageSegments: [{ rows: group.rows, text: group.text, nickname: null }],
      };
    }
    internalSplitCount += Math.max(0, messageSegments.length - 1);
    return {
      ...group,
      nickname: messageSegments.length === 1
        ? messageSegments[0].nickname
        : null,
      messageSegments,
    };
  });

  return {
    groups: annotated,
    candidateCount: highConfidenceCount + wideBodyCount,
    highConfidenceCount,
    wideBodyCount,
    internalSplitCount,
  };
}

function prepareWechatMessages(lines) {
  const peaks = findAlignPeaks(lines);
  const leftHit = line =>
    Math.abs(line.x - peaks.left) <= ANCHOR_CONFIG.alignTolerance;
  const rightHit = line =>
    Math.abs(line.x + line.w - peaks.right) <= ANCHOR_CONFIG.alignTolerance;

  const groups = [];
  for (const line of lines) {
    if (WECHAT_TIME.test(line.text.trim())) continue;
    if (!leftHit(line) && !rightHit(line)) continue;
    let current = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      const dy = line.gy - group.lastY;
      const dx = Math.abs(line.x - group.lastX);
      if (dy >= 0 && dy < ANCHOR_CONFIG.mergeDy &&
          dx < ANCHOR_CONFIG.mergeDx &&
          (dy < bestDy || (dy === bestDy && dx < bestDx))) {
        current = group;
        bestDy = dy;
        bestDx = dx;
      }
    }
    if (current) {
      current.rows.push(line);
      current.rows.sort((a, b) => a.gy - b.gy || a.x - b.x);
      current.text = current.rows.map(row => row.text).join("");
      current.lastY = Math.max(...current.rows.map(row => row.gy));
      current.lastX = line.x;
    } else {
      groups.push({
        rows: [line],
        text: line.text,
        gy: line.gy,
        lastY: line.gy,
        lastX: line.x,
      });
    }
  }

  const nicknameResult = attachWechatNicknameFields(groups, peaks);
  const annotatedGroups = nicknameResult.groups;
  const labels = Array(annotatedGroups.length).fill(null);
  const kinds = Array(groups.length).fill("");
  const sampleRows = [];
  for (let index = 0; index < annotatedGroups.length; index++) {
    const rows = annotatedGroups[index].rows;
    const hasLeft = rows.some(leftHit);
    const hasRight = rows.some(rightHit);
    if (hasRight && !hasLeft) {
      labels[index] = "me";
      kinds[index] = "definite-right";
    } else if (hasLeft && !hasRight) {
      labels[index] = "them";
      kinds[index] = "definite-left";
    } else if (hasLeft && hasRight) {
      kinds[index] = "pixel-pending";
      const row = [...rows].sort((a, b) => b.w * b.h - a.w * a.h)[0];
      sampleRows.push({ id: `bubble-${index}`, groupIndex: index, row });
    }
  }
  return {
    groups: annotatedGroups,
    kinds,
    labels,
    peaks,
    sampleRows,
    nicknameCandidateCount: nicknameResult.candidateCount,
    nicknameHighConfidenceCount: nicknameResult.highConfidenceCount,
    nicknameWideBodyCount: nicknameResult.wideBodyCount,
    nicknameInternalSplitCount: nicknameResult.internalSplitCount,
  };
}

function makeRegionRequests(prepared, frameUris) {
  return prepared.sampleRows.map(({ id, groupIndex, row }) => {
    const uri = frameUris[row.frameIndex];
    if (!uri) throw new Error(`找不到 frameIndex=${row.frameIndex} 对应的抽帧文件`);
    const x = Math.max(0, Math.floor(row.x));
    const y = Math.max(0, Math.floor(row.y));
    const right = Math.ceil(row.x + row.w);
    const bottom = Math.ceil(row.y + row.h);
    if (right <= x || bottom <= y) throw new Error(`气泡 ${groupIndex + 1} 的文本框无效`);
    return {
      id,
      groupIndex,
      frameIndex: row.frameIndex,
      uri,
      x,
      y,
      width: right - x,
      height: bottom - y,
    };
  });
}

function finalizeWechatMessages(prepared, samples) {
  const labels = [...prepared.labels];
  const kinds = [...prepared.kinds];
  const byId = new Map((samples ?? []).map(sample => [sample.id, sample]));
  const warnings = [];
  const usedSamples = [];

  for (const pending of prepared.sampleRows) {
    const rawSample = byId.get(pending.id) ?? {
      id: pending.id,
      side: null,
      errorCode: "E_RESULT_MISSING",
      error: "原生采样没有返回结果",
    };
    const sample = {
      ...rawSample,
      frameIndex: rawSample.frameIndex ?? pending.row.frameIndex,
    };
    usedSamples.push(sample);
    if (sample?.side === "me" || sample?.side === "them") {
      labels[pending.groupIndex] = sample.side;
      kinds[pending.groupIndex] = "pixel-color";
      continue;
    }
    kinds[pending.groupIndex] = sample?.error ? "pixel-error" : "pixel-unresolved";
    const detail = sample?.error
      ? `采样失败：${sample.error}`
      : `底色未判定${sample?.rgb ? `（RGB ${sample.rgb.join(",")}）` : ""}`;
    warnings.push(`气泡 ${pending.groupIndex + 1} ${detail}，该气泡未输出。`);
  }

  const resolved = usedSamples.filter(
    sample => sample.side === "me" || sample.side === "them",
  );
  return {
    markdown: prepared.groups.map((group, index) => {
      const side = labels[index];
      if (!side) return null;
      if (side === "them") {
        return (group.messageSegments ?? [{ text: group.text, nickname: group.nickname }])
          .map(segment => segment.nickname
            ? `[${segment.nickname.text}] ${segment.nickname.bodyText}`
            : `[对方] ${segment.text}`)
          .join("\n");
      }
      return `[我] ${group.text}`;
    }).filter(Boolean).join("\n"),
    speakerWarnings: warnings,
    speakerSamples: usedSamples,
    speakerStats: {
      dual: prepared.sampleRows.length,
      pixelResolved: resolved.length,
      pixelMe: resolved.filter(sample => sample.side === "me").length,
      pixelThem: resolved.filter(sample => sample.side === "them").length,
      pixelUnresolved: prepared.sampleRows.length - resolved.length,
      pixelErrors: usedSamples.filter(sample => sample.error).length,
      decodedPixels: usedSamples.reduce(
        (sum, sample) => sum + (Number(sample.decodedPixels) || 0),
        0,
      ),
      sampledPixels: usedSamples.reduce(
        (sum, sample) => sum + (Number(sample.sampledPixels) || 0),
        0,
      ),
      nicknameCandidates: prepared.nicknameCandidateCount ??
        prepared.groups.filter(group => group.nickname).length,
      nicknameHighConfidence: prepared.nicknameHighConfidenceCount ?? 0,
      nicknameWideBody: prepared.nicknameWideBodyCount ?? 0,
      nicknameInternalSplits: prepared.nicknameInternalSplitCount ?? 0,
      nicknameApplied: prepared.groups.reduce((sum, group, index) =>
        sum + (labels[index] === "them"
          ? (group.messageSegments ?? []).filter(segment => segment.nickname).length
          : 0), 0),
    },
  };
}

function renderPlain(lines) {
  const rows = [];
  for (const line of lines) {
    const row = rows.at(-1);
    if (!row || line.gy - row.gy >= 18) {
      rows.push({ gy: line.gy, parts: [line] });
    } else {
      row.parts.push(line);
    }
  }
  return rows.map(row =>
    row.parts.sort((a, b) => a.x - b.x)
      .map(part => part.dedupeParts?.join(" ") ?? part.text)
      .join(" "),
  ).join("\n");
}

module.exports = {
  ANCHOR_CONFIG,
  analyzeAnchorFrames,
  attachWechatNicknameFields,
  bandForY,
  boxContainment,
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
  levenshteinDistance,
  normalizeText,
  prepareWechatMessages,
  renderPlain,
  textSimilarity,
};
