#!/usr/bin/env node
/**
 * 文本锚点架构（M3 验证）：不解码任何像素，直接从每帧的 OCR 结果还原长文本。
 *
 *   node anchor-ocr.mjs <OCR缓存目录> <wechat|plain> [--stride N] [--out out.md] [--diag]
 *
 * 与现有拼接架构的分工：拼接架构靠像素对齐（jpeg-js 解码 + SAD 粗搜 + 拼长图），
 * 本脚本靠文本自身携带的几何信息。四个步骤全部只读 OCR 输出的 x/y/w/h：
 *
 *   1. 固定 UI —— 某个 y 带在 ≥80% 的帧里都有文本行 ⇒ 它不随内容滚动
 *   2. 帧间位移 —— 相邻帧的共同文本行，y 差按 ±3px 聚类投票，最大簇的中位数
 *   3. 发言人   —— 先把续行聚成气泡，再用左右对齐峰和相邻明确气泡判方向
 *   4. 去重     —— 累积位移映射全局 y，在可靠位移路径内按文本框位置合并
 *
 * 失败自检见 checkAnchors()：锚点 0 明确无重叠，1–2 个不可单独采信；
 * 锚点足够后再检查投票是否分散。任一情况都报警，不静默降级。
 */
import fs from "node:fs";
import path from "node:path";

// ── 参数
const argv = process.argv.slice(2);
const cacheDir = argv[0];
const mode = argv[1] ?? "plain";
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const STRIDE = Number(opt("stride", 7));
const OUT = opt("out", null);
const DIAG = argv.includes("--diag");
if (!cacheDir) {
  console.error("用法: node anchor-ocr.mjs <OCR缓存目录> <wechat|plain> [--stride N] [--out f.md] [--diag]");
  process.exit(1);
}

// ── 可调参数（改这里，不要散落在代码里）
const SHIFT_TOL = 3;        // 位移投票的聚类容差 px
const FIXED_BAND = 20;      // 固定 UI 的 y 带宽度 px
const FIXED_RATIO = 0.8;    // 占用率超过它就算固定 UI
const DEDUP_WINDOW = 90;    // 去重的几何邻域 ±px
const SAME_BOX_OVERLAP = 0.6; // 跨帧同一文本框的面积包含率
const ALIGN_TOL = 30;       // 判定"贴着对齐峰"的容差 px
const MERGE_DY = 62;        // 同一气泡内续行的最大行距
const MERGE_DX = 60;        // 同一气泡内续行的最大左边界差
const MIN_ANCHOR = 3;       // 失败自检：一对帧至少要这么多锚点
const MIN_VOTE = 0.4;       // 失败自检：最大簇至少占这么多
const WECHAT_TIME = /^(昨天\s*)?\d{1,2}[:：]\d{2}$/;

const norm = s => s.replace(/[\s，。、,.…""'']/g, "");
const clen = s => Array.from(s).length;
const band = y => Math.round(y / FIXED_BAND);

// ── 载入
const files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".json")).sort();
const frames = files
  .filter((_, i) => i % STRIDE === 0)
  .map((f, frameIndex) => ({
    name: f,
    lines: JSON.parse(fs.readFileSync(path.join(cacheDir, f), "utf8"))
      .map(l => ({ ...l, frameIndex })),
  }));
if (frames.length < 2) { console.error("帧数不足"); process.exit(1); }

// ── 1. 固定 UI
function findFixedBands(frames) {
  const hit = new Map();
  for (const fr of frames) {
    for (const b of new Set(fr.lines.map(l => band(l.y)))) hit.set(b, (hit.get(b) ?? 0) + 1);
  }
  const fixed = new Set();
  for (const [b, n] of hit) if (n / frames.length >= FIXED_RATIO) fixed.add(b);
  return fixed;
}
const fixedBands = findFixedBands(frames);
const isFixed = l => fixedBands.has(band(l.y));

