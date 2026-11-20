/**
 * The RAM preview's controller on main (`webgpu/previewFrameCache.ts` is the
 * worker side):
 *
 * - keeps `previewCacheStore.cachedRanges` (the ruler's green bar) in step
 *   with what the worker holds for the timeline as it is now;
 * - runs **Render In→Out**: every frame between the marks through the
 *   preview, so playback of the range then presents cached frames;
 * - with **Background render** on, fills the frames after a paused playhead
 *   while idle — only when composing costs more than a frame (a light stack
 *   plays in real time anyway) — without changing what is shown (`prerender`);
 * - counts dropped playback frames from each play (`previewMetrics`).
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from '../types';
import type { TimelineCompositor, TimelineRenderOptions } from '../composition/previewCompositionTypes';
import { previewMetrics } from '../composition/previewMetrics';
import { frameRanges, PREVIEW_CACHE_FPS } from '../composition/previewCacheGrid';
import { markedRange, previewCacheStore } from '../store/previewCacheStore';
import { renderCacheStore, useRenderCacheStore } from '../store/renderCacheStore';
import { playbackStore } from '../store/playbackStore';
import { previewCacheBinding } from '../actions/previewCacheBinding';

export interface PreviewCacheInputs {
  clips: Clip[];
  groups: ClipGroup[];
  transitions: ClipTransition[];
  overlays: TextOverlay[];
  exportSettings: Pick<ExportSettings, 'outputResolution'> | undefined;
  /** The options a preview render passes (size caps, finishing, colour, captions). */
  options: TimelineRenderOptions;
  totalDuration: number;
}

export interface PreviewCacheControlsArgs {
  engineRef: RefObject<TimelineCompositor | null>;
  /** The preview's own frame render (it draws titles over the composite too). */
  renderAt: (globalTime: number) => Promise<void>;
  requestRender: (globalTime: number) => void;
  isPlaying: boolean;
  inputs: PreviewCacheInputs;
}

/** Idle time before a background fill starts. */
const BACKGROUND_IDLE_MS = 1500;
/** How far past the playhead one background fill goes. */
const BACKGROUND_AHEAD_FRAMES = 10 * PREVIEW_CACHE_FPS;
const STATUS_INTERVAL_MS = 1000;

