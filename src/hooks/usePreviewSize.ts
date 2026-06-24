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
  /** Size from window dimensions instead of the observed element rect. */
  preferViewport?: boolean;
}

export const DEFAULT_PREVIEW_CONSTRAINTS: PreviewSizeConstraints = {
  maxWidthPct: 0.9,
  maxHeightPct: 0.75,
};

/** Single-clip preview: size from viewport, not the panel column. */
export const VIEWPORT_PREVIEW_CONSTRAINTS: PreviewSizeConstraints = {
  ...DEFAULT_PREVIEW_CONSTRAINTS,
  preferViewport: true,
};

const DEFAULT_MAX_WIDTH_PCT = 0.9;
const DEFAULT_MAX_HEIGHT_PCT = 0.75;
const DEFAULT_MAX_PIXEL_AREA = 1920 * 1080;

/** Ignore sub-pixel size churn that would thrash the canvas backing store. */
export const PREVIEW_SIZE_THRESHOLD_PX = 2;

function sizesWithinThreshold(
  prev: PreviewSize,
  next: PreviewSize,
  threshold: number,
): boolean {
  return (
    Math.abs(prev.cssWidth - next.cssWidth) < threshold &&
    Math.abs(prev.cssHeight - next.cssHeight) < threshold &&
    Math.abs(prev.canvasWidth - next.canvasWidth) < threshold &&
    Math.abs(prev.canvasHeight - next.canvasHeight) < threshold
  );
}

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
  constraints: PreviewSizeConstraints = DEFAULT_PREVIEW_CONSTRAINTS,
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
  constraints: PreviewSizeConstraints = DEFAULT_PREVIEW_CONSTRAINTS,
): PreviewSize | null {
  const [size, setSize] = useState<PreviewSize | null>(null);
  const rafRef = useRef<number>(0);

  const maxWidthPct = constraints.maxWidthPct ?? DEFAULT_MAX_WIDTH_PCT;
  const maxHeightPct = constraints.maxHeightPct ?? DEFAULT_MAX_HEIGHT_PCT;
  const maxPixelArea = constraints.maxPixelArea ?? DEFAULT_MAX_PIXEL_AREA;
  const preferViewport = constraints.preferViewport ?? false;

  const measure = useCallback(() => {
    const resolvedConstraints: PreviewSizeConstraints = {
      maxWidthPct,
      maxHeightPct,
      maxPixelArea,
    };

    let containerWidth: number;
    let containerHeight: number;
    if (preferViewport && typeof window !== 'undefined') {
      containerWidth = window.innerWidth;
      containerHeight = window.innerHeight;
    } else {
      const el = elementRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      containerWidth = rect.width;
      containerHeight = rect.height;
    }

    const next = computePreviewSize(
      containerWidth,
      containerHeight,
      aspectRatio,
      resolvedConstraints,
    );
    setSize((prev) => {
      if (!prev) return next;
      if (sizesWithinThreshold(prev, next, PREVIEW_SIZE_THRESHOLD_PX)) {
        return prev;
      }
      return next;
    });
  }, [
    elementRef,
    aspectRatio,
    maxWidthPct,
    maxHeightPct,
    maxPixelArea,
    preferViewport,
  ]);

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
    if (observer && elementRef.current && !preferViewport) {
      observer.observe(elementRef.current);
    }

    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [measure, elementRef, preferViewport]);

  return size;
}
