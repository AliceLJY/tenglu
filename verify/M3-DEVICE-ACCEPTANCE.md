# M3 第五轮 Android 真机验收清单

本清单只用于第五轮唯一候选 APK。现有拼接路径仍完整保留且默认选中；本次只运行文本锚点
路径。两段录屏各处理一次，完整 4fps OCR JSON 诊断开关全程保持关闭。

## 唯一候选 APK

- 安装包：[下载唯一候选 APK](https://expo.dev/artifacts/eas/xBlFm5XYF9gko-zNireHHrjauLlSTl9TAFaCR-D4I6s.apk)
- 构建页：[EAS Build 895881b9-2a79-4a6b-8f91-b4180a0d72df](https://expo.dev/accounts/aliceljy/projects/tenglu/builds/895881b9-2a79-4a6b-8f91-b4180a0d72df)
- 状态：`FINISHED`；源提交：`524f1f559d64f16e8d7da91224cb0dd44a4dcfc0`
- 大小：`114,578,076 bytes（109.27 MiB）`
- SHA-256：`8915a669cf3b023136d7e89caf09496f3948987faeafa80bced03843e913b99b`

## 手机上只做这六步

1. 安装上方唯一候选 APK。手机切到浅色模式，保持竖屏；打开“誊录”，允许读取所选视频。
2. 顶部“处理路径”选择“文本锚点 M3”，确认“导出完整 4fps OCR JSON（诊断）”保持关闭。
3. “模式”选择“微信”，选择时长约 0:27 的微信录屏；完成后点“复制完整验收报告”。
4. 把剪贴板原文标为“微信报告”，不要删减；随后回到 App。
5. 处理路径仍选“文本锚点 M3”，模式改成“通用”，选择时长约 0:32 的小红书录屏；完成后
   点“复制完整验收报告”，把剪贴板原文标为“小红书报告”。
6. 发回微信报告和小红书报告。即使 App 显示告警，也不重试、不自行删改内容。

这六步不运行耗时较长的“现有拼接”；对照使用已经保存的 M2-L3 微信基线。处理期间 App
保持屏幕常亮。第四轮的完整 108 / 128 帧 ML Kit bundle 已经在 Mac 验证，本次不重复承担
诊断采集的抽帧与 OCR 成本。

## 收到两份报告后的固定命令

先把两段完整报告保存为 `/tmp/m5-wx-report.txt`、`/tmp/m5-xhs-report.txt`。

微信先验证完整报告、提取设备 Markdown，并与 M2-L3 做逐字节比较：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  "$HOME/Desktop/个人机遇/面试项目/录屏还原-首次验证/真机基线/M2-L3-真机输出.md" \
  /tmp/m5-wx-report.txt \
  --expect-mode wechat \
  --out /tmp/m5-wx.md
cd ~/Projects/tenglu/verify
python3 score.py /tmp/m5-wx.md groundtruth.json "M3 第五轮 Android 真机"
```

小红书没有 groundtruth；只验证报告、自检和内容量级：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  /tmp/m5-xhs-report.txt \
  --extract-only \
  --expect-mode generic \
  --out /tmp/m5-xhs.md
wc -l -m /tmp/m5-xhs.md
```

## 通过线

- 微信：字符级 ≥90%、发言人 39/41（39 条可识别消息全对）、顺序完全正确、无自检告警、
  局部采样必须触发且未定 0、总耗时 ≤40,000 ms。
- 小红书：自检 0 告警，Markdown 约 200 行，总耗时 ≤40,000 ms。
- 微信报告必须显示 4fps / stride=5 / 最大间隔 1250 ms / 22 个算法帧；通用报告必须显示
  4fps / stride=3 / 最大间隔 750 ms / 43 个算法帧。
- 两份报告的完整 4fps 诊断采集都必须为关闭；`extractedFrameCount` 与
  `ocrCapturedFrameCount` 必须等于各自算法帧数，单帧耗时必须以这个实际抽取数作分母。
- 两份报告的 `frameExtractionMethod` 必须是 `MediaMetadataRetriever.OPTION_CLOSEST`，
  `screenAwakeRequested` 必须为 `true`。
- 两份报告的 `remainingTempFileCount` 必须为 0；否则说明私有缓存仍留有临时 JPEG。
- `nativeStaleTempFileCount` 必须等于 `nativeStaleTempFileDeletedCount`；新流程不能带着删不掉的
  上次临时帧继续。
