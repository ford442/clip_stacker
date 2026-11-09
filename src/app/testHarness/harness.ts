/**
 * Render regression harness (`?test_harness`, #346): `window.clipStacker.test`.
 *
 * Same-page only, like `finishingPresetApi.ts`, and never installed on a
 * normal load — `main.tsx` imports this module dynamically only when the
 * query parameter is present, so it is a separate chunk.
 *
 * - `buildProject(spec)` / `loadProject(json)` / `snapshotProject()` — build
 *   a fixture from the bundled demo clips, or load a saved project whose
 *   clips reference them by file name.
 * - `renderPreviewFrame(t)` — one frame from the main-thread WebGPU timeline
 *   compositor, fed by `<video>` seeks (the preview's frame source), with
 *   the project's finishing, colour management, titles and captions.
 * - `exportProject()` — the app's real Render action; resolves to the file.
 * - `decodeFrame(blob, t)` — the exported file's frame at `t` via WebCodecs.
 * - `compare`, `toPng`, `fromPng`, `mediaDuration` — helpers that keep pixel
 *   data in the page (Playwright only sees scores and PNG strings).
 * - `timelineSummary`, `autoSaveSummary`, `crash` — for the smoke flows.
 */

import type {
  CaptionEntry,
  CaptionExportMode,
  ChromaKeySettings,
  Clip,
  ClipKeyframes,
  ClipTransition,
  ExportSettings,
  OverlayBlendMode,
  Project,
  TextOverlay,
} from '../../types';
import { DEFAULT_EXPORT_SETTINGS } from '../../types';
import { editorStore } from '../../store/editorStore';
import { settingsStore } from '../../store/settingsStore';
import { renderJobStore } from '../../store/renderJobStore';
import { playbackStore } from '../../store/playbackStore';
import { fetchDemoClips, DEMO_CLIPS } from '../../media/demoClips';
import { createClipId, getMediaInfo } from '../../media/media';
import { moveClipToVideoLayer } from '../../timeline/trackModel';
import { applyProjectData, serializeProject } from '../../project';
import { selectProjectSnapshot } from '../../project/snapshot';
import { DEFAULT_FINISHING } from '../../finishing/finishing';
import { DEFAULT_COLOR_MANAGEMENT, type ColorManagementSettings } from '../../finishing/colorManagement';
import { applyFinishingPresetInput } from '../../store/finishingPresetStore';
import { visibleTextOverlays } from '../../timeline/trackModel';
import { selectTimelineClips } from '../../store/selectors';
import { computeTotalDuration } from '../../timeline/transitions';
import { getClipDuration } from '../../timeline/clipTiming';
import { readAutoSaveSession } from '../../project/autoSave';
import { DecoderFrameCursor } from '../../media/decoderCursor';
import { harnessBindings } from '../harnessBindings';
import { compareImages, meanRgb, type ImageComparison } from './imageMetrics';

export interface HarnessClipSpec {
  /** Which bundled demo clip (`public/demo/demo-clip-{a,b}.mp4`). */
  demo: 'a' | 'b';
  trimStart?: number;
  trimEnd?: number;
  /** Video lane: 0 = base sequence, 1+ = overlays (PiP). */
  layer?: number;
  /** Output start time on an overlay lane (seconds). */
  startTime?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  overlayBlend?: OverlayBlendMode;
  chromaKey?: ChromaKeySettings;
  keyframes?: ClipKeyframes;
}

export interface HarnessFixtureSpec {
  clips: HarnessClipSpec[];
  transitions?: ClipTransition[];
  textOverlays?: Partial<TextOverlay>[];
  captions?: CaptionEntry[];
  /** A finishing preset's `finishing` object (applied as `replace`). */
  finishing?: Record<string, unknown>;
  colorManagement?: Partial<ColorManagementSettings>;
  /** Output size, `"WxH"`; defaults to the demo clips' 640x360. */
  resolution?: string;
  /** How export carries captions (`settingsStore.captionExportMode`); default `none`. */
  captionExportMode?: CaptionExportMode;
}

const DEFAULT_RESOLUTION = '640x360';

let demoFiles: Map<string, File> | null = null;

async function demoFile(which: 'a' | 'b'): Promise<File> {
  if (!demoFiles) {
    const files = await fetchDemoClips();
    demoFiles = new Map(files.map((file) => [file.name, file]));
  }
  const spec = DEMO_CLIPS[which === 'a' ? 0 : 1];
  const file = spec ? demoFiles.get(spec.fileName) : undefined;
  if (!file) throw new Error(`demo clip ${which} not found`);
  return file;
}

