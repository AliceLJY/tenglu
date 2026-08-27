/**
 * 滚动录屏拼接核心 —— 纯 JS，无原生依赖，可直接搬进 React Native。
 *
 * 输入：一组按时间顺序抽出的帧（RGBA 像素数组）
 * 输出：拼好的长图（RGBA 像素数组）
 *
 * 所有函数都不碰文件系统、不依赖 Node API，只接受和返回像素数组。
 * 宿主负责取帧与落盘：
 *   Node — jpeg-js 读帧；RN — expo-video-thumbnails 抽帧 + jpeg-js **只用 decode**。
 * 长图落盘一律走本文件的 encodeBMP()，**不要用 jpeg-js 编码** —— JPEG 有损，OCR 会少认块。
 */

/** RGBA → 灰度（整数近似，避免浮点） */
function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return g;
}

/**
 * 分离固定 UI 与滚动区：逐行跨帧标准差 + 滞后阈值（hysteresis）。
 *
 * ⚠️ 这里试过两个更简单的做法，两个各错一半，别改回去：
 *
 *   A. 取"最大连续超阈值段" —— 上边界对，**下边界会被截断**。
 *      内容区中部的 row_std 会局部走低（大段留白、纯色图片、行距），
 *      最大连续段在那里断开。实测小红书把 y183~1508 判成 y1081~1195，只剩 114px。
 *   B. 从两端向内收缩 —— 下边界对，**上边界会吃进状态栏**。
 *      时钟/电量/录屏计时胶囊也在逐帧变化，从上往下扫第一行就超阈值。
 *      实测两段素材都判成 y6~，把状态栏当成了内容。
 *
 * 正解是滞后阈值：**高阈值找种子，低阈值向外扩**。
 *   - 中部局部走低（小红书实测降到 15，两侧 22）高于低阈值，扩展时能跨过去 → 修好 A
 *   - 状态栏与内容区之间隔着导航栏（std 接近 0，远低于低阈值），扩展到那里会停 → 修好 B
 *
 * 阈值全部自适应（取本段自己的 85 分位），不写死数字——
 * 固定 12.0 在滚动慢或对比度低的素材上会把内容区判成固定 UI。
 *
 * 取样只用后 60% 的帧：顶部导航栏在有些 app 里是滚动后才浮现的，
 * 用整段视频会把它误判成滚动区（小红书实测）。
 *
 * ⚠️ **预扫至少给 24 帧。** 微信素材 12 帧就够，但小红书在 12/16 帧时种子会落进状态栏
 * （帧太少时内容区的变化还没体现出来，而时钟和录屏计时胶囊每帧都在变），
 * 返回 y6~68 = 屏高的 3.8%。24 帧起两段素材都稳定正确。
 *
 * （坑 A 由 Minis 在 iSH 侧先撞到，本实现独立复现后连坑 B 一起解决。）
 */
function detectScrollRegion(grays, w, h, opts = {}) {
  const use = grays.slice(Math.floor(grays.length * 0.4));
  const n = use.length;
  const std = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let acc = 0, cols = 0;
    for (let x = 0; x < w; x += 4) {
      let s = 0, s2 = 0;
      for (let k = 0; k < n; k++) {
        const v = use[k][y * w + x];
        s += v; s2 += v * v;
      }
      acc += Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      cols++;
    }
    std[y] = acc / cols;
  }
  const sorted = Array.from(std).sort((a, b) => a - b);
  const p85 = sorted[Math.floor(sorted.length * 0.85)];
  const hi = Math.max(10, p85 * (opts.hiRatio ?? 0.70));   // 种子阈值
  const lo = Math.max(4, p85 * (opts.loRatio ?? 0.28));    // 扩展阈值

  // 1) 用高阈值找最长的连续段作为种子
  let bs = 0, be = 0, cs = -1;
  for (let y = 0; y <= h; y++) {
    if (y < h && std[y] >= hi) { if (cs < 0) cs = y; }
    else if (cs >= 0) { if (y - cs > be - bs) { bs = cs; be = y; } cs = -1; }
  }
  if (be === bs) return { top: 0, bottom: h, threshold: hi, seed: [0, h] };

  // 2) 用低阈值从种子向两端扩展，允许跨过短缺口
  const GAP = opts.gap ?? 40;
  let top = bs;
  for (let y = bs - 1; y >= 0; y--) {
    if (std[y] >= lo) { top = y; continue; }
    let j = y, run = 0;
    while (j >= 0 && std[j] < lo && run < GAP) { j--; run++; }
    if (run >= GAP || j < 0) break;      // 缺口太长 = 真的到边界了（导航栏）
    top = j; y = j;
  }
  let bottom = be;
  for (let y = be; y < h; y++) {
    if (std[y] >= lo) { bottom = y + 1; continue; }
    let j = y, run = 0;
    while (j < h && std[j] < lo && run < GAP) { j++; run++; }
    if (run >= GAP || j >= h) break;
    bottom = j + 1; y = j;
  }
  // 自检：内容区不可能只占屏幕的一小条。低于 30% 基本是种子落错了地方
  // （实测小红书预扫只给 12/16 帧时，种子落进状态栏，返回 y6~68 = 屏高的 3.8%）。
  // 这是这个函数唯一能自己发现失败的信号，调用方必须处理，不要静默接受。
  const ok = (bottom - top) >= h * 0.3;
  return { top, bottom, threshold: hi, seed: [bs, be], ok };
}

