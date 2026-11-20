import { usePreviewCacheStore } from '../store/previewCacheStore';
import { PREVIEW_CACHE_FPS } from '../composition/previewCacheGrid';

/**
 * Inside the ruler: the In / Out range and, in green, the frames the RAM
 * preview holds for the timeline as it is now (they play back without being
 * composed again). Pointer events pass through to the ruler's scrub.
 */
export function PreviewCacheBar({ pixelsPerSecond }: { pixelsPerSecond: number }) {
  const ranges = usePreviewCacheStore((s) => s.cachedRanges);
  const inPoint = usePreviewCacheStore((s) => s.inPoint);
  const outPoint = usePreviewCacheStore((s) => s.outPoint);
  const px = (seconds: number) => seconds * pixelsPerSecond;
  return (
    <>
      {inPoint !== null && outPoint !== null && outPoint > inPoint && (
        <span
          className="ruler-inout-range"
          style={{ left: px(inPoint), width: px(outPoint - inPoint) }}
          title="In → Out (Shift+Enter renders it into the preview cache)"
        />
      )}
      {inPoint !== null && <span className="ruler-inout-mark ruler-inout-mark--in" style={{ left: px(inPoint) }} />}
      {outPoint !== null && <span className="ruler-inout-mark ruler-inout-mark--out" style={{ left: px(outPoint) }} />}
      {ranges.map(([start, end]) => (
        <span
          key={start}
          className="ruler-cache-span"
          data-testid="ruler-cache-span"
          style={{ left: px(start / PREVIEW_CACHE_FPS), width: Math.max(1, px((end - start) / PREVIEW_CACHE_FPS)) }}
        />
      ))}
    </>
  );
}
