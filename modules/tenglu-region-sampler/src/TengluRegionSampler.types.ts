export type RegionRequest = {
  id: string;
  frameIndex: number;
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExtractedFrame = {
  uri: string;
  width: number;
  height: number;
  requestedTimeMs: number;
};

export type ExtractedFrameBatch = {
  frames: ExtractedFrame[];
  method: "MediaMetadataRetriever.OPTION_CLOSEST";
  staleFileCount: number;
  staleDeletedCount: number;
  elapsedMs: number;
};

export type FrameCleanupResult = {
  foundCount: number;
  deletedCount: number;
  remainingCount: number;
};

export type RegionSample = {
  id: string;
  frameIndex?: number;
  side: "me" | "them" | null;
  rgb?: number[];
  brightPixels?: number;
  decodedPixels?: number;
  sampledPixels?: number;
  width?: number;
  height?: number;
  error?: string;
  errorCode?: string;
  rect?: { x: number; y: number; width: number; height: number };
  frameWidth?: number;
  frameHeight?: number;
};

export type RegionSampleBatch = {
  samples: RegionSample[];
  decoderCount: number;
  elapsedMs: number;
};
