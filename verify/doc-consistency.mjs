#!/usr/bin/env node
/**
 * 术语一致性检查 —— 防"改了代码/决策，但文档里旧说法还在某处活着"。
 *
 * 为什么有这个脚本：2026-08-28 这一天，Codex 冷读九轮，其中五轮拦下的是同一种问题——
 * 一个决策改了，我只改了"我记得的那几处"，漏掉的那处继续和新决策打架。
 * 人工 grep 不可靠的原因是：**它依赖我想得起来该搜什么**，而漏掉的恰恰是想不起来的。
 *
 * 用法：node verify/doc-consistency.mjs   （退出码 0 通过 / 1 有冲突）
 *
 * 加一条规则的成本是一行。**决策一旦反转，先来这里加一行，再去改文档。**
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTRA = [process.env.HOME + "/Desktop/个人机遇/面试项目/誊录"];

// term: 出现即需检查的字样；allow: 允许的行内语境；allowFile: 允许的封存文件
const RULES = [
  { term: "walkKeyframes", allow: /废弃|不要用|不要复活|不要接回|任何批次|试探法后被|中途试过|历史|反例|module\.exports|^async function|^\s*\*/ },
  { term: "M2 可选", allow: null },
  { term: "降级为 M2", allow: null },
  { term: "getThumbnailAsync 可指定宽度", allow: null },
  { term: "唯一的大头", allow: /Mac 上/ },
  { term: "抽帧是最大的未知数", allow: /~~|已被真机实测推翻/ },
  // 下面这类是"曾经写过、后来被证伪"的说法。它们仍可出现，但**同一行内必须自带否定标记**——
  // 否则冷读者（人或 agent）读到那一行就会当成现行结论。
  // 2026-08-28 实证：有两处我肉眼判定"这是历史语境"而放行，废弃标记在下一行，
  // 冷读方随即又报了一次。同一行自带否定，是唯一能一行行读就读对的写法。
  { term: "运算 /16", allow: /不成立|不是|订正|⚠️/ },
  { term: "所有运算", allow: /不成立|不是|订正|⚠️/ },
  { term: "遍历约 98 万", allow: /不成立|不是|订正|错了|⚠️/ },
  { term: "收益已被数据否定", allow: /不是|订正|错的|⚠️/ },
  // L3 实施方式：只能"先裁再降"，"整帧先降"会让采样行错开 2px、破坏逐字节一致
  { term: "整帧先降采样", allow: /不是|不能|错|⚠️|会让|破坏/ },
  { term: "整帧降到", allow: /不是|不能|错|⚠️/ },
  // 归因：位移"阶段"约 2s/对是事实，但断言那 2s 属于 SAD/Hermes 是未证实的
  { term: "Hermes 上约 2s", allow: /阶段|未知|未定|待测/ },
  { term: "慢 100+ 倍", allow: /阶段|未知|未定|待测/ },
  { term: "不是减少解码", allow: /订正|⚠️|已改/ },
  // 计时项数：原 7 + 新 6 = 13
  { term: "新增五项", allow: null },
  { term: "五项细分计时", allow: null },
  { term: "五项真机计时", allow: null },
  { term: "五项必须", allow: null },
  { term: "五项细分", allow: null },
  // "位移计算 219s" 把整个阶段的耗时算在 SAD 头上；现行说法是"位移阶段"
  { term: "位移计算 219", allow: null },
  { term: "位移计算约 219", allow: null },
  { term: "逐帧位移（两级 SAD", allow: null },
  { term: "per-frame displacement (two-stage SAD", allow: null },
  { term: "逐帧 `estimateShift`", allow: null, allowFile: /交接-M1\.md$/ },
  // M3 局部像素门禁后来补跑出更低的热缓存值；禁止只保留最初两次的窄区间。
  { term: "46.1–47.6 ms", allow: null },
  { term: "3.5–3.7 ms", allow: null },
  // M3 Android 已进入独立候选路径，设计文档不能继续写成“以后再接入”。
  { term: "只说明 M3 验证通过后的 Android 接入方式", allow: null },
  { term: "这条路线目前只活在 `verify/` 下", allow: null },
  // M3 真机路线已改为独立阶段计时，不能继续要求拼接架构的固定 13 项。
  { term: "回传 13 项耗时 + Markdown", allow: null },
  // M3 Android preview 已由 EAS 编译完成，不能继续写成等待云端编译。
  { term: "尚待云端 APK 编译与 Alice 真机验收", allow: null },
  // 完整热缓存复跑区间已扩到 55.8ms，禁止保留较早的窄区间。
  { term: "39.6–47.6 ms", allow: null },
  // M3 局部采样已由 OPPO 真机测到 60ms，设计文档不能继续写成未测。
  { term: "Android 真机尚未测到这条路径", allow: null },
  // 第四轮只允许一份新候选清单，不能继续让 Alice 安装第一轮 APK。
  { term: "881e467c-50db-4ee2-856b-8ea11bf95da2", allow: null },
  // 第四轮唯一候选已构建完成，验收清单不能继续保留待填写占位。
  { term: "待本批 EAS 构建完成后填写", allow: null },
  // 第五轮只能交付新的唯一候选，验收清单不能继续指向第四轮 APK。
  { term: "2fc13155-b9c6-4034-b0a4-fdbfc6eb0b0a", allow: null },
  // 第五轮唯一候选已由 EAS 构建完成，所有交付字段都必须填真实值。
  { term: "待第五轮唯一候选构建完成后填写", allow: null },
  // v0.3.0 起 Android 默认走文本锚点，拼接只作为可切换回退。
  { term: "Still gated behind a toggle", allow: null },
  { term: "stitching remains the default", allow: null },
  { term: "目前仍藏在开关后面", allow: null },
  { term: "默认路径仍是拼接", allow: null },
  { term: "仍完整保留且默认选中", allow: null },
  { term: "### 待 Alice 拍板：要不要替换拼接架构", allow: /已拍板/ },
  { term: "拼接是默认，文本锚点可切换", allow: null },
  // README 的产品描述与流程图也必须反映双路径，不能继续把拼接写成唯一流程。
  { term: "stitches the frames into one long image", allow: null },
  { term: "把帧拼成一张长图", allow: null },
  { term: "→ stitch (two-stage SAD", allow: null },
  { term: "→ 拼接（两级 SAD", allow: null },
  // 上线批必须生成新的两段浅色真机清单与 APK，不能复用第五轮候选。
  { term: "# M3 第五轮 Android 真机验收清单", allow: null },
  { term: "895881b9-2a79-4a6b-8f91-b4180a0d72df", allow: null },
  // 第五轮性能候选不再把完整 4fps 诊断采集混入 ≤40s 验收。
  { term: "验收时保持开启", allow: null },
  { term: "报告未证明完整 4fps OCR 已采集并导出", allow: null },
  { term: "两份报告都必须显示 stride=3", allow: null },
  // stride 已按模式拆分：微信 5 / 1250ms，通用 3 / 750ms。
  { term: "算法本身按最大相邻间隔 750 ms", allow: null },
  { term: "M3 device stride comes from a 750ms", allow: null },
  { term: "`--anchors exact`、`--stride 7` 和", allow: null },
  // 第四轮把算法帧数误当成 native 实际抽取数，3.5 倍单帧回归已被 bundle 订正。
  { term: "单帧成本涨 3.5 倍", allow: /不成立|订正|⚠️/ },
  { term: "验收候选默认开启", allow: /第五轮|已改|历史/ },
  { term: "统一规则是 4fps 下相邻处理帧不超过 750ms", allow: /推翻|订正|⚠️/ },
  { term: "### 仍需真机回答", allow: /第四轮|第五轮|历史/ },
  // 4d70d01 当时只修了离线 verifier；第五轮已把同一几何约束同步到 Android production helper。
  { term: "现有拼接路径、`findAlignPeaks`", allow: null },
  { term: "**已修**（本次提交）", allow: /离线验证脚本/ },
  // 多帧多数必须再过“同一文本变体”门禁，不能把相邻行的无关多数拿来替换。
  { term: "去重只在至少三票严格多数时推翻", allow: /文本变体/ },
  { term: "只有同一归一化全文至少 3 票且严格过半时采用多数", allow: /相似度|文本变体/ },
  { term: "默认去重只在至少三帧", allow: /相似度|文本变体/ },
  { term: "严格多数时替代“更长胜出”", allow: /相似度|文本变体/ },
  { term: "全文至少 3 票且严格过半时采用多数 observation", allow: /相似度|文本变体/ },
  // v0.3.0 已把可靠的群昵称行独立为 Markdown 发言人字段。
  { term: "昵称字段仍待独立验证", allow: null },
  { term: "群昵称字段尚未适配", allow: null },
  // 发言人颜色未定时保留现行安全行为：跳过该气泡并告警，不伪造字段。
  { term: "明确标记发言人未定", allow: null },
  // 昵称字段现在只按显式几何行保留；“任何昵称都不区分”的旧原则已被收窄。
  { term: "不去判断\"这是昵称", allow: null },
];

