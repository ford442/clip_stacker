/**
 * Seek/render coalescing for timeline scrubbing.
 *
 * Scrubbing the playhead fires render requests far faster than a frame can be
 * seeked + composited. Awaiting every one of them queues up stale work and makes
 * the scrub feel laggy. The scheduler keeps at most one render in flight and,
 * while it is running, remembers only the *latest* requested time — when the
 * in-flight render settles it runs that newest time and drops the intermediates.
 */

export interface RenderScheduler {
  /** Request a render at `time`; collapses with any in-flight/pending request. */
  request(time: number): void;
  /** Drop any pending (not-yet-started) request. */
  cancel(): void;
  /** True while a render promise is in flight. */
  readonly isRendering: boolean;
}

export function createRenderScheduler(
  render: (time: number) => Promise<void>,
  /** Called when a newer render supersedes one already in flight. */
  onSuperseded?: () => void,
): RenderScheduler {
  let rendering = false;
  let pending: number | null = null;

  const run = (time: number): void => {
    rendering = true;
    void Promise.resolve(render(time))
      .catch(() => {
        // Swallow — the render callback owns its own error handling/state.
      })
      .finally(() => {
        rendering = false;
        if (pending !== null) {
          const next = pending;
          pending = null;
          run(next);
        }
      });
  };

  return {
    request(time: number): void {
      if (rendering) {
        // Keep only the most recent target while a render is in flight.
        pending = time;
        onSuperseded?.();
        return;
      }
      run(time);
    },
    cancel(): void {
      pending = null;
    },
    get isRendering(): boolean {
      return rendering;
    },
  };
}
