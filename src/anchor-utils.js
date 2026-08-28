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
});

const WECHAT_TIME = /^(昨天\s*)?\d{1,2}[:：]\d{2}$/;

function normalizeText(text) {
  return text.replace(/[\s，。、,.…"']/g, "");
}

function charLength(text) {
  return Array.from(text).length;
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

function clusterVote(diffs) {
  if (!diffs.length) return { shift: 0, votes: 0, total: 0 };
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
  clusters.sort((a, b) => b.length - a.length);
  const top = clusters[0];
  return {
    shift: top[Math.floor(top.length / 2)],
    votes: top.length,
    total: diffs.length,
  };
}

function estimateShift(previous, current, fixedBands) {
  const isFixed = line => fixedBands.has(bandForY(line.y));
  const index = new Map();
  for (const line of previous) {
    if (isFixed(line)) continue;
    const key = normalizeText(line.text);
    if (charLength(key) < 4) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(line);
  }

  const diffs = [];
  for (const line of current) {
    if (isFixed(line)) continue;
    const key = normalizeText(line.text);
    if (charLength(key) < 4) continue;
    const matches = index.get(key);
    if (!matches || matches.length !== 1) continue;
    diffs.push(matches[0].y - line.y);
  }
  return clusterVote(diffs);
}

function checkAnchors(shifts) {
  return shifts.map((shift, index) => {
    const ratio = shift.total ? shift.votes / shift.total : 0;
    const reasons = [];
    if (shift.total === 0) {
      reasons.push("无共同文本（锚点 0，明确无重叠）");
    } else if (shift.total < ANCHOR_CONFIG.minAnchor) {
      reasons.push(`锚点仅 ${shift.total} 个（1–2，不可单独采信）`);
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

function placeFrames(frames, fixedBands) {
  const shifts = [];
  let cumulativeShift = 0;
  const placed = frames[0].lines.map(line => ({ ...line, gy: line.y }));
  for (let index = 1; index < frames.length; index++) {
    const estimate = estimateShift(
      frames[index - 1].lines,
      frames[index].lines,
      fixedBands,
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

function dedupePlacedLines(lines, shifts) {
  const sorted = [...lines].sort((a, b) => a.gy - b.gy || a.x - b.x);
  const output = [];
  for (const line of sorted) {
    if (!normalizeText(line.text)) continue;
    let merged = false;
    for (let index = output.length - 1; index >= 0; index--) {
      const previous = output[index];
      if (Math.abs(previous.gy - line.gy) > ANCHOR_CONFIG.dedupWindow) continue;
      if (previous.frameIndex === line.frameIndex ||
          !hasReliableShiftPath(previous, line, shifts)) continue;
      if (boxContainment(previous, line) < ANCHOR_CONFIG.sameBoxOverlap) continue;
      if (charLength(line.text) > charLength(previous.text)) output[index] = line;
      merged = true;
      break;
    }
    if (!merged) output.push(line);
  }
  return output.sort((a, b) => a.gy - b.gy || a.x - b.x);
}

function analyzeAnchorFrames(frames) {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new RangeError("文本锚点路径至少需要 2 帧");
  }
  const fixedBands = findFixedBands(frames);
  const placedResult = placeFrames(frames, fixedBands);
  const isFixed = line => fixedBands.has(bandForY(line.y));
  const content = placedResult.placed.filter(
    line => !isFixed(line) && normalizeText(line.text),
  );
  const unique = dedupePlacedLines(content, placedResult.shifts);
  return {
    ...placedResult,
    fixedBands,
    contentLineCount: content.length,
    uniqueLines: unique,
    anchorWarnings: checkAnchors(placedResult.shifts),
  };
}

function findAlignPeaks(lines) {
  const leftCounts = new Map();
  const rightCounts = new Map();
  for (const line of lines) {
    leftCounts.set(line.x, (leftCounts.get(line.x) ?? 0) + 1);
    const right = line.x + line.w;
    rightCounts.set(right, (rightCounts.get(right) ?? 0) + 1);
  }
  const peak = counts =>
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [NaN, 0];
  return { left: peak(leftCounts)[0], right: peak(rightCounts)[0] };
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

  const labels = Array(groups.length).fill(null);
  const kinds = Array(groups.length).fill("");
  const sampleRows = [];
  for (let index = 0; index < groups.length; index++) {
    const rows = groups[index].rows;
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
  return { groups, kinds, labels, peaks, sampleRows };
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
      return side ? `[${side === "me" ? "我" : "对方"}] ${group.text}` : null;
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
    row.parts.sort((a, b) => a.x - b.x).map(part => part.text).join(" "),
  ).join("\n");
}

module.exports = {
  ANCHOR_CONFIG,
  analyzeAnchorFrames,
  bandForY,
  boxContainment,
  checkAnchors,
  clusterVote,
  collectFrameLines,
  dedupePlacedLines,
  estimateShift,
  finalizeWechatMessages,
  findAlignPeaks,
  findFixedBands,
  makeRegionRequests,
  normalizeText,
  prepareWechatMessages,
  renderPlain,
};
