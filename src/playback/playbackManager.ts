import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import { ClipAudioCache } from '../audio/clipAudioCache';
import {
  buildAudioSchedule,
  effectiveEntryVolume,
  entriesActiveAtOrAfter,
  schedulesMatchStructure,
  type AudioScheduleEntry,
} from '../audio/schedule';
import { RemappedAudioCache } from '../audio/remappedAudioCache';
import { ProcessedAudioCache } from '../audio/processedAudioCache';
import {
  applyPreferredLatency,
  audioContextLatency,
  getAudioContext,
  heardContextTime,
  onAudioContextReplaced,
  outputLatencySec,
  preferAudioLatency,
  type AudioLatencyClass,
} from '../audio/audioService';
import { audioSyncOffsetSec } from '../store/audioSyncStore';
import { AnalyserLevelReader, ZERO_ANALYSER_LEVELS, type AnalyserLevels } from '../audio/analyserLevels';
import { applyGainEnvelope, applyPanEnvelope } from '../audio/gainEnvelope';
import { planEntryCycles, startEntrySource, type ActiveSource } from './entrySources';
import { planBusGraph, type BusGraphPlan } from '../audio/fxGraph';
import { PreviewBusRouting } from './busRouting';
import type { MasterBusSettings } from '../audio/audioBus';
import { audioFxStore } from '../store/audioFxStore';

// Analyser meter levels and the gain / pan envelope maths live in sibling
// modules; re-exported for existing importers.
export { ZERO_ANALYSER_LEVELS, type AnalyserLevels } from '../audio/analyserLevels';
export { applyGainEnvelope, applyPanEnvelope,  } from '../audio/gainEnvelope';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface AudioPlaybackStatus {
  state: PlaybackState;
  /** False when AudioContext could not be created — callers should mute-fallback. */
  available: boolean;
  currentTime: number;
}

type StatusListener = (status: AudioPlaybackStatus) => void;

/**
 * Session-scoped Web Audio playback graph for timeline preview.
 *
 * Decodes clip audio into cached `AudioBuffer`s, schedules
 * `AudioBufferSourceNode`s at sample-accurate timeline offsets, and exposes
 * `AudioContext.currentTime` as the master clock for the visual playhead.
 * Lane / master FX and sidechain ducks run in the bus-graph AudioWorklet
 * (`busRouting.ts`) when the project has any.
 */
