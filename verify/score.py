#!/usr/bin/env python3
"""
准确率评分：把还原输出与真实聊天记录逐条比对。

    python3 score.py <还原输出.md> <groundtruth.json> [标签]

唯一的准确率标准是 groundtruth.json —— 它是从微信数据库导出的真实记录。
expected_output.md 只是"我这边跑出来的参考输出"，本身带 6% 误差，不要拿它当标准答案。

输出三个数：
  逐条完全一致  —— 粒度太粗（41 条的分母下一条 = 2.4 个点），实测在 87.8–92.7% 之间抖，不要对外报
  字符级        —— 稳定在 93.7–94.0%，这是该报的数
  发言人        —— 只依赖气泡底色，不受 OCR 质量影响，五组参数下一次没抖过
"""
import json, re, difflib, sys

if len(sys.argv) < 3:
    sys.exit(__doc__)
out_path, gt_path = sys.argv[1], sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else "结果"

gt = json.load(open(gt_path))
VISUAL = re.compile(r"^\[(图片|表情|Facepalm|Lol|视频|动画表情)\]+$")
gtt = [g for g in gt if not VISUAL.match(g["text"])]      # 纯图片/表情 OCR 读不到，不计入分母

got = []
for line in open(out_path):
    m = re.match(r"^\[(我|对方|me|them)\]\s*(.*)$", line.strip())
    if m:
        got.append({"who": "me" if m.group(1) in ("我", "me") else "them", "text": m.group(2)})

norm = lambda s: re.sub(r"[\s，。、,.…“”\"']", "", s)
used, res = set(), []
for g in gtt:
    best, bi = 0, -1
    for i, x in enumerate(got):
        if i in used:
            continue
        r = difflib.SequenceMatcher(None, norm(g["text"]), norm(x["text"])).ratio()
        if r > best:
            best, bi = r, i
    if bi >= 0 and best > 0.55:
        used.add(bi); res.append((g, got[bi], best))
    else:
        res.append((g, None, 0))

full = sum(1 for x in res if x[2] >= 0.999)
who  = sum(1 for g, m, _ in res if m and g["who"] == m["who"])
a = "".join(norm(g["text"]) for g in gtt)
b = "".join(norm(m["text"]) for g, m, _ in res if m)
char = difflib.SequenceMatcher(None, a, b).ratio()
idx = [got.index(m) for g, m, _ in res if m]

# 分母里还混着"含表情标记但不是纯表情"的条目 —— VISUAL 的 `^\[(A|B)\]+$` 只允许一个
# 左括号，`[Facepalm][Facepalm]...` 这类连发匹配不上，于是留在了分母里。OCR 读不到表情，
# 任何还原路线都产不出它们，所以发言人与逐条的真实上限低于 100%。
# 有意不修那个正则：修了分母会从 41 变 39，M1/M2/M3 的历史数字将全部不可比。
# 尺子保持不动，但必须自己说清上限，否则"还差几个点"会被一路误读。
EMOJI = re.compile(r"\[(图片|表情|Facepalm|Lol|视频|动画表情)\]")
unreachable = [g for g in gtt if EMOJI.search(g["text"])]

print(f"{label} | 可读文本 {len(gtt)} 条 vs 输出 {len(got)} 条")
if unreachable:
    print(f"  ⚠ 其中 {len(unreachable)} 条含表情标记、OCR 产不出 —— "
          f"发言人与逐条的上限是 {len(gtt) - len(unreachable)}/{len(gtt)}"
          f" = {(len(gtt) - len(unreachable)) / len(gtt) * 100:.1f}%，不是 100%")
    for g in unreachable:
        print(f"      [{g['who']}] {g['text']}")
print(f"  字符级      {char*100:5.1f}%   ← 报这个（基准 93.7%，验收线 ≥90%）")
print(f"  发言人      {who}/{len(gtt)} = {who/len(gtt)*100:5.1f}%   （上限见上方 ⚠ 行，≥39/41 即满分）")
print(f"  逐条一致    {full}/{len(gtt)} = {full/len(gtt)*100:5.1f}%   （粒度粗、会抖，仅供参考）")
print(f"  顺序        {'完全正确' if idx == sorted(idx) else '有错乱'}")
