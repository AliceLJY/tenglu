import { Directory } from "expo-file-system";

const {
  buildOcrCacheExport,
  utf8ByteLength,
} = require("./ocr-cache-format");

function timestampForName(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function exportOcrCache(capture, runSummary, onProgress) {
  const { entries } = buildOcrCacheExport(capture, runSummary);
  const parent = await Directory.pickDirectoryAsync();
  const folderName = `tenglu-m3-ocr-${runSummary.app}-${timestampForName()}`;
  const folder = parent.createDirectory(folderName);
  const directories = {
    "": folder,
    ocr: folder.createDirectory("ocr"),
    meta: folder.createDirectory("meta"),
  };
  let bytes = 0;
  let bundleUri = "";

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    onProgress?.(`写入 OCR JSON ${index + 1}/${entries.length}`);
    const file = directories[entry.directory].createFile(
      entry.name,
      "application/json",
    );
    file.write(entry.content);
    bytes += utf8ByteLength(entry.content);
    if (entry.name === "M3-OCR-BUNDLE.json") bundleUri = file.uri;
    if (index % 12 === 11) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return {
    directoryUri: folder.uri,
    ocrDirectoryUri: directories.ocr.uri,
    folderName,
    bundleUri,
    frameFileCount: capture.frames.length,
    fileCount: entries.length,
    bytes,
  };
}