const DS = 4, OFF = 60, BAND = 300, REFINE = 24;

function downsample(g, w, h) {
  const dw = (w / DS) | 0, dh = (h / DS) | 0, out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) out[y * dw + x] = g[y * DS * w + x * DS];
  return { d: out, dw, dh };
}

function sad(a, aw, ay, b, bw, by, tw, th, stride = 1) {
  let s = 0;
  for (let y = 0; y < th; y += stride) {
    const ia = (ay + y) * aw, ib = (by + y) * bw;
    for (let x = 0; x < tw; x++) s += Math.abs(a[ia + x] - b[ib + x]);
  }
  return s;
}

/**
 * 估计 newG 相对 oldG 向上滚动了多少像素。
 * 两级搜索：降采样 4 倍全范围粗搜 → 全分辨率 ±24px 精搜。
 * 判据用 SAD 而非归一化互相关：同一段视频的帧同源、无亮度差，SAD 更快且精度相同。
 * 返回 dy<0 表示回弹（滑到底的橡皮筋），调用方应丢弃该帧。
 */
function estimateShift(oldG, newG, w, h) {
  const A = downsample(oldG, w, h), B = downsample(newG, w, h);
  const dOFF = (OFF / DS) | 0, dBAND = (BAND / DS) | 0;
  let best = Infinity, bestY = 0;
  for (let y = 0; y + dBAND <= A.dh; y++) {
    const s = sad(A.d, A.dw, y, B.d, B.dw, dOFF, A.dw, dBAND);
    if (s < best) { best = s; bestY = y; }
  }
  const coarse = bestY * DS;
  let fb = Infinity, fy = coarse;
  const lo = Math.max(0, coarse - REFINE), hi = Math.min(h - BAND, coarse + REFINE);
  for (let y = lo; y <= hi; y++) {
    const s = sad(oldG, w, y, newG, w, OFF, w, BAND);
    if (s < fb) { fb = s; fy = y; }
  }
  // 归一化一个粗糙的置信度：SAD 越小越像
  const conf = 1 - Math.min(1, fb / (w * BAND * 64));
  return { dy: fy - OFF, conf };
}

/**
 * 选关键帧。相邻关键帧的间隔必须小于一屏，否则两帧之间没有重叠、
 * 后面的一次性匹配会失败并静默少算位移（丢内容）。所以一旦某帧跨过上限
 * 就回退选它的前一帧，而不是"选第一个超过 60% 的帧"。
 */