/** The same Clip the toolbar's import builds for a file. */
async function clipFromFile(file: File): Promise<Clip> {
  const { duration, objectUrl, videoWidth, videoHeight, hasAudio } = await getMediaInfo(file);
  return {
    id: createClipId(),
    file,
    objectUrl,
    title: file.name,
    kind: 'video',
    duration,
    ...(videoWidth !== undefined ? { videoWidth } : {}),
    ...(videoHeight !== undefined ? { videoHeight } : {}),
    ...(hasAudio !== undefined ? { hasAudio } : {}),
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function resetProject(): void {
  disposePreviewEngine();
  const initial = editorStore.getInitialState();
  editorStore.getState().resetHistory({
    clips: [],
    tracks: initial.tracks,
    clipGroups: [],
    transitions: [],
    textOverlays: [],
    captions: [],
    captionStyle: {},
    masterAudioMarkers: [],
    selectedClipId: null,
    masterAudio: null,
  });
  settingsStore.getState().setFinishing(DEFAULT_FINISHING);
  settingsStore.getState().setColorManagement(DEFAULT_COLOR_MANAGEMENT);
  renderJobStore.getState().setStatus('');
}

function setResolution(resolution: string): void {
  const exportSettings: ExportSettings = {
    ...DEFAULT_EXPORT_SETTINGS,
    outputResolution: resolution,
  };
  delete exportSettings.resolutionPreset;
  settingsStore.getState().setExportSettings(exportSettings);
}

async function buildProject(spec: HarnessFixtureSpec): Promise<void> {
  resetProject();
  setResolution(spec.resolution ?? DEFAULT_RESOLUTION);
  const editor = editorStore.getState();
  for (const clipSpec of spec.clips) {
    const { demo, layer = 0, startTime, ...fields } = clipSpec;
    const clip: Clip = { ...(await clipFromFile(await demoFile(demo))), ...fields };
    editor.addClip(clip);
    if (layer > 0) {
      const state = editorStore.getState();
      const tracks = moveClipToVideoLayer(state.tracks, clip.id, layer, state.clips);
      editor.setTracks(
        startTime === undefined
          ? tracks
          : tracks.map((track) => ({
              ...track,
              items: track.items.map((item) => (item.clipId === clip.id ? { ...item, startTime } : item)),
            })),
      );
    }
  }
  if (spec.transitions) editor.setTransitions(spec.transitions);
  if (spec.textOverlays) {
    editor.setTextOverlays(
      spec.textOverlays.map((overlay, index) => ({
        id: `title-${index}`,
        text: 'Title',
        fontsize: 40,
        fontcolor: '#ffffff',
        x: 0.1,
        y: 0.1,
        scrolling: false,
        scrollSpeed: 20,
        box: true,
        boxColor: 'black@0.5',
        ...overlay,
      })),
    );
  }
  if (spec.captions) editor.setCaptions(spec.captions);
  if (spec.finishing) {
    const result = applyFinishingPresetInput(spec.finishing);
    if (!result.ok) throw new Error(`finishing: ${result.errors.join('; ')}`);
  }
  settingsStore.getState().setCaptionExportMode(spec.captionExportMode ?? 'none');
  if (spec.colorManagement) {
    settingsStore.getState().setColorManagement({ ...DEFAULT_COLOR_MANAGEMENT, ...spec.colorManagement });
  }
  editor.setSelectedClipId(null);
}

function snapshotProject(): Project {
  return serializeProject(selectProjectSnapshot(editorStore.getState(), settingsStore.getState()));
}

/** Load a saved project; its clips resolve against the demo clips by file name. */
async function loadProject(json: Project | string): Promise<void> {
  disposePreviewEngine();
  const project: Project = typeof json === 'string' ? (JSON.parse(json) as Project) : json;
  const live: Clip[] = [];
  for (const which of ['a', 'b'] as const) live.push(await clipFromFile(await demoFile(which)));
  const applied = await applyProjectData(project, live);
  editorStore.getState().resetHistory({
    clips: applied.clips,
    tracks: applied.tracks,
    clipGroups: applied.clipGroups,
    transitions: applied.transitions,
    textOverlays: applied.textOverlays,
    captions: applied.captions,
    captionStyle: applied.captionStyle,
    masterAudioMarkers: applied.masterAudioMarkers,
    selectedClipId: null,
    masterAudio: applied.masterAudio,
    ...(applied.masterBus ? { masterBus: applied.masterBus } : {}),
  });
  settingsStore.getState().setFinishing(applied.finishing);
  settingsStore.getState().setColorManagement(applied.colorManagement);
}

function outputSize(): { width: number; height: number } {
  const [w, h] = settingsStore.getState().exportSettings.outputResolution.split('x').map(Number);
  return { width: w || 640, height: h || 360 };
}

/** Read a canvas (WebGPU or 2D) back through a VideoFrame, as the encoder does. */
async function readCanvas(canvas: HTMLCanvasElement): Promise<ImageData> {
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  try {
    return videoFrameToImageData(frame, canvas.width, canvas.height);
  } finally {
    frame.close();
  }
}

function videoFrameToImageData(frame: VideoFrame, width: number, height: number): ImageData {
  const scratch = new OffscreenCanvas(width, height);
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(frame, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

type PreviewEngineHandle = {
  engine: import('../../webgpu/timelinePreview').TimelinePreviewEngine;
  canvas: HTMLCanvasElement;
  provider: import('../../media/decoderFrameProvider').TimelineDecoderFrameProvider;
  /** No frame drawn yet (see `renderPreviewFrame`). */
  fresh: boolean;
};

/** One engine for the harness's lifetime: SwiftShader pipeline compiles are slow. */
let previewHandle: PreviewEngineHandle | null = null;

function disposePreviewEngine(): void {
  previewHandle?.provider.destroy();
  previewHandle?.engine.destroy();
  previewHandle = null;
}

async function previewEngine(clips: Clip[]): Promise<PreviewEngineHandle> {
  if (previewHandle) return previewHandle;
  const { TimelinePreviewEngine } = await import('../../webgpu/timelinePreview');
  const { TimelineDecoderFrameProvider } = await import('../../media/decoderFrameProvider');
  const canvas = document.createElement('canvas');
  const { width, height } = outputSize();
  canvas.width = width;
  canvas.height = height;
  const engine = await TimelinePreviewEngine.create(canvas, clips);
  previewHandle = { engine, canvas, provider: new TimelineDecoderFrameProvider(), fresh: true };
  return previewHandle;
}

/**
 * One composed frame from the preview compositor at output time `t`: the
 * project's plan (titles, captions, finishing, colour management) at the
 * output size. Titles and captions are drawn on the 2D pass over the
 * composed frame, as the preview overlay and the 2D export composite do.
 */
async function renderPreviewFrame(t: number): Promise<ImageData> {
  const { renderTextOverlaysAsync } = await import('../../export/canvasRenderer');
  const editor = editorStore.getState();
  const settings = settingsStore.getState();
  const { width, height } = outputSize();
  const clips = selectTimelineClips(editor);
  const overlays = visibleTextOverlays(editor.tracks, editor.textOverlays);
  const handle = await previewEngine(clips);
  const { engine, canvas, provider } = handle;
  // Grain / denoise temporal state would otherwise depend on call order.
  engine.resetFinishingTemporal();
  const render = () =>
    engine.renderTimelineFrame(
      clips,
      editor.clipGroups,
      editor.transitions,
      overlays,
      settings.exportSettings,
      t,
      {
        maxHeight: height,
        maxWidth: width,
        finishing: settings.finishing,
        colorManagement: settings.colorManagement,
        captions: editor.captions,
        captionStyle: editor.captionStyle,
        // The preview worker's happy path: WebCodecs cursors, as export uses.
        // (The `<video>`-seek fallback renders black under headless SwiftShader.)
        frameProvider: provider,
      },
    );
  // With managed colour (P3 / HDR10) the first frame a fresh engine draws
  // comes out black — the live preview never shows it because it keeps
  // drawing. Draw it once and throw it away. (Export's frame 0 has the same
  // defect; e2e/goldens.spec.ts pins it as a known failure.)
  if (handle.fresh) {
    await render();
    await engine.flush();
    handle.fresh = false;
  }
  const plan = await render();
  await engine.flush();
  const hasText = plan.layers.some((layer) => layer.kind === 'text' || layer.kind === 'caption');
  if (!hasText) return readCanvas(canvas);
  const composite = document.createElement('canvas');
  composite.width = canvas.width;
  composite.height = canvas.height;
  const ctx = composite.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.drawImage(canvas, 0, 0);
  await renderTextOverlaysAsync(composite, plan, { clear: false });
  return readCanvas(composite);
}

/**
 * HDR10: the PQ-encoded RGBA the export hands its 10-bit encoder for frame
 * `t` (`readPqExportRgba`). The canvas shows the SDR monitor view instead.
 */
async function renderPqFrame(t: number): Promise<ImageData> {
  await renderPreviewFrame(t);
  if (!previewHandle) throw new Error('preview engine missing');
  const rgba = await previewHandle.engine.readPqExportRgba();
  if (!rgba) throw new Error('no PQ readback (is colourManagement.outputColor hdr10?)');
  const { width, height } = previewHandle.canvas;
  return new ImageData(new Uint8ClampedArray(rgba), width, height);
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

export interface ExportOptions {
  /**
   * Re-encode even when FFmpeg could stream-copy (default true), so the file
   * comes from the compositor the goldens are about.
   */
  forceReencode?: boolean;
  /** Force the FFmpeg path (`settingsStore.forceFFmpeg`); default false. */
  forceFFmpeg?: boolean;
}

/** Run the app's Render action and return the produced file. */
async function exportProject(options: ExportOptions = {}): Promise<Blob> {
  if (!harnessBindings.performRender) throw new Error('App has not bound its render action yet');
  const settings = settingsStore.getState();
  const previous = { forceReencode: settings.forceReencode, forceFFmpeg: settings.forceFFmpeg };
  settings.setForceReencode(options.forceReencode ?? true);
  settings.setForceFFmpeg(options.forceFFmpeg ?? false);
  try {
    // performRender closes over the clips React last rendered; let a fixture
    // built just now commit (and the binding effect re-run) first.
    await settle();
    await harnessBindings.performRender();
  } finally {
    settings.setForceReencode(previous.forceReencode);
    settings.setForceFFmpeg(previous.forceFFmpeg);
  }
  const { outputUrl, status } = renderJobStore.getState();
  if (!outputUrl) throw new Error(`Render produced no output: ${status}`);
  return (await fetch(outputUrl)).blob();
}

/** The exported file's frame at `t` (seconds), decoded with WebCodecs. */
async function decodeFrame(blob: Blob, t: number): Promise<ImageData> {
  const cursor = await DecoderFrameCursor.open(blob, 0, t + 1);
  try {
    const frame = await cursor.frameAt(t);
    if (!frame) throw new Error(`no decoded frame at ${t}s`);
    try {
      return videoFrameToImageData(frame, frame.displayWidth, frame.displayHeight);
    } finally {
      frame.close();
    }
  } finally {
    cursor.close();
  }
}

async function mediaDuration(blob: Blob): Promise<number> {
  const info = await getMediaInfo(new File([blob], 'export.mp4', { type: 'video/mp4' }));
  URL.revokeObjectURL(info.objectUrl);
  return info.duration;
}

function toPng(image: ImageData): Promise<string> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' }).then(async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  });
}

async function fromPng(base64: string): Promise<ImageData> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** What the timeline holds now: pool size, output duration, per-clip titles and durations. */
function timelineSummary(): {
  clipCount: number;
  totalDuration: number;
  titles: string[];
  durations: number[];
} {
  const editor = editorStore.getState();
  const clips = selectTimelineClips(editor);
  return {
    clipCount: editor.clips.length,
    totalDuration: computeTotalDuration(clips, editor.transitions),
    titles: clips.map((clip) => clip.title),
    durations: clips.map((clip) => getClipDuration(clip)),
  };
}

/** The autosave session in storage, summarized (null when none). */
function autoSaveSummary(): { clipCount: number; savedAt: string } | null {
  const session = readAutoSaveSession();
  if (!session) return null;
  return { clipCount: session.project.clips.length, savedAt: String(session.savedAt) };
}

/** Throw inside `App`'s render, as a real component crash would. */
function crash(message = 'test harness crash'): void {
  if (!harnessBindings.crash) throw new Error('App has not bound its crash switch yet');
  harnessBindings.crash(new Error(message));
}

export const testHarness = {
  buildProject,
  loadProject,
  snapshotProject,
  renderPreviewFrame,
  renderPqFrame,
  exportProject,
  decodeFrame,
  mediaDuration,
  timelineSummary,
  autoSaveSummary,
  crash,
  toPng,
  fromPng,
  compare: (a: ImageData, b: ImageData): ImageComparison => compareImages(a, b),
  meanRgb: (image: ImageData) => meanRgb(image),
  /** Free the cached preview engine (GPU device resources, decoder cursors). */
  disposePreviewEngine,
  stores: { editorStore, settingsStore, renderJobStore, playbackStore },
};

export type TestHarness = typeof testHarness;

declare global {
  interface Window {
    clipStacker?: { test?: TestHarness } & Record<string, unknown>;
  }
}

export function installTestHarness(target: Window = window): void {
  const api = (target.clipStacker ??= {});
  api.test = testHarness;
}
