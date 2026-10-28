/**
 * Lane-bus routing for the preview's Web Audio graph.
 *
 * Without bus FX (and with no loudness meter open) the playback graph is
 * unchanged: every source's pan node feeds the master gain directly. With
 * them, each lane gets a unity GainNode that sums its sources into one input
 * of the bus-graph AudioWorkletNode (`wasm/audioFx.ts`), which runs the lane
 * chains, ducks and master chain and feeds the master gain:
 *
 *   source -> gain -> pan -> lane input --+
 *   source -> gain -> pan -> lane input --+-> bus graph (worklet) -> master gain -> analyser
 *   (no lane) ---------------> direct ----+
 *
 * A change of lane set or packed order needs a new node (its input count is
 * fixed), and the sources must reconnect: `sync` reports that, and the
 * playback manager reschedules. Parameter edits retune the running node.
 */

import type { BusGraphPlan } from './fxGraph';
import { audioFxStore } from '../store/audioFxStore';
import {
  audioWorkletSupported,
  createBusFxNode,
  isAudioFxPreviewEnabled,
  type BusFxNode,
} from '../wasm/audioFx';

export class PreviewBusRouting {
  private node: BusFxNode | null = null;
  private laneInputs = new Map<string, GainNode>();
  private direct: GainNode | null = null;
  private laneKey = '';
  private latencyFrames = 0;
  private sampleRate = 48000;
  private generation = 0;
  private meter = false;

  /** Look-ahead delay of the running graph (s); the playhead subtracts it. */
  get latencySec(): number {
    return this.node ? this.latencyFrames / this.sampleRate : 0;
  }

  get active(): boolean {
    return this.node !== null;
  }

  /**
   * Bring the routing in line with `plan` (null: the project needs no bus
   * graph). Resolves true when sources must reconnect: the set of lane
   * inputs appeared, changed or went away. `onLost` runs if a running graph
   * fails later (the routing has already torn itself down).
   */
  async sync(
    ctx: AudioContext,
    master: AudioNode,
    plan: BusGraphPlan | null,
    meter: boolean,
    onLost: () => void,
  ): Promise<boolean> {
    const generation = ++this.generation;
    const need = plan !== null && (plan.processing || meter);
    if (!need) {
      audioFxStore.getState().setPreview({ state: 'idle' });
      return this.teardown();
    }
    if (!isAudioFxPreviewEnabled()) {
      audioFxStore.getState().setPreview({ state: 'disabled' });
      return this.teardown();
    }
    if (!audioWorkletSupported(ctx)) {
      audioFxStore.getState().setPreview({ state: 'failed', reason: 'AudioWorklet unavailable' });
      return this.teardown();
    }

    const key = plan.laneTrackIds.join('\u0000');
    if (this.node && key === this.laneKey) {
      this.meter = meter;
      this.node.setLayout(plan, meter);
      audioFxStore.getState().setMeters(audioFxStore.getState().meters, plan.laneTrackIds);
      return false;
    }

    if (!this.node) audioFxStore.getState().setPreview({ state: 'loading' });
    let node: BusFxNode;
    try {
      node = await createBusFxNode(ctx, plan, meter, {
        onReady: (latency) => {
          if (this.node !== node) return;
          this.latencyFrames = latency;
          audioFxStore.getState().setPreview({ state: 'active', latencyFrames: latency });
        },
        onError: (reason) => {
          if (this.node !== node) return;
          audioFxStore.getState().setPreview({ state: 'failed', reason });
          this.teardown();
          onLost();
        },
        onMeters: (reading) => {
          if (this.node === node) audioFxStore.getState().setMeters(reading, plan.laneTrackIds);
        },
      });
    } catch (err) {
      if (generation !== this.generation) return false;
      audioFxStore.getState().setPreview({ state: 'failed', reason: (err as Error).message || String(err) });
      return this.teardown();
    }
    if (generation !== this.generation) {
      node.dispose();
      return false;
    }

    this.teardown();
    this.sampleRate = ctx.sampleRate;
    this.latencyFrames = 0;
    this.meter = meter;
    plan.laneTrackIds.forEach((trackId, index) => {
      const input = ctx.createGain();
      input.connect(node.node, 0, node.input(index));
      this.laneInputs.set(trackId, input);
    });
    this.direct = ctx.createGain();
    this.direct.connect(node.node, 0, node.input(node.lanes));
    node.node.connect(master);
    this.node = node;
    this.laneKey = key;
    audioFxStore.getState().setMeters(null, plan.laneTrackIds);
    return true;
  }

  /** The node a source for an entry on `trackId` connects to. */
  destination(trackId: string | undefined, master: AudioNode): AudioNode {
    if (!this.node) return master;
    return (trackId !== undefined ? this.laneInputs.get(trackId) : undefined) ?? this.direct ?? master;
  }

  /** Clear filter / envelope / delay state (play start, seek). */
  reset(): void {
    this.node?.reset();
  }

  resetMeter(): void {
    this.node?.resetMeter();
    if (this.meter) audioFxStore.getState().setMeters(null);
  }

  /** Disconnect everything; true when there was a running graph. */
  teardown(): boolean {
    const had = this.node !== null;
    for (const input of this.laneInputs.values()) input.disconnect();
    this.laneInputs.clear();
    this.direct?.disconnect();
    this.direct = null;
    this.node?.dispose();
    this.node = null;
    this.laneKey = '';
    this.latencyFrames = 0;
    if (had) audioFxStore.getState().setMeters(null, []);
    return had;
  }

  dispose(): void {
    this.generation += 1;
    this.teardown();
  }
}
