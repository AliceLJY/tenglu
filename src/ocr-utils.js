function assertRgbaCanvas(canvas, width, height) {
  if (!(canvas instanceof Uint8Array)) {
    throw new TypeError("canvas must be a Uint8Array");
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError("width must be a positive integer");
  }
  if (height !== undefined && (!Number.isInteger(height) || height < 0)) {
    throw new RangeError("height must be a non-negative integer");
  }

  const required = height === undefined ? width * 4 : width * height * 4;
  if (height === undefined ? canvas.length % required !== 0 : canvas.length < required) {
    throw new RangeError("canvas length does not match its dimensions");
  }
}

/** Return an independent copy of whole RGBA rows from a canvas. */
function copyRgbaRows(canvas, width, startY, height) {
  assertRgbaCanvas(canvas, width);
  if (!Number.isInteger(startY) || startY < 0 ||
      !Number.isInteger(height) || height < 0) {
    throw new RangeError("startY and height must be non-negative integers");
  }

  const stride = width * 4;
  const totalHeight = canvas.length / stride;
  if (startY + height > totalHeight) {
    throw new RangeError("requested rows exceed the canvas");
  }

  const start = startY * stride;
  const out = new Uint8Array(height * stride);
  out.set(canvas.subarray(start, start + out.length));
  return out;
}

function validFrame(frame) {
  return frame &&
    [frame.left, frame.top, frame.width, frame.height].every(Number.isFinite) &&
    frame.width > 0 && frame.height > 0;
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 === 1
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

/** Sample the per-channel median of bright pixels inside a clipped OCR frame. */
function sampleBrightMedianRgb(
  canvas,
  width,
  height,
  frame,
  threshold = 150,
  minBrightCount = 20,
) {
  assertRgbaCanvas(canvas, width, height);
  if (!validFrame(frame) || !Number.isFinite(threshold) ||
      !Number.isInteger(minBrightCount) || minBrightCount < 1) return null;

  const left = Math.max(0, Math.floor(frame.left));
  const top = Math.max(0, Math.floor(frame.top));
  const right = Math.min(width, Math.ceil(frame.left + frame.width));
  const bottom = Math.min(height, Math.ceil(frame.top + frame.height));
  if (left >= right || top >= bottom) return null;

  const red = [];
  const green = [];
  const blue = [];
  const allRed = [];
  const allGreen = [];
  const allBlue = [];
  for (let y = top; y < bottom; y++) {
    let pixel = (y * width + left) * 4;
    for (let x = left; x < right; x++, pixel += 4) {
      const r = canvas[pixel];
      const g = canvas[pixel + 1];
      const b = canvas[pixel + 2];
      allRed.push(r);
      allGreen.push(g);
      allBlue.push(b);
      // Match the verified reference: brightness is the arithmetic RGB mean.
      if (r + g + b > threshold * 3) {
        red.push(r);
        green.push(g);
        blue.push(b);
      }
    }
  }

  const channels = red.length >= minBrightCount
    ? [red, green, blue]
    : [allRed, allGreen, allBlue];
  return channels[0].length
    ? channels.map(median)
    : null;
}

/** Convert ML Kit lines from one OCR segment into long-canvas coordinates. */
function collectRecognizedLines(result, segmentTop, canvas, width, height) {
  if (!Number.isFinite(segmentTop)) {
    throw new TypeError("segmentTop must be finite");
  }
  assertRgbaCanvas(canvas, width, height);

  const collected = [];
  for (const block of result?.blocks ?? []) {
    for (const line of block?.lines ?? []) {
      if (typeof line?.text !== "string") continue;
      const text = line.text.trim();
      if (!text) continue;

      const frame = line.frame == null ? block.frame : line.frame;
      if (!validFrame(frame)) continue;

      const globalFrame = { ...frame, top: frame.top + segmentTop };
      collected.push({
        text,
        x: frame.left,
        y: globalFrame.top,
        rgb: sampleBrightMedianRgb(canvas, width, height, globalFrame),
      });
    }
  }
  return collected;
}

module.exports = {
  collectRecognizedLines,
  copyRgbaRows,
  sampleBrightMedianRgb,
};