// ── 2. 帧间位移：共同文本行的 y 差，±SHIFT_TOL 聚类投票
function clusterVote(diffs) {
  if (!diffs.length) return { shift: 0, votes: 0, total: 0 };
  const sorted = [...diffs].sort((a, b) => a - b);
  const clusters = [];
  for (const d of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && d - last[last.length - 1] <= SHIFT_TOL) last.push(d);
    else clusters.push([d]);
  }
  clusters.sort((a, b) => b.length - a.length);
  const top = clusters[0];
  return { shift: top[Math.floor(top.length / 2)], votes: top.length, total: diffs.length };
}

function estimateShift(prev, cur) {
  const index = new Map();
  for (const l of prev) {
    if (isFixed(l)) continue;
    const k = norm(l.text);
    if (clen(k) < 4) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(l);
  }
  const diffs = [];
  for (const l of cur) {
    if (isFixed(l)) continue;
    const k = norm(l.text);
    if (clen(k) < 4) continue;
    const hits = index.get(k);
    if (!hits || hits.length !== 1) continue;   // 同一文本在前帧出现多次 ⇒ 不能当锚点
    diffs.push(hits[0].y - l.y);
  }
  return clusterVote(diffs);
}

const shifts = [];
let cum = 0;
const placed = frames[0].lines.map(l => ({ ...l, gy: l.y }));
for (let i = 1; i < frames.length; i++) {
  const est = estimateShift(frames[i - 1].lines, frames[i].lines);
  cum += est.shift;
  shifts.push({ from: frames[i - 1].name, to: frames[i].name, ...est, cum });
  for (const l of frames[i].lines) placed.push({ ...l, gy: l.y + cum });
}

// ── 失败自检：不静默降级
// 本验证器不读像素；生产接入时，1–2 个锚点应由上层显式回退现有 SAD 路径。
function checkAnchors(shifts) {
  return shifts
    .map((s, i) => {
      const ratio = s.total ? s.votes / s.total : 0;
      const reasons = [];
      if (s.total === 0) reasons.push("无共同文本（锚点 0，明确无重叠）");
      else if (s.total < MIN_ANCHOR) reasons.push(`锚点仅 ${s.total} 个（1–2，不可单独采信）`);
      else if (ratio < MIN_VOTE) reasons.push(`位移投票分散（最大簇 ${(ratio * 100).toFixed(0)}% < ${MIN_VOTE * 100}%）`);
      return reasons.length ? { pair: `${s.from}→${s.to}`, index: i, reasons } : null;
    })
    .filter(Boolean);
}
const warnings = checkAnchors(shifts);

// ── 3. 发言人：左/右边界的峰
function findAlignPeaks(lines) {
  const L = new Map(), R = new Map();
  for (const l of lines) {
    L.set(l.x, (L.get(l.x) ?? 0) + 1);
    R.set(l.x + l.w, (R.get(l.x + l.w) ?? 0) + 1);
  }
  const peak = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? [NaN, 0];
  return { left: peak(L)[0], right: peak(R)[0] };
}

// ── 4. 去重：可靠位移路径内，同位置文本框以较完整的那次识别为准
function boxContainment(a, b) {
  const overlapX = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.gy + a.h, b.gy + b.h) - Math.max(a.gy, b.gy));
  const smallerArea = Math.min(a.w * a.h, b.w * b.h);
  return smallerArea ? (overlapX * overlapY) / smallerArea : 0;
}

function hasReliableShiftPath(a, b) {
  const lo = Math.min(a.frameIndex, b.frameIndex);
  const hi = Math.max(a.frameIndex, b.frameIndex);
  return shifts.slice(lo, hi).every(s =>
    s.total >= MIN_ANCHOR && s.votes / (s.total || 1) >= MIN_VOTE
  );
}

