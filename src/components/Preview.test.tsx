import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { CaptionEntry, Clip, TextOverlay, Track } from '../types';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { createDefaultTracks, MAIN_VIDEO_TRACK_ID } from '../utils/trackModel';
import { buildPreviewCompositionPlan } from '../utils/previewComposition';
import type { TimelinePreviewProps } from './TimelineCompositorPreview';

// The real compositor needs WebGPU; what matters here is that a one-clip
// project reaches it, and with what.
const compositorProps = vi.fn<(props: TimelinePreviewProps) => void>();
vi.mock('./TimelineCompositorPreview', () => ({
  TimelineCompositorPreview: (props: TimelinePreviewProps) => {
    compositorProps(props);
    return null;
  },
}));

const { Preview } = await import('./Preview');

/** A shaky clip: one analysed frame that shifts the picture right by 5% of UV. */
function stabilizedClip(): Clip {
  return {
    id: 'solo',
    file: new File(['x'], 'solo.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:solo',
    title: 'solo',
    kind: 'video',
    duration: 4,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    videoWidth: 1920,
    videoHeight: 1080,
    stabilize: true,
    stabilization: {
      fps: 1,
      matrices: new Float32Array([1, 0, 0.05, 0, 1, 0]),
      frameCount: 1,
      zoom: 1,
      maxCorrection: 0.05,
      smoothRadius: 1,
    },
  };
}

const TITLE: TextOverlay = {
  id: 'title',
  text: 'Hello',
  fontsize: 48,
  fontcolor: 'white',
  x: 0.1,
  y: 0.1,
  scrolling: false,
  scrollSpeed: 0,
  box: false,
  boxColor: 'black@0.5',
};

const CAPTION: CaptionEntry = { id: 'cc', startSec: 0, endSec: 4, text: 'Spoken words' };

describe('Preview', () => {
  let root: Root | null = null;

  beforeEach(() => {
    __resetEditorStoreForTests();
    compositorProps.mockClear();
    const tracks: Track[] = createDefaultTracks().map((t) =>
      t.id === MAIN_VIDEO_TRACK_ID ? { ...t, items: [{ clipId: 'solo', startTime: 0 }] } : t,
    );
    editorStore.setState({
      clips: [stabilizedClip()],
      tracks,
      textOverlays: [TITLE],
      captions: [CAPTION],
    });
    settingsStore.setState({ outputUrl: null, showCaptionsInPreview: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it('previews a one-clip project with the compositor, titles, captions and stabilization', () => {
    root = createRoot(document.createElement('div'));
    act(() => {
      root!.render(<Preview />);
    });

    expect(compositorProps).toHaveBeenCalled();
    const props = compositorProps.mock.calls.at(-1)![0];
    expect(props.timelineClips.map((c) => c.id)).toEqual(['solo']);
    expect(props.textOverlays.map((o) => o.id)).toEqual(['title']);
    expect(props.captions?.map((c) => c.id)).toEqual(['cc']);

    // What the compositor draws from those props — the same plan export uses.
    const plan = buildPreviewCompositionPlan(
      props.timelineClips,
      props.clipGroups,
      props.transitions,
      props.textOverlays,
      props.exportSettings,
      1,
      720,
      undefined,
      { captions: props.captions, captionStyle: props.captionStyle },
    );
    const kinds = plan.layers.map((layer) => layer.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('caption');
    const clipLayer = plan.layers.find((layer) => layer.kind === 'base');
    expect(clipLayer && 'warpMatrix' in clipLayer ? clipLayer.warpMatrix : undefined).toBeDefined();
  });

  it('keeps the plain player for an audio-only selection', () => {
    editorStore.setState({
      clips: [{ ...stabilizedClip(), kind: 'audio', stabilize: false }],
      selectedClipId: 'solo',
      tracks: createDefaultTracks(),
    });
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => {
      root!.render(<Preview />);
    });
    expect(compositorProps).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).not.toBeNull();
  });
});
