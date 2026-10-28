import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import { ClipAudioCache } from './clipAudioCache';
import {
  buildAudioSchedule,
  effectiveEntryVolume,
  entriesActiveAtOrAfter,
  schedulesMatchStructure,
  type AudioScheduleEntry,
} from './schedule';
import { RemappedAudioCache } from '../utils/remappedAudioCache';
import { ProcessedAudioCache } from './processedAudioCache';
import { createAudioContext } from './context';
import { bandEnergy, ZERO_ANALYSER_LEVELS, type AnalyserLevels } from './analyserLevels';
import { applyGainEnvelope, applyPanEnvelope } from './gainEnvelope';
import { planBusGraph, type BusGraphPlan } from './fxGraph';
import { PreviewBusRouting } from './busRouting';
import type { MasterBusSettings } from '../utils/audioBus';
import { audioFxStore } from '../store/audioFxStore';

// Analyser meter levels and the gain / pan envelope maths live in sibling
// modules; re-exported for existing importers.
export { ZERO_ANALYSER_LEVELS, type AnalyserLevels } from './analyserLevels';
export { applyGainEnvelope, applyPanEnvelope, samplePanAt } from './gainEnvelope';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface AudioPlaybackStatus {
  state: PlaybackState;
  /** False when AudioContext could not be created — callers should mute-fallback. */
  available: boolean;
  currentTime: number;
}

