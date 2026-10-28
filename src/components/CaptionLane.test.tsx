import { afterEach, describe, expect, it } from 'vitest';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { CaptionLane } from './CaptionLane';
import type { CaptionEntry } from '../types';

const CAPTIONS: CaptionEntry[] = [
  { id: 'a', startSec: 1, endSec: 3, text: 'Hello' },
  { id: 'b', startSec: 4, endSec: 5, text: 'Multi\nline' },
];

const PIXELS_PER_SECOND = 40;

describe('CaptionLane', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(props: Partial<React.ComponentProps<typeof CaptionLane>> = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <StrictMode>
          <CaptionLane
            captions={CAPTIONS}
            duration={10}
            width={10 * PIXELS_PER_SECOND}
            pixelsPerSecond={PIXELS_PER_SECOND}
            selectedCaptionId={null}
            onSelect={() => undefined}
            onResize={() => undefined}
            onAddAt={() => undefined}
            {...props}
          />
        </StrictMode>,
      );
    });
    return container;
  }

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.parentNode?.removeChild(container);
    container = null;
  });

  it('renders one chip per cue, positioned and sized by its timing', () => {
    const el = mount();
    const chips = el.querySelectorAll<HTMLElement>('.caption-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].style.left).toBe(`${1 * PIXELS_PER_SECOND}px`);
    expect(chips[0].style.width).toBe(`${2 * PIXELS_PER_SECOND}px`);
    expect(chips[1].style.left).toBe(`${4 * PIXELS_PER_SECOND}px`);
  });

  it('flattens multi-line cue text into a single-line chip label', () => {
    const el = mount();
    const labels = el.querySelectorAll('.caption-chip-text');
    expect(labels[0].textContent).toBe('Hello');
    expect(labels[1].textContent).toBe('Multi ⏎ line');
  });

  it('marks the selected cue for both styling and assistive tech', () => {
    const el = mount({ selectedCaptionId: 'b' });
    const chips = el.querySelectorAll<HTMLElement>('.caption-chip');
    expect(chips[0].className).not.toContain('caption-chip--selected');
    expect(chips[1].className).toContain('caption-chip--selected');
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('selects a cue when its chip is pressed', () => {
    const selected: (string | null)[] = [];
    const el = mount({ onSelect: (id) => selected.push(id) });
    act(() => {
      el.querySelectorAll<HTMLElement>('.caption-chip')[0].dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(selected).toEqual(['a']);
  });

  it('renders nothing when the timeline has no duration', () => {
    const el = mount({ duration: 0 });
    expect(el.querySelector('.caption-lane')).toBeNull();
  });

  it('gives short cues a minimum chip width so they stay clickable', () => {
    const el = mount({
      captions: [{ id: 'tiny', startSec: 0, endSec: 0.01, text: 'x' }],
      pixelsPerSecond: 1,
    });
    const chip = el.querySelector<HTMLElement>('.caption-chip')!;
    expect(parseFloat(chip.style.width)).toBeGreaterThanOrEqual(4);
  });

  it('exposes the cue timings and text in the chip label', () => {
    const el = mount();
    const chip = el.querySelector<HTMLElement>('.caption-chip')!;
    expect(chip.getAttribute('aria-label')).toContain('1.00');
    expect(chip.getAttribute('aria-label')).toContain('3.00');
    expect(chip.getAttribute('aria-label')).toContain('Hello');
  });
});
