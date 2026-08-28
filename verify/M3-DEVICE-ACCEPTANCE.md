# v0.3.0 Android 真机验收清单

本清单只用于 v0.3.0 唯一候选 APK。Alice 只运行两段已经验过的浅色素材，不录深色素材，
不运行拼接基线，也不判断通过与否；只按固定步骤操作并原样回传证据。

## 候选 APK

本批 EAS 构建完成后，在这里登记唯一候选的下载链接、构建页、状态、源提交、字节数和
SHA-256。构建前不复用任何旧 APK。

## 手机上只做这七步

1. 安装本清单登记的 v0.3.0 唯一候选 APK。手机保持浅色模式和竖屏；打开“誊录”，允许读取所选视频。
2. 不点处理路径开关。截一张首页图，图中要同时看见“文本锚点 M3”已选中，以及“导出完整 4fps OCR JSON（诊断）”处于关闭状态。
3. “模式”保持“微信”，选择时长约 0:27 的微信录屏。完成后截一张结果页图，再点“复制完整验收报告”。
4. 把剪贴板原文标为“微信报告”，不要删减；随后回到 App。
5. 不改处理路径。“模式”改成“通用”，选择时长约 0:32 的小红书录屏。完成后截一张结果页图，再点“复制完整验收报告”。
6. 把剪贴板原文标为“小红书报告”，不要删减。
7. 发回首页截图、微信结果截图、小红书结果截图、微信报告和小红书报告。全程不重试、不手动切路径、不自行判断告警。

处理期间 App 会保持屏幕常亮。两段的完整 108 / 128 帧 ML Kit bundle 已经在 Mac 侧验证，
本次诊断开关保持关闭，不重复承担完整 4fps 采集成本。

## 收到两份报告后的固定命令

先把两段完整报告保存为 `/tmp/v030-wx-report.txt`、`/tmp/v030-xhs-report.txt`。

微信验证完整报告、提取设备 Markdown，并与 M2-L3 做逐字节比较：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  "$HOME/Desktop/个人机遇/面试项目/录屏还原-首次验证/真机基线/M2-L3-真机输出.md" \
  /tmp/v030-wx-report.txt \
  --expect-mode wechat \
  --out /tmp/v030-wx.md
cd ~/Projects/tenglu/verify
python3 score.py /tmp/v030-wx.md groundtruth.json "v0.3.0 Android 真机"
```

小红书没有 groundtruth；只验证报告、自检和内容量级：

```bash
cd ~/Projects/tenglu
node verify/device-accept.mjs \
  /tmp/v030-xhs-report.txt \
  --extract-only \
  --expect-mode generic \
  --out /tmp/v030-xhs.md
wc -l -m /tmp/v030-xhs.md
```

## 通过线

- 首页截图：没有手动切换时，“文本锚点 M3”已经选中。
- 两份报告：`请求路径` 与 `路径` 都是文本锚点，状态为 `ok`，完整 4fps 诊断采集关闭，总耗时都不超过 40,000 ms。
- 微信：字符级不低于 90%、发言人 39/41（39 条可识别消息全对）、顺序完全正确、锚点自检 21/21；局部采样必须触发，13 个气泡全部判定，未定 0。
- 小红书：锚点自检 42/42、0 告警，Markdown 约 200 行，累计位移接近 10,414 px。
- 微信报告应为 4fps / stride=5 / 最大间隔 1250 ms / 22 个算法帧；通用报告应为 4fps / stride=3 / 最大间隔 750 ms / 43 个算法帧。
- 两份报告的 `frameExtractionMethod` 都是 `MediaMetadataRetriever.OPTION_CLOSEST`，`screenAwakeRequested` 都是 `true`。
- 两份报告的 `remainingTempFileCount` 都是 0；`nativeStaleTempFileCount` 等于 `nativeStaleTempFileDeletedCount`。

以上判断全部在报告回传后执行；手机操作阶段不增加分支。
