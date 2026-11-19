/**
 * Per-stem loudness for a tapped export mix (`TimelineMixStreamOptions.meterTaps`):
 * one BS.1770 `loudness_meter_*` instance per output tap, fed each chunk's taps
 * straight from the heap block the mix wrote them to, so metering copies nothing.
 * Like the session's own output meter, a tap meter hears exactly the delivered
 * frames (the taps are already aligned with the output).
 */

import { withHeap } from './emscriptenLoader';
import { MIX_METER } from './mediaEngineLayout';
import type { MediaEngineWasmModule } from './mediaEngineSession';

/** One stem's loudness: integrated LUFS, loudness range LU, true peak dBTP, sample peak dBFS. */
export interface TapMeterReading {
  /** The tapped lane (`BusGraphPlan.tapTrackIds`), or null for the direct input. */
  trackId: string | null;
  integrated: number;
  range: number;
  truePeak: number;
  samplePeak: number;
}

/** `loudness_meter_read` writes `MIX_METER.momentary` … `MIX_METER.samplePeak`. */
const READ_VALUES = MIX_METER.samplePeak + 1;

type MeterModule = Required<
  Pick<
    MediaEngineWasmModule,
    '_loudness_meter_create' | '_loudness_meter_process' | '_loudness_meter_read' | '_loudness_meter_destroy'
  >
> &
  MediaEngineWasmModule;

function hasMeterExports(mod: MediaEngineWasmModule): mod is MeterModule {
  return (
    typeof mod._loudness_meter_create === 'function' &&
    typeof mod._loudness_meter_process === 'function' &&
    typeof mod._loudness_meter_read === 'function' &&
    typeof mod._loudness_meter_destroy === 'function'
  );
}

/** One loudness meter per output tap, in tap order. */
export class TapMeters {
  private constructor(
    private readonly mod: MeterModule,
    private readonly handles: number[],
    private readonly trackIds: Array<string | null>,
    private readonly channels: number,
  ) {}

  /**
   * Meters for `trackIds` (one per tap; null = the direct input). Null when
   * the module lacks the meter exports or a meter cannot be created.
   */
  static create(
    mod: MediaEngineWasmModule,
    sampleRate: number,
    channels: number,
    trackIds: Array<string | null>,
  ): TapMeters | null {
    if (!hasMeterExports(mod)) return null;
    const handles: number[] = [];
    for (let i = 0; i < trackIds.length; i++) {
      const handle = mod._loudness_meter_create(sampleRate, channels);
      if (!handle) {
        for (const h of handles) mod._loudness_meter_destroy(h);
        return null;
      }
      handles.push(handle);
    }
    return new TapMeters(mod, handles, trackIds, channels);
  }

  /** Meter `frames` frames of every tap at `tapsPtr` (tap-major, `frames * channels` floats each). */
  process(tapsPtr: number, frames: number): boolean {
    const bytes = frames * this.channels * 4;
    const mod = this.mod;
    return this.handles.every((handle, t) => mod._loudness_meter_process(handle, tapsPtr + t * bytes, frames) === 0);
  }

  read(): TapMeterReading[] | null {
    const mod = this.mod;
    return withHeap(mod, (heap) => {
      const out = heap.alloc(READ_VALUES * 8);
      return this.handles.map((handle, t): TapMeterReading => {
        const n = mod._loudness_meter_read(handle, out, READ_VALUES);
        const values = heap.readF64(out, Math.max(0, n));
        return {
          trackId: this.trackIds[t] ?? null,
          integrated: values[MIX_METER.integrated] ?? -Infinity,
          range: values[MIX_METER.range] ?? 0,
          truePeak: values[MIX_METER.truePeak] ?? -Infinity,
          samplePeak: values[MIX_METER.samplePeak] ?? -Infinity,
        };
      });
    });
  }

  destroy(): void {
    for (const handle of this.handles.splice(0)) this.mod._loudness_meter_destroy(handle);
  }
}
