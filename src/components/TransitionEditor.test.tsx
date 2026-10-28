import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TransitionEditor } from './TransitionEditor';
import type { ClipTransition } from '../types';
import { DEFAULT_CUSTOM_EXPRESSION } from '../webgpu/transitions/customShader';

const BASE: ClipTransition = { afterClipIndex: 1, type: 'dissolve', duration: 0.5 };

describe('TransitionEditor', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(overrides: Partial<React.ComponentProps<typeof TransitionEditor>> = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <StrictMode>
          <TransitionEditor
            transition={BASE}
            clipATitle="A"
            clipBTitle="B"
            onUpdate={() => undefined}
            onClose={() => undefined}
            {...overrides}
          />
        </StrictMode>,
      );
    });
    return container;
  }

  function shaderInput(el: HTMLElement): HTMLTextAreaElement | null {
    return el.querySelector<HTMLTextAreaElement>('.te-shader-input');
  }

  function typeShader(el: HTMLElement, value: string) {
    const input = shaderInput(el)!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.parentNode?.removeChild(container);
    container = null;
    vi.useRealTimers();
  });

  it('offers every registry transition plus cut and morph', () => {
    const el = mount();
    const labels = Array.from(el.querySelectorAll('.te-type-btn')).map(
      (b) => b.textContent,
    );
    expect(labels).toContain('Cut');
    expect(labels).toContain('Morph (RIFE)');
    expect(labels).toEqual(
      expect.arrayContaining([
        'Film burn',
        'Luma wipe',
        'Radial iris',
        'Glitch chromashift',
        'Motion blur pull',
        'Custom (WGSL)',
      ]),
    );
  });

  it('exposes the per-transition params of the selected type', () => {
    const el = mount({
      transition: { ...BASE, type: 'motionBlurPull', params: { taps: 8 } },
    });
    const labels = Array.from(el.querySelectorAll('.te-label')).map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Blur length', 'Sample taps', 'Pull distance']));
  });

  it('shows the WGSL textarea only for the custom type', () => {
    expect(shaderInput(mount())).toBeNull();
    act(() => root!.unmount());
    root = null;
    container?.parentNode?.removeChild(container);

    const el = mount({ transition: { ...BASE, type: 'custom' } });
    expect(shaderInput(el)!.value).toBe(DEFAULT_CUSTOM_EXPRESSION);
  });

  it('exposes the four generic uniform knobs for a custom expression', () => {
    const el = mount({ transition: { ...BASE, type: 'custom' } });
    const labels = Array.from(el.querySelectorAll('.te-label')).map((l) => l.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(['Custom 0', 'Custom 1', 'Custom 2', 'Custom 3']),
    );
  });

  it('pushes edited WGSL onto the transition', () => {
    const onUpdate = vi.fn();
    const el = mount({ transition: { ...BASE, type: 'custom' }, onUpdate });
    typeShader(el, 'sampleTo(uv)');
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'custom', customShader: 'sampleTo(uv)' }),
    );
  });

  it('banners a rejected expression and marks the field invalid', () => {
    const el = mount({ transition: { ...BASE, type: 'custom' } });
    typeShader(el, 'let x = sampleTo(uv)');

    const banner = el.querySelector('.te-shader-error');
    expect(banner?.textContent).toMatch(/Declarations are not allowed/);
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(shaderInput(el)!.className).toContain('invalid');
    expect(shaderInput(el)!.getAttribute('aria-invalid')).toBe('true');
  });

  it('clears the banner once the expression is valid again', () => {
    const el = mount({ transition: { ...BASE, type: 'custom' } });
    typeShader(el, 'mix(sampleFrom(uv), sampleTo(uv)');
    expect(el.querySelector('.te-shader-error')).not.toBeNull();

    typeShader(el, 'mix(sampleFrom(uv), sampleTo(uv), u.progress)');
    expect(el.querySelector('.te-shader-error')).toBeNull();
  });

  it('drops the shader field when switching away from custom', () => {
    const onUpdate = vi.fn();
    const el = mount({
      transition: { ...BASE, type: 'custom', customShader: 'sampleTo(uv)' },
      onUpdate,
    });
    const filmBurn = Array.from(el.querySelectorAll<HTMLButtonElement>('.te-type-btn')).find(
      (b) => b.textContent === 'Film burn',
    )!;
    act(() => filmBurn.click());
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'filmBurn', customShader: undefined }),
    );
  });
});
