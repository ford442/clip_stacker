import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { Timeline } from './Timeline';
import {
  __resetEditorStoreForTests,
  editorStore,
} from '../store/editorStore';
import { createDefaultTracks } from '../utils/trackModel';
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
        />
        <RenderProbe onRender={() => (renderCount += 1)} />
      </StrictMode>,
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renderCount).toBeLessThan(40);
  });
});

function RenderProbe({ onRender }: { onRender: () => void }) {
  onRender();
  return null;
}
