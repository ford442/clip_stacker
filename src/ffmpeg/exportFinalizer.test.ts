import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import {
  buildExportFinalizeArgs,
  needsExportFinalization,
} from './exportFinalizer';

describe('export finalizer', () => {
  it('leaves default MP4 renders untouched', () => {
    expect(needsExportFinalization(DEFAULT_EXPORT_SETTINGS)).toBe(false);
  });

  it('encodes ProRes 422 HQ as a QuickTime MOV with copied audio', () => {
    const args = buildExportFinalizeArgs({
      ...DEFAULT_EXPORT_SETTINGS,
      outputFormat: 'prores',
      proresProfile: 3,
    });

    expect(args).toEqual([
      '-i', 'render-finalizer-input.mp4',
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'prores_ks',
      '-profile:v', '3',
      '-pix_fmt', 'yuv422p10le',
      '-vendor', 'apl0',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-f', 'mov',
      '-y', 'render-finalized.mov',
    ]);
  });

  it('applies selectable video and audio cleanup independently', () => {
    const args = buildExportFinalizeArgs({
      ...DEFAULT_EXPORT_SETTINGS,
      lightVideoCleanup: true,
      audioCleanup: true,
    });

    expect(args).toContain(
      'hqdn3d=1.2:1.2:3:3,deband=1thr=0.02:2thr=0.02:3thr=0.02:4thr=0.02',
    );
    expect(args).toContain('highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
  });

  it('falls back to ProRes HQ for an invalid stored profile', () => {
    const args = buildExportFinalizeArgs({
      ...DEFAULT_EXPORT_SETTINGS,
      outputFormat: 'prores',
      proresProfile: 4 as 1 | 2 | 3,
    });
    expect(args.slice(args.indexOf('-profile:v'), args.indexOf('-profile:v') + 2))
      .toEqual(['-profile:v', '3']);
  });
});
