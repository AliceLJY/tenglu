/**
 * 基准复现：在 Node 里跑与 app 完全相同的算法，产出 long_node.bmp。
 * codex 移植到 RN 后用同一段录屏比对，长图高度差应 <5px。
 *
 *   node verify/run-node.js <帧目录> <抽帧fps>
 *
 * 计时口径与 M1 任务书第八节一致，六个阶段互不重叠：
 *   预扫 / 试探取帧 / 拼接 / BMP编码 / (OCR 在 app 侧) / 总耗时
 */
const S = require("../src/stitcher");
const j = require("jpeg-js"), fs = require("fs"), path = require("path");

const dir = process.argv[2], FPS = Number(process.argv[3] || 4);
if (!dir) { console.error("用法: node run-node.js <帧目录> [fps]"); process.exit(1); }
const all = fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).sort();
const DUR = (all.length / FPS) * 1000;
const dec = i => j.decode(fs.readFileSync(path.join(dir, all[i])), { useTArray: true });

const T = {};
const tAll = Date.now();

// ---- 阶段一：预扫（16 次取帧 + 解码 + 灰度 + 滚动区检测）----
let t = Date.now();
const pre = Array.from({ length: 16 }, (_, i) => Math.round((i * (all.length - 1)) / 15)).map(dec);
const w = pre[0].width, h = pre[0].height;
const { top, bottom } = S.detectScrollRegion(pre.map(im => S.toGray(im.data, w, h)), w, h);
const vh = bottom - top;
T.预扫 = Date.now() - t;

// ---- 阶段二：试探取帧（walkKeyframes 全程，含其内部每次取帧+解码）----
let grabMs = 0, grabN = 0;
const grab = async ms => {
  const g0 = Date.now();
  const im = dec(Math.min(all.length - 1, Math.max(0, Math.round((ms / 1000) * FPS))));
  const r = S.cropRows(im.data, w, top, bottom);
  grabMs += Date.now() - g0; grabN++;
  return r;
};

(async () => {
  t = Date.now();
  const { frames, times, probes, warnings } = await S.walkKeyframes(grab, DUR, w, vh);
  T.试探取帧 = Date.now() - t;

  // ---- 阶段三：拼接 ----
  // walkKeyframes 返回的 frames 全部是已确认的关键帧，这里传 identity indices。
  // 不要再调 pickKeyframes —— 那是给"已有完整帧序列"的旧路径用的，
  // 在这里二次筛帧会偏离基准。
  t = Date.now();
  const out = S.stitch(frames, frames.map((_, i) => i), w, vh);
  T.拼接 = Date.now() - t;

  // ---- 阶段四：BMP 编码（无损；不要用 jpeg-js 编码）----
  t = Date.now();
  const bmp = S.encodeBMP(out.canvas, out.width, out.height);
  fs.writeFileSync(path.join(__dirname, "long_node.bmp"), Buffer.from(bmp));
  T.BMP编码 = Date.now() - t;

  T.总耗时 = Date.now() - tAll;

  console.log(`滚动区 y${top}~${bottom} (高 ${vh})`);
  console.log(`探测 ${probes} 次 → 关键帧 ${frames.length} 张 @ ${times.map(x => (x / 1000).toFixed(1) + "s").join(" ")}`);
  console.log(`长图 ${out.width}x${out.height} → long_node.bmp (${(bmp.length / 1048576).toFixed(1)} MB)`);
  console.log(`耗时 ms: ${JSON.stringify(T)}`);
  console.log(`  其中取帧+解码 ${grabMs}ms / ${grabN} 次（含在「试探取帧」内）`);
  warnings.forEach(x => console.log("  ⚠", x));
})();
