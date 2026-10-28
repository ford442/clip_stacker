/**
 * The preview half of lane buses: the media engine's bus graph running live
 * in an AudioWorklet (`public/worklets/audio-fx-processor.js`).
 *
 * Clip inserts can be baked into each clip's buffer ahead of time
 * (`processedAudioCache.ts`), but the bus stage cannot: a sidechain duck
 * depends on another lane at playback time, and the master chain and meter
 * see the sum of everything. So it runs on the audio thread, on the very
 * C++ the export premix runs — compiled glue-free (`media_engine_fx.wasm`),
 * because an AudioWorkletGlobalScope has no fetch or importScripts. The main
 * thread compiles the module and posts it to the processor; the CSP already
 * allows `'wasm-unsafe-eval'`, and the worklet script is same-origin.
 *
 * Kill switch: `?no_audio_fx` (bus FX are then bypassed in preview; export
 * still applies them). A failed load bypasses them too and the UI badge
 * says "FX not previewed" — never a `DynamicsCompressorNode` stand-in.
 */

import type { BusGraphPlan } from '../audio/fxGraph';
import { resolvePublicAssetUrl } from '../utils/publicAssetUrl';
import { resolveWasmAssetUrl } from './emscriptenLoader';
import { MIX_BUS_FLAG_METER, MIX_FX_STRIDE } from './mediaEngineLayout';
import { decodeMeterReading, type MixMeterReading } from './mediaEngineSession';

export const AUDIO_FX_KILL_PARAM = 'no_audio_fx';
export const AUDIO_FX_PROCESSOR = 'clip-stacker-bus-fx';
export const AUDIO_FX_WORKLET_PATH = 'worklets/audio-fx-processor.js';
export const AUDIO_FX_WASM = 'media_engine_fx.wasm';
/** Lane inputs per node (plus the direct input): implementations cap node inputs at 32. */
export const AUDIO_FX_MAX_LANES = 31;

/** What the worklet's `applyLayout` reads: the packed graph, ready to copy into its heap. */
export interface BusLayoutMessage {
  effects: Float64Array;
  effectCount: number;
  buses: Int32Array;
  masterFirst: number;
  masterCount: number;
  outputGainDb: number;
  finalFirst: number;
  finalCount: number;
  flags: number;
}

export function busLayoutMessage(plan: BusGraphPlan, meter: boolean): BusLayoutMessage {
  return {
    effects: Float64Array.from(plan.effects),
    effectCount: plan.effects.length / MIX_FX_STRIDE,
    buses: Int32Array.from(plan.buses),
    masterFirst: plan.masterFirst,
    masterCount: plan.masterCount,
    outputGainDb: plan.outputGainDb,
    finalFirst: plan.finalFirst,
    finalCount: plan.finalCount,
    flags: meter ? MIX_BUS_FLAG_METER : 0,
  };
}

/** Where the preview's bus FX stand. */
export type AudioFxPreviewState =
  | { state: 'idle' }
  | { state: 'disabled' }
  | { state: 'loading' }
  | { state: 'active'; latencyFrames: number }
  | { state: 'failed'; reason: string };

function currentSearch(): string {
  return typeof location !== 'undefined' ? location.search : '';
}

export function isAudioFxPreviewEnabled(search: string = currentSearch()): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return !params.has(AUDIO_FX_KILL_PARAM);
}

/** True when this browser can run AudioWorklets at all. */
export function audioWorkletSupported(ctx: BaseAudioContext | null): boolean {
  return Boolean(ctx && 'audioWorklet' in ctx && typeof AudioWorkletNode !== 'undefined');
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

/** Compile `media_engine_fx.wasm` once per page; a failure is retried on the next call. */
export function loadAudioFxModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    const url = resolveWasmAssetUrl(AUDIO_FX_WASM);
    modulePromise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${AUDIO_FX_WASM}`);
      // compileStreaming wants application/wasm; a misconfigured server still works.
      if (typeof WebAssembly.compileStreaming === 'function' && response.headers.get('content-type')?.includes('wasm')) {
        return WebAssembly.compileStreaming(response);
      }
      return WebAssembly.compile(await response.arrayBuffer());
    })();
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

const registrations = new WeakMap<BaseAudioContext, Promise<void>>();

/** Add the processor script to `ctx`'s worklet scope (once per context). */
export function registerAudioFxWorklet(ctx: BaseAudioContext): Promise<void> {
  let pending = registrations.get(ctx);
  if (!pending) {
    pending = ctx.audioWorklet.addModule(resolvePublicAssetUrl(AUDIO_FX_WORKLET_PATH));
    pending.catch(() => registrations.delete(ctx));
    registrations.set(ctx, pending);
  }
  return pending;
}

export interface BusFxCallbacks {
  /** The graph is built; `latencyFrames` of look-ahead delay sit between input and output. */
  onReady?(latencyFrames: number): void;
  onError?(reason: string): void;
  onMeters?(reading: MixMeterReading): void;
}

/** One live bus graph: an AudioWorkletNode with a lane input per bus plus the direct input. */
export class BusFxNode {
  readonly lanes: number;

  constructor(
    readonly node: AudioWorkletNode,
    lanes: number,
  ) {
    this.lanes = lanes;
  }

  /** Retune (or, when the structure changed, rebuild) the graph; same lane count only. */
  setLayout(plan: BusGraphPlan, meter: boolean): void {
    this.node.port.postMessage({ type: 'layout', layout: busLayoutMessage(plan, meter) });
  }

  /** Clear filter, envelope and delay-line state (a seek); the meter keeps measuring. */
  reset(): void {
    this.node.port.postMessage({ type: 'reset' });
  }

  resetMeter(): void {
    this.node.port.postMessage({ type: 'resetMeter' });
  }

  /** Lane input `index` (the plan's lane order; `lanes` is the direct input). */
  input(index: number): number {
    return Math.max(0, Math.min(this.lanes, index));
  }

  dispose(): void {
    this.node.port.onmessage = null;
    this.node.port.close();
    this.node.disconnect();
  }
}

/**
 * Build a node for `plan` on `ctx`. Throws when the worklet or module cannot
 * load; the caller falls back to the dry graph.
 */
export async function createBusFxNode(
  ctx: BaseAudioContext,
  plan: BusGraphPlan,
  meter: boolean,
  callbacks: BusFxCallbacks = {},
): Promise<BusFxNode> {
  const lanes = Math.min(plan.laneTrackIds.length, AUDIO_FX_MAX_LANES);
  if (lanes !== plan.laneTrackIds.length) throw new Error(`more than ${AUDIO_FX_MAX_LANES} lanes`);
  const [module] = await Promise.all([loadAudioFxModule(), registerAudioFxWorklet(ctx)]);
  const node = new AudioWorkletNode(ctx, AUDIO_FX_PROCESSOR, {
    numberOfInputs: lanes + 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { module, layout: busLayoutMessage(plan, meter) },
  });
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; latency?: number; message?: string; values?: Float64Array };
    if (data?.type === 'ready') callbacks.onReady?.(data.latency ?? 0);
    else if (data?.type === 'error') callbacks.onError?.(data.message ?? 'bus graph error');
    else if (data?.type === 'meters' && data.values) callbacks.onMeters?.(decodeMeterReading(data.values));
  };
  node.onprocessorerror = () => callbacks.onError?.('processor error');
  return new BusFxNode(node, lanes);
}

export function _resetAudioFxModuleForTests(): void {
  modulePromise = null;
}
