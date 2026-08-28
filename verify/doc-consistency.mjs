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
  { term: "逐帧位移（两级 SAD", allow: null },
  { term: "per-frame displacement (two-stage SAD", allow: null },
  { term: "逐帧 `estimateShift`", allow: null, allowFile: /交接-M1\.md$/ },
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
  const lines = readFileSync(file, "utf8").split("\n");
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
