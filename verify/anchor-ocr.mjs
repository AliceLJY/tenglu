#!/usr/bin/env node
/**
 * 文本锚点架构（M3 验证）：直接从每帧 OCR 结果还原长文本；只有满宽歧义气泡
 * 在显式传入 --frames 时才用 djpeg 解码对应文本框的小区域。
 *
 *   node anchor-ocr.mjs <OCR缓存目录> <wechat|plain> [--stride N] [--frames 帧目录] [--out out.md] [--diag]
 *
 * 与现有拼接架构的分工：拼接架构靠像素对齐（jpeg-js 解码 + SAD 粗搜 + 拼长图），
 * 本脚本靠文本自身携带的几何信息；像素只用于坐标无法区分的发言人：
 *
 *   1. 固定 UI —— 某个 y 带在 ≥80% 的帧里都有文本行 ⇒ 它不随内容滚动
 *   2. 帧间位移 —— 相邻帧的共同文本行，y 差按 ±3px 聚类投票，最大簇的中位数
 *   3. 发言人   —— 单侧对齐峰直接判；双贴峰时可选 djpeg 小区域底色判定
 *   4. 去重     —— 累积位移映射全局 y，在可靠位移路径内按文本框位置合并
 *
 * 失败自检见 checkAnchors()：锚点 0 明确无重叠，1–2 个不可单独采信；
 * 锚点足够后再检查投票是否分散。任一情况都报警，不静默降级。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sampleBrightMedianRgb } = require("../src/ocr-utils.js");
const { classifyBubbleColor } = require("../src/postprocess.js");

// ── 参数
const argv = process.argv.slice(2);
const cacheDir = argv[0];
const mode = argv[1] ?? "plain";
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const framesArg = argv.indexOf("--frames");
if (framesArg >= 0 && (!argv[framesArg + 1] || argv[framesArg + 1].startsWith("--"))) {
  console.error("参数错误：--frames 后必须提供帧目录");
  process.exit(1);
}
const STRIDE = Number(opt("stride", 7));
const FRAME_DIR = opt("frames", null);
const OUT = opt("out", null);
const DIAG = argv.includes("--diag");
if (!cacheDir) {
  console.error("用法: node anchor-ocr.mjs <OCR缓存目录> <wechat|plain> [--stride N] [--frames 帧目录] [--out f.md] [--diag]");
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
const DJPEG_BIN = process.env.DJPEG_BIN ?? "djpeg";

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

function parsePpm(buffer) {
  let offset = 0;
  const isSpace = value => value === 9 || value === 10 || value === 13 || value === 32;
  const token = () => {
    while (offset < buffer.length) {
      if (isSpace(buffer[offset])) { offset++; continue; }
      if (buffer[offset] === 35) {
        while (offset < buffer.length && buffer[offset] !== 10) offset++;
        continue;
      }
      break;
    }
    const start = offset;
    while (offset < buffer.length && !isSpace(buffer[offset])) offset++;
    return buffer.subarray(start, offset).toString("ascii");
  };

  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (magic !== "P6" || !Number.isInteger(width) || !Number.isInteger(height) || max !== 255) {
    throw new Error(`djpeg 返回了不支持的 PPM：${magic} ${width}x${height} max=${max}`);
  }
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
  else if (isSpace(buffer[offset])) offset++;
  const expected = width * height * 3;
  if (buffer.length - offset < expected) {
    throw new Error(`djpeg PPM 像素不足：需要 ${expected}，实际 ${buffer.length - offset}`);
  }
  return { width, height, rgb: buffer.subarray(offset, offset + expected) };
}

function rgbToRgba(rgb) {
  const rgba = new Uint8Array(rgb.length / 3 * 4);
  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
    rgba[dst] = rgb[src];
    rgba[dst + 1] = rgb[src + 1];
    rgba[dst + 2] = rgb[src + 2];
    rgba[dst + 3] = 255;
  }
  return rgba;
}

function sampleLineColor(line) {
  const frame = frames[line.frameIndex];
  if (!frame) throw new Error(`找不到 frameIndex=${line.frameIndex} 对应的帧`);
  const imageName = frame.name.replace(/\.json$/i, ".jpg");
  const imagePath = path.join(FRAME_DIR, imageName);
  if (!fs.existsSync(imagePath)) throw new Error(`找不到原始帧：${imagePath}`);

  const left = Math.max(0, Math.floor(line.x));
  const top = Math.max(0, Math.floor(line.y));
  const right = Math.ceil(line.x + line.w);
  const bottom = Math.ceil(line.y + line.h);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) throw new Error("无效文本框");

  const started = process.hrtime.bigint();
  const decoded = spawnSync(DJPEG_BIN, [
    "-crop", `${width}x${height}+${left}+${top}`,
    "-pnm",
    imagePath,
  ], { encoding: null, maxBuffer: 4 * 1024 * 1024 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (decoded.error) {
    const hint = decoded.error.code === "ENOENT"
      ? `（请安装 jpeg-turbo，或用 DJPEG_BIN 指定 djpeg 路径）`
      : "";
    throw new Error(`djpeg 启动失败：${decoded.error.message}${hint}`);
  }
  if (decoded.status !== 0) {
    throw new Error(`djpeg 裁剪失败（exit ${decoded.status}）：${decoded.stderr?.toString().trim()}`);
  }

  const ppm = parsePpm(decoded.stdout);
  const extraLeft = ppm.width - width;
  if (extraLeft < 0 || ppm.height < height) {
    throw new Error(`djpeg 裁剪尺寸异常：请求 ${width}x${height}，得到 ${ppm.width}x${ppm.height}`);
  }
  const rgba = rgbToRgba(ppm.rgb);
  const rgb = sampleBrightMedianRgb(rgba, ppm.width, ppm.height, {
    left: extraLeft,
    top: 0,
    width,
    height,
  });
  const color = classifyBubbleColor(rgb);
  return {
    side: color === "self" ? "me" : color === "other" ? "them" : null,
    rgb,
    frame: imageName,
    box: { x: left, y: top, w: width, h: height },
    cropOutputPixels: ppm.width * ppm.height,
    sampledPixels: width * height,
    elapsedMs,
  };
}

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
  const pixelSamples = [];
  const speakerWarnings = [];
  let dualCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const rows = groups[i].rows;
    const hasL = rows.some(leftHit), hasR = rows.some(rightHit);
    const rightHits = new Set(rows.filter(rightHit).map(r => band(r.gy))).size;
    if (hasR && !hasL) {
      labels[i] = "me"; kinds[i] = "definite-right";
    } else if (hasL && !hasR) {
      labels[i] = "them"; kinds[i] = "definite-left";
    } else if (hasL && hasR) {
      dualCount++;
      if (FRAME_DIR) {
        const sampleRow = [...rows].sort((a, b) => b.w * b.h - a.w * a.h)[0];
        try {
          const sample = sampleLineColor(sampleRow);
          pixelSamples.push({ group: i, ...sample });
          if (sample.side) {
            labels[i] = sample.side;
            kinds[i] = "pixel-color";
          } else {
            kinds[i] = "pixel-unresolved";
            speakerWarnings.push(`气泡 ${i + 1} 底色未判定（${sample.frame}）`);
          }
        } catch (error) {
          kinds[i] = "pixel-error";
          speakerWarnings.push(`气泡 ${i + 1} 采样失败：${error.message}`);
        }
      } else if (rightHits >= 2) {
        labels[i] = "me";
        kinds[i] = "weak-right-repeat";
      } else {
        labels[i] = "them";
        kinds[i] = "double-default-left";
      }
    }
  }

  return {
    peaks: { left, right },
    speakerSamples: pixelSamples,
    speakerWarnings,
    speakerStats: {
      dual: dualCount,
      mode: FRAME_DIR ? "pixel" : "geometry",
      pixelResolved: kinds.filter(k => k === "pixel-color").length,
      pixelMe: pixelSamples.filter(s => s.side === "me").length,
      pixelThem: pixelSamples.filter(s => s.side === "them").length,
      pixelUnresolved: kinds.filter(k => k === "pixel-unresolved" || k === "pixel-error").length,
      pixelMs: pixelSamples.reduce((sum, s) => sum + s.elapsedMs, 0),
      cropOutputPixels: pixelSamples.reduce((sum, s) => sum + s.cropOutputPixels, 0),
      sampledPixels: pixelSamples.reduce((sum, s) => sum + s.sampledPixels, 0),
      repeatedRight: kinds.filter(k => k === "weak-right-repeat").length,
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
  if (s.mode === "pixel") {
    console.error(`发言人双贴峰 ${s.dual} 个：局部像素判定 ${s.pixelResolved}（我 ${s.pixelMe}，对方 ${s.pixelThem}，未定 ${s.pixelUnresolved}）`);
    console.error(`局部像素采样：djpeg 输出 ${s.cropOutputPixels} px，实际文本框 ${s.sampledPixels} px，djpeg 合计 ${s.pixelMs.toFixed(1)} ms`);
  } else {
    console.error(`发言人双贴峰 ${s.dual} 个：纯坐标多行右峰 ${s.repeatedRight}，默认左峰 ${s.defaultLeft}`);
  }
}
if (rendered.speakerWarnings?.length) {
  console.error(`\n⚠ 发言人采样 ${rendered.speakerWarnings.length}/${rendered.speakerStats.dual} 个未解决：`);
  for (const warning of rendered.speakerWarnings) console.error(`   ${warning}`);
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
  if (rendered.speakerSamples?.length) {
    console.error(`\n发言人局部像素明细：`);
    for (const sample of rendered.speakerSamples) {
      const { x, y, w, h } = sample.box;
      const rgb = sample.rgb ? sample.rgb.map(v => Math.round(v)).join(",") : "无";
      const side = sample.side === "me" ? "我" : sample.side === "them" ? "对方" : "未定";
      console.error(`   气泡 ${sample.group + 1}  ${sample.frame}  (${x},${y},${w},${h})  RGB(${rgb}) → ${side}`);
    }
  }
}

if (OUT) { fs.writeFileSync(OUT, rendered.text + "\n"); console.error(`\n→ ${OUT}`); }
else console.log(rendered.text);

process.exitCode = warnings.length || rendered.speakerWarnings?.length ? 2 : 0;