function pickKeyframes(shifts, viewH, overlap = 0.6) {
  // 回弹帧（相对前一帧位移为负的帧）从候选里真实排除。
  // 早期版本只数了个 dropped 计数、什么都没排除——微信素材上结果碰巧正确
  // （回弹帧的 cum 与前帧相同、不触发选帧），但那是巧合不是保证：
  // cand = k-1 恰落在回弹帧上、或末尾强制帧是回弹帧时，一张"正在回弹中"的
  // 过渡画面就会进 keep。Codex 冷读时指出计数与行为不符。
  const rebound = new Set();
  const cum = [0];
  let acc = 0;
  shifts.forEach((s, i) => {
    if (s.dy < 0) rebound.add(i + 1);          // 帧 i+1 相对帧 i 在回弹
    acc += Math.max(0, s.dy);
    cum.push(acc);
  });
  const prevSolid = k => { while (k > 0 && rebound.has(k)) k--; return k; };

  const keep = [0];
  let last = 0, tooFar = 0;
  for (let k = 1; k < cum.length; k++) {
    if (cum[k] - cum[last] > viewH * overlap) {
      let cand = k - 1 > last ? k - 1 : k;
      cand = prevSolid(cand);                   // 候选是回弹帧 → 往前找实帧
      if (cand <= last) cand = rebound.has(k) ? prevSolid(k) : k;
      if (cand <= last) continue;               // 附近全是回弹，等下一个
      if (cum[cand] - cum[last] >= viewH) tooFar++;
      keep.push(cand);
      last = cand;
    }
  }
  const tail = prevSolid(cum.length - 1);       // 末尾也取最后一个非回弹帧
  if (tail > keep[keep.length - 1]) keep.push(tail);
  return { keep, dropped: rebound.size, tooFar };
}

/**
 * 拼接。关键帧之间重新做一次性匹配，不沿用逐帧累积值 ——
 * 累积每帧半个像素，跨 20 帧就漂 3-4px。
 */
function stitch(frames, keep, w, viewH) {
  // 关键帧之间做一次性匹配定位。位移 <= 0 的帧【跳过不贴】——
  // 它相对上一个已贴帧没有带来新内容（用户往回滚了）。
  // 早期版本把负位移夹成 0 仍然贴上去，两帧落在同一位置、后帧覆盖前帧，
  // 正是规格禁止的同位置覆盖（"真真假假"重影事故就是这个形状）。
  // 跳过的帧继续以上一个已贴帧为参照去匹配下一帧，链不断。
  const grays = keep.map(k => toGray(frames[k], w, viewH));
  const placedIdx = [0];                        // keep 内下标
  const off = [0];
  let skipped = 0;
  const warnings = [];
  for (let i = 1; i < grays.length; i++) {
    const ref = placedIdx[placedIdx.length - 1];
    const { dy, conf } = estimateShift(grays[ref], grays[i], w, viewH);
    if (conf < 0.5) {
      // 页面跳转（内容整体切换，不是滚动）：两侧帧之间不存在真实位移，
      // 匹配结果是垃圾值——直接采用会贴出错位内容，跳过不贴又会让 anchor
      // 卡死在跳转前、后面全丢（Minis 在 iSH 侧实测：卡死让长图 13861 只剩 7657）。
      // 按它验证过的方案：保守推进 0.95×视口（宁可多不可少，重叠交给去重），
      // 把跳转后的帧当新 anchor 贴上，链继续。
      warnings.push(`关键帧 ${i} 与前帧匹配置信度仅 ${conf.toFixed(2)}（疑似页面跳转），按 0.95 屏保守推进`);
      placedIdx.push(i);
      off.push(off[off.length - 1] + Math.round(viewH * 0.95));
      continue;
    }
    if (dy <= 0) { skipped++; continue; }
    placedIdx.push(i);
    off.push(off[off.length - 1] + dy);
  }
  const H = off[off.length - 1] + viewH;
  const canvas = new Uint8Array(w * H * 4);
  placedIdx.forEach((pi, j) => canvas.set(frames[keep[pi]], off[j] * w * 4));
  return { canvas, width: w, height: H, offsets: off, skipped, warnings };
}

/** 从整帧 RGBA 里裁出滚动区 */
function cropRows(rgba, w, top, bottom) {
  return rgba.subarray(top * w * 4, bottom * w * 4);
}

