import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRenderScheduler } from './seekCoalescer';

describe('createRenderScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs the render callback for a single request', async () => {
    const render = vi.fn().mockResolvedValue(undefined);
    const scheduler = createRenderScheduler(render);

    scheduler.request(1.5);
    await vi.runAllTimersAsync();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(1.5);
  });

  it('keeps only the latest time while a render is in flight', async () => {
    let resolveRender: (() => void) | undefined;
    const render = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const scheduler = createRenderScheduler(render);

    scheduler.request(1);
    scheduler.request(2);
    scheduler.request(3);

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(1);

    resolveRender?.();
    await vi.runAllTimersAsync();

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(3);
  });

  it('drops a pending request when cancelled', async () => {
    let resolveRender: (() => void) | undefined;
    const render = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const scheduler = createRenderScheduler(render);

    scheduler.request(1);
    scheduler.request(2);
    scheduler.cancel();

    resolveRender?.();
    await vi.runAllTimersAsync();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('invokes onSuperseded when a newer request arrives during render', async () => {
    let resolveRender: (() => void) | undefined;
    const render = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const onSuperseded = vi.fn();
    const scheduler = createRenderScheduler(render, onSuperseded);

    scheduler.request(1);
    scheduler.request(2);

    expect(onSuperseded).toHaveBeenCalledTimes(1);

    resolveRender?.();
    await vi.runAllTimersAsync();

    expect(render).toHaveBeenLastCalledWith(2);
  });

  it('reports isRendering while a render promise is in flight', async () => {
    let resolveRender: (() => void) | undefined;
    const render = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const scheduler = createRenderScheduler(render);

    expect(scheduler.isRendering).toBe(false);
    scheduler.request(0);
    expect(scheduler.isRendering).toBe(true);

    resolveRender?.();
    await vi.runAllTimersAsync();

    expect(scheduler.isRendering).toBe(false);
  });
});