type StatusListener = (status: AudioPlaybackStatus) => void;

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
  entry: AudioScheduleEntry;
  /** AudioContext time when this source was scheduled to start. */
  when: number;
  /**
   * Elapsed time (seconds) since `entry.timelineStart` at schedule start —
   * spans the WHOLE looped entry, not just this source's own cycle. Fades
   * and volume/pan automation are authored across the full looped duration
   * (same domain as the Inspector's automation editor), so they're sampled
   * from this global position rather than resetting at each loop boundary;
   * a source's own cycle only bounds `playDuration` (how long it plays).
   */
  clipElapsed: number;
  playDuration: number;
}

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
  private analyserTimeDomain: Float32Array | null = null;
  private analyserFrequency: Float32Array | null = null;
  private readonly busRouting = new PreviewBusRouting();
  private busPlan: BusGraphPlan | null = null;
  private unsubscribeMeters: (() => void) | null = null;

  /** Whether Web Audio routing is usable (false → muted visual preview). */
  get isAvailable(): boolean {
    return this.available && !this.contextFailed;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Live AudioContext sample rate / latency, for Copy Debug. Null before the context exists. */
  getContextDiagnostics(): { sampleRate: number; baseLatency: number; state: AudioContextState } | null {
    if (!this.ctx) return null;
    return {
      sampleRate: this.ctx.sampleRate,
      baseLatency: this.ctx.baseLatency,
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
    if (!this.analyser) return { ...ZERO_ANALYSER_LEVELS };

    const binCount = this.analyser.frequencyBinCount;
    if (!this.analyserTimeDomain || this.analyserTimeDomain.length !== this.analyser.fftSize) {
      this.analyserTimeDomain = new Float32Array(this.analyser.fftSize);
    }
    if (!this.analyserFrequency || this.analyserFrequency.length !== binCount) {
      this.analyserFrequency = new Float32Array(binCount);
    }

    this.analyser.getFloatTimeDomainData(
      this.analyserTimeDomain as unknown as Float32Array<ArrayBuffer>,
    );
    this.analyser.getFloatFrequencyData(
      this.analyserFrequency as unknown as Float32Array<ArrayBuffer>,
    );

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < this.analyserTimeDomain.length; i++) {
      const s = this.analyserTimeDomain[i];
      sumSq += s * s;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, this.analyserTimeDomain.length));

    // Frequency data is in dB (−∞…0). Map bands to 0–1 loosely.
    const bass = bandEnergy(this.analyserFrequency, 0, Math.floor(binCount * 0.08));
    const mid = bandEnergy(
      this.analyserFrequency,
      Math.floor(binCount * 0.08),
      Math.floor(binCount * 0.4),
    );
    const treble = bandEnergy(
      this.analyserFrequency,
      Math.floor(binCount * 0.4),
      binCount,
    );

    return { rms, peak, bass, mid, treble };
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
      // The bus graph's look-ahead delays what is heard; the picture follows.
      const heard = this.ctx.currentTime - this.contextOrigin - this.busRouting.latencySec;
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
      this.ctx = createAudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.available = true;
      // A loudness meter opening or closing can start / stop the bus graph.
      this.unsubscribeMeters ??= audioFxStore.subscribe((next, prev) => {
        if ((next.meterRequests > 0) !== (prev.meterRequests > 0)) void this.syncBusRouting();
      });
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
    const ok = await this.resumeContext();
    if (!ok || !this.ctx || !this.masterGain) {
      this.pausedAt = Math.max(0, timelineTime);
      this.state = 'paused';
      this.emit();
      return false;
    }

    this.stopSources();
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
   * Tear down the graph and close the AudioContext. Call on project unload /
   * preview unmount to avoid DevTools leak warnings.
   */
  async dispose(): Promise<void> {
    this.syncGeneration += 1;
    this.seekGeneration += 1;
    this.stopSources();
    this.busRouting.dispose();
    this.busPlan = null;
    this.unsubscribeMeters?.();
    this.unsubscribeMeters = null;
    this.cache.clear();
    this.remapCache.clear();
    this.processedCache.clear();
    this.schedule = [];
    this.listeners.clear();
    this.state = 'stopped';
    this.pausedAt = 0;
    this.timelineOrigin = 0;
    this.contextOrigin = 0;
    this.analyserTimeDomain = null;
    this.analyserFrequency = null;

    const ctx = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.available = true;
    this.contextFailed = false;

    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
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
    const meter = audioFxStore.getState().meterRequests > 0;
    const changed = await this.busRouting.sync(ctx, master, this.busPlan, meter, () => {
      void this.rescheduleIfPlaying();
    });
    if (changed && reschedule) await this.rescheduleIfPlaying();
    return changed;
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

      // The decoded/remapped buffer holds exactly ONE cycle; a looped clip
      // replays it back to back, so schedule one source per remaining cycle
      // rather than one long source spanning the whole (multiplied) entry.
      const rate =
        entry.rateRemap
          ? 1
          : Number.isFinite(entry.playbackRate) && entry.playbackRate > 0
            ? entry.playbackRate
            : 1;
      const maxOffset = Math.max(0, buffer.duration - 1e-4);

      for (let cycleIndex = 0; cycleIndex < entry.loopCount; cycleIndex++) {
        const cycleStart = entry.timelineStart + cycleIndex * entry.cycleDuration;
        const cycleEnd = cycleStart + entry.cycleDuration;
        if (cycleEnd <= globalTime + 1e-4) continue;

        // Cycle-local elapsed indexes into the single-cycle decoded buffer.
        const cycleLocalElapsed = Math.max(0, globalTime - cycleStart);
        const remainingTimeline = entry.cycleDuration - cycleLocalElapsed;
        if (remainingTimeline <= 1e-4) continue;

        const bufferOffset = entry.bufferOffset + cycleLocalElapsed * rate;
        // Clamp to buffer length so we never schedule past the decoded samples.
        if (bufferOffset >= maxOffset) continue;
        const remainingSource = maxOffset - bufferOffset;
        const maxTimelineFromBuffer = remainingSource / rate;
        const playDuration = Math.min(remainingTimeline, maxTimelineFromBuffer);
        if (playDuration <= 1e-4) continue;
        const playDurationSource = playDuration * rate;

        const when =
          cycleStart > globalTime ? now + (cycleStart - globalTime) : now;

        // Fades and volume/pan automation are authored across the WHOLE
        // looped span (same domain as the Inspector automation editor), so
        // sample them from the global (unwrapped) elapsed time — this also
        // naturally confines fadeIn to the first cycle and fadeOut to the
        // last, without special-casing interior cycles.
        const globalClipElapsed = Math.max(0, globalTime - entry.timelineStart);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;

        const gain = ctx.createGain();
        const duckedVolume = effectiveEntryVolume(entry, this.schedule);
        applyGainEnvelope(
          gain.gain,
          { ...entry, volume: duckedVolume },
          when,
          playDuration,
          globalClipElapsed,
          ctx.currentTime,
        );

        // Its lane's bus input when the bus graph runs, else the master gain.
        const destination = this.busRouting.destination(entry.trackId, master);
        let panner: StereoPannerNode | null = null;
        if (typeof ctx.createStereoPanner === 'function') {
          panner = ctx.createStereoPanner();
          applyPanEnvelope(
            panner.pan,
            entry.panAutomation,
            when,
            playDuration,
            globalClipElapsed,
            ctx.currentTime,
            entry.duration,
          );
          source.connect(gain);
          gain.connect(panner);
          panner.connect(destination);
        } else {
          source.connect(gain);
          gain.connect(destination);
        }

        try {
          source.start(when, bufferOffset, playDurationSource);
        } catch {
          continue;
        }

        const active: ActiveSource = {
          source,
          gain,
          panner,
          entry,
          when,
          clipElapsed: globalClipElapsed,
          playDuration,
        };
        source.onended = () => {
          this.active = this.active.filter((item) => item !== active);
          try {
            source.disconnect();
            gain.disconnect();
            panner?.disconnect();
          } catch {
            // ignore
          }
        };
        this.active.push(active);
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
