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
  // 完整热缓存复跑区间已扩到 55.8ms，禁止保留较早的窄区间。
  { term: "39.6–47.6 ms", allow: null },
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
