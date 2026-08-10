import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import { ClipAudioCache } from './clipAudioCache';
import {
  buildAudioSchedule,
  effectiveEntryVolume,
  entriesActiveAtOrAfter,
  schedulesMatchStructure,
  type AudioScheduleEntry,
} from './schedule';
import {
  collectAutomationBreakpoints,
  DEFAULT_CLIP_PAN,
  scheduleAudioParamBreakpoints,
} from '../utils/clipAutomation';
import { sampleKeyframes } from '../utils/keyframes';
import { clampClipVolume } from '../utils/audioVolume';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface AudioPlaybackStatus {
  state: PlaybackState;
  /** False when AudioContext could not be created — callers should mute-fallback. */
  available: boolean;
  currentTime: number;
}

/** Instantaneous meter reading from the playback AnalyserNode. */
export interface AnalyserLevels {
  /** Broadband RMS in 0–1. */
  rms: number;
  /** Peak sample in 0–1. */
  peak: number;
  /** Low / mid / high band energies in 0–1 (for reactive shaders / meters). */
  bass: number;
  mid: number;
  treble: number;
}

export const ZERO_ANALYSER_LEVELS: AnalyserLevels = {
  rms: 0,
  peak: 0,
  bass: 0,
  mid: 0,
  treble: 0,
};

type StatusListener = (status: AudioPlaybackStatus) => void;

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
  entry: AudioScheduleEntry;
  /** AudioContext time when this source was scheduled to start. */
  when: number;
  /** Clip-local elapsed time at schedule start (handles mid-clip seeks). */
  clipElapsed: number;
  playDuration: number;
}

/**
 * Session-scoped Web Audio playback graph for timeline preview.
 *
 * Decodes clip audio into cached `AudioBuffer`s, schedules
 * `AudioBufferSourceNode`s at sample-accurate timeline offsets, and exposes
 * `AudioContext.currentTime` as the master clock for the visual playhead.
 */
