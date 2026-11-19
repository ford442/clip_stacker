/**
 * Build a render fixture (`e2e/fixtures.ts` specs) in the stores: the clips,
 * lanes, transitions, titles, captions, nesting, finishing and colour of a
 * `HarnessFixtureSpec`, through the same store actions the UI uses.
 *
 * The harness (`harness.ts`) feeds it the bundled demo clips; unit tests feed
 * it stand-in clips of the same length, so a fixture's saved project can be
 * checked without decoding media (the interchange round-trip tests do).
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
  TextOverlay,
} from '../../types';
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_PROJECT_TIMECODE } from '../../types';
import { editorStore } from '../../store/editorStore';
import { settingsStore } from '../../store/settingsStore';
import { moveClipToVideoLayer } from '../../timeline/trackModel';
import { DEFAULT_FINISHING } from '../../finishing/finishing';
import { DEFAULT_COLOR_MANAGEMENT, type ColorManagementSettings } from '../../finishing/colorManagement';
import { applyFinishingPresetInput } from '../../store/finishingPresetStore';

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
  /**
   * Nest these clips (indices into `clips`) and titles (indices into
   * `textOverlays`) into one sequence, placed where they were — the
   * Library's *Nest selected*.
   */
  nest?: { clips: number[]; titles?: number[] };
}

export const DEFAULT_FIXTURE_RESOLUTION = '640x360';

/** Empty project, default finishing / colour, no status. */
export function resetFixtureProject(): void {
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
  settingsStore.getState().setTimecode(DEFAULT_PROJECT_TIMECODE);
}

export function setFixtureResolution(resolution: string): void {
  const exportSettings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, outputResolution: resolution };
  delete exportSettings.resolutionPreset;
  settingsStore.getState().setExportSettings(exportSettings);
}

/** A default title with the spec's fields over it. */
export function fixtureTitle(overlay: Partial<TextOverlay>, index: number): TextOverlay {
  return {
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
  };
}

/** Build `spec` into the stores; `makeClip` supplies a fresh clip of demo `a` / `b`. */
export async function buildFixture(spec: HarnessFixtureSpec, makeClip: (demo: 'a' | 'b') => Promise<Clip>): Promise<void> {
  resetFixtureProject();
  setFixtureResolution(spec.resolution ?? DEFAULT_FIXTURE_RESOLUTION);
  const editor = editorStore.getState();
  const clipIds: string[] = [];
  for (const clipSpec of spec.clips) {
    const { demo, layer = 0, startTime, ...fields } = clipSpec;
    const clip: Clip = { ...(await makeClip(demo)), ...fields };
    clipIds.push(clip.id);
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
  if (spec.textOverlays) editor.setTextOverlays(spec.textOverlays.map(fixtureTitle));
  if (spec.captions) editor.setCaptions(spec.captions);
  if (spec.nest) {
    const refused = editor.nestClips({
      clipIds: spec.nest.clips.map((index) => clipIds[index] ?? ''),
      textOverlayIds: (spec.nest.titles ?? []).map((index) => `title-${index}`),
    });
    if (refused) throw new Error(`nest: ${refused}`);
  }
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
