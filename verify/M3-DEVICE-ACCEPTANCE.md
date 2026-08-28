# M3 Android 真机验收清单

本清单只用于 M3 候选 APK 的一次性验收。现有拼接路径仍完整保留；本次用已经保存的
M2-L3 微信基线做对照，不重复执行耗时较长的旧路径。

## 手机上只做这六步

1. 安装交付消息中标为 “M3 Android candidate” 的唯一 APK。
2. 手机使用浅色模式，保持竖屏；打开“誊录”，允许它读取所选视频。
3. 顶部“处理路径”选择“文本锚点 M3”。同一位置的“现有拼接”就是保留的旧路径，本次不要运行它。
4. “模式”选择“微信”，选择时长约 0:27 的微信录屏。完成后点“复制完整验收报告”，粘贴到一条消息的“微信”段。
5. 处理路径仍选“文本锚点 M3”，“模式”改成“通用”，选择时长约 0:32 的小红书录屏。完成后再次点“复制完整验收报告”，粘贴到同一条消息的“小红书”段。
6. 两段报告原样发回。即使看到告警，也不要自行判断或重试。

处理期间 App 会请求保持屏幕常亮。每份完整报告都包括路径、素材时长、全部分项耗时、
总耗时、计时对账、锚点自检、局部采样区域数/解码像素数/未定数、告警和 Markdown。

## 收到报告后的固定命令

先把两段完整报告分别保存为 `/tmp/m3-wx-report.txt` 和
`/tmp/m3-xhs-report.txt`。微信逐字节比对并提取 Markdown：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  "$HOME/Desktop/个人机遇/面试项目/录屏还原-首次验证/真机基线/M2-L3-真机输出.md" \
  /tmp/m3-wx-report.txt \
  --expect-mode wechat \
  --out /tmp/m3-wx.md
```

无论逐字节结果是否相同，都运行唯一的质量评分：

```bash
cd ~/Projects/tenglu/verify
python3 score.py /tmp/m3-wx.md groundtruth.json "M3 Android 真机"
```

小红书没有保存现行 M2-L3 字节基线，也没有 groundtruth，不能伪造逐字节或准确率结论。
只从报告中提取原始 Markdown，再与本批 Mac 回归核对失败自检、行数和字符数量级：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  /tmp/m3-xhs-report.txt \
  --extract-only \
  --expect-mode generic \
  --out /tmp/m3-xhs.md
wc -l -m /tmp/xhs.md /tmp/m3-xhs.md
```

`/tmp/xhs.md` 由出 APK 前的固定 Mac 回归命令生成。行数和字符数只用于比较两条独立 OCR
路线的内容量级，不替代真值评分。微信基线与两段素材都留在仓库外。

验收读数：微信总耗时不超过 40000ms；锚点自检 15/15；局部采样区域数和解码像素数有记录、未定 0；
官方分数发言人 39/41（等于 39 条可识别消息全对）、字符级不低于 M2-L3 真机基线 90.6%、顺序完全正确。
小红书锚点自检无告警，输出约 200 行。发现差异先看评分和自检，不把“字节不同”直接判成失败。
