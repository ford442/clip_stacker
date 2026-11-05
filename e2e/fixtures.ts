/**
 * Golden render cases (#365). Each fixture is built from the bundled demo
 * clips (6 s each, 640x360) by `window.clipStacker.test.buildProject` and
 * rendered at 320x180 so SwiftShader stays fast and the PNG goldens small.
 *
 * `times` are output seconds on the 30 fps export grid (n / 30), so the
 * preview frame and the decoded export frame are the same frame.
 */

export interface GoldenCase {
  name: string;
  spec: Record<string, unknown>;
  times: number[];
  /**
   * `hdr10`: the preview canvas is the SDR monitor view of a PQ file, so the
   * golden is the PQ readback export encodes, and the export itself only has
   * to succeed — or refuse cleanly where no 10-bit encoder exists (CI's
   * Chromium has neither HEVC Main10 nor AV1 10-bit).
   */
  mode?: 'sdr' | 'hdr10';
  /** Per-case floor for preview ≈ export (grain is noise H.264 smooths). */
  minExportPsnr?: number;
  minExportSsim?: number;
}

const RESOLUTION = '320x180';
const TWO_CLIPS = [{ demo: 'a' }, { demo: 'b' }];
const ONE_CLIP = [{ demo: 'b', trimEnd: 2 }];
const PATTERN_CLIP = [{ demo: 'a', trimEnd: 2 }];

/**
 * One pass on one clip. Settings are strong enough that the pass missing
 * from the render falls far below the golden floor (≤ 30 dB against the
 * unfinished frame). Passes that act on edges and texture use demo A (the
 * detailed test pattern); the smooth colour bars barely move under them.
 */
function finishing(
  pass: string,
  settings: Record<string, unknown>,
  clips: Record<string, unknown>[] = ONE_CLIP,
): Record<string, unknown> {
  return {
    clips,
    resolution: RESOLUTION,
    finishing: {
      schema: 'clip_stacker.finishing-preset',
      version: 1,
      name: `e2e ${pass}`,
      apply: 'replace',
      finishing: { [pass]: { enabled: true, ...settings } },
    },
  };
}

export const GOLDEN_CASES: GoldenCase[] = [
  { name: 'cut', spec: { clips: TWO_CLIPS, resolution: RESOLUTION }, times: [1, 7] },
  {
    name: 'xfade',
    spec: {
      clips: TWO_CLIPS,
      resolution: RESOLUTION,
      transitions: [{ afterClipIndex: 0, type: 'dissolve', duration: 1 }],
    },
    times: [5.5],
  },
  {
    name: 'pip-chroma-key',
    spec: {
      clips: [
        { demo: 'a', trimEnd: 3 },
        {
          demo: 'b',
          trimEnd: 3,
          layer: 1,
          startTime: 0,
          x: 0.5,
          y: 0.1,
          width: 0.45,
          height: 0.45,
          overlayBlend: 'chroma',
          chromaKey: { color: '#00ff00', similarity: 0.3, blend: 0.1 },
        },
      ],
      resolution: RESOLUTION,
    },
    times: [1],
  },
  {
    name: 'rotated-clip',
    spec: {
      clips: [
        {
          demo: 'b',
          trimEnd: 2,
          keyframes: {
            rotation: [{ t: 0, value: 15 }],
            scaleX: [{ t: 0, value: 0.8 }],
            scaleY: [{ t: 0, value: 0.8 }],
          },
        },
      ],
      resolution: RESOLUTION,
    },
    times: [1],
  },
  {
    name: 'title',
    spec: {
      clips: ONE_CLIP,
      resolution: RESOLUTION,
      textOverlays: [{ text: 'Golden title', fontsize: 28, x: 0.1, y: 0.1 }],
    },
    times: [1],
  },
  {
    name: 'captions',
    spec: {
      clips: ONE_CLIP,
      resolution: RESOLUTION,
      captions: [{ id: 'cue-1', startSec: 0, endSec: 2, text: 'Golden caption' }],
      captionExportMode: 'burn',
    },
    times: [1],
  },
  {
    name: 'finishing-noise-reduction',
    spec: finishing(
      'noiseReduction',
      { quality: 'standard', spatialStrength: 1, spatialRadius: 4, temporal: false },
      PATTERN_CLIP,
    ),
    times: [1],
  },
  {
    name: 'finishing-primary',
    spec: finishing('primaryColor', { exposure: 0.4, contrast: 1.2, saturation: 1.3, temperature: 0.3 }),
    times: [1],
  },
  {
    name: 'finishing-curves',
    spec: finishing('curves', {
      levels: { outBlack: 0.04 },
      curves: { master: [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }] },
    }),
    times: [1],
  },
  {
    name: 'finishing-secondary',
    spec: finishing('secondaryColor', {
      grades: [{ enabled: true, maskType: 'hue', hueCenter: 0, hueWidth: 60, hueShift: 90, satScale: 1.5 }],
    }),
    times: [1],
  },
  { name: 'finishing-lut', spec: finishing('lut', { lutId: 'teal-orange', intensity: 1 }), times: [1] },
  {
    name: 'finishing-sharpen',
    spec: finishing('sharpen', { mode: 'classic', amount: 1, radius: 3, threshold: 0 }, PATTERN_CLIP),
    times: [1],
  },
  {
    name: 'finishing-chromatic-aberration',
    spec: finishing('chromaticAberration', { amount: 1, radial: 0, angle: 0 }, PATTERN_CLIP),
    times: [1],
  },
  {
    name: 'finishing-bloom',
    spec: finishing('bloom', { amount: 0.6, threshold: 0.5, radius: 0.5 }),
    times: [1],
  },
  {
    name: 'finishing-grain',
    spec: finishing('grain', { quality: 'film', amount: 1, size: 0.6 }, PATTERN_CLIP),
    times: [1],
  },
  {
    name: 'display-p3',
    spec: { clips: ONE_CLIP, resolution: RESOLUTION, colorManagement: { outputColor: 'display-p3' } },
    times: [1],
  },
  {
    name: 'hdr10',
    spec: { clips: ONE_CLIP, resolution: RESOLUTION, colorManagement: { outputColor: 'hdr10' } },
    times: [1],
    mode: 'hdr10',
  },
];
