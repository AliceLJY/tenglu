import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useKeepAwake } from "expo-keep-awake";
import { useState } from "react";
import {
  Alert,
  Button,
  Pressable,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { processRecording } from "./src/pipeline";
import { processAnchorRecording } from "./src/anchor-pipeline";
import { exportOcrCache } from "./src/ocr-cache-export";

const {
  anchorWarningNotice,
  defaultEngineForPlatform,
  stitchRetryRequest,
} = require("./src/result-policy");

const STITCH_TIMING_ROWS = [
  ["预扫", "prescan"],
  ["取帧与位移", "frameShift"],
  ["抽帧累计（明细）", "thumbnail"],
  ["位移阶段抽帧（明细）", "shiftThumbMs"],
  ["首次解码（明细）", "decodeMs"],
  ["小灰图（明细）", "grayMs"],
  ["逐帧粗搜（明细）", "shiftMs"],
  ["关键帧准备（明细）", "keyframeMs"],
  ["UI 让出（明细）", "pauseMs"],
  ["拼接", "stitch"],
  ["BMP 编码", "bmp"],
  ["OCR", "ocr"],
  ["总耗时", "total"],
];

const ANCHOR_TIMING_ROWS = [
  ["精确帧抽取", "frameExtract"],
  ["逐帧 ML Kit OCR", "frameOcr"],
  ["UI 让出", "uiPause"],
  ["固定 UI / 锚点 / 去重", "anchorLayout"],
  ["歧义气泡局部采样", "speakerSampling"],
  ["Markdown", "markdown"],
  ["临时文件清理", "cleanup"],
  ["总耗时", "total"],
];

const ENGINE_LABELS = {
  stitch: "现有拼接（M2-L3）",
  anchor: "文本锚点（M3）",
};

function KeepAwakeWhileBusy() {
  useKeepAwake("tenglu-processing", { suppressDeactivateWarnings: true });
  return null;
}

function timingRows(engine) {
  return engine === "anchor" ? ANCHOR_TIMING_ROWS : STITCH_TIMING_ROWS;
}

function buildValidationReport(result) {
  const rows = timingRows(result.engine)
    .map(([label, key]) => {
      const value = result.timings[key];
      return `${label}: ${value == null ? "未完成" : `${value} ms`}`;
    })
    .join("\n");
  const warnings = result.warnings?.length
    ? result.warnings.map(warning => `- ${warning}`).join("\n")
    : "无";
  return [
    `路径: ${ENGINE_LABELS[result.engine]}`,
    `请求路径: ${ENGINE_LABELS[result.requestedEngine ?? result.engine]}`,
    `状态: ${result.status ?? "ok"}`,
    `模式: ${result.stats.app === "wechat" ? "微信" : "通用"}`,
    "",
    "耗时:",
    rows,
    result.timingWarning ? `计时告警: ${result.timingWarning}` : "计时对账: 通过",
    "",
    "统计:",
    JSON.stringify(result.stats, null, 2),
    "",
    "还原告警:",
    warnings,
    "",
    "----- BEGIN MARKDOWN -----",
    result.markdown,
    "----- END MARKDOWN -----",
  ].join("\n");
}

function ModeButton({ active, label, onPress }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      onPress={onPress}
      style={[styles.modeButton, active && styles.modeButtonActive]}
    >
      <Text style={styles.modeText}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [mode, setMode] = useState("wechat");
  const [engine, setEngine] = useState(() =>
    defaultEngineForPlatform(Platform.OS)
  );
  const [captureOcrCache, setCaptureOcrCache] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState("等待选择录屏");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const ocrExportComplete = result?.stats?.ocrExportFrameFiles != null;
  const awaitingOcrExport = Boolean(
    result?.engine === "anchor" &&
    result?.ocrCache &&
    !ocrExportComplete,
  );

  async function runRecording(asset, requestedMode, requestedEngine) {
    const processingStarted = Date.now();
    setError("");
    setResult(null);
    setLastRun({ asset, mode: requestedMode });
    setBusy(true);
    setProgress("读取录屏");
    try {
      const processor = requestedEngine === "anchor"
        ? processAnchorRecording
        : processRecording;
      const output = await processor(
        asset,
        requestedMode,
        setProgress,
        {
          captureOcrCache:
            requestedEngine === "anchor" && captureOcrCache,
        },
      );
      const actualEngine = output.engine ?? requestedEngine;
      const status = output.status ??
        (output.warnings?.length || output.timingWarning ? "warning" : "ok");
      setResult({
        ...output,
        engine: actualEngine,
        requestedEngine,
        status,
        stats: {
          ...output.stats,
          app: requestedMode,
          durationMs: Math.round(Number(asset.duration)),
          screenAwakeRequested: true,
        },
      });
      if (Platform.OS === "android" && requestedEngine === "anchor") {
        setProgress(
          output.ocrCache
            ? "M3 处理结束，请先导出 OCR JSON"
            : status === "ok"
              ? "处理完成，可以复制 Markdown"
              : "处理完成，但有内容风险，请查看提示",
        );
      } else {
        setProgress("完成，可以复制 Markdown");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const failureStats = caught?.m3FailureStats ?? {};
      setError(message);
      if (Platform.OS === "android" && requestedEngine === "anchor") {
        setResult({
          engine: "anchor",
          requestedEngine: "anchor",
          status: "failed",
          markdown: "",
          warnings: [`M3 处理失败：${message}`],
          timingWarning: "处理未完成，无法完成分项耗时对账。",
          timings: {
            frameExtract: null,
            frameOcr: null,
            uiPause: null,
            anchorLayout: null,
            speakerSampling: null,
            markdown: null,
            cleanup: null,
            total: Date.now() - processingStarted,
          },
          stats: {
            app: requestedMode,
            durationMs: Math.round(Number(asset.duration)),
            screenAwakeRequested: true,
            failure: message,
            ...failureStats,
          },
        });
        setProgress("M3 处理失败，请复制完整验收报告");
      } else {
        setProgress("处理停止");
      }
    } finally {
      setBusy(false);
    }
  }

  async function chooseVideo() {
    if (busy || exporting || awaitingOcrExport) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("需要相册权限才能读取你选择的录屏。");
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (picked.canceled || !picked.assets?.[0]) return;

    await runRecording(picked.assets[0], mode, engine);
  }

  async function retryWithStitch() {
    const retry = stitchRetryRequest(lastRun);
    if (busy || exporting || !retry) return;
    if (awaitingOcrExport) {
      const exported = await exportCapturedOcr();
      if (!exported) return;
    }
    setEngine(retry.engine);
    setMode(retry.mode);
    await runRecording(retry.asset, retry.mode, retry.engine);
  }

  async function copyResult() {
    if (!result?.markdown) return;
    await Clipboard.setStringAsync(result.markdown);
    Alert.alert("已复制", "Markdown 已复制到剪贴板。");
  }

  async function copyValidationReport() {
    if (!result) return;
    await Clipboard.setStringAsync(buildValidationReport(result));
    Alert.alert("已复制", "本次路径、耗时、统计、告警和 Markdown 已复制。");
  }

  async function exportCapturedOcr() {
    if (!result?.ocrCache || exporting) return false;
    setExporting(true);
    const started = Date.now();
    try {
      const exported = await exportOcrCache(result.ocrCache, {
        app: result.stats.app,
        stride: result.stats.stride,
        timings: result.timings,
        stats: result.stats,
        warnings: result.warnings,
      }, setProgress);
      const elapsedMs = Date.now() - started;
      setResult(previous => previous ? {
        ...previous,
        stats: {
          ...previous.stats,
          ocrExportFolder: exported.folderName,
          ocrExportFrameFiles: exported.frameFileCount,
          ocrExportFiles: exported.fileCount,
          ocrExportBytes: exported.bytes,
          ocrExportMs: elapsedMs,
        },
      } : previous);
      setProgress("OCR JSON 已导出；请再复制完整验收报告");
      Alert.alert(
        "OCR JSON 已导出",
        `${exported.folderName}\n${exported.frameFileCount} 个逐帧 JSON；` +
        "回传时只需选择文件夹根部的 M3-OCR-BUNDLE.json。",
      );
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setProgress("OCR JSON 未导出");
      Alert.alert("OCR JSON 未导出", message);
      return false;
    } finally {
      setExporting(false);
    }
  }

  const userWarning = anchorWarningNotice(result);

  return (
    <SafeAreaView style={styles.safeArea}>
      {Platform.OS === "android" && busy ? <KeepAwakeWhileBusy /> : null}
      <StatusBar backgroundColor="#ffffff" barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>誊录</Text>
        <Text style={styles.hint}>竖屏、匀速慢滑、中途不要切页面。</Text>

        {Platform.OS === "android" ? (
          <>
            <Text style={styles.label}>处理路径</Text>
            <View accessibilityRole="radiogroup" style={styles.modeRow}>
              {/* 默认路径排第一位：Android 默认走文本锚点，拼接是回退。
                  顺序与「模式」那行保持一致（默认选中的排左边）。 */}
              <ModeButton
                active={engine === "anchor"}
                label="文本锚点 M3"
                onPress={() =>
                  !busy && !exporting && !awaitingOcrExport && setEngine("anchor")
                }
              />
              <ModeButton
                active={engine === "stitch"}
                label="现有拼接"
                onPress={() =>
                  !busy && !exporting && !awaitingOcrExport && setEngine("stitch")
                }
              />
            </View>
          </>
        ) : null}
        {Platform.OS === "android" && engine === "anchor" ? (
          <>
            <Text style={styles.anchorHint}>
              深色模式尚未在真机验证；未知气泡颜色会明确告警并跳过该气泡，
              不会猜测发言人。
            </Text>
            <View style={styles.exportToggleRow}>
              <View style={styles.exportToggleText}>
                <Text style={styles.label}>导出完整 4fps OCR JSON（诊断）</Text>
                <Text style={styles.anchorHint}>
                  最终性能验收保持关闭；开启会额外抽取并 OCR 每个源帧，
                  但仍不导出视频或图片。
                </Text>
              </View>
              <Switch
                accessibilityLabel="导出完整 4fps OCR JSON"
                disabled={busy || exporting || awaitingOcrExport}
                onValueChange={setCaptureOcrCache}
                value={captureOcrCache}
              />
            </View>
          </>
        ) : null}

        <Text style={styles.label}>模式</Text>
        <View accessibilityRole="radiogroup" style={styles.modeRow}>
          <ModeButton
            active={mode === "wechat"}
            label="微信"
            onPress={() =>
              !busy && !exporting && !awaitingOcrExport && setMode("wechat")
            }
          />
          <ModeButton
            active={mode === "generic"}
            label="通用"
            onPress={() =>
              !busy && !exporting && !awaitingOcrExport && setMode("generic")
            }
          />
        </View>

        <Button
          disabled={busy || exporting || awaitingOcrExport}
          onPress={chooseVideo}
          title={busy
            ? "处理中…"
            : exporting
              ? "正在导出…"
              : awaitingOcrExport
                ? "请先导出本段 OCR JSON"
                : "选择录屏"}
        />

        <Text style={styles.progress}>{progress}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {userWarning ? (
          <View style={styles.warningBox}>
            <Text style={styles.warningTitle}>{userWarning.title}</Text>
            <Text style={styles.warningText}>{userWarning.message}</Text>
            <View style={styles.warningAction}>
              <Button
                disabled={busy || exporting || !lastRun}
                onPress={retryWithStitch}
                title="用拼接路径重新处理"
              />
            </View>
          </View>
        ) : result?.warnings?.length ? (
          <View style={styles.warningBox}>
            <Text style={styles.warningTitle}>还原告警</Text>
            {result.warnings.map((warning, index) => (
              <Text key={`${index}-${warning}`} style={styles.warningText}>
                {warning}
              </Text>
            ))}
          </View>
        ) : null}

        {result ? (
          <>
            {Platform.OS === "android" ? (
              <Text style={styles.resultEngine}>
                本次路径：{ENGINE_LABELS[result.engine]}
              </Text>
            ) : null}
            <Text style={styles.label}>耗时（ms）</Text>
            <View style={styles.timingBox}>
              {timingRows(result.engine).map(([label, key]) => (
                <View key={key} style={styles.timingRow}>
                  <Text>{label}</Text>
                  <Text>{result.timings[key]}</Text>
                </View>
              ))}
              {result.timingWarning ? (
                <Text style={styles.timingWarning}>
                  {result.timingWarning}
                </Text>
              ) : null}
            </View>

            {result.engine === "anchor" && result.status === "failed" ? (
              <Text style={styles.stats}>
                M3 未完成；已保留错误、总等待时间和可用上下文，请复制完整验收报告。
              </Text>
            ) : result.engine === "anchor" ? (
              <Text style={styles.stats}>
                4fps 共 {result.stats.sourceFrameCount} 帧 → stride=
                {result.stats.stride} 取
                {result.stats.frameCount} 帧；锚点自检
                {result.stats.anchorPassedCount}/{result.stats.anchorPairCount}；
                OCR {result.stats.ocrLineCount} 行 → 去重后
                {result.stats.uniqueLineCount} 行；累计滚动
                {result.stats.cumulativeShift}px。{"\n"}
                native 精确抽取 {result.stats.extractedFrameCount} 帧 /{" "}
                {result.stats.nativeFrameExtractMs}ms /{" "}
                {result.stats.nativeFrameExtractPerFrameMs}ms 每帧。{"\n"}
                局部采样 {result.stats.sampleRegionCount} 区，解码
                {result.stats.decodedPixels} px，已定
                {result.stats.sampleResolvedCount}，未定
                {result.stats.sampleUnresolvedCount}（错误
                {result.stats.sampleErrorCount}）；native
                {result.stats.nativeSamplingMs}ms。{"\n"}
                OCR 缓存采集
                {result.stats.ocrCaptureEnabled
                  ? `${result.stats.ocrCapturedFrameCount} 帧（完整 4fps）`
                  : "关闭"}
                {result.stats.ocrExportFrameFiles != null
                  ? `；已导出 ${result.stats.ocrExportFrameFiles} 帧 / ` +
                    `${result.stats.ocrExportBytes} bytes / ${result.stats.ocrExportMs}ms`
                  : ""}。
              </Text>
            ) : (
              <Text style={styles.stats}>
                滚动区 y{result.stats.scrollTop}~{result.stats.scrollBottom}；
                {result.stats.frameCount} 帧 → {result.stats.keyframeCount} 关键帧；
                长图 {result.stats.width}×{result.stats.height}
              </Text>
            )}

            <Text style={styles.label}>Markdown</Text>
            <TextInput
              editable={false}
              multiline
              scrollEnabled
              selectTextOnFocus
              style={styles.output}
              value={result.markdown}
            />
            {Platform.OS === "android" && result.engine === "anchor" ? (
              <>
                {result.ocrCache ? (
                  <Button
                    disabled={exporting || ocrExportComplete}
                    onPress={exportCapturedOcr}
                    title={exporting
                      ? "正在导出 OCR JSON…"
                      : ocrExportComplete
                        ? "OCR JSON 已导出"
                        : "导出 OCR JSON"}
                  />
                ) : null}
                <Button
                  disabled={awaitingOcrExport || exporting}
                  onPress={copyValidationReport}
                  title={awaitingOcrExport
                    ? "请先导出 OCR JSON"
                    : "复制完整验收报告"}
                />
              </>
            ) : null}
            <Button
              disabled={!result.markdown}
              onPress={copyResult}
              title={result.engine === "anchor"
                ? "仅复制 Markdown（非验收）"
                : "复制 Markdown"}
            />
            {Platform.OS === "android" && result.engine !== "anchor" ? (
              <Button
                onPress={copyValidationReport}
                title="复制完整验收报告"
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#ffffff",
    flex: 1,
  },
  container: {
    gap: 12,
    padding: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
  },
  hint: {
    color: "#444444",
    fontSize: 15,
  },
  anchorHint: {
    color: "#7a4f00",
    fontSize: 13,
  },
  exportToggleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  exportToggleText: {
    flex: 1,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
  },
  modeRow: {
    flexDirection: "row",
  },
  modeButton: {
    alignItems: "center",
    borderColor: "#777777",
    borderWidth: 1,
    flex: 1,
    padding: 10,
  },
  modeButtonActive: {
    backgroundColor: "#dddddd",
  },
  modeText: {
    fontSize: 16,
  },
  progress: {
    color: "#333333",
    minHeight: 20,
  },
  error: {
    color: "#b00020",
  },
  resultEngine: {
    fontSize: 15,
    fontWeight: "600",
  },
  warningBox: {
    backgroundColor: "#fff3cd",
    borderColor: "#d39e00",
    borderWidth: 1,
    padding: 10,
  },
  warningTitle: {
    fontWeight: "700",
    marginBottom: 4,
  },
  warningText: {
    color: "#4f3b00",
    marginTop: 2,
  },
  warningAction: {
    marginTop: 10,
  },
  timingBox: {
    borderColor: "#cccccc",
    borderWidth: 1,
  },
  timingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  timingWarning: {
    borderTopColor: "#b00020",
    borderTopWidth: 1,
    color: "#b00020",
    padding: 10,
  },
  stats: {
    color: "#444444",
    fontSize: 13,
  },
  output: {
    borderColor: "#999999",
    borderWidth: 1,
    fontSize: 14,
    minHeight: 260,
    padding: 10,
    textAlignVertical: "top",
  },
});
