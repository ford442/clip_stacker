import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AUDIO_EFFECTS_COMMIT_DEBOUNCE_MS,
  InspectorClipAudioEffectsSection,
} from './InspectorClipAudioEffectsSection';
import { DEFAULT_EQ_BAND, type ClipAudioEffects } from '../../utils/audioEffects';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function setRange(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('InspectorClipAudioEffectsSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('adds a band immediately and debounces slider drags', () => {
    const onChange = vi.fn();
    render(<InspectorClipAudioEffectsSection clipId="a" effects={undefined} onChange={onChange} />);
    const add = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add EQ band'))!;
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('a', { eq: [DEFAULT_EQ_BAND] });

    const effects: ClipAudioEffects = { eq: [DEFAULT_EQ_BAND] };
    render(<InspectorClipAudioEffectsSection clipId="a" effects={effects} onChange={onChange} />);
    onChange.mockClear();
    const gain = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    setRange(gain, '3');
    setRange(gain, '4.5');
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(AUDIO_EFFECTS_COMMIT_DEBOUNCE_MS));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('a', { eq: [{ ...DEFAULT_EQ_BAND, gainDb: 4.5 }] });
  });

  it('lands a pending drag on its own clip when the selection moves', () => {
    const onChange = vi.fn();
    const effects: ClipAudioEffects = { eq: [DEFAULT_EQ_BAND] };
    render(<InspectorClipAudioEffectsSection clipId="a" effects={effects} onChange={onChange} />);
    setRange(container.querySelector<HTMLInputElement>('input[type="range"]')!, '-6');
    render(<InspectorClipAudioEffectsSection clipId="b" effects={undefined} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith('a', { eq: [{ ...DEFAULT_EQ_BAND, gainDb: -6 }] });
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });
});
