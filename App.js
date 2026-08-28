import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  Alert,
  Button,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { processRecording } from "./src/pipeline";

const TIMING_ROWS = [
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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("等待选择录屏");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  async function chooseVideo() {
    if (busy) return;
    setError("");
    setResult(null);

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

    setBusy(true);
    setProgress("读取录屏");
    try {
      const output = await processRecording(
        picked.assets[0],
        mode,
        setProgress,
      );
      setResult(output);
      setProgress("完成，可以复制 Markdown");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setProgress("处理停止");
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    if (!result?.markdown) return;
    await Clipboard.setStringAsync(result.markdown);
    Alert.alert("已复制", "Markdown 已复制到剪贴板。");
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar backgroundColor="#ffffff" barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>誊录</Text>
        <Text style={styles.hint}>竖屏、匀速慢滑、中途不要切页面。</Text>

        <Text style={styles.label}>模式</Text>
        <View accessibilityRole="radiogroup" style={styles.modeRow}>
          <ModeButton
            active={mode === "wechat"}
            label="微信"
            onPress={() => !busy && setMode("wechat")}
          />
          <ModeButton
            active={mode === "generic"}
            label="通用"
            onPress={() => !busy && setMode("generic")}
          />
        </View>

        <Button
          disabled={busy}
          onPress={chooseVideo}
          title={busy ? "处理中…" : "选择录屏"}
        />

        <Text style={styles.progress}>{progress}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {result?.warnings?.length ? (
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
            <Text style={styles.label}>耗时（ms）</Text>
            <View style={styles.timingBox}>
              {TIMING_ROWS.map(([label, key]) => (
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

            <Text style={styles.stats}>
              滚动区 y{result.stats.scrollTop}~{result.stats.scrollBottom}；
              {result.stats.frameCount} 帧 → {result.stats.keyframeCount} 关键帧；
              长图 {result.stats.width}×{result.stats.height}
            </Text>

            <Text style={styles.label}>Markdown</Text>
            <TextInput
              editable={false}
              multiline
              scrollEnabled
              selectTextOnFocus
              style={styles.output}
              value={result.markdown}
            />
            <Button
              disabled={!result.markdown}
              onPress={copyResult}
              title="复制 Markdown"
            />
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
