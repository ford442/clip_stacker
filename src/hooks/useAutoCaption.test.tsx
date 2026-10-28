import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { CaptionEntry } from '../types';
import type { CaptionProvider } from '../utils/captionProvider';
import {
  registerCaptionProvider,
  __resetCaptionProvidersForTests,
} from '../utils/captionProvider';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { useAutoCaption, type UseAutoCaptionResult } from './useAutoCaption';

// The real mixer needs OfflineAudioContext and decoded media; the hook's job is
// what it does with the cues, so the audio render is stubbed.
vi.mock('../utils/autoCaptionAudio', () => ({
  renderAutoCaptionAudio: vi.fn(async () => ({
    audio: { length: 0 } as unknown as AudioBuffer,
    timeOffsetSec: 0,
    durationSec: 4,
  })),
}));

const EXISTING: CaptionEntry[] = [{ id: 'old', startSec: 0, endSec: 1, text: 'Typed by hand' }];

function makeProvider(
  transcribe: CaptionProvider['transcribe'],
  id = 'mock',
): CaptionProvider {
  return { id, label: 'Mock provider', isAvailable: async () => true, transcribe };
}

describe('useAutoCaption', () => {
  let root: Root | null = null;
  let hook: UseAutoCaptionResult | null = null;

  function Probe() {
    hook = useAutoCaption();
    return null;
  }

  async function mount() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  }

  beforeEach(() => {
    __resetCaptionProvidersForTests();
    __resetEditorStoreForTests();
    settingsStore.getState().setAutoCaptionProviderId('mock');
    settingsStore.getState().setAutoCaptionMerge(false);
    settingsStore.getState().setAutoCaptionScope('timeline');
    editorStore.getState().setCaptions(EXISTING);
    settingsStore.getState().setStatus('');
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    hook = null;
  });

  it('lists providers that report themselves available', async () => {
    registerCaptionProvider(makeProvider(async () => []));
    await mount();
    expect(hook!.providers).toEqual([{ id: 'mock', label: 'Mock provider' }]);
    expect(hook!.unavailableReason).toBeNull();
  });

  it('explains itself when no provider can run', async () => {
    await mount();
    expect(hook!.providers).toHaveLength(0);
    expect(hook!.unavailableReason).toMatch(/transcription/i);
  });

  it('replaces the track and leaves one undo step', async () => {
    registerCaptionProvider(
      makeProvider(async () => [{ id: 'new', startSec: 2, endSec: 3, text: 'Spoken' }]),
    );
    await mount();
    await act(async () => {
      await hook!.run();
    });

    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['new']);
    act(() => editorStore.getState().undo());
    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['old']);
  });

  it('merges around existing cues when asked', async () => {
    settingsStore.getState().setAutoCaptionMerge(true);
    registerCaptionProvider(
      makeProvider(async () => [
        { id: 'overlap', startSec: 0.5, endSec: 1.5, text: 'Overlaps' },
        { id: 'new', startSec: 2, endSec: 3, text: 'Spoken' },
      ]),
    );
    await mount();
    await act(async () => {
      await hook!.run();
    });
    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['old', 'new']);
  });

  it('leaves the previous track intact when cancelled mid-run', async () => {
    registerCaptionProvider(
      makeProvider(
        (_audio, options) =>
          new Promise<CaptionEntry[]>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Transcription cancelled', 'AbortError')),
            );
          }),
      ),
    );
    await mount();

    let pending!: Promise<void>;
    await act(async () => {
      pending = hook!.run();
      // Let the run reach the provider (and install its AbortController)
      // before cancelling, the way a user clicking Cancel would.
      await Promise.resolve();
    });
    expect(hook!.running).toBe(true);

    await act(async () => {
      hook!.cancel();
      await pending;
    });

    expect(editorStore.getState().captions).toEqual(EXISTING);
    expect(settingsStore.getState().status).toMatch(/cancelled/i);
    expect(hook!.running).toBe(false);
  });
});