function dedupe(lines) {
  const sorted = [...lines].sort((a, b) => a.gy - b.gy || a.x - b.x);
  const out = [];
  for (const l of sorted) {
    const k = norm(l.text);
    if (!k) continue;
    let merged = false;
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i];
      if (Math.abs(p.gy - l.gy) > DEDUP_WINDOW) continue;
      if (p.frameIndex === l.frameIndex || !hasReliableShiftPath(p, l)) continue;
      if (boxContainment(p, l) < SAME_BOX_OVERLAP) continue;
      if (clen(l.text) > clen(p.text)) out[i] = l;    // 更完整的那次识别胜出
      merged = true;
      break;
    }
    if (!merged) out.push(l);
  }
  return out.sort((a, b) => a.gy - b.gy || a.x - b.x);
}

const content = placed.filter(l => !isFixed(l) && norm(l.text));
const unique = dedupe(content);

// ── 输出
function renderWechat(lines) {
  const { left, right } = findAlignPeaks(lines);
  const leftHit = l => Math.abs(l.x - left) <= ALIGN_TOL;
  const rightHit = l => Math.abs(l.x + l.w - right) <= ALIGN_TOL;

  // 先按气泡聚行，再判 speaker；同 gy 的 OCR 噪声不能打断真实续行。
  const groups = [];
  for (const l of lines) {
    if (WECHAT_TIME.test(l.text.trim())) continue;
    if (!leftHit(l) && !rightHit(l)) continue;
    let cur = null;
    let bestDy = Infinity, bestDx = Infinity;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const dy = l.gy - g.lastY;
      const dx = Math.abs(l.x - g.lastX);
      if (dy >= 0 && dy < MERGE_DY && dx < MERGE_DX &&
          (dy < bestDy || (dy === bestDy && dx < bestDx))) {
        cur = g;
        bestDy = dy;
        bestDx = dx;
      }
    }
    if (cur) {
      cur.rows.push(l);
      cur.rows.sort((a, b) => a.gy - b.gy || a.x - b.x);
      cur.text = cur.rows.map(r => r.text).join("");
      cur.lastY = Math.max(...cur.rows.map(r => r.gy));
      cur.lastX = l.x;
    } else {
      groups.push({ rows: [l], text: l.text, gy: l.gy, lastY: l.gy, lastX: l.x });
    }
  }

  const labels = Array(groups.length).fill(null);
  const kinds = Array(groups.length).fill("");
  const trusted = Array(groups.length).fill(false);
  let dualCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const rows = groups[i].rows;
    const hasL = rows.some(leftHit), hasR = rows.some(rightHit);
    if (hasL && hasR) dualCount++;
    const rightHits = new Set(rows.filter(rightHit).map(r => band(r.gy))).size;
    if (hasR && !hasL) {
      labels[i] = "me"; kinds[i] = "definite-right"; trusted[i] = clen(norm(groups[i].text)) >= 4;
    } else if (hasL && !hasR) {
      labels[i] = "them"; kinds[i] = "definite-left"; trusted[i] = clen(norm(groups[i].text)) >= 4;
    } else if (hasL && hasR && rightHits >= 2) {
      labels[i] = "me"; kinds[i] = "weak-right-repeat";
    } else if (hasL && hasR) {
      kinds[i] = "double-unresolved";
    }
  }

  // 弱 me 只判自己，不给邻居传播；短 OCR 碎片也不充当明确锚点。
  for (let i = 0; i < groups.length; i++) {
    if (kinds[i] === "double-unresolved") { labels[i] = "them"; kinds[i] = "double-default-left"; }
  }
  let segStart = 0;
  const barriers = kinds.map((k, i) => k === "weak-right-repeat" ? i : -1)
    .filter(i => i >= 0)
    .concat(groups.length);
  for (const segEnd of barriers) {
    const anchors = [];
    for (let i = segStart; i < segEnd; i++) if (trusted[i]) anchors.push(i);
    for (let a = 0; a + 1 < anchors.length; a++) {
      const li = anchors[a], ri = anchors[a + 1];
      if (labels[li] === labels[ri]) continue;
      const unresolved = [];
      for (let i = li + 1; i < ri; i++) {
        if (kinds[i] === "double-default-left") unresolved.push(i);
      }
      const split = Math.floor(unresolved.length / 2); // 奇数中点归右侧锚点
      for (let rank = 0; rank < unresolved.length; rank++) {
        const i = unresolved[rank];
        labels[i] = rank < split ? labels[li] : labels[ri];
        kinds[i] = "propagated-nearest-definite";
      }
    }
    segStart = segEnd + 1;
  }

  // 这是结构先验：仅当单行精确双贴峰、且夹在两个同侧明确气泡之间时，按孤立回复取反。
  for (let i = 1; i + 1 < groups.length; i++) {
    const g = groups[i];
    if (g.rows.length !== 1 || kinds[i] !== "double-default-left") continue;
    const l = g.rows[0];
    if (trusted[i - 1] && trusted[i + 1] && labels[i - 1] === labels[i + 1] &&
        Math.abs(l.x - left) <= 3 && Math.abs(l.x + l.w - right) <= 3) {
      labels[i] = labels[i - 1] === "me" ? "them" : "me";
      kinds[i] = "single-double-sandwich-fallback";
    }
  }

  return {
    peaks: { left, right },
    speakerStats: {
      dual: dualCount,
      repeatedRight: kinds.filter(k => k === "weak-right-repeat").length,
      propagated: kinds.filter(k => k === "propagated-nearest-definite").length,
      isolatedReply: kinds.filter(k => k === "single-double-sandwich-fallback").length,
      defaultLeft: kinds.filter(k => k === "double-default-left").length,
    },
    text: groups
      .map((g, i) => labels[i] ? `[${labels[i] === "me" ? "我" : "对方"}] ${g.text}` : null)
      .filter(Boolean)
      .join("\n"),
  };
}

