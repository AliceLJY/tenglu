/**
 * 基准复现脚本：在 Node 里跑与 app 完全相同的算法，产出 expected_long.jpg。
 * codex 移植到 RN 后，用同一段录屏比对，长图高度差应 <5px。
 *   node verify/run-node.js <帧目录> <抽帧fps>
 */
const S = require("../src/stitcher");
const j = require("jpeg-js"), fs = require("fs"), path = require("path");
const dir = process.argv[2], FPS = Number(process.argv[3] || 4);
const all = fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).sort();
const DUR = (all.length / FPS) * 1000;
const dec = i => j.decode(fs.readFileSync(path.join(dir, all[i])), { useTArray: true });

const pre = Array.from({ length: 16 }, (_, i) => Math.round((i * (all.length - 1)) / 15)).map(dec);
const w = pre[0].width, h = pre[0].height;
const { top, bottom } = S.detectScrollRegion(pre.map(im => S.toGray(im.data, w, h)), w, h);
const vh = bottom - top;
const grab = async ms => S.cropRows(dec(Math.min(all.length - 1, Math.max(0, Math.round((ms / 1000) * FPS)))).data, w, top, bottom);

(async () => {
  const t0 = Date.now();
  const { frames, times, probes, warnings } = await S.walkKeyframes(grab, DUR, w, vh);
  const out = S.stitch(frames, frames.map((_, i) => i), w, vh);
  console.log(`滚动区 y${top}~${bottom} (高 ${vh})`);
  console.log(`探测 ${probes} 次 → 关键帧 ${frames.length} 张 @ ${times.map(t => (t / 1000).toFixed(1) + "s").join(" ")}`);
  console.log(`长图 ${out.width}x${out.height}，耗时 ${Date.now() - t0}ms`);
  warnings.forEach(x => console.log("  ⚠", x));
  fs.writeFileSync(path.join(__dirname, "long_node.jpg"),
    j.encode({ data: Buffer.from(out.canvas), width: out.width, height: out.height }, 88).data);
})();