export class AudioPlaybackManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly cache = new ClipAudioCache();
  private readonly remapCache = new RemappedAudioCache();
  private readonly processedCache = new ProcessedAudioCache();
  private schedule: AudioScheduleEntry[] = [];
  private active: ActiveSource[] = [];
  private state: PlaybackState = 'stopped';
  private available = true;
  private contextFailed = false;
  /** Timeline time corresponding to `contextOrigin`. */
  private timelineOrigin = 0;
  /** `AudioContext.currentTime` when playback last started. */
  private contextOrigin = 0;
  /** Paused / scrubbed timeline position when not playing. */
  private pausedAt = 0;
  private listeners = new Set<StatusListener>();
  private syncGeneration = 0;
  private scheduleGeneration = 0;
  /** Coalesces rapid scrub seeks while playing into one reschedule. */
  private seekGeneration = 0;
  private masterVolume = 1;
  private readonly levels = new AnalyserLevelReader();
  private readonly busRouting = new PreviewBusRouting();
  private busPlan: BusGraphPlan | null = null;
  private unsubscribeMeters: (() => void) | null = null;
  private unsubscribeContext: (() => void) | null = null;
  /** The shared context was replaced; the bus graph must be rebuilt on the new one. */
  private needsRouting = false;

  /** Whether Web Audio routing is usable (false → muted visual preview). */
  get isAvailable(): boolean {
    return this.available && !this.contextFailed;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Live AudioContext sample rate / latency, for Copy Debug. Null before the context exists. */
  getContextDiagnostics(): {
    sampleRate: number;
    baseLatency: number;
    outputLatency: number;
    latencyHint: AudioLatencyClass;
    syncOffsetMs: number;
    state: AudioContextState;
  } | null {
    if (!this.ctx) return null;
    return {
      sampleRate: this.ctx.sampleRate,
      baseLatency: this.ctx.baseLatency,
      outputLatency: outputLatencySec(this.ctx),
      latencyHint: audioContextLatency(),
      syncOffsetMs: Math.round(audioSyncOffsetSec() * 1000),
      state: this.ctx.state,
    };
  }

  /** Master output gain (0–2). Live-updates without restarting sources. */
  getMasterVolume(): number {
    return this.masterVolume;
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(2, volume));
    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(this.masterVolume, now + 0.03);
    }
  }

  /**
   * Sample the AnalyserNode for waveform meters / audio-reactive uniforms.
   * Returns zeros when the graph is unavailable or idle.
   */
  readAnalyserLevels(): AnalyserLevels {
    return this.analyser ? this.levels.read(this.analyser) : { ...ZERO_ANALYSER_LEVELS };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): AudioPlaybackStatus {
    return {
      state: this.state,
      available: this.isAvailable,
      currentTime: this.getCurrentTime(),
    };
  }

  /**
   * Current timeline playhead driven by the audio clock while playing,
   * otherwise the paused/scrubbed position.
   */
  getCurrentTime(): number {
    if (this.state === 'playing' && this.ctx) {
      // The picture follows what is heard, not what is rendered: the output
      // device's latency (measured by `getOutputTimestamp` where available),
      // the bus graph's look-ahead, and the user's calibrated offset (a
      // positive offset means sound arrives later still, e.g. a Bluetooth
      // sink that under-reports).
      const heard = heardContextTime(this.ctx) - this.contextOrigin - this.busRouting.latencySec - audioSyncOffsetSec();
      return this.timelineOrigin + Math.max(0, heard);
    }
    return this.pausedAt;
  }

  /**
   * Create the AudioContext if needed. Resume is deferred to
   * {@link resumeContext} (must run from a user gesture for autoplay policy).
   */
  async ensureContext(): Promise<boolean> {
    if (this.contextFailed) return false;
    if (this.ctx) return true;

    try {
      const ctx = getAudioContext();
      if (!ctx) throw new Error('Web Audio unavailable');
      this.attach(ctx);
      this.available = true;
      // A loudness meter opening or closing can start / stop the bus graph.
      this.unsubscribeMeters ??= audioFxStore.subscribe((next, prev) => {
        if ((next.meterRequests > 0) !== (prev.meterRequests > 0)) void this.syncBusRouting();
      });
      this.unsubscribeContext ??= onAudioContextReplaced((next) => this.onContextReplaced(next));
      this.emit();
      return true;
    } catch {
      this.contextFailed = true;
      this.available = false;
      this.ctx = null;
      this.masterGain = null;
      this.analyser = null;
      this.emit();
      return false;
    }
  }

  /** Resume a suspended context — call from a user gesture (Play). */
  async resumeContext(): Promise<boolean> {
    const ok = await this.ensureContext();
    if (!ok || !this.ctx) return false;
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }
    return this.ctx.state === 'running';
  }

  /**
   * Rebuild the schedule and warm-decode audio for the current timeline.
   * Safe to call frequently; in-flight decodes are coalesced per clip.
   * Volume-only edits while playing update GainNodes in place (no restart).
   */
  async syncTimeline(
    clips: Clip[],
    groups: ClipGroup[],
    transitions: ClipTransition[],
    tracks: Track[] = [],
    masterBus?: MasterBusSettings,
  ): Promise<void> {
    this.busPlan = tracks.length > 0 || masterBus ? planBusGraph(tracks, masterBus) : null;
    const nextSchedule = buildAudioSchedule(clips, groups, transitions, tracks);
    const structureUnchanged = schedulesMatchStructure(this.schedule, nextSchedule);
    this.schedule = nextSchedule;
    const keepIds = new Set(this.schedule.map((e) => e.clipId));
    this.cache.prune(keepIds);
    this.remapCache.prune(keepIds);
    this.processedCache.prune(keepIds);

    if (!this.isAvailable) return;
    const ok = await this.ensureContext();
    if (!ok || !this.ctx) return;

    const generation = ++this.syncGeneration;
    const ctx = this.ctx;
    const [rerouted] = await Promise.all([
      this.syncBusRouting(false),
      ...this.schedule.map((entry) => this.resolveBuffer(entry, ctx)),
    ]);
    if (generation !== this.syncGeneration) return;

    if (this.state === 'playing') {
      if (structureUnchanged && !rerouted && this.active.length > 0) {
        this.applyLiveGains();
      } else {
        const t = this.getCurrentTime();
        this.stopSources();
        await this.scheduleFrom(t);
      }
    }
  }

  /** Start (or resume) playback from `timelineTime`. */
  async play(timelineTime: number): Promise<boolean> {
    this.stopSources();
    // Nothing of ours is sounding: the one safe moment to move the shared
    // context to the latency class the bus graph asked for.
    if (this.ctx) applyPreferredLatency(true);
    const ok = await this.resumeContext();
    if (!ok || !this.ctx || !this.masterGain) {
      this.pausedAt = Math.max(0, timelineTime);
      this.state = 'paused';
      this.emit();
      return false;
    }
    if (this.needsRouting) await this.syncBusRouting(false);

    this.busRouting.reset();
    this.pausedAt = Math.max(0, timelineTime);
    this.timelineOrigin = this.pausedAt;
    this.contextOrigin = this.ctx.currentTime;
    this.state = 'playing';
    await this.scheduleFrom(this.pausedAt);
    this.emit();
    return true;
  }

  /** Pause and return the frozen timeline time. */
  pause(): number {
    const t = this.getCurrentTime();
    this.pausedAt = Math.max(0, t);
    this.stopSources();
    this.state = 'paused';
    this.emit();
    return this.pausedAt;
  }

  /**
   * Seek / scrub to `timelineTime`. While playing, sources are stopped and
   * re-scheduled from the new offset. Rapid scrub events are coalesced so the
   * graph only rebuilds once per animation frame (~frame-accurate).
   */
  async seek(timelineTime: number): Promise<void> {
    const t = Math.max(0, timelineTime);
    this.pausedAt = t;
    this.emit();

    if (this.state !== 'playing' || !this.ctx) return;

    const generation = ++this.seekGeneration;
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
    if (generation !== this.seekGeneration || this.state !== 'playing') return;

    this.stopSources();
    this.busRouting.reset();
    this.timelineOrigin = this.pausedAt;
    this.contextOrigin = this.ctx.currentTime;
    await this.scheduleFrom(this.pausedAt);
    this.emit();
  }

  /** Stop playback and clear active sources (keeps cache). */
  stop(): void {
    this.stopSources();
    this.state = 'stopped';
    this.emit();
  }

  /**
   * Tear down this manager's graph. The shared context stays open (it belongs
   * to `audioService`); only our nodes are disconnected.
   */
  async dispose(): Promise<void> {
    this.syncGeneration += 1;
    this.seekGeneration += 1;
    this.stopSources();
    this.busRouting.dispose();
    this.busPlan = null;
    this.unsubscribeMeters?.();
    this.unsubscribeMeters = null;
    this.unsubscribeContext?.();
    this.unsubscribeContext = null;
    this.needsRouting = false;
    this.cache.clear();
    this.remapCache.clear();
    this.processedCache.clear();
    this.schedule = [];
    this.listeners.clear();
    this.state = 'stopped';
    this.pausedAt = 0;
    this.timelineOrigin = 0;
    this.contextOrigin = 0;

    this.detach();
    this.available = true;
    this.contextFailed = false;
  }

  /** Restart the preview loudness meter's integrated / range / peak readings. */
  resetBusMeter(): void {
    this.busRouting.resetMeter();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Start, retune or stop the bus-graph worklet for the current plan. With
   * `reschedule`, a playing preview reconnects its sources when the lane
   * inputs changed; resolves whether they did.
   */
  private async syncBusRouting(reschedule = true): Promise<boolean> {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master) return false;
    this.needsRouting = false;
    const meter = audioFxStore.getState().meterRequests > 0;
    const changed = await this.busRouting.sync(ctx, master, this.busPlan, meter, () => {
      void this.rescheduleIfPlaying();
    });
    // The WASM bus graph can take most of a render quantum: ask for a roomier
    // output buffer while it is in the graph (applied at the next idle play).
    preferAudioLatency(this.busRouting.active ? 'balanced' : 'interactive');
    if (changed && reschedule) await this.rescheduleIfPlaying();
    return changed;
  }

  /** Master gain -> analyser -> destination on `ctx`. */
  private attach(ctx: AudioContext): void {
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.masterVolume;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.masterGain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /** Disconnect our nodes; never closes the shared context. */
  private detach(): void {
    for (const node of [this.masterGain, this.analyser]) {
      try {
        node?.disconnect();
      } catch {
        // never connected
      }
    }
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
  }

  /** The shared context was swapped while idle: move over; decoded buffers are context-free and kept. */
  private onContextReplaced(next: AudioContext): void {
    this.stopSources();
    this.busRouting.dispose();
    this.detach();
    this.attach(next);
    this.needsRouting = this.busPlan !== null || audioFxStore.getState().meterRequests > 0;
  }

  private async rescheduleIfPlaying(): Promise<void> {
    if (this.state !== 'playing' || !this.ctx) return;
    const t = this.getCurrentTime();
    this.stopSources();
    this.timelineOrigin = t;
    this.contextOrigin = this.ctx.currentTime;
    await this.scheduleFrom(t);
  }

  /** Decoded → rate-remapped → insert-processed buffer for one entry. */
  private async resolveBuffer(
    entry: AudioScheduleEntry,
    ctx: BaseAudioContext,
  ): Promise<AudioBuffer | null> {
    const buffer = await this.remapCache.get(entry, this.cache, ctx);
    if (!buffer) return null;
    return this.processedCache.get(entry, buffer, ctx);
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // ignore listener errors
      }
    }
  }

  private stopSources(): void {
    this.scheduleGeneration += 1;
    for (const { source, gain, panner } of this.active) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect();
        gain.disconnect();
        panner?.disconnect();
      } catch {
        // ignore
      }
    }
    this.active = [];
  }

  /** Push current schedule volumes (with ducking) onto active GainNodes. */
  private applyLiveGains(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const active of this.active) {
      const updated = this.schedule.find(
        (entry) =>
          entry.clipId === active.entry.clipId &&
          entry.timelineStart === active.entry.timelineStart &&
          entry.objectUrl === active.entry.objectUrl,
      );
      if (!updated) continue;
      active.entry = updated;
      const duckedVolume = effectiveEntryVolume(updated, this.schedule);
      // Remaining play window from now — re-apply envelopes from current local time.
      const played = Math.max(0, now - active.when);
      const localNow = active.clipElapsed + played;
      const remaining = Math.max(0, active.playDuration - played);
      if (remaining <= 1e-4) continue;
      applyGainEnvelope(
        active.gain.gain,
        { ...updated, volume: duckedVolume },
        now,
        remaining,
        localNow,
        now,
      );
      if (active.panner) {
        applyPanEnvelope(
          active.panner.pan,
          updated.panAutomation,
          now,
          remaining,
          localNow,
          now,
          updated.duration,
        );
      }
    }
  }

  private async scheduleFrom(globalTime: number): Promise<void> {
    if (!this.ctx || !this.masterGain || this.state !== 'playing') return;

    const generation = this.scheduleGeneration;
    const ctx = this.ctx;
    const master = this.masterGain;
    const now = ctx.currentTime;
    const remaining = entriesActiveAtOrAfter(this.schedule, globalTime);

    // Prefetch all buffers in parallel so later clips aren't delayed by
    // earlier decodes (keeps multi-clip starts gapless).
    await Promise.all(remaining.map((entry) => this.resolveBuffer(entry, ctx)));
    if (
      generation !== this.scheduleGeneration ||
      this.state !== 'playing' ||
      this.ctx !== ctx
    ) {
      return;
    }

    for (const entry of remaining) {
      if (generation !== this.scheduleGeneration) return;

      const buffer = await this.resolveBuffer(entry, ctx);
      if (
        !buffer ||
        this.state !== 'playing' ||
        this.ctx !== ctx ||
        generation !== this.scheduleGeneration
      ) {
        return;
      }

      const destination = this.busRouting.destination(entry.trackId, master);
      const volume = effectiveEntryVolume(entry, this.schedule);
      for (const cycle of planEntryCycles(entry, buffer.duration, globalTime, now)) {
        const active = startEntrySource(ctx, buffer, entry, cycle, volume, destination, (ended) => {
          this.active = this.active.filter((item) => item !== ended);
        });
        if (active) this.active.push(active);
      }
    }
  }
}

/** Singleton used by the timeline preview session. */
let sharedManager: AudioPlaybackManager | null = null;

export function getAudioPlaybackManager(): AudioPlaybackManager {
  if (!sharedManager) {
    sharedManager = new AudioPlaybackManager();
  }
  return sharedManager;
}

/** Close the shared manager (project unload / preview teardown). */
export async function disposeAudioPlaybackManager(): Promise<void> {
  if (!sharedManager) return;
  const manager = sharedManager;
  sharedManager = null;
  await manager.dispose();
}
