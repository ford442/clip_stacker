import { useCallback, useEffect, useRef, useState } from 'react';

export interface PreviewSize {
  /** CSS pixels the preview should occupy. */
  cssWidth: number;
  cssHeight: number;
  /** High-DPI backing-store size. */
  canvasWidth: number;
  canvasHeight: number;
  /** Device pixel ratio used for the backing store. */
  dpr: number;
}

export interface PreviewSizeConstraints {
  /** Max fraction of viewport width (0-1). */
  maxWidthPct?: number;
  /** Max fraction of viewport height (0-1). */
  maxHeightPct?: number;
  /** Absolute pixel cap on the backing store (default 1920×1080 area). */
  maxPixelArea?: number;
}

const DEFAULT_MAX_WIDTH_PCT = 0.9;
const DEFAULT_MAX_HEIGHT_PCT = 0.75;
const DEFAULT_MAX_PIXEL_AREA = 1920 * 1080;

/**
 * Compute a preview size that fits inside a container while capping at a
 * percentage of the browser viewport. The backing store is sized at DPR so the
 * preview stays crisp on high-density displays without exceeding a sane pixel
 * budget.
 */
export function computePreviewSize(
  containerWidth: number,
  containerHeight: number,
  aspectRatio: number,
  constraints: PreviewSizeConstraints = {},
): PreviewSize {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const maxWidthPct = constraints.maxWidthPct ?? DEFAULT_MAX_WIDTH_PCT;
  const maxHeightPct = constraints.maxHeightPct ?? DEFAULT_MAX_HEIGHT_PCT;
  const maxPixelArea = constraints.maxPixelArea ?? DEFAULT_MAX_PIXEL_AREA;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : containerWidth;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : containerHeight;

  const maxCssWidth = Math.min(containerWidth, viewportWidth * maxWidthPct);
  const maxCssHeight = Math.min(containerHeight, viewportHeight * maxHeightPct);

  let cssWidth = maxCssWidth;
  let cssHeight = cssWidth / aspectRatio;
  if (cssHeight > maxCssHeight) {
    cssHeight = maxCssHeight;
    cssWidth = cssHeight * aspectRatio;
  }

  let canvasWidth = Math.max(1, Math.round(cssWidth * dpr));
  let canvasHeight = Math.max(1, Math.round(cssHeight * dpr));

  const area = canvasWidth * canvasHeight;
  if (area > maxPixelArea) {
    const scale = Math.sqrt(maxPixelArea / area);
    canvasWidth = Math.max(1, Math.round(canvasWidth * scale));
    canvasHeight = Math.max(1, Math.round(canvasHeight * scale));
  }

  return { cssWidth, cssHeight, canvasWidth, canvasHeight, dpr };
}

/**
 * Observe a preview container and report a size that is capped to a percentage
 * of the viewport and scaled for DPR. Stable across resize.
 */
export function usePreviewSize(
  elementRef: React.RefObject<HTMLElement>,
  aspectRatio: number,
  constraints: PreviewSizeConstraints = {},
): PreviewSize | null {
  const [size, setSize] = useState<PreviewSize | null>(null);
  const rafRef = useRef<number>(0);

  const measure = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = computePreviewSize(rect.width, rect.height, aspectRatio, constraints);
    setSize((prev) => {
      if (!prev) return next;
      const same =
        prev.cssWidth === next.cssWidth &&
        prev.cssHeight === next.cssHeight &&
        prev.canvasWidth === next.canvasWidth &&
        prev.canvasHeight === next.canvasHeight;
      return same ? prev : next;
    });
  }, [elementRef, aspectRatio, constraints]);

  useEffect(() => {
    measure();

    const onResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    };

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(onResize)
        : null;
    if (observer && elementRef.current) {
      observer.observe(elementRef.current);
    }

    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [measure]);

  return size;
}
