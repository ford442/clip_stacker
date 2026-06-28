import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDebugReport } from './debugReport';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import type { Clip } from '../types';
import {
  setFfmpegManagerForTesting,
  resetFfmpegManagerForTesting,
  FfmpegManager,
} from '../ffmpeg/ffmpegManager';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    file: new File([], 'test.mp4'),
    objectUrl: 'blob:test',
    title: 'Test Clip',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('generateDebugReport', () => {
  beforeEach(() => {
    resetFfmpegManagerForTesting();
    const mgr = new FfmpegManager({ useWorker: false });
    mgr.recordLog('[info] test log line');
    mgr.setLastCommand(['-i', 'input.mp4', '-filter_complex', '[0:v]null[v]', '-map', '[v]', 'out.mp4']);
    setFfmpegManagerForTesting(mgr);
  });

  it('includes environment, clips, and FFmpeg command sections', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'TestAgent/1.0',
      hardwareConcurrency: 8,
    });
    vi.stubGlobal('screen', { width: 1920, height: 1080 });
    vi.stubGlobal('window', {
      crossOriginIsolated: true,
      devicePixelRatio: 2,
      location: { href: 'http://localhost:4173/' },
    });

    const report = generateDebugReport({
      status: 'Render failed: test error',
      renderPlan: {
        path: 'lossless-concat',
        reason: 'All clips match',
        willReencode: false,
        description: 'Lossless concat',
      },
      encoderPath: 'ffmpeg',
      clips: [makeClip()],
      clipGroups: [],
      transitions: [],
      textOverlays: [],
      exportSettings: DEFAULT_EXPORT_SETTINGS,
      error: new Error('test error'),
    });

    expect(report).toContain('# clip_stacker Debug Report');
    expect(report).toContain('## Environment');
    expect(report).toContain('TestAgent/1.0');
    expect(report).toContain('## Render Plan');
    expect(report).toContain('Lossless concat');
    expect(report).toContain('## Last FFmpeg Command');
    expect(report).toContain('-filter_complex');
    expect(report).toContain('## filter_complex');
    expect(report).toContain('[0:v]null[v]');
    expect(report).toContain('## Error');
    expect(report).toContain('test error');
    expect(report).toContain('## FFmpeg Logs');
    expect(report).toContain('[info] test log line');

    vi.unstubAllGlobals();
  });
});