const SKIP = /node_modules|\.git|package-lock|\/out\/|doc-consistency/;   // 跳过自身：规则定义行必然含这些字样
function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(md|js|mjs)$/.test(p)) acc.push(p);
  }
  return acc;
}

let bad = 0;
// 「实际测过的范围」是 Alice 点名要写的实测数字，用内容 hash 冻住，防止被顺手"优化措辞"。
// 闸的意思是「改动必须是有意的」，不是「永不可改」——真要改就连同 hash 一起改，
// 让每次改动都在 diff 里留下痕迹。
//
// 更新记录：
// 2026-09-03  README 中英文互换文件名（README.md=中文默认脸面，README_EN.md=英文），Alice 拍板；
//             两段冻结内容与 hash 都没变，只是所在文件名跟着换。
// 2026-08-29  修同节内自相矛盾（前文已记群聊实测，后文仍写"没试过群聊"），
//             并把"超过 30 秒"订正为"超过 45 秒"（群聊 44.2 秒是目前最长）。
//             矛盾由 Codex 在 v0.3.0 发布报告的 concerns 中指出。
const FROZEN_SECTIONS = [
  {
    file: "README_EN.md",
    start: "### What was actually tested",
    end: "## How it works",
    sha256: "754926f1bedd947fe64f3cb66f7cdb370ef2212dc0b58ec5de95283d9bb9722d",
  },
  {
    file: "README.md",
    start: "### 实际测过的范围",
    end: "## 工作原理",
    sha256: "e70206d72c534e9aa2d60944999c578425bb2d920340116219af06804af285b1",
  },
];
for (const frozen of FROZEN_SECTIONS) {
  const text = readFileSync(join(ROOT, frozen.file), "utf8");
  const start = text.indexOf(frozen.start);
  const end = text.indexOf(frozen.end, start + frozen.start.length);
  const section = start >= 0 && end > start ? text.slice(start, end) : "";
  const actual = createHash("sha256").update(section).digest("hex");
  if (actual === frozen.sha256) continue;
  console.log(`✗ ${frozen.file}  Alice 指定的实测范围段被改动`);
  bad++;
}
const EXPECTED_VERSION = "0.3.0";
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const appJson = JSON.parse(readFileSync(join(ROOT, "app.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
for (const [label, actual] of [
  ["package.json", packageJson.version],
  ["app.json", appJson.expo?.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json packages['']", packageLock.packages?.[""]?.version],
]) {
  if (actual === EXPECTED_VERSION) continue;
  console.log(`✗ ${label}  版本应为 ${EXPECTED_VERSION}，实际 ${actual ?? "缺失"}`);
  bad++;
}
const EXPECTED_V030_CANDIDATE = {
  "EAS build ID": "d6dc7577-b0b1-4bef-ad55-8a7f1d6c3637",
  "源提交": "436c7b26509912d2074e81a53a7eecc83dbfbd44",
  "APK 字节数": "114584348",
  "APK SHA-256": "9ab21d768b1e1fb3ccb1f67e0f39d7568c5199fd5c67a199af66fb3b675b587d",
};
for (const file of ["PLAN.md", "verify/M3-DEVICE-ACCEPTANCE.md"]) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const [label, expected] of Object.entries(EXPECTED_V030_CANDIDATE)) {
    if (text.includes(expected)) continue;
    console.log(`✗ ${file}  缺少 v0.3.0 候选 ${label}: ${expected}`);
    bad++;
  }
}
const EXPECTED_V030_RELEASE_DOCS = [
  {
    file: "README_EN.md",
    facts: [
      "text anchors by default",
      "image-stitching pipeline remains available as a fallback",
      "5.913 s vs. 161.6 s (27.3× faster)",
      "91.4% vs. 90.6%",
    ],
  },
  {
    file: "README.md",
    facts: [
      "默认走文本锚点",
      "长图拼接路径仍作为回退保留",
      "5.913 秒 vs 161.6 秒（快 27.3 倍）",
      "91.4% vs 90.6%",
    ],
  },
  {
    file: "verify/V0.3.0-RELEASE-NOTES.md",
    facts: [
      "5,913 ms",
      "161,600 ms",
      "91.4%",
      "90.6%",
      "39/41",
      "顺序 100%",
      "12,528 ms",
      "42/42",
      "深色模式尚未在真机验证",
      "不会猜测发言人",
      "群聊昵称字段化只在一台设备、一种分辨率上验证过",
      "群聊没有消息级真值",
      "27 秒录屏，569 字人工真值",
      "32 秒录屏",
      "44 秒录屏，60 条消息",
    ],
  },
];
for (const { file, facts } of EXPECTED_V030_RELEASE_DOCS) {
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const fact of facts) {
    if (text.includes(fact)) continue;
    console.log(`✗ ${file}  缺少 v0.3.0 发布事实: ${fact}`);
    bad++;
  }
}
for (const file of [...walk(ROOT), ...EXTRA.flatMap(d => { try { return walk(d); } catch { return []; } })]) {
  const text = readFileSync(file, "utf8");
  // 已封存的历史文档豁免：顶部自带封存标记 + 明写"以 PLAN.md 为准"的，
  // 其内容是当时的历史记录，不必跟着现行结论改。豁免必须显式，不能靠遗漏。
  if (/##\s*⚠️\s*本文档已封存/.test(text.slice(0, 2000))) continue;
  const lines = text.split("\n");
  const fileLabel = relative(ROOT, file);
  lines.forEach((line, i) => {
    for (const { term, allow, allowFile } of RULES) {
      if (!line.includes(term)) continue;
      if (allowFile && allowFile.test(fileLabel)) continue;
      if (allow && allow.test(line)) continue;
      console.log(`✗ ${fileLabel}:${i + 1}  「${term}」出现在未许可语境`);
      console.log(`    ${line.trim().slice(0, 100)}`);
      bad++;
    }
  });
}
console.log(bad ? `\n${bad} 处术语冲突` : "✓ 术语一致性通过");
process.exit(bad ? 1 : 0);
