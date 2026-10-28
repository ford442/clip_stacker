import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BusFxChainEditor } from './BusFxChainEditor';
import { LaneDuckPicker } from './LaneDuckPicker';
import { LoudnessTargetFields } from './LoudnessTargetFields';
import { RenderPlanAudioNotes } from './RenderPlanAudioNotes';
import { createBusEffect, type BusEffect, type LaneDuck } from '../../utils/audioBus';
import { editorStore, __resetEditorStoreForTests } from '../../store/editorStore';
import type { RenderPlan } from '../../types';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function byLabel<T extends Element>(label: string): T {
  const el = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`nothing labelled "${label}"`);
  return el;
}

function press(label: string) {
  act(() => byLabel<HTMLButtonElement>(label).dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  __resetEditorStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BusFxChainEditor', () => {
  const chain = (): BusEffect[] => [createBusEffect('gate'), createBusEffect('compressor'), createBusEffect('limiter')];

  it('reorders, bypasses and removes as separate (non-coalesced) edits', () => {
    const fx = chain();
    const onChange = vi.fn();
    render(<BusFxChainEditor fx={fx} label="Music" onChange={onChange} />);

    press('Move Compressor 2 earlier');
    expect(onChange).toHaveBeenLastCalledWith([fx[1], fx[0], fx[2]], false);

    act(() => byLabel<HTMLInputElement>('Limiter 3 enabled').click());
    expect(onChange.mock.lastCall![0][2]).toMatchObject({ kind: 'limiter', enabled: false });
    expect(onChange.mock.lastCall![1]).toBe(false);

    press('Remove Gate 1');
    expect(onChange).toHaveBeenLastCalledWith([fx[1], fx[2]], false);
  });

  it('removing the last effect clears the chain', () => {
    const onChange = vi.fn();
    render(<BusFxChainEditor fx={[createBusEffect('gate')]} label="Music" onChange={onChange} />);
    press('Remove Gate 1');
    expect(onChange).toHaveBeenLastCalledWith(undefined, false);
  });

  it('parameter edits are coalesced', () => {
    const fx = chain();
    const onChange = vi.fn();
    render(<BusFxChainEditor fx={fx} label="Music" onChange={onChange} />);
    const ceiling = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.startsWith('Ceiling'))!
      .querySelector('input')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(ceiling, '-2.5');
      ceiling.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange.mock.lastCall![0][2]).toMatchObject({ kind: 'limiter', ceilingDb: -2.5 });
    expect(onChange.mock.lastCall![1]).toBe(true);
  });

  it('is read-only when disabled', () => {
    render(<BusFxChainEditor fx={chain()} label="Music" disabled onChange={() => {}} />);
    const controls = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'),
    );
    expect(controls.length).toBeGreaterThan(10);
    for (const el of controls) expect(el.disabled).toBe(true);
  });
});

describe('LaneDuckPicker', () => {
  const candidates = [{ id: 'v1', label: 'Dialogue' }];

  function picker(duck: LaneDuck | undefined, isAudioLane = true) {
    const onChange = vi.fn();
    render(
      <LaneDuckPicker label="Music" isAudioLane={isAudioLane} duck={duck} candidates={candidates} onChange={onChange} />,
    );
    return { onChange, select: byLabel<HTMLSelectElement>('Music ducking') };
  }

  it('maps legacy / off / sidechain to the stored ducking', () => {
    const { onChange, select } = picker(undefined);
    expect(select.value).toBe('legacy');
    choose(select, 'key:v1');
    expect(onChange.mock.lastCall![0]).toMatchObject({ sourceTrackId: 'v1', depthDb: 9 });
    choose(select, 'off');
    expect(onChange).toHaveBeenLastCalledWith('off', false);
    choose(select, 'legacy');
    expect(onChange).toHaveBeenLastCalledWith(undefined, false);
  });

  it('video lanes have no legacy step to fall back to', () => {
    const { onChange, select } = picker(undefined, false);
    expect(select.value).toBe('off');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['off', 'key:v1']);
    choose(select, 'off');
    expect(onChange).toHaveBeenLastCalledWith(undefined, false);
  });

  it('flags a duck whose key lane was removed', () => {
    picker({ sourceTrackId: 'gone', depthDb: 9, thresholdDb: -40, attack: 0.05, hold: 0.2, release: 0.5 });
    expect(container.textContent).toContain('key lane was removed');
  });
});

describe('LoudnessTargetFields', () => {
  it('sets, retargets and clears the master bus loudness target', () => {
    render(<LoudnessTargetFields />);
    const select = container.querySelector('select')!;
    choose(select, 'streaming');
    expect(editorStore.getState().masterBus).toEqual({ loudness: { targetLufs: -14, truePeakDb: -1 } });
    choose(select, 'broadcast');
    expect(editorStore.getState().masterBus?.loudness?.targetLufs).toBe(-23);
    choose(select, 'off');
    expect(editorStore.getState().masterBus).toBeUndefined();
    expect(editorStore.getState().undoDepth).toBe(3);
  });
});

describe('RenderPlanAudioNotes', () => {
  const base: RenderPlan = { path: 'effects-reencoding', reason: '', willReencode: true, description: '' };

  it('reports the engine mix and the delivered loudness', () => {
    render(
      <RenderPlanAudioNotes
        plan={{
          ...base,
          audioFx: 'engine',
          loudness: { targetLufs: -14, measuredLufs: -21.04, gainDb: 7.04, outputLufs: -14.02, outputTruePeakDb: -1.06 },
        }}
      />,
    );
    expect(container.textContent).toContain('measured -21.0 LUFS, +7.0 dB → delivered -14.0 LUFS');
    expect(container.textContent).toContain('-1.1 dBTP');
  });

  it('warns when the bus settings were skipped', () => {
    render(<RenderPlanAudioNotes plan={{ ...base, audioFx: 'offline-fallback' }} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('mixed dry');
  });
});
