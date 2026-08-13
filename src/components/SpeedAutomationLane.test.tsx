import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode, act, type ComponentProps } from 'react';
import { SpeedAutomationLane } from './SpeedAutomationLane';
import type { Clip } from '../types';
import { SPEED_LANE_LAST_SEED_KEY } from '../utils/speedLane';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File(['x'], 'a.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:c1',
    title: 'Monster Mash',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: 10,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('SpeedAutomationLane', () => {
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
    try {
      localStorage.removeItem(SPEED_LANE_LAST_SEED_KEY);
    } catch {
      /* ignore */
    }
  });

  function renderLane(
    clip: Clip,
    props: Partial<ComponentProps<typeof SpeedAutomationLane>> = {},
  ) {
    const onChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <StrictMode>
        <SpeedAutomationLane
          clip={clip}
          width={320}
          durationSec={8}
          playheadLocal={2}
          onChange={onChange}
          {...props}
        />
      </StrictMode>,
    );
    return onChange;
  }

  it('renders scale ticks, playhead rate, and seed controls', async () => {
    renderLane(makeClip({ playbackRate: 1.2 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = container?.textContent ?? '';
    expect(text).toContain('0.25×');
    expect(text).toContain('1.00×');
    expect(text).toContain('4.00×');
    expect(text).toContain('Seed 1×');
    expect(container?.querySelector('.speed-lane-rate-live.is-active')).toBeTruthy();
  });

  it('seeds a flat 1× curve and remembers last seed rate', async () => {
    const onChange = renderLane(makeClip());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const seed1x = container?.querySelectorAll('.speed-lane-seed')[1] as HTMLButtonElement;
    seed1x?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last?.playbackRate).toEqual([
      { t: 0, value: 1 },
      { t: 8, value: 1 },
    ]);
    expect(localStorage.getItem(SPEED_LANE_LAST_SEED_KEY)).toBe('1');
  });

  it('shows rate labels on existing keyframes', async () => {
    renderLane(
      makeClip({
        automation: {
          playbackRate: [
            { t: 0, value: 1 },
            { t: 4, value: 0.65 },
          ],
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container?.textContent).toContain('0.65×');
    expect(container?.querySelectorAll('.speed-lane-key-btn').length).toBe(2);
  });

  it('nudges selected keyframe with arrow keys', async () => {
    const onChange = renderLane(
      makeClip({
        automation: {
          playbackRate: [{ t: 2, value: 1 }],
        },
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const keyBtn = container?.querySelector('.speed-lane-key-btn') as HTMLButtonElement;
    await act(async () => {
      keyBtn?.click();
    });
    const lane = container?.querySelector('.speed-lane') as HTMLDivElement;
    await act(async () => {
      lane?.focus();
      lane?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last?.playbackRate?.[0]?.value).toBeGreaterThan(1);
  });
});