/**
 * RGBA → 24 位 BMP。给 RN 用：中间盘绝对不能用 JPEG。
 *
 * 实测同一张长图送同一个 OCR：PNG 71 块 661 字符、BMP 71 块 661 字符（完全一致），
 * 而 JPEG q92 只有 69 块 655 字符 —— 有损压缩会吃掉文字边缘，OCR 少认两块。
 * Minis 在 iSH 侧独立测到同样现象（JPEG 比 BMP 少认一块）。
 *
 * 选 BMP 而不是 PNG 的理由是编码成本：BMP 就是拼个 54 字节头再倒着写像素，
 * PNG 要走 zlib，在模拟层/低端机上慢几十倍（Minis 实测 PNG 2431ms vs BMP 46ms）。
 */
function encodeBMP(rgba, w, h) {
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;   // 每行 4 字节对齐
  const pixSize = rowSize * h;
  const out = new Uint8Array(54 + pixSize);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;                          // "BM"
  dv.setUint32(2, 54 + pixSize, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);                            // DIB 头长度
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);                              // 正数 = 行序自下而上
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);                            // 24 bpp
  dv.setUint32(34, pixSize, true);
  for (let y = 0; y < h; y++) {
    let dst = 54 + (h - 1 - y) * rowSize;                // BMP 最后一行在最前
    let src = y * w * 4;
    for (let x = 0; x < w; x++, src += 4) {
      out[dst++] = rgba[src + 2];                        // B
      out[dst++] = rgba[src + 1];                        // G
      out[dst++] = rgba[src];                            // R
    }
  }
  return out;
}

/**
 * 各 app 的预设。预扫帧数不做通用值 —— app 类型是用户一秒能回答的事，
 * 问一句比让算法去猜可靠得多，也省掉一半抽帧成本。
 *
 * preScan 的下限由"种子会不会落进状态栏"决定：帧太少时内容区的跨帧变化
 * 还没体现出来，而时钟/电量/录屏计时胶囊每帧都在变，种子就会落到顶部那一条。
 * 实测微信 12 帧已稳定正确，小红书要 24 帧（12/16 帧时返回 y6~68 = 屏高 3.8%）。
 */
const PRESETS = {
  wechat:      { preScan: 12, mode: "wechat" },   // 微信聊天：滚动慢、气泡有色差
  xiaohongshu: { preScan: 24, mode: "plain"  },   // 小红书评论：滚动快、通篇左对齐
  generic:     { preScan: 24, mode: "plain"  },   // 不确定就用它，多花约 12 次抽帧
};

/**
 * 输出层去重：拼接产生的重影会让同一段内容出现两次。
 *
 * 设计原则（Alice 定的）：**拼接层宁可多不可少 —— 重复能去掉，丢失补不回来。**
 * 所以位移估计偏保守、宁可多贴一帧，重叠部分交给这里收拾。
 *
 * 只去"长行 + 近距离"的重复：
 *   - 短行不动（"哈哈哈""真的""是的"在真实对话里本来就会重复出现）
 *   - 窗口限定在最近 WINDOW 行内（重影总是近距离的；隔了几百行的相同长句更可能是真内容）
 *
 * 这是第二道防线：第一道在拼接层（stitch 跳过负位移帧，回弹修复后小红书 OCR
 * 重复组从 12 降到 2）。本函数兜住剩下的——实测微信一行没删、准确率不变。
 */
function dedupeLines(lines, opts = {}) {
  const MINLEN = opts.minLen ?? 8;
  const WINDOW = opts.window ?? 40;
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length >= MINLEN) {
      const from = Math.max(0, out.length - WINDOW);
      if (out.slice(from).some(x => x.trim() === t)) continue;
    }
    out.push(line);
  }
  return out;
}

module.exports = { PRESETS, encodeBMP, dedupeLines, toGray, detectScrollRegion, estimateShift, pickKeyframes, stitch, cropRows };

