/**
 * 滚动录屏拼接核心 —— 纯 JS，无原生依赖，可直接搬进 React Native。
 *
 * 输入：一组按时间顺序抽出的帧（RGBA 像素数组）
 * 输出：拼好的长图（RGBA 像素数组）
 *
 * 所有函数都不碰文件系统、不依赖 Node API，只接受和返回像素数组。
 * 宿主负责：Node 用 jpeg-js 读写文件；RN 用 expo-video-thumbnails 抽帧 + jpeg-js 解码。
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
 * 分离固定 UI 与滚动区：逐行算跨帧标准差。
 * <3 固定（导航栏/输入栏），>=12 滚动内容。取中间最大的连续滚动段。
 *
 * 只用后 60% 的帧取样 —— 顶部导航栏在有些 app 里是滚动后才浮现的，
 * 用整段视频会把它误判成滚动区（小红书实测）。
 */
function detectScrollRegion(grays, w, h) {
  const use = grays.slice(Math.floor(grays.length * 0.4));
  const n = use.length;
  const moving = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = 0; x < w; x += 4) {            // 横向每 4 列采一个，够用且快 4 倍
      let s = 0, s2 = 0;
      for (let k = 0; k < n; k++) {
        const v = use[k][y * w + x];
        s += v; s2 += v * v;
      }
      acc += Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    }
    moving[y] = acc / (w / 4) >= 12 ? 1 : 0;
  }
  let best = [0, 0], cur = -1;
  for (let y = 0; y <= h; y++) {
    if (y < h && moving[y]) { if (cur < 0) cur = y; }
    else if (cur >= 0) { if (y - cur > best[1] - best[0]) best = [cur, y]; cur = -1; }
  }
  return { top: best[0], bottom: best[1] };
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
  const cum = [0];
  let acc = 0, dropped = 0;
  for (const s of shifts) {
    if (s.dy < 0) dropped++;
    acc += Math.max(0, s.dy);
    cum.push(acc);
  }
  const keep = [0];
  let last = 0, tooFar = 0;
  for (let k = 1; k < cum.length; k++) {
    if (cum[k] - cum[last] > viewH * overlap) {
      const cand = k - 1 > last ? k - 1 : k;
      if (cum[cand] - cum[last] >= viewH) tooFar++;
      keep.push(cand);
      last = cand;
    }
  }
  if (keep[keep.length - 1] !== cum.length - 1) keep.push(cum.length - 1);
  return { keep, dropped, tooFar };
}

/**
 * 拼接。关键帧之间重新做一次性匹配，不沿用逐帧累积值 ——
 * 累积每帧半个像素，跨 20 帧就漂 3-4px。
 */
function stitch(frames, keep, w, viewH) {
  const grays = keep.map(k => toGray(frames[k], w, viewH));
  const off = [0];
  for (let i = 1; i < grays.length; i++) {
    const { dy } = estimateShift(grays[i - 1], grays[i], w, viewH);
    off.push(off[i - 1] + Math.max(0, dy));
  }
  const H = off[off.length - 1] + viewH;
  const canvas = new Uint8Array(w * H * 4);
  keep.forEach((k, i) => canvas.set(frames[k], off[i] * w * 4));
  return { canvas, width: w, height: H, offsets: off };
}

/** 从整帧 RGBA 里裁出滚动区 */
function cropRows(rgba, w, top, bottom) {
  return rgba.subarray(top * w * 4, bottom * w * 4);
}

module.exports = { toGray, detectScrollRegion, estimateShift, pickKeyframes, stitch, cropRows };

/**
 * 边抽边验：app 里的正式取帧策略。
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
  const hi = (opts.maxAdvance ?? 0.75) * viewH;
  const MIN_STEP = opts.minStepMs ?? 100;
  const maxProbes = opts.maxProbes ?? 60;

  const first = await grabFrame(0);
  const frames = [first], times = [0];
  let prevGray = toGray(first, w, viewH);
  let t = 0, step = Math.max(300, Math.min(3000, durationMs / 12));
  let probes = 1;
  const warnings = [];

  while (t < durationMs - 60 && probes < maxProbes) {
    const atEnd = t + step >= durationMs - 1;
    const nt = Math.min(durationMs - 1, t + step);
    const f = await grabFrame(nt);
    probes++;
    const g = toGray(f, w, viewH);
    const { dy, conf } = estimateShift(prevGray, g, w, viewH);

    // 迈太大 —— 不论是不是最后一帧都要收步重试，这是丢内容的唯一入口
    if (dy > hi || conf < 0.85) {
      if (step > MIN_STEP) {
        const shrink = dy > hi ? Math.max(0.35, (hi / dy) * 0.9) : 0.5;
        step = Math.max(MIN_STEP, Math.floor(step * shrink));
        continue;
      }
      // 已经收到最小步长仍然过大 = 用户在这一段滑得太快，视频里本就没拍到
      warnings.push(`t=${(nt / 1000).toFixed(1)}s 处滑动过快（单步 ${dy}px / 屏高 ${viewH}px，置信度 ${conf.toFixed(2)}），该段内容可能已丢失`);
    } else if (dy < 0) {
      step = Math.floor(step * 1.6);            // 回弹，跳过
      continue;
    } else if (dy < lo && !atEnd) {
      step = Math.floor(step * (dy > 4 ? Math.min(3, hi / Math.max(dy, 1)) : 2.5));
      continue;                                  // 前进太少，迈大一点重试
    }

    frames.push(f); times.push(nt); prevGray = g; t = nt;
    if (nt >= durationMs - 1) break;
    step = Math.max(MIN_STEP, Math.floor(step * 1.15));   // 收下后略微加速，适应越滑越快
  }
  if (probes >= maxProbes) warnings.push(`取帧探测达到上限 ${maxProbes} 次，可能未覆盖完整视频`);
  return { frames, times, probes, warnings };
}

module.exports.walkKeyframes = walkKeyframes;
