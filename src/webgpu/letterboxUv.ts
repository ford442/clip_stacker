/**
 * Letterbox UV maths shared by the GPU compositors and the Canvas2D layer
 * drawer. Kept apart from `exportCompositor.ts` so the Canvas2D text/overlay
 * path the editor loads up front does not drag in the preview engine and its
 * finishing pass chain (which stay behind the lazy export / fallback imports).
 */

export interface LetterboxUv {
  uvScale: [number, number];
  uvOffset: [number, number];
}

export function computeLetterboxUv(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): LetterboxUv {
  const safeVideoWidth = Math.max(1, videoWidth);
  const safeVideoHeight = Math.max(1, videoHeight);
  const videoAspect = safeVideoWidth / safeVideoHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  let destWidth: number;
  let destHeight: number;
  if (videoAspect > canvasAspect) {
    destWidth = canvasWidth;
    destHeight = canvasWidth / videoAspect;
  } else {
    destHeight = canvasHeight;
    destWidth = canvasHeight * videoAspect;
  }

  const x = (canvasWidth - destWidth) / 2;
  const y = (canvasHeight - destHeight) / 2;

  return {
    uvScale: [destWidth / canvasWidth, destHeight / canvasHeight],
    uvOffset: [x / canvasWidth, y / canvasHeight],
  };
}

/** Multiply letterbox UV with per-layer Ken Burns / animation UV. */
export function combineLetterboxWithLayerUv(
  letterbox: LetterboxUv,
  layerUvScale: [number, number] | undefined,
  layerUvOffset: [number, number] | undefined,
): LetterboxUv {
  const kx = layerUvScale?.[0] ?? 1;
  const ky = layerUvScale?.[1] ?? 1;
  const ox = layerUvOffset?.[0] ?? 0;
  const oy = layerUvOffset?.[1] ?? 0;
  return {
    uvScale: [letterbox.uvScale[0] * kx, letterbox.uvScale[1] * ky],
    uvOffset: [
      letterbox.uvOffset[0] + ox * letterbox.uvScale[0],
      letterbox.uvOffset[1] + oy * letterbox.uvScale[1],
    ],
  };
}

/** Map normalized texture UV rect to pixel crop in the source image. */
export function uvRectToSourcePixels(
  srcWidth: number,
  srcHeight: number,
  uv: LetterboxUv,
): { sx: number; sy: number; sw: number; sh: number } {
  return {
    sx: uv.uvOffset[0] * srcWidth,
    sy: uv.uvOffset[1] * srcHeight,
    sw: uv.uvScale[0] * srcWidth,
    sh: uv.uvScale[1] * srcHeight,
  };
}