/**
 * 边抽边验取帧 —— ⚠️ M2 可选优化，M1 不要用（主路径是固定 fps 全取）。\n *\n * 它在\u201c前段静止后段猛滑\u201d的素材上找不到落点（小红书实测 60 次探测只收 1 帧），\n * 三次修复尝试全部失败，记录见 PLAN.md「取帧策略」节。
 *
 * 不要"均匀抽 N 帧再算位移"——稀疏帧之间可能跨过回弹或快速滑动段，
 * 匹配会静默错位并高估总位移（实测均匀抽 12 帧把 3739 高估成 4224，长图多出 485px 重影）。
 *
 * 这里改成每抽一帧就跟「上一个已确认的关键帧」直接匹配：
 *   位移过大 → 时间点往回收，重抽；过小 → 往前推，重抽；落在目标区间才收下。
 * 每次匹配都是关键帧对关键帧，无累积误差，也不需要密集帧。
 *
 * @param grabFrame  async (timeMs) => RGBA（已裁到滚动区），由宿主实现
 * @param durationMs 视频时长
 * @param w, viewH   滚动区宽高
 */
async function walkKeyframes(grabFrame, durationMs, w, viewH, opts = {}) {
  const lo = (opts.minAdvance ?? 0.45) * viewH;
  const target = (opts.targetAdvance ?? 0.58) * viewH;
  const hi = (opts.maxAdvance ?? 0.65) * viewH;
  const MIN_STEP = opts.minStepMs ?? 80;
  const maxProbes = opts.maxProbes ?? 60;

  const first = await grabFrame(0);
  const frames = [first], times = [0];
  let prevGray = toGray(first, w, viewH);
  let t = 0, probes = 1;
  const warnings = [];

  // 起步先用小步测滚动速度，不要拿"时长/12"猜。
  // 猜出来的步长在滚得快的素材上会一路超上限、反复回退空转：
  // 实测小红书（10412px/32s，比微信快 3 倍）用猜的起步会耗尽 60 次探测才走到 7.4s。
  // Minis 在 iSH 侧撞到同一问题（空转 135 次 / 100 秒），解法一致。
  let step = opts.probeStepMs ?? 500;
  let pxPerMs = 0;

  while (t < durationMs - 60 && probes < maxProbes) {
    const nt = Math.min(durationMs - 1, t + Math.max(MIN_STEP, Math.round(step)));
    const f = await grabFrame(nt);
    probes++;
    const g = toGray(f, w, viewH);
    const { dy, conf } = estimateShift(prevGray, g, w, viewH);
    const dt = nt - t;

    // 测到速度就用速度直接反推步长，避免靠试错收敛
    if (dy > 0 && conf >= 0.85 && dt > 0) pxPerMs = dy / dt;

    if (dy > hi || conf < 0.85) {
      if (step > MIN_STEP) {
        step = pxPerMs > 0
          ? Math.max(MIN_STEP, (target / pxPerMs) * 0.95)      // 有速度：一步到位
          : Math.max(MIN_STEP, step * (dy > hi ? Math.max(0.3, (hi / dy) * 0.85) : 0.5));
        continue;
      }
      warnings.push(`t=${(nt / 1000).toFixed(1)}s 处滑动过快（单步 ${dy}px / 屏高 ${viewH}px，置信度 ${conf.toFixed(2)}），该段内容可能已丢失`);
    } else if (dy < 0) {
      step = step * 1.6;
      continue;
    } else if (dy < lo && nt < durationMs - 1) {
      // 试过把这里放宽成"只要 dy>2 就收下"，想着多几个关键帧无所谓、能少几次探测。
      // 结果反而更糟：微信从 13 次探测涨到 60 次耗尽、只覆盖到 9.0s。
      // 原因是收下小位移会把 pxPerMs 估偏，后面每一步的反推都跟着错。
      // **别再往这个方向改了**，这是第三次在同一个地方翻车。
      step = pxPerMs > 0
        ? Math.min(durationMs, (target / pxPerMs) * 1.05)
        : step * 2.5;
      continue;
    }

    frames.push(f); times.push(nt); prevGray = g; t = nt;
    if (nt >= durationMs - 1) break;
    // 按刚测到的真实速度定下一步，跟得上加速/减速
    step = pxPerMs > 0 ? Math.max(MIN_STEP, target / pxPerMs) : step * 1.15;
  }
  if (probes >= maxProbes) warnings.push(`取帧探测达到上限 ${maxProbes} 次，只覆盖到 ${(t / 1000).toFixed(1)}s / ${(durationMs / 1000).toFixed(1)}s`);
  return { frames, times, probes, warnings };
}

module.exports.walkKeyframes = walkKeyframes;
