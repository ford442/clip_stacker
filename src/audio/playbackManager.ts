import type { Clip, ClipGroup, ClipTransition } from '../types';
import { ClipAudioCache } from './clipAudioCache';
import {
  buildAudioSchedule,
  entriesActiveAtOrAfter,
  type AudioScheduleEntry,
} from './schedule';

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
  entry: AudioScheduleEntry;
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

  /** Whether Web Audio routing is usable (false → muted visual preview). */
  get isAvailable(): boolean {
    return this.available && !this.contextFailed;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
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
   */
  async syncTimeline(
    clips: Clip[],
    groups: ClipGroup[],
    transitions: ClipTransition[],
  ): Promise<void> {
    this.schedule = buildAudioSchedule(clips, groups, transitions);
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

    // If already playing, reschedule so volume/trim edits take effect.
    if (this.state === 'playing') {
      const t = this.getCurrentTime();
      this.stopSources();
      await this.scheduleFrom(t);
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
   * re-scheduled from the new offset (sample-accurate within one buffer period).
   */
  async seek(timelineTime: number): Promise<void> {
    const t = Math.max(0, timelineTime);
    this.pausedAt = t;
    if (this.state === 'playing') {
      this.stopSources();
      if (this.ctx) {
        this.timelineOrigin = t;
        this.contextOrigin = this.ctx.currentTime;
        await this.scheduleFrom(t);
      }
    }
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
    this.stopSources();
    this.cache.clear();
    this.schedule = [];
    this.listeners.clear();
    this.state = 'stopped';
    this.pausedAt = 0;
    this.timelineOrigin = 0;
    this.contextOrigin = 0;

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
    for (const { source } of this.active) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
    this.active = [];
  }

  private async scheduleFrom(globalTime: number): Promise<void> {
    if (!this.ctx || !this.masterGain || this.state !== 'playing') return;

    const generation = this.scheduleGeneration;
    const ctx = this.ctx;
    const master = this.masterGain;
    const now = ctx.currentTime;
    const remaining = entriesActiveAtOrAfter(this.schedule, globalTime);

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
      const remainingDuration = entry.duration - clipElapsed;
      if (remainingDuration <= 1e-4) continue;

      const bufferOffset = entry.bufferOffset + clipElapsed;
      // Clamp to buffer length so we never schedule past the decoded samples.
      const maxOffset = Math.max(0, buffer.duration - 1e-4);
      if (bufferOffset >= maxOffset) continue;
      const playDuration = Math.min(
        remainingDuration,
        maxOffset - bufferOffset,
      );
      if (playDuration <= 1e-4) continue;

      const when =
        entry.timelineStart > globalTime
          ? now + (entry.timelineStart - globalTime)
          : now;

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gain = ctx.createGain();
      applyGainEnvelope(
        gain.gain,
        entry,
        when,
        playDuration,
        clipElapsed,
        ctx.currentTime,
      );

      source.connect(gain);
      gain.connect(master);

      try {
        source.start(when, bufferOffset, playDuration);
      } catch {
        continue;
      }

      const active: ActiveSource = { source, gain, entry };
      source.onended = () => {
        this.active = this.active.filter((item) => item !== active);
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
      };
      this.active.push(active);
    }
  }
}

/**
 * Apply volume + per-clip audio fade envelopes relative to the scheduled
 * start of this source (`when`), accounting for mid-clip seeks via
 * `clipElapsed`.
 */
export function applyGainEnvelope(
  param: AudioParam,
  entry: Pick<
    AudioScheduleEntry,
    'volume' | 'audioFadeIn' | 'audioFadeOut' | 'duration'
  >,
  when: number,
  playDuration: number,
  clipElapsed: number,
  earliestTime: number,
): void {
  const volume = entry.volume;
  const fadeIn = entry.audioFadeIn;
  const fadeOut = entry.audioFadeOut;
  const fullDuration = entry.duration;

  // Cancel any prior automation and start from the level at clipElapsed.
  const startTime = Math.max(when, earliestTime);
  param.cancelScheduledValues(startTime);

  const levelAt = (localTime: number): number => {
    let level = volume;
    if (fadeIn > 0 && localTime < fadeIn) {
      level *= localTime / fadeIn;
    }
    if (fadeOut > 0 && localTime > fullDuration - fadeOut) {
      const outProgress = (fullDuration - localTime) / fadeOut;
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
    const fadeOutStartLocal = fullDuration - fadeOut;
    const fadeOutStart = when + (fadeOutStartLocal - clipElapsed);
    const fadeOutEnd = when + playDuration;
    if (fadeOutEnd > startTime && clipElapsed < fullDuration) {
      if (fadeOutStart > startTime) {
        param.setValueAtTime(volume, Math.max(startTime, fadeOutStart));
      }
      const endLevel = levelAt(clipElapsed + playDuration);
      param.linearRampToValueAtTime(endLevel, Math.max(startTime, fadeOutEnd));
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
