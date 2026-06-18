/**
 * Preview budget helpers: cap the live preview resolution and decide when the
 * preview has been degraded enough to warrant a user-visible notice.
 *
 * The cap keeps compositing/decoding cost bounded on high-resolution projects
 * (1080p/1440p/4k) by rendering the preview at a reduced height while preserving
 * aspect ratio. It is an internal default (720p) — there is no UI control.
 */

import { WEBGPU_LAYER_BUDGET, type PreviewBackend } from "./feature-detector";

/** Default maximum height (px) for the live preview composite. */
export const DEFAULT_PREVIEW_MAX_HEIGHT = 720;

export interface CappedResolution {
  width: number;
  height: number;
  /** Capped / output scale factor (1 when no cap applied). */
  scale: number;
  /** Whether the resolution was actually reduced. */
  capped: boolean;
}

/**
 * Scale `width`x`height` down so height never exceeds `maxHeight`, preserving
 * aspect ratio. Returns the original dimensions (scale 1) when already within
 * budget or when inputs are degenerate.
 */
export function capPreviewResolution(
  width: number,
  height: number,
  maxHeight: number = DEFAULT_PREVIEW_MAX_HEIGHT,
): CappedResolution {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    maxHeight <= 0 ||
    height <= maxHeight
  ) {
    return { width, height, scale: 1, capped: false };
  }

  const scale = maxHeight / height;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: maxHeight,
    scale,
    capped: true,
  };
}

export interface PreviewBudgetInput {
  backend: PreviewBackend;
  /** Whether the preview resolution was reduced. */
  capped: boolean;
  /** Original (uncapped) output height. */
  outputHeight: number;
  /** Capped preview height actually rendered. */
  cappedHeight: number;
  /** Estimated simultaneous layers in the composition. */
  layerCount: number;
}

export interface PreviewBudgetResult {
  degraded: boolean;
  /** Short user-facing message, or null when nothing is degraded. */
  message: string | null;
}

/**
 * Decide whether the preview is running in a degraded mode and build a concise
 * message for the user. Covers resolution capping and WebGPU→Canvas2D fallback
 * caused by exceeding the layer budget.
 */
export function evaluatePreviewBudget(
  input: PreviewBudgetInput,
): PreviewBudgetResult {
  const parts: string[] = [];

  if (input.capped && input.outputHeight > input.cappedHeight) {
    parts.push(
      `reduced to ${input.cappedHeight}p (from ${input.outputHeight}p)`,
    );
  }

  if (input.backend === "canvas2d" && input.layerCount > WEBGPU_LAYER_BUDGET) {
    parts.push(
      `compositing ${input.layerCount} layers on Canvas2D (over the ${WEBGPU_LAYER_BUDGET}-layer WebGPU budget)`,
    );
  }

  if (parts.length === 0) {
    return { degraded: false, message: null };
  }

  return {
    degraded: true,
    message: `Preview quality ${parts.join(" · ")} for performance.`,
  };
}
