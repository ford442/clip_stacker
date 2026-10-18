import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { Timeline } from './Timeline';
import {
  __resetEditorStoreForTests,
  editorStore,
} from '../store/editorStore';
import { createDefaultTracks } from '../utils/trackModel';
import { __resetPlaybackStoreForTests, playbackStore } from '../store/playbackStore';
import { DEFAULT_PIXELS_PER_SECOND } from '../utils/timelineLayout';
import { planAddClip } from '../utils/planAddClip';
import type { Clip } from '../types';

function makeClip(id: string): Clip {
  const file = new File(['x'], `${id}.mp4`, { type: 'video/mp4' });
  return {
    id,
    file,
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 5,
    videoWidth: 1920,
    videoHeight: 1080,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('Timeline render stability', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      root.unmount();
      root = null;
    }
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    __resetEditorStoreForTests();
    __resetPlaybackStoreForTests();
  });

  it('does not exceed React update depth when a clip is added', async () => {
    const clip = makeClip('a');
    const plan = planAddClip([], createDefaultTracks(), [], clip);
    editorStore.setState({
      clips: plan.clips,
      tracks: plan.tracks!,
      selectedClipId: clip.id,
    });

    let renderCount = 0;
    const noop = () => undefined;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(
      <StrictMode>
        <Timeline
          onMoveUp={noop}
          onMoveDown={noop}
          onReorder={noop}
          onMoveToTrack={noop}
          onTransitionUpdate={noop}
          onDelete={noop}
          onCaptionResize={noop}
          onCaptionAdd={noop}
        />
        <RenderProbe onRender={() => (renderCount += 1)} />
      </StrictMode>,
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renderCount).toBeLessThan(40);
  });

  it('moves the playhead from the ruler without any preview running', async () => {
    const clip = makeClip('a');
    const plan = planAddClip([], createDefaultTracks(), [], clip);
    editorStore.setState({ clips: plan.clips, tracks: plan.tracks!, selectedClipId: clip.id });
    const noop = () => undefined;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <Timeline
          onMoveUp={noop}
          onMoveDown={noop}
          onReorder={noop}
          onMoveToTrack={noop}
          onTransitionUpdate={noop}
          onDelete={noop}
          onCaptionResize={noop}
          onCaptionAdd={noop}
        />,
      );
    });

    const ruler = container.querySelector<HTMLElement>('.timeline-ruler')!;
    expect(ruler).not.toBeNull();
    expect(container.querySelector('.timeline-playhead')).toBeNull();

    // happy-dom lays nothing out, so the ruler's left edge is 0 and clientX is the offset.
    const pointer = (type: string, clientX: number) =>
      ruler.dispatchEvent(
        new PointerEvent(type, { clientX, pointerId: 1, button: 0, bubbles: true }),
      );
    await act(async () => {
      pointer('pointerdown', 2 * DEFAULT_PIXELS_PER_SECOND);
    });
    expect(playbackStore.getState().scrubbing).toBe(true);
    expect(playbackStore.getState().playheadTime).toBeCloseTo(2, 5);

    await act(async () => {
      pointer('pointermove', 3 * DEFAULT_PIXELS_PER_SECOND);
    });
    expect(playbackStore.getState().playheadTime).toBeCloseTo(3, 5);
    expect(container.querySelector('.timeline-playhead')).not.toBeNull();

    // Dragging past the end clamps to the clip's duration.
    await act(async () => {
      pointer('pointermove', 99 * DEFAULT_PIXELS_PER_SECOND);
      pointer('pointerup', 99 * DEFAULT_PIXELS_PER_SECOND);
    });
    expect(playbackStore.getState().playheadTime).toBeCloseTo(5, 5);
    expect(playbackStore.getState().scrubbing).toBe(false);
  });
});

function RenderProbe({ onRender }: { onRender: () => void }) {
  onRender();
  return null;
}
