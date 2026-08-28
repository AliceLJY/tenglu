import { NativeModule, requireNativeModule } from 'expo';

import type {
  ExtractedFrameBatch,
  FrameCleanupResult,
  RegionRequest,
  RegionSampleBatch,
} from './TengluRegionSampler.types';

declare class TengluRegionSamplerModule extends NativeModule<{}> {
  extractFrames(sourceUri: string, timesJson: string): Promise<string>;
  cleanupFrames(): Promise<string>;
  sampleRegions(requestsJson: string): Promise<string>;
}

const nativeModule = requireNativeModule<TengluRegionSamplerModule>(
  'TengluRegionSampler',
);

export async function extractFrames(
  sourceUri: string,
  timesMs: number[],
): Promise<ExtractedFrameBatch> {
  return JSON.parse(
    await nativeModule.extractFrames(sourceUri, JSON.stringify(timesMs)),
  );
}

export async function cleanupFrames(): Promise<FrameCleanupResult> {
  return JSON.parse(await nativeModule.cleanupFrames());
}

export async function sampleRegions(
  requests: RegionRequest[],
): Promise<RegionSampleBatch> {
  return JSON.parse(await nativeModule.sampleRegions(JSON.stringify(requests)));
}

export default nativeModule;
