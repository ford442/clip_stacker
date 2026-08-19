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

    const deadline = Date.now() + 1000;
    let text = '';
    while (Date.now() < deadline) {
      text = container.textContent ?? '';
      if (/\d+ slices/.test(text)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(text).toContain('Create Intercut Clip');
    expect(text).toContain('Source clocks');
    expect(text).toContain('Freeze hidden');
    expect(text).toContain('Parallel');
    expect(text).toContain('Material');
    expect(text).toContain('Clip C (optional)');
    expect(text).toContain('Tail after last cut');
    expect(text).toMatch(/\d+ slices/);
    expect(text).toMatch(/stream copy|re-encode/);
  });

  it('passes landing clip and tail duration to onGenerate', async () => {
    const a = makeClip('alpha', { duration: 20, trimEnd: 20 });
    const b = makeClip('bravo', { duration: 20, trimEnd: 20 });
    editorStore.setState({ clips: [a, b], selectedClipId: a.id });

    const generated: unknown[] = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <StrictMode>
        <IntercutModal
          isOpen
          generating={false}
          onClose={() => undefined}
          onGenerate={async (config) => {
            generated.push(config);
            return true;
          }}
        />
      </StrictMode>,
    );

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !container.querySelector('.intercut-estimate')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const landing = container.querySelector('select')
      ? Array.from(container.querySelectorAll('select')).find((el) =>
          Array.from(el.options).some((opt) => opt.value === 'auto'),
        )
      : undefined;
    const tail = Array.from(container.querySelectorAll('input[type="number"]')).find((el) => {
      const label = el.closest('label')?.textContent ?? '';
      return label.includes('Tail after last cut');
    }) as HTMLInputElement | undefined;

    expect(landing).toBeTruthy();
    expect(tail).toBeTruthy();
    landing!.value = 'A';
    landing!.dispatchEvent(new Event('change', { bubbles: true }));
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setInputValue?.call(tail, '3');
    tail!.dispatchEvent(new Event('input', { bubbles: true }));
    tail!.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 30));
    const create = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent ?? '').includes('Create intercut'),
    );
    expect(create).toBeTruthy();
    create!.click();

    const waitGen = Date.now() + 1000;
    while (Date.now() < waitGen && generated.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(generated).toHaveLength(1);
    const config = generated[0] as {
      forceFinalClip: string;
      tailDurationSec: number;
    };
    expect(config.forceFinalClip).toBe('A');
    expect(config.tailDurationSec).toBe(3);
  });

  it('supports selecting bell-curve easing and adapts field labels', async () => {
    const a = makeClip('alpha', { duration: 20, trimEnd: 20 });
    const b = makeClip('bravo', { duration: 20, trimEnd: 20 });
    editorStore.setState({ clips: [a, b], selectedClipId: a.id });

    const generated: unknown[] = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <StrictMode>
        <IntercutModal
          isOpen
          generating={false}
          onClose={() => undefined}
          onGenerate={async (config) => {
            generated.push(config);
            return true;
          }}
        />
      </StrictMode>,
    );

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !container.querySelector('.intercut-estimate')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const easingSelect = Array.from(container.querySelectorAll('select')).find((el) =>
      Array.from(el.options).some((opt) => opt.value === 'bellCurveSmooth'),
    );
    expect(easingSelect).toBeTruthy();

    easingSelect!.value = 'bellCurveSmooth';
    easingSelect!.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(container.textContent).toContain('Base (start & end)');
    expect(container.textContent).toContain('Peak (midpoint)');
    expect(container.textContent).toContain('Bell curve ramps frequency from the base rate up to a peak strobe');

    const create = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent ?? '').includes('Create intercut'),
    );
    expect(create).toBeTruthy();
    create!.click();

    const waitGen = Date.now() + 1000;
    while (Date.now() < waitGen && generated.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(generated).toHaveLength(1);
    const config = generated[0] as {
      automation: {
        easing?: { type: string };
      };
    };
    expect(config.automation.easing).toEqual({ type: 'bellCurveSmooth' });
  });

  it('passes optional clip C through onGenerate', async () => {
    const a = makeClip('alpha', { duration: 20, trimEnd: 20 });
    const b = makeClip('bravo', { duration: 20, trimEnd: 20 });
    const c = makeClip('charlie', { duration: 20, trimEnd: 20 });
    editorStore.setState({ clips: [a, b, c], selectedClipId: a.id });

    const generated: unknown[] = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <StrictMode>
        <IntercutModal
          isOpen
          generating={false}
          onClose={() => undefined}
          onGenerate={async (config) => {
            generated.push(config);
            return true;
          }}
        />
      </StrictMode>,
    );

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !container.querySelector('.intercut-estimate')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const clipCSelect = Array.from(container.querySelectorAll('select')).find((el) => {
      const label = el.closest('label')?.textContent ?? '';
      return label.includes('Clip C');
    });
    expect(clipCSelect).toBeTruthy();
    clipCSelect!.value = c.id;
    clipCSelect!.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.textContent).toContain('Clip C (resolve on C)');

    const create = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent ?? '').includes('Create intercut'),
    );
    expect(create).toBeTruthy();
    create!.click();

    const waitGen = Date.now() + 1000;
    while (Date.now() < waitGen && generated.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(generated).toHaveLength(1);
    const config = generated[0] as { clipC?: { id: string } };
    expect(config.clipC?.id).toBe('charlie');
  });
});
