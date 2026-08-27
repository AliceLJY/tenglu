/**
 * 基准复现：在 Node 里跑与 app 完全相同的算法，产出 long_node.bmp。
 * codex 移植到 RN 后用同一段录屏比对，长图高度差应 <5px。
 *
 *   node verify/run-node.js <帧目录> <抽帧fps> [wechat|xiaohongshu|generic]
 *
 * 计时口径与 M1 任务书第八节一致，六个阶段互不重叠：
 *   预扫 / 取帧与位移 / 拼接 / BMP编码 / (OCR 在 app 侧) / 总耗时
 */
const S = require("../src/stitcher");
const j = require("jpeg-js"), fs = require("fs"), path = require("path");

const dir = process.argv[2], FPS = Number(process.argv[3] || 4);
const app = process.argv[4] || "generic";
const preset = S.PRESETS[app] || S.PRESETS.generic;
if (!dir) { console.error("用法: node run-node.js <帧目录> [fps] [wechat|xiaohongshu|generic]"); process.exit(1); }
const all = fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).sort();
const DUR = (all.length / FPS) * 1000;
const dec = i => j.decode(fs.readFileSync(path.join(dir, all[i])), { useTArray: true });

const T = {};
const tAll = Date.now();

// ---- 阶段一：预扫（PRESETS[app].preScan 次取帧 + 解码 + 灰度 + 滚动区检测）----
let t = Date.now();
const N = preset.preScan;
const pre = Array.from({ length: N }, (_, i) => Math.round((i * (all.length - 1)) / (N - 1))).map(dec);
const w = pre[0].width, h = pre[0].height;
const reg = S.detectScrollRegion(pre.map(im => S.toGray(im.data, w, h)), w, h);
if (!reg.ok) { console.error(`✗ 滚动区检测失败：y${reg.top}~${reg.bottom} 只占屏高 ${((reg.bottom-reg.top)/h*100).toFixed(1)}%，加大预扫帧数或换素材`); process.exit(1); }
const { top, bottom } = reg;
const vh = bottom - top;
T.预扫 = Date.now() - t;

// ---- 阶段二：取帧（固定间隔全取 + 逐帧位移）----
// 主路径就是"按固定 fps 全取"，不做试探。理由是 Alice 的判断：
//   滚动快 = 用户认为那段不重要（快速划过正文），滚动慢 = 重要（评论区）。
//   所以不需要精确控制每帧的位移落点 —— 快滑段丢一点正是用户想丢的，
//   慢滑段重叠多也无所谓，重复交给输出层 dedupeLines() 收拾。
// 试探取帧（walkKeyframes）作为省抽帧成本的优化留到 M2，它在
// "前段静止后段猛滑"的素材上找不到落点，见 PLAN.md「已知限制」。
let grabMs = 0, grabN = 0;
t = Date.now();
const imgs = [];
for (let i = 0; i < all.length; i++) {
  const g0 = Date.now();
  imgs.push(dec(i));
  grabMs += Date.now() - g0; grabN++;
}
const regions = imgs.map(im => S.cropRows(im.data, w, top, bottom));
const grays = regions.map(r => S.toGray(r, w, vh));
const shifts = [];
for (let i = 0; i < grays.length - 1; i++) shifts.push(S.estimateShift(grays[i], grays[i + 1], w, vh));
const { keep, dropped, tooFar } = S.pickKeyframes(shifts, vh);
T.取帧与位移 = Date.now() - t;

// ---- 阶段三：拼接 ----
t = Date.now();
const out = S.stitch(regions, keep, w, vh);
T.拼接 = Date.now() - t;

// ---- 阶段四：BMP 编码（无损；不要用 jpeg-js 编码）----
t = Date.now();
const bmp = S.encodeBMP(out.canvas, out.width, out.height);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
// 产物一律落 verify/out/ —— 该目录整个被 gitignore。
// 2026-08-28 事故：长图曾因 .gitignore 按文件名写死（long_node.jpg）而在改成 BMP 后
// 混进三个 commit。现在双保险：按类型拦 + 独立忽略目录。
fs.writeFileSync(path.join(outDir, "long_node.bmp"), Buffer.from(bmp));
T.BMP编码 = Date.now() - t;

T.总耗时 = Date.now() - tAll;

console.log(`[${app}] 预扫 ${N} 帧 → 滚动区 y${top}~${bottom} (高 ${vh})`);
console.log(`${all.length} 帧 → 关键帧 ${keep.length} 张` + (dropped ? `，丢弃回弹帧 ${dropped}` : "") + (tooFar ? `  ⚠ ${tooFar} 处滑动过快、两帧间无重叠，该段内容已丢失` : ""));
console.log(`长图 ${out.width}x${out.height} → out/long_node.bmp (${(bmp.length / 1048576).toFixed(1)} MB)`);
console.log(`耗时 ms: ${JSON.stringify(T)}`);
console.log(`  其中取帧+解码 ${grabMs}ms / ${grabN} 次（含在「取帧与位移」内）`);
(out.warnings || []).forEach(x => console.log("  ⚠", x));   // 与 app 同裁定：告警必须可见