export class AudioPlaybackManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly cache = new ClipAudioCache();
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

  /** Whether Web Audio routing is usable (false → muted visual preview). */
  get isAvailable(): boolean {
    return this.available && !this.contextFailed;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
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
      return this.timelineOrigin + (this.ctx.currentTime - this.contextOrigin);
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
      const Ctx =
        typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext
          : undefined;
      if (!Ctx) {
        this.contextFailed = true;
        this.available = false;
        this.emit();
        return false;
      }
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.available = true;
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
  ): Promise<void> {
    const nextSchedule = buildAudioSchedule(clips, groups, transitions, tracks);
    const structureUnchanged = schedulesMatchStructure(this.schedule, nextSchedule);
    this.schedule = nextSchedule;
    const keepIds = new Set(this.schedule.map((e) => e.clipId));
    this.cache.prune(keepIds);

    if (!this.isAvailable) return;
    const ok = await this.ensureContext();
    if (!ok || !this.ctx) return;

    const generation = ++this.syncGeneration;
    const ctx = this.ctx;
    await Promise.all(
      this.schedule.map((entry) =>
        this.cache.get(entry.clipId, entry.objectUrl, ctx),
      ),
    );
    if (generation !== this.syncGeneration) return;

    if (this.state === 'playing') {
      if (structureUnchanged && this.active.length > 0) {
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
    this.cache.clear();
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

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

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
    await Promise.all(
      remaining.map((entry) => this.cache.get(entry.clipId, entry.objectUrl, ctx)),
    );
    if (
      generation !== this.scheduleGeneration ||
      this.state !== 'playing' ||
      this.ctx !== ctx
    ) {
      return;
    }

    for (const entry of remaining) {
      if (generation !== this.scheduleGeneration) return;

      const buffer = await this.cache.get(entry.clipId, entry.objectUrl, ctx);
      if (
        !buffer ||
        this.state !== 'playing' ||
        this.ctx !== ctx ||
        generation !== this.scheduleGeneration
      ) {
        return;
      }

      const clipElapsed = Math.max(0, globalTime - entry.timelineStart);
      const remainingTimeline = entry.duration - clipElapsed;
      if (remainingTimeline <= 1e-4) continue;

      const rate =
        Number.isFinite(entry.playbackRate) && entry.playbackRate > 0
          ? entry.playbackRate
          : 1;
      const bufferOffset = entry.bufferOffset + clipElapsed * rate;
      // Clamp to buffer length so we never schedule past the decoded samples.
      const maxOffset = Math.max(0, buffer.duration - 1e-4);
      if (bufferOffset >= maxOffset) continue;
      const remainingSource = maxOffset - bufferOffset;
      const maxTimelineFromBuffer = remainingSource / rate;
      const playDuration = Math.min(remainingTimeline, maxTimelineFromBuffer);
      if (playDuration <= 1e-4) continue;
      const playDurationSource = playDuration * rate;

      const when =
        entry.timelineStart > globalTime
          ? now + (entry.timelineStart - globalTime)
          : now;

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
        clipElapsed,
        ctx.currentTime,
      );

      let panner: StereoPannerNode | null = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        applyPanEnvelope(
          panner.pan,
          entry.panAutomation,
          when,
          playDuration,
          clipElapsed,
          ctx.currentTime,
          entry.duration,
        );
        source.connect(gain);
        gain.connect(panner);
        panner.connect(master);
      } else {
        source.connect(gain);
        gain.connect(master);
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
        clipElapsed,
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

/** Map a slice of Analyser frequency bins (dB) to a 0–1 energy. */
function bandEnergy(frequencyDb: Float32Array, start: number, end: number): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    // getFloatFrequencyData is typically −100…0 dB.
    const db = frequencyDb[i];
    const linear = db <= -100 ? 0 : Math.pow(10, db / 20);
    sum += linear;
  }
  return Math.min(1, sum / (end - start));
}

/**
 * Apply volume keyframes + per-clip audio fade envelopes relative to the
 * scheduled start of this source (`when`), accounting for mid-clip seeks via
 * `clipElapsed`. Automation values are absolute linear gain; fades multiply.
 */
export function applyGainEnvelope(
  param: AudioParam,
  entry: Pick<
    AudioScheduleEntry,
    'volume' | 'audioFadeIn' | 'audioFadeOut' | 'duration' | 'volumeAutomation'
  >,
  when: number,
  playDuration: number,
  clipElapsed: number,
  earliestTime: number,
): void {
  const volume = clampClipVolume(entry.volume);
  const hasAutomation = (entry.volumeAutomation?.length ?? 0) > 0;
  const fadeIn = entry.audioFadeIn;
  const fadeOut = entry.audioFadeOut;

  // Fast path: constant volume with optional linear fades (legacy behavior).
  if (!hasAutomation) {
    const startTime = Math.max(when, earliestTime);
    param.cancelScheduledValues(startTime);

    const levelAt = (localTime: number): number => {
      let level = volume;
      if (fadeIn > 0 && localTime < fadeIn) {
        level *= localTime / fadeIn;
      }
      if (fadeOut > 0 && localTime > entry.duration - fadeOut) {
        const outProgress = (entry.duration - localTime) / fadeOut;
        level *= Math.max(0, Math.min(1, outProgress));
      }
      return level;
    };

    param.setValueAtTime(levelAt(clipElapsed), startTime);

    if (fadeIn > 0 && clipElapsed < fadeIn) {
      const fadeInEnd = when + (fadeIn - clipElapsed);
      if (fadeInEnd > startTime) {
        param.linearRampToValueAtTime(volume, fadeInEnd);
      }
    }

    if (fadeOut > 0) {
      const fadeOutStartLocal = entry.duration - fadeOut;
      const fadeOutStart = when + (fadeOutStartLocal - clipElapsed);
      const fadeOutEnd = when + playDuration;
      if (fadeOutEnd > startTime && clipElapsed < entry.duration) {
        if (fadeOutStart > startTime) {
          param.setValueAtTime(volume, Math.max(startTime, fadeOutStart));
        }
        const endLevel = levelAt(clipElapsed + playDuration);
        param.linearRampToValueAtTime(endLevel, Math.max(startTime, fadeOutEnd));
      }
    }
    return;
  }

  const breakpoints = collectAutomationBreakpoints({
    duration: entry.duration,
    clipElapsed,
    playDuration,
    keyframes: entry.volumeAutomation,
    defaultValue: volume,
    fadeIn,
    fadeOut,
  }).map((point) => ({
    ...point,
    value: clampClipVolume(point.value),
  }));

  scheduleAudioParamBreakpoints(
    param,
    breakpoints,
    when,
    clipElapsed,
    earliestTime,
  );
}

/**
 * Apply stereo pan automation (−1…+1). Empty keyframes leave the pan centered.
 */
export function applyPanEnvelope(
  param: AudioParam,
  panAutomation: AudioScheduleEntry['panAutomation'],
  when: number,
  playDuration: number,
  clipElapsed: number,
  earliestTime: number,
  fullDuration?: number,
): void {
  const hasAutomation = (panAutomation?.length ?? 0) > 0;
  if (!hasAutomation) {
    const startTime = Math.max(when, earliestTime);
    param.cancelScheduledValues(startTime);
    param.setValueAtTime(DEFAULT_CLIP_PAN, startTime);
    return;
  }

  const duration = Math.max(
    fullDuration ?? 0,
    clipElapsed + playDuration,
  );
  const breakpoints = collectAutomationBreakpoints({
    duration,
    clipElapsed,
    playDuration,
    keyframes: panAutomation,
    defaultValue: DEFAULT_CLIP_PAN,
  }).map((point) => ({
    ...point,
    value: Math.max(-1, Math.min(1, point.value)),
  }));

  scheduleAudioParamBreakpoints(
    param,
    breakpoints,
    when,
    clipElapsed,
    earliestTime,
  );
}

/** Instantaneous pan at local clip time (for tests / meters). */
export function samplePanAt(
  panAutomation: AudioScheduleEntry['panAutomation'],
  localTime: number,
): number {
  return Math.max(
    -1,
    Math.min(1, sampleKeyframes(panAutomation, localTime, DEFAULT_CLIP_PAN)),
  );
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
