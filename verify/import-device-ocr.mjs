#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function validLine(line) {
  return line && typeof line.text === "string" && line.text.length > 0 &&
    [line.x, line.y, line.w, line.h].every(Number.isFinite) &&
    (line.conf === null || Number.isFinite(line.conf));
}

export function validateDeviceOcrBundle(bundle) {
  if (bundle?.formatVersion !== 1 || !Array.isArray(bundle.frames) ||
      !bundle.frames.length) {
    throw new Error("不是受支持的 M3 OCR bundle（formatVersion 应为 1）");
  }
  if (bundle.stats?.formatVersion !== 1 ||
      bundle.stats?.capturesEverySourceFrame !== true ||
      !Number.isInteger(bundle.stats?.sourceFrameCount) ||
      bundle.stats.sourceFrameCount !== bundle.frames.length ||
      !Number.isFinite(bundle.stats?.fps) || bundle.stats.fps <= 0) {
    throw new Error("bundle 未证明它是完整连续的逐帧 OCR 序列");
  }
  const names = new Set();
  let previousTimeMs = -1;
  for (let index = 0; index < bundle.frames.length; index++) {
    const frame = bundle.frames[index];
    const expectedFile = `f_${String(index + 1).padStart(4, "0")}.json`;
    if (frame?.file !== expectedFile || frame?.sourceIndex !== index) {
      throw new Error(
        `帧序列不连续：第 ${index + 1} 帧应为 ${expectedFile}/sourceIndex=${index}`,
      );
    }
    if (names.has(frame.file)) throw new Error(`帧文件名重复：${frame.file}`);
    names.add(frame.file);
    if (!Number.isFinite(frame.timeMs) || frame.timeMs <= previousTimeMs) {
      throw new Error(`${frame.file} 的 timeMs 必须有限且严格递增`);
    }
    previousTimeMs = frame.timeMs;
    if (!Array.isArray(frame.lines) || !frame.lines.every(validLine)) {
      throw new Error(`${frame.file} 不符合 text/x/y/w/h/conf 缓存格式`);
    }
  }
  if (bundle.stats?.capturedFrameCount !== bundle.frames.length) {
    throw new Error(
      `统计帧数 ${bundle.stats?.capturedFrameCount} 与实际 ${bundle.frames.length} 不符`,
    );
  }
  return bundle;
}

export function importDeviceOcrBundle(bundlePath, outputDir) {
  const bundle = validateDeviceOcrBundle(
    JSON.parse(fs.readFileSync(bundlePath, "utf8")),
  );
  if (fs.existsSync(outputDir)) {
    if (!fs.statSync(outputDir).isDirectory() || fs.readdirSync(outputDir).length) {
      throw new Error(`输出目录必须不存在或为空：${outputDir}`);
    }
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  for (const frame of bundle.frames) {
    fs.writeFileSync(
      path.join(outputDir, frame.file),
      `${JSON.stringify(frame.lines, null, 2)}\n`,
    );
  }
  return {
    outputDir,
    frameCount: bundle.frames.length,
    stats: bundle.stats,
  };
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [bundlePath, outputDir] = process.argv.slice(2);
  if (!bundlePath || !outputDir) {
    console.error("用法: node import-device-ocr.mjs <M3-OCR-BUNDLE.json> <空输出目录>");
    process.exit(1);
  }
  try {
    const result = importDeviceOcrBundle(bundlePath, outputDir);
    console.error(
      `已导入 ${result.frameCount} 帧 → ${result.outputDir}\n` +
      `复现本次 App 参数：node anchor-ocr.mjs ${result.outputDir} ` +
      `${result.stats.app === "wechat" ? "wechat" : "plain"} ` +
      `--stride ${result.stats.processingStride}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
