# M3 第四轮 Android 真机验收清单

本清单只用于第四轮唯一候选 APK。现有拼接路径仍完整保留且默认选中；本次只运行文本锚点
路径。两段录屏各处理一次，每段结束后立即导出自己的 OCR bundle，再处理下一段。

## 唯一候选 APK

- 安装包：`待本批 EAS 构建完成后填写`
- 构建页：`待本批 EAS 构建完成后填写`
- 状态 / 源提交 / 大小 / SHA-256：`待本批 EAS 构建完成后填写`

## 手机上只做这六步

1. 安装上方唯一候选 APK。手机切到浅色模式，保持竖屏；打开“誊录”，允许读取所选视频。
2. 顶部“处理路径”选择“文本锚点 M3”，确认“导出完整 4fps OCR JSON”保持开启。
3. “模式”选择“微信”，选择时长约 0:27 的微信录屏。处理完成后点“导出 OCR JSON”，
   在系统目录选择器中选择 `Download`，点“使用此文件夹”。回到 App 后点“复制完整验收报告”。
4. 把剪贴板内容标为“微信报告”；在文件选择器中进入
   `Download/tenglu-m3-ocr-wechat-时间/`，选中根部的 `M3-OCR-BUNDLE.json`，标为“微信 bundle”。
5. 回到 App，处理路径仍选“文本锚点 M3”，“模式”改成“通用”，选择时长约 0:32 的
   小红书录屏。完成后同样导出到 `Download`，再复制完整验收报告。
6. 发回四项原始内容：微信报告、微信 bundle、小红书报告、小红书 bundle。即使 App 显示告警，
   也不重试、不自行删改内容。

这六步不运行耗时较长的“现有拼接”；对照使用已经保存的 M2-L3 微信基线。处理期间 App
保持屏幕常亮。OCR bundle 只含聊天文字、文本框、ML Kit confidence 和统计，不含录屏、
图片或像素；App 仍没有联网权限，只有这一步人工导出会把明文带出 App。

## 收到四项材料后的固定命令

先把两段完整报告保存为 `/tmp/m4-wx-report.txt`、`/tmp/m4-xhs-report.txt`，两份 bundle
保存为 `/tmp/m4-wx-bundle.json`、`/tmp/m4-xhs-bundle.json`。导入逐帧缓存：

```bash
cd ~/Projects/tenglu
node verify/import-device-ocr.mjs /tmp/m4-wx-bundle.json /tmp/m4-ocr-wx
node verify/import-device-ocr.mjs /tmp/m4-xhs-bundle.json /tmp/m4-ocr-xhs
```

微信先验证完整报告、提取设备 Markdown，并与 M2-L3 做逐字节比较：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  "$HOME/Desktop/个人机遇/面试项目/录屏还原-首次验证/真机基线/M2-L3-真机输出.md" \
  /tmp/m4-wx-report.txt \
  --expect-mode wechat \
  --out /tmp/m4-wx.md
cd ~/Projects/tenglu/verify
python3 score.py /tmp/m4-wx.md groundtruth.json "M3 第四轮 Android 真机"
```

小红书没有 groundtruth；只验证报告、自检和内容量级：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  /tmp/m4-xhs-report.txt \
  --extract-only \
  --expect-mode generic \
  --out /tmp/m4-xhs.md
wc -l -m /tmp/m4-xhs.md
```

逐帧 bundle 可直接复现本批文本锚点与去重，不需要重新出 APK。微信先跑当前参数及三项
删除测试；离线没有原始 JPEG，speaker 会退回纯坐标能力，因此这些分数只读取字符级、顺序、
锚点和去重贡献，不把离线 speaker 当成本批官方结果：

```bash
cd ~/Projects/tenglu/verify
node anchor-ocr.mjs /tmp/m4-ocr-wx wechat --stride 3 --out /tmp/m4-wx-replay.md
python3 score.py /tmp/m4-wx-replay.md groundtruth.json "M4 当前参数（字符贡献）"
node anchor-ocr.mjs /tmp/m4-ocr-wx wechat --stride 3 --anchors exact --out /tmp/m4-wx-exact.md
python3 score.py /tmp/m4-wx-exact.md groundtruth.json "M4 删除模糊锚点（字符贡献）"
node anchor-ocr.mjs /tmp/m4-ocr-wx wechat --stride 7 --out /tmp/m4-wx-stride7.md
python3 score.py /tmp/m4-wx-stride7.md groundtruth.json "M4 删除加密取帧（字符贡献）"
node anchor-ocr.mjs /tmp/m4-ocr-wx wechat --stride 3 --dedupe longer --out /tmp/m4-wx-longer.md
python3 score.py /tmp/m4-wx-longer.md groundtruth.json "M4 删除多帧共识（字符贡献）"
```

小红书没有 groundtruth，四个变体只比较告警、位移与内容量级：

```bash
cd ~/Projects/tenglu/verify
node anchor-ocr.mjs /tmp/m4-ocr-xhs plain --stride 3 --out /tmp/m4-xhs-replay.md
node anchor-ocr.mjs /tmp/m4-ocr-xhs plain --stride 3 --anchors exact --out /tmp/m4-xhs-exact.md
node anchor-ocr.mjs /tmp/m4-ocr-xhs plain --stride 7 --out /tmp/m4-xhs-stride7.md
node anchor-ocr.mjs /tmp/m4-ocr-xhs plain --stride 3 --dedupe longer --out /tmp/m4-xhs-longer.md
wc -l -m /tmp/m4-xhs-replay.md /tmp/m4-xhs-exact.md /tmp/m4-xhs-stride7.md /tmp/m4-xhs-longer.md
```

其中 `--anchors exact` 删除模糊锚点，`--stride 7` 删除加密取帧，`--dedupe longer` 删除
多帧共识。设备官方质量分、39/41 speaker 和总耗时只取完整报告；离线回放只量化三项规则
对位移、告警、去重、字符级与顺序的净贡献。

## 通过线

- 微信：字符级 ≥90%、发言人 39/41（39 条可识别消息全对）、顺序完全正确、无自检告警、
  总耗时 ≤40,000 ms。
- 小红书：自检 0 告警，Markdown 约 200 行；再用 bundle 检查累计位移和重复内容。
- 两份报告都必须显示 stride=3、最大相邻处理帧间隔 750 ms、完整 4fps OCR 已采集并导出。
- 两份报告的 `remainingTempFileCount` 必须为 0；否则说明私有缓存仍留有临时 JPEG。
- `nativeStaleTempFileCount` 必须等于 `nativeStaleTempFileDeletedCount`；新流程不能带着删不掉的
  上次临时帧继续。
- 两份 bundle 的逐帧 JSON 数量必须等于各自源帧数，`ocr/` 中每个对象严格含
  `text/x/y/w/h/conf`；`meta/` 统计不能混入 `ocr/` 帧目录。
