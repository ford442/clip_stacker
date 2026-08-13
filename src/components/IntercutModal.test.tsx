import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { IntercutModal } from './IntercutModal';
import {
  __resetEditorStoreForTests,
  editorStore,
} from '../store/editorStore';
import type { Clip } from '../types';

function makeClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File(['x'], `${id}.mp4`, { type: 'video/mp4' }),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 8,
    videoWidth: 1280,
    videoHeight: 720,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('IntercutModal', () => {
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

  it('shows a live slice estimate for two selected clips', async () => {
    const a = makeClip('alpha', { duration: 20, trimEnd: 20 });
    const b = makeClip('bravo', { duration: 20, trimEnd: 20 });
    editorStore.setState({ clips: [a, b], selectedClipId: a.id });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <StrictMode>
        <IntercutModal
          isOpen
          generating={false}
          onClose={() => undefined}
          onGenerate={async () => true}
        />
      </StrictMode>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = container.textContent ?? '';
    expect(text).toContain('Create Intercut Clip');
    expect(text).toMatch(/\d+ slices/);
    expect(text).toMatch(/stream copy|re-encode/);
  });
});
