/**
 * Feature detection + debug override for decoder-backed live preview.
 *
 * The happy path decodes preview frames with `VideoDecoder` inside the preview
 * worker (no `HTMLVideoElement.currentTime` on the main thread). `?legacy_preview_video`
 * forces the old hidden-`<video>` seek path so the two can be compared on the
 * same machine, and so a decoder regression has a one-URL escape hatch.
 *
 * Evaluated on the main thread only: a worker's `location.search` is the worker
 * script URL's query, not the page's, so the resolved flag is passed in `init`.
 */

const LEGACY_PARAM = 'legacy_preview_video';

let testOverride: boolean | null = null;

export function isLegacyPreviewVideoForced(
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.has(LEGACY_PARAM);
}

/** True when WebCodecs demux+decode can serve preview frames in a worker. */
export function isPreviewDecoderSupported(
  scope: { VideoDecoder?: unknown; EncodedVideoChunk?: unknown } = globalThis as never,
): boolean {
  return typeof scope.VideoDecoder === 'function' && typeof scope.EncodedVideoChunk === 'function';
}

/**
 * Whether the preview worker should try the decoder path at all.
 * `testOverride` (set via `__setPreviewDecoderOverrideForTests`) wins, then the
 * URL kill switch, then feature detection.
 */
export function isPreviewDecoderEnabled(
  search?: string,
  scope?: { VideoDecoder?: unknown; EncodedVideoChunk?: unknown },
): boolean {
  if (testOverride !== null) return testOverride;
  if (isLegacyPreviewVideoForced(search)) return false;
  return isPreviewDecoderSupported(scope);
}

function pageParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/** `?gpu_profile`: per-pass GPU timings (timestamp-query) in metrics and Copy Debug. */
export function isGpuProfileRequestedByPage(
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  return pageParams(search).has('gpu_profile');
}

/**
 * `?test_harness` runs on SwiftShader, a fallback adapter: only then may live
 * preview use one (`allowFallbackAdapterForPreview`).
 */
export function isFallbackAdapterAllowedByPage(
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  return pageParams(search).has('test_harness');
}

export function __setPreviewDecoderOverrideForTests(value: boolean | null): void {
  testOverride = value;
}
