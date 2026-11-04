/**
 * `selectEncoderPath` is the one routing decision. This table pins it, and
 * checks that the pre-render estimate (`calculateRenderPlan`) and the router
 * (`hybridMergeClips`, with its encoders stubbed) land on the same path for
 * every row — the estimate used to say "canvas" for speed curves, loops and
 * reverse, which the router then refused, and ignored the "GPU only when
 * re-encoding" rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ClipTransition, TextOverlay } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { DEFAULT_FINISHING, type FinishingSettings } from './finishing';
import { DEFAULT_COLOR_MANAGEMENT, type ColorManagementSettings } from './colorManagement';
import { hdr10TextRefusal, selectEncoderPath, type SelectedEncoderPath } from './encoderPath';

const probes = vi.hoisted(() => ({ webGpu: false, webCodecs: false }));

vi.mock('../webgpu/exportCompositor', () => ({
  isWebGpuExportAvailable: vi.fn(async () => probes.webGpu),
}));
vi.mock('./webcodecs', () => ({
  isWebCodecsAvailable: vi.fn(async () => probes.webCodecs),
  encodeVideoWithWebCodecs: vi.fn(async () => new Blob(['gpu'])),
}));
vi.mock('./webcodecs-audio', () => ({
  isAudioEncoderAvailable: vi.fn(async () => false),
  assessWebCodecsAudioMix: vi.fn(() => ({ supported: false, reason: 'test' })),
  prepareStreamingAudioMix: vi.fn(async () => false),
}));
vi.mock('./canvas-encoder', () => ({
  encodeClipsWithCanvas: vi.fn(async () => new Blob(['canvas'])),
}));
vi.mock('../ffmpeg/ffmpegService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ffmpeg/ffmpegService')>()),
  mergeClips: vi.fn(async () => new Blob(['ffmpeg'])),
  muxVideoWithAudio: vi.fn(async (blob: Blob) => blob),
}));

import { calculateRenderPlan } from '../ffmpeg/ffmpegService';
import { hybridMergeClips } from './hybrid-encoder';
import { encodeVideoWithWebCodecs } from './webcodecs';

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 4,
    // Matches the default 1080p output, so a plain clip is a lossless concat.
    videoWidth: 1920,
    videoHeight: 1080,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

const PLAIN = [clip('a'), clip('b')];
const FADED = [clip('a', { videoFadeIn: 0.5 }), clip('b')];
const SPEED_CURVE = [
  clip('a', { automation: { playbackRate: [{ t: 0, value: 1 }, { t: 2, value: 2 }] } }),
];
const LOOPED = [clip('a', { loopCount: 3 })];
const REVERSED = [clip('a', { reversed: true })];
const RIFE = [clip('a', { rifeProcessed: true, videoFadeIn: 0.5 })];
const KEYED = [clip('a'), clip('b', { layerIndex: 1, overlayBlend: 'chroma', chromaKey: { color: '#00ff00', similarity: 0.4, blend: 0.1 } })];
const XFADE: ClipTransition[] = [{ afterClipIndex: 0, type: 'fade', duration: 0.5 }];
const TITLE: TextOverlay = {
  id: 't',
  text: 'Title',
  fontsize: 32,
  fontcolor: 'white',
  x: 0,
  y: 0,
  scrolling: false,
  scrollSpeed: 0,
  box: false,
  boxColor: 'black@0.5',
};
const GRADED: FinishingSettings = {
  ...DEFAULT_FINISHING,
  lut: { enabled: true, lutId: 'some-lut', intensity: 1 },
};
const HDR10: ColorManagementSettings = { ...DEFAULT_COLOR_MANAGEMENT, outputColor: 'hdr10' };

interface Row {
  name: string;
  clips: Clip[];
  transitions?: ClipTransition[];
  textOverlays?: TextOverlay[];
  finishing?: FinishingSettings;
  forceFFmpeg?: boolean;
  useCanvas?: boolean;
  forceReencode?: boolean;
  webGpu: boolean;
  webCodecs: boolean;
  expected: SelectedEncoderPath;
}

const ROWS: Row[] = [
  { name: 'plain concat, GPU everywhere', clips: PLAIN, webGpu: true, webCodecs: true, expected: 'ffmpeg' },
  { name: 'plain concat + Force re-encode', clips: PLAIN, forceReencode: true, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'fade, GPU everywhere', clips: FADED, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'fade, WebCodecs without WebGPU', clips: FADED, webGpu: false, webCodecs: true, expected: 'webcodecs' },
  { name: 'fade, no WebCodecs', clips: FADED, webGpu: true, webCodecs: false, expected: 'ffmpeg' },
  { name: 'fade, Force FFmpeg', clips: FADED, forceFFmpeg: true, webGpu: true, webCodecs: true, expected: 'ffmpeg' },
  { name: 'transition with WebGPU', clips: PLAIN, transitions: XFADE, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'transition without WebGPU', clips: PLAIN, transitions: XFADE, webGpu: false, webCodecs: true, expected: 'ffmpeg' },
  { name: 'finishing without WebGPU', clips: FADED, finishing: GRADED, webGpu: false, webCodecs: true, expected: 'ffmpeg' },
  { name: 'title with WebGPU', clips: PLAIN, textOverlays: [TITLE], webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'RIFE clip', clips: RIFE, webGpu: true, webCodecs: true, expected: 'ffmpeg' },
  { name: 'canvas, plain fade', clips: FADED, useCanvas: true, webGpu: true, webCodecs: true, expected: 'canvas' },
  { name: 'canvas, speed curve → GPU', clips: SPEED_CURVE, useCanvas: true, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'canvas, speed curve, no WebGPU', clips: SPEED_CURVE, useCanvas: true, webGpu: false, webCodecs: true, expected: 'ffmpeg' },
  { name: 'canvas, loop → GPU', clips: LOOPED, useCanvas: true, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'canvas, reversed → GPU', clips: REVERSED, useCanvas: true, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'canvas, keyed PiP → GPU', clips: KEYED, useCanvas: true, webGpu: true, webCodecs: true, expected: 'webcodecs' },
  { name: 'canvas, transition, no WebGPU', clips: PLAIN, transitions: XFADE, useCanvas: true, webGpu: false, webCodecs: false, expected: 'ffmpeg' },
];

function inputFor(row: Row) {
  return {
    clips: row.clips,
    transitions: row.transitions ?? [],
    textOverlays: row.textOverlays ?? [],
    finishing: row.finishing ?? DEFAULT_FINISHING,
    forceFFmpeg: row.forceFFmpeg ?? false,
    useCanvas: row.useCanvas ?? false,
  };
}

function estimate(row: Row, colorManagement = DEFAULT_COLOR_MANAGEMENT) {
  const i = inputFor(row);
  return calculateRenderPlan(i.clips, i.transitions, i.textOverlays, DEFAULT_EXPORT_SETTINGS, {
    finishing: i.finishing,
    forceFFmpeg: i.forceFFmpeg,
    useCanvasRenderer: i.useCanvas,
    webGpuAvailable: row.webGpu,
    webCodecsAvailable: row.webCodecs,
    forceReencode: row.forceReencode,
    outputColor: colorManagement.outputColor,
  });
}

async function route(row: Row, colorManagement = DEFAULT_COLOR_MANAGEMENT) {
  probes.webGpu = row.webGpu;
  probes.webCodecs = row.webCodecs;
  const i = inputFor(row);
  return hybridMergeClips(
    i.clips,
    i.transitions,
    DEFAULT_EXPORT_SETTINGS,
    () => {},
    undefined,
    i.forceFFmpeg,
    i.textOverlays,
    i.useCanvas,
    true,
    row.forceReencode ?? false,
    undefined,
    [],
    i.finishing,
    null,
    null,
    colorManagement,
  );
}

const basePath = (path: string) => (path === 'webcodecs-av' ? 'webcodecs' : path);

describe('selectEncoderPath', () => {
  beforeEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {};
    vi.mocked(encodeVideoWithWebCodecs).mockClear();
  });

  it.each(ROWS)('$name → $expected', (row) => {
    const i = inputFor(row);
    const decision = selectEncoderPath({
      ...i,
      webGpuAvailable: row.webGpu,
      webCodecsAvailable: row.webCodecs,
      mediaRecorderAvailable: true,
      willReencode: estimate(row).willReencode || row.forceReencode === true,
    });
    expect(decision.path).toBe(row.expected);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it.each(ROWS)('estimate and router agree: $name', async (row) => {
    const plan = estimate(row);
    const result = await route(row);
    expect(plan.encoderIntent).toBe(row.expected);
    expect(basePath(result.path)).toBe(row.expected);
    expect(result.renderPlan?.encoderReasons?.length).toBeGreaterThan(0);
  });

  it('demotes canvas when MediaRecorder is missing', () => {
    const decision = selectEncoderPath({
      ...inputFor({ name: '', clips: FADED, useCanvas: true, webGpu: true, webCodecs: true, expected: 'canvas' }),
      webGpuAvailable: true,
      webCodecsAvailable: true,
      mediaRecorderAvailable: false,
      willReencode: true,
    });
    expect(decision.path).toBe('webcodecs');
    expect(decision.reasons[0]).toMatch(/MediaRecorder/);
  });

  it('names what the canvas path cannot composite', () => {
    const decision = selectEncoderPath({
      ...inputFor({ name: '', clips: [...SPEED_CURVE, ...LOOPED], useCanvas: true, webGpu: true, webCodecs: true, expected: 'webcodecs' }),
      webGpuAvailable: true,
      webCodecsAvailable: true,
      willReencode: true,
    });
    expect(decision.reasons[0]).toMatch(/speed curves, loops/);
  });
});

describe('HDR10 with titles or captions (refused, #347)', () => {
  const row: Row = { name: 'hdr10 title', clips: FADED, textOverlays: [TITLE], webGpu: true, webCodecs: true, expected: 'webcodecs' };

  it('the estimate carries the refusal', () => {
    const plan = estimate(row, HDR10);
    expect(plan.refusal).toMatch(/HDR10 export cannot include text overlays/);
    expect(estimate(row).refusal).toBeUndefined();
  });

  it('the router refuses before encoding anything', async () => {
    await expect(route(row, HDR10)).rejects.toThrow(/HDR10 export cannot include text overlays/);
    expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
  });

  it('burned-in captions are refused too; soft captions and plain HDR10 are not', () => {
    expect(hdr10TextRefusal({ outputColor: 'hdr10', textOverlays: [], burnCaptions: true })).toMatch(/captions/);
    expect(hdr10TextRefusal({ outputColor: 'hdr10', textOverlays: [], burnCaptions: false })).toBeUndefined();
    expect(hdr10TextRefusal({ outputColor: 'display-p3', textOverlays: [TITLE], burnCaptions: true })).toBeUndefined();
  });

  it('HDR10 + title on FFmpeg is not refused (FFmpeg writes Rec.709 and says so)', () => {
    const plan = estimate({ ...row, forceFFmpeg: true }, HDR10);
    expect(plan.encoderIntent).toBe('ffmpeg');
    expect(plan.refusal).toBeUndefined();
  });
});