function renderPlain(lines) {
  const rows = [];
  for (const l of lines) {
    const row = rows[rows.length - 1];
    if (!row || l.gy - row.gy >= 18) rows.push({ gy: l.gy, parts: [l] });
    else row.parts.push(l);
  }
  return { peaks: null, text: rows.map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.text).join(" ")).join("\n") };
}

const rendered = mode === "wechat" ? renderWechat(unique) : renderPlain(unique);

// ── 报告
console.error(`帧 ${files.length} → 取 ${frames.length}（stride=${STRIDE}）`);
console.error(`固定 UI y 带: ${[...fixedBands].sort((a, b) => a - b).map(b => b * FIXED_BAND).join(", ") || "无"}`);
console.error(`总滚动 ${cum} px，文本行 ${content.length} → 去重后 ${unique.length}`);
if (rendered.peaks) console.error(`对齐峰: 左 ${rendered.peaks.left}（对方） 右 ${rendered.peaks.right}（我）`);
if (rendered.speakerStats) {
  const s = rendered.speakerStats;
  console.error(`发言人双贴峰 ${s.dual} 个：多行右峰 ${s.repeatedRight}，相邻明确气泡 ${s.propagated}，孤立回复先验 ${s.isolatedReply}，默认左峰 ${s.defaultLeft}`);
}
if (warnings.length) {
  console.error(`\n⚠ 失败自检 ${warnings.length}/${shifts.length} 对不达标 —— 结果可能缺内容：`);
  for (const w of warnings) console.error(`   ${w.pair}: ${w.reasons.join("；")}`);
} else {
  console.error(`失败自检: ${shifts.length}/${shifts.length} 对通过`);
}
if (DIAG) {
  console.error(`\n位移明细：`);
  for (const s of shifts) {
    console.error(`   ${s.from}→${s.to}  ${String(s.shift).padStart(5)}px  锚点 ${String(s.total).padStart(3)}  簇占比 ${((s.votes / (s.total || 1)) * 100).toFixed(0).padStart(3)}%  累积 ${s.cum}`);
  }
}

if (OUT) { fs.writeFileSync(OUT, rendered.text + "\n"); console.error(`\n→ ${OUT}`); }
else console.log(rendered.text);

process.exitCode = warnings.length ? 2 : 0;
