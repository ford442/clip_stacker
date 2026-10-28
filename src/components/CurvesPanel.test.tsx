import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CurvesPanel } from './CurvesPanel';
import { DEFAULT_CURVES, type CurvesPass } from '../utils/finishing';
import { identityCurves } from '../utils/curves';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: CurvesPass;

const initialSettings = (): CurvesPass => ({
  ...DEFAULT_CURVES,
  enabled: true,
  curves: identityCurves(),
});

function Harness() {
  const [settings, setSettings] = useState<CurvesPass>(initialSettings);
  return (
    <CurvesPanel
      settings={settings}
      onChange={(next) => {
        latest = next;
        setSettings(next);
      }}
    />
  );
}

/** Editor box: 212 SVG units drawn at 212 px, curve [0,1]² inset by 6. */
function pointerAt(type: string, x: number, y: number, target: Element) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    clientX: 6 + x * 200,
    clientY: 6 + (1 - y) * 200,
    button: 0,
  });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(ev);
  });
}

describe('CurvesPanel editor', () => {
  beforeEach(() => {
    latest = initialSettings();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
    const svg = container.querySelector('svg.curves-editor')!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 212, height: 212, right: 212, bottom: 212, x: 0, y: 0 }) as DOMRect;
    (svg as SVGSVGElement).setPointerCapture = () => {};
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('click adds a knot on the curve and dragging moves it', () => {
    const svg = container.querySelector('svg.curves-editor')!;
    pointerAt('pointerdown', 0.6, 0.6, svg);
    expect(latest.curves.master).toHaveLength(3);
    pointerAt('pointermove', 0.6, 0.45, svg);
    pointerAt('pointermove', 0.62, 0.4, svg);
    pointerAt('pointerup', 0.62, 0.4, svg);
    const knot = latest.curves.master[1];
    expect(knot.x).toBeCloseTo(0.62, 2);
    expect(knot.y).toBeCloseTo(0.4, 2);
    // Further moves after release do nothing.
    pointerAt('pointermove', 0.9, 0.9, svg);
    expect(latest.curves.master[1].y).toBeCloseTo(0.4, 2);
  });

  it('double-click removes a knot, arrows nudge it, the end knots stay', () => {
    const svg = container.querySelector('svg.curves-editor')!;
    pointerAt('pointerdown', 0.5, 0.5, svg);
    pointerAt('pointerup', 0.5, 0.5, svg);
    const knots = () => container.querySelectorAll('circle.curves-editor-knot');
    expect(knots()).toHaveLength(3);
    act(() => {
      knots()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(latest.curves.master[1].y).toBeCloseTo(0.51, 6);
    act(() => {
      knots()[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(latest.curves.master).toHaveLength(2);
    act(() => {
      knots()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(latest.curves.master).toHaveLength(2);
  });

  it('channel tabs edit their own curve', () => {
    const tab = Array.from(container.querySelectorAll('[role=tab]')).find(
      (t) => t.textContent === 'Red',
    )!;
    act(() => {
      tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const svg = container.querySelector('svg.curves-editor')!;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 212, height: 212, right: 212, bottom: 212, x: 0, y: 0 }) as DOMRect;
    (svg as SVGSVGElement).setPointerCapture = () => {};
    pointerAt('pointerdown', 0.3, 0.2, svg);
    pointerAt('pointerup', 0.3, 0.2, svg);
    expect(latest.curves.red).toHaveLength(3);
    expect(latest.curves.master).toHaveLength(2);
  });
});
