import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PACKAGE = "@react-native-ml-kit/text-recognition";
const EXPECTED_VERSION = "2.0.0";
const JAVA_RELATIVE = path.join(
  "android",
  "src",
  "main",
  "java",
  "com",
  "rnmlkit",
  "textrecognition",
  "TextRecognitionModule.java",
);
const NEEDLE = '        map.putString("text", line.getText());';
const PATCHED = [
  NEEDLE,
  '        map.putDouble("confidence", line.getConfidence());',
].join("\n");

export function patchMlKitConfidence(root = process.cwd()) {
  const packageRoot = path.join(root, "node_modules", ...PACKAGE.split("/"));
  const packageJsonPath = path.join(packageRoot, "package.json");
  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (metadata.version !== EXPECTED_VERSION) {
    throw new Error(
      `${PACKAGE} 版本应为 ${EXPECTED_VERSION}，实际 ${metadata.version}；` +
      "拒绝把补丁套到未知源码。",
    );
  }

  const javaPath = path.join(packageRoot, JAVA_RELATIVE);
  const source = fs.readFileSync(javaPath, "utf8");
  if (source.includes(PATCHED)) return { changed: false, javaPath };
  const occurrences = source.split(NEEDLE).length - 1;
  if (occurrences !== 1) {
    throw new Error(`ML Kit confidence 补丁锚点应出现 1 次，实际 ${occurrences} 次。`);
  }
  fs.writeFileSync(javaPath, source.replace(NEEDLE, PATCHED));
  return { changed: true, javaPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = patchMlKitConfidence();
  console.log(
    result.changed
      ? "已让 ML Kit Android bridge 返回真实 line confidence。"
      : "ML Kit Android bridge confidence 补丁已存在。",
  );
}
