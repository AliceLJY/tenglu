/**
 * 基准复现：在 Node 里跑与 app 完全相同的算法，产出 long_node.bmp。
 * codex 移植到 RN 后用同一段录屏比对，长图高度差应 <5px。
 *
 *   node verify/run-node.js <帧目录> <抽帧fps> [wechat|xiaohongshu|generic]
 *
 * L3 主路径与 app 一致：先裁滚动区，再融合生成小灰图；关键帧才二次解码。
 * Node 已经拿到抽好的 JPEG，因此 shiftThumbMs 和 pauseMs 固定为 0。
 */
const S = require("../src/stitcher");
const { reconcileFrameShiftTiming } = require("../src/pipeline-utils");
const j = require("jpeg-js"), fs = require("fs"), path = require("path");

const dir = process.argv[2], FPS = Number(process.argv[3] || 4);
const app = process.argv[4] || "generic";
const preset = S.PRESETS[app] || S.PRESETS.generic;
if (!dir) { console.error("用法: node run-node.js <帧目录> [fps] [wechat|xiaohongshu|generic]"); process.exit(1); }
const all = fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).sort();
const DUR = (all.length / FPS) * 1000;
const dec = i => j.decode(fs.readFileSync(path.join(dir, all[i])), { useTArray: true });
const now = () => globalThis.performance?.now?.() ?? Date.now();

function assertSameFrameSize(image, width, height) {
  if (image.width !== width || image.height !== height) {
    throw new Error(
      `录屏帧尺寸中途变化：预期 ${width}x${height}，实际 ${image.width}x${image.height}。`,
    );
  }
}

const T = {};
const detail = {
  shiftThumbMs: 0,
  decodeMs: 0,
  grayMs: 0,
  shiftMs: 0,
  keyframeMs: 0,
  pauseMs: 0,
};
const tAll = now();

// ---- 阶段一：预扫（PRESETS[app].preScan 次取帧 + 解码 + 灰度 + 滚动区检测）----
let t = now();
const N = preset.preScan;
const preIndices = Array.from(
  { length: N },
  (_, i) => Math.round((i * (all.length - 1)) / (N - 1)),
);
const preGrays = [];
let w = 0, h = 0;
for (let i = 0; i < preIndices.length; i++) {
  const image = dec(preIndices[i]);
  if (i === 0) {
    w = image.width;
    h = image.height;
  } else {
    assertSameFrameSize(image, w, h);
  }
  preGrays.push(S.toGray(image.data, w, h));
}
const reg = S.detectScrollRegion(preGrays, w, h);
preGrays.length = 0;
if (!reg.ok) { console.error(`✗ 滚动区检测失败：y${reg.top}~${reg.bottom} 只占屏高 ${((reg.bottom-reg.top)/h*100).toFixed(1)}%，加大预扫帧数或换素材`); process.exit(1); }
const { top, bottom } = reg;
const vh = bottom - top;
T.预扫 = Math.round(now() - t);

// ---- 阶段二：取帧（固定间隔全取 + 逐帧位移）----
// 主路径就是"按固定 fps 全取"，不做试探。理由是 Alice 的判断：
//   滚动快 = 用户认为那段不重要（快速划过正文），滚动慢 = 重要（评论区）。
//   所以不需要精确控制每帧的位移落点 —— 快滑段丢一点正是用户想丢的，
//   慢滑段重叠多也无所谓，重复交给输出层 dedupeLines() 收拾。
// 试探取帧（walkKeyframes）已废弃：它省的是抽帧次数，而真机实测抽帧只占 4.3%，
// 即使降到 0 也只省 4%，且它有三次修复失败的已知缺陷。见 stitcher.js 该函数注释。
t = now();
const shifts = [];
let previousCoarseGray = null;
for (let i = 0; i < all.length; i++) {
  let started = now();
  const image = dec(i);
  detail.decodeMs += now() - started;
  assertSameFrameSize(image, w, h);

  started = now();
  const coarseGray = S.prepareFrameCoarseGray(image.data, w, h, top, bottom);
  detail.grayMs += now() - started;

  if (previousCoarseGray) {
    started = now();
    shifts.push(S.estimateShiftCoarsePrepared(previousCoarseGray, coarseGray));
    detail.shiftMs += now() - started;
  }
  previousCoarseGray = coarseGray;
}

let started = now();
const { keep, dropped, tooFar } = S.pickKeyframes(shifts, vh);
const regions = new Array(all.length);
detail.keyframeMs += now() - started;
previousCoarseGray = null;
for (const frameIndex of keep) {
  started = now();
  const image = dec(frameIndex);
  assertSameFrameSize(image, w, h);
  regions[frameIndex] = S.cropRows(image.data, w, top, bottom).slice();
  detail.keyframeMs += now() - started;
}
const frameShiftRaw = now() - t;
T.取帧与位移 = Math.round(frameShiftRaw);
const timingReconciliation = reconcileFrameShiftTiming(frameShiftRaw, detail);
const detailRounded = Object.fromEntries(
  Object.entries(detail).map(([key, value]) => [key, Math.round(value)]),
);

// ---- 阶段三：拼接 ----
t = now();
const out = S.stitch(regions, keep, w, vh);
T.拼接 = Math.round(now() - t);

// ---- 阶段四：BMP 编码（无损；不要用 jpeg-js 编码）----
t = now();
const bmp = S.encodeBMP(out.canvas, out.width, out.height);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
// 产物一律落 verify/out/ —— 该目录整个被 gitignore。
// 2026-08-28 事故：长图曾因 .gitignore 按文件名写死（long_node.jpg）而在改成 BMP 后
// 混进三个 commit。现在双保险：按类型拦 + 独立忽略目录。
fs.writeFileSync(path.join(outDir, "long_node.bmp"), Buffer.from(bmp));
T.BMP编码 = Math.round(now() - t);

T.总耗时 = Math.round(now() - tAll);

console.log(`[${app}] 预扫 ${N} 帧 → 滚动区 y${top}~${bottom} (高 ${vh})`);
console.log(`${all.length} 帧 → 关键帧 ${keep.length} 张` + (dropped ? `，丢弃回弹帧 ${dropped}` : "") + (tooFar ? `  ⚠ ${tooFar} 处滑动过快、两帧间无重叠，该段内容已丢失` : ""));
console.log(`长图 ${out.width}x${out.height} → out/long_node.bmp (${(bmp.length / 1048576).toFixed(1)} MB)`);
console.log(`耗时 ms: ${JSON.stringify(T)}`);
console.log(`细分 ms: ${JSON.stringify(detailRounded)}`);
if (timingReconciliation.shouldWarn) {
  console.log(
    `  ⚠ 位移阶段对账差额 ${Math.round(timingReconciliation.unclassifiedMs)}ms，` +
    `超过 ${Math.round(timingReconciliation.thresholdMs)}ms 告警阈值`,
  );
}
(out.warnings || []).forEach(x => console.log("  ⚠", x));   // 与 app 同裁定：告警必须可见