/** Whether the RAM preview is on (the option `renderAt` passes). */
export function usePreviewCacheControls(args: PreviewCacheControlsArgs): boolean {
  const enabled = useRenderCacheStore((s) => s.settings.previewCache);
  const background = useRenderCacheStore((s) => s.settings.backgroundRender);
  const argsRef = useRef(args);
  useEffect(() => {
    argsRef.current = args;
  });

  const refreshStatus = useCallback(async () => {
    const { engineRef, inputs } = argsRef.current;
    const engine = engineRef.current;
    if (!engine?.previewCacheStatus || !renderCacheStore.getState().settings.previewCache) {
      previewCacheStore.getState().setCachedRanges([]);
      return null;
    }
    try {
      const status = await engine.previewCacheStatus(
        inputs.clips,
        inputs.groups,
        inputs.transitions,
        inputs.overlays,
        inputs.exportSettings,
        inputs.options,
      );
      previewCacheStore.getState().setCachedRanges(status ? frameRanges(status.frames) : []);
      return status;
    } catch {
      return null;
    }
  }, []);

  // The ruler bar follows the worker (renders fill it, edits invalidate it).
  useEffect(() => {
    if (!enabled) {
      previewCacheStore.getState().setCachedRanges([]);
      return;
    }
    const timer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refreshStatus]);

  // Each play counts its own dropped frames.
  useEffect(() => {
    if (args.isPlaying) previewMetrics.startPlayback();
  }, [args.isPlaying]);

  // Clear requests (Export tab, timeline chrome) and the setting turning off.
  useEffect(() => {
    if (!enabled) argsRef.current.engineRef.current?.clearPreviewCache?.();
    return previewCacheStore.subscribe((state, prev) => {
      if (state.clearRequest !== prev.clearRequest) argsRef.current.engineRef.current?.clearPreviewCache?.();
    });
  }, [enabled]);

  // Render In→Out.
  useEffect(() => {
    let running = false;
    const run = async (range: [number, number]) => {
      if (running) return;
      running = true;
      const cancelAt = previewCacheStore.getState().cancelRequest;
      const first = Math.ceil(range[0] * PREVIEW_CACHE_FPS - 1e-6);
      const end = Math.max(first + 1, Math.ceil(range[1] * PREVIEW_CACHE_FPS - 1e-6));
      const total = end - first;
      const restore = playbackStore.getState().playheadTime ?? 0;
      const stats = { frames: total, hits: 0, misses: 0 };
      const before = previewMetrics.snapshot();
      try {
        for (let frame = first; frame < end; frame++) {
          if (previewCacheStore.getState().cancelRequest !== cancelAt || argsRef.current.isPlaying) break;
          previewCacheStore.getState().setJob({ done: frame - first, total });
          await argsRef.current.renderAt(frame / PREVIEW_CACHE_FPS);
        }
      } finally {
        const after = previewMetrics.snapshot();
        stats.hits = after.cacheHits - before.cacheHits;
        stats.misses = after.cacheMisses - before.cacheMisses;
        previewCacheStore.getState().setJob(null);
        argsRef.current.requestRender(restore);
        running = false;
        await refreshStatus();
      }
      return stats;
    };
    previewCacheBinding.renderRange = async (from, to) => {
      if (!renderCacheStore.getState().settings.previewCache) throw new Error('The preview cache is off');
      return (await run([from, to])) ?? { frames: 0, hits: 0, misses: 0 };
    };
    previewCacheBinding.status = () => refreshStatus();
    const unsubscribe = previewCacheStore.subscribe((state, prev) => {
      if (state.renderRequest === prev.renderRequest) return;
      const range = markedRange(state);
      if (range && renderCacheStore.getState().settings.previewCache) void run(range);
    });
    return () => {
      unsubscribe();
      previewCacheBinding.renderRange = null;
      previewCacheBinding.status = null;
    };
  }, [refreshStatus]);

  // Background render while paused and idle.
  const { isPlaying } = args;
  useEffect(() => {
    if (!enabled || !background || isPlaying) return;
    let stopped = false;
    // A playhead move restarts the idle wait and ends the fill in flight.
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fill = async () => {
      const gen = generation;
      const heavy = previewMetrics.snapshot().avgFrameMs > 1000 / PREVIEW_CACHE_FPS;
      if (!heavy || previewCacheStore.getState().job) return;
      const restoreTime = playbackStore.getState().playheadTime ?? 0;
      const start = Math.round(restoreTime * PREVIEW_CACHE_FPS);
      const { inputs } = argsRef.current;
      const last = Math.min(start + BACKGROUND_AHEAD_FRAMES, Math.floor(inputs.totalDuration * PREVIEW_CACHE_FPS));
      for (let frame = start + 1; frame < last && !stopped && gen === generation; frame++) {
        const engine = argsRef.current.engineRef.current;
        if (!engine) return;
        try {
          await engine.renderTimelineFrame(
            inputs.clips,
            inputs.groups,
            inputs.transitions,
            inputs.overlays,
            inputs.exportSettings,
            frame / PREVIEW_CACHE_FPS,
            { ...inputs.options, previewCache: true, prerender: { restoreTime } },
          );
        } catch {
          return; // cancelled by a foreground render, or the shown frame is not cached
        }
        if ((frame - start) % PREVIEW_CACHE_FPS === 0) {
          const status = await refreshStatus();
          if (status && status.bytes >= status.budgetBytes * 0.9) return;
        }
      }
      await refreshStatus();
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fill(), BACKGROUND_IDLE_MS);
    };
    schedule();
    const unsubscribe = playbackStore.subscribe((state, prev) => {
      if (state.playheadTime !== prev.playheadTime) {
        generation += 1;
        schedule();
      }
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, background, isPlaying, args.inputs, refreshStatus]);

  return enabled;
}
