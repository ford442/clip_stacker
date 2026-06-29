import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  RenderPlan,
  TextOverlay,
} from '../types';
import {
  getLastFfmpegCommand,
  getLastFfmpegError,
  getLastFfmpegFilterComplex,
  getLastFfmpegLogs,
  getFfmpegEnvironmentDiagnostics,
} from '../ffmpeg/ffmpegService';

export interface DebugReportContext {
  status: string;
  renderPlan: RenderPlan | null;
  encoderPath: string;
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings: ExportSettings;
  error?: unknown;
}

function formatClipSummary(clip: Clip, index: number): string {
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const effects: string[] = [];
  if (clip.videoFadeIn > 0) effects.push(`vFadeIn=${clip.videoFadeIn}s`);
  if (clip.videoFadeOut > 0) effects.push(`vFadeOut=${clip.videoFadeOut}s`);
  if (clip.audioFadeIn > 0) effects.push(`aFadeIn=${clip.audioFadeIn}s`);
  if (clip.audioFadeOut > 0) effects.push(`aFadeOut=${clip.audioFadeOut}s`);
  if (clip.rifeProcessed) effects.push(`RIFE×${clip.rifeMultiplier ?? '?'}`);
  if ((clip.layerIndex ?? 0) > 0) effects.push(`layer=${clip.layerIndex}`);
  if (clip.volume !== undefined && clip.volume !== 1) {
    effects.push(`vol=${clip.volume}`);
  }
  const effectStr = effects.length > 0 ? ` | effects: ${effects.join(', ')}` : '';
  return (
    `${index + 1}. "${clip.title}" (${clip.kind}) ` +
    `[${clip.trimStart.toFixed(2)}s – ${trimEnd.toFixed(2)}s]${effectStr}`
  );
}

function getEnvironmentInfo(): string[] {
  const lines: string[] = [];
  lines.push(`- User Agent: ${navigator.userAgent}`);
  lines.push(`- CrossOriginIsolated: ${window.crossOriginIsolated}`);
  lines.push(`- Hardware concurrency: ${navigator.hardwareConcurrency ?? 'unknown'}`);
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string };
  };
  if (nav.deviceMemory) {
    lines.push(`- Device memory: ~${nav.deviceMemory} GB`);
  }
  lines.push(
    `- Screen: ${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
  );
  if (nav.userAgentData?.platform) {
    lines.push(`- Platform: ${nav.userAgentData.platform}`);
  }
  return lines;
}

/** Produce a rich markdown debug report for bug reports and clipboard export. */
export function generateDebugReport(ctx: DebugReportContext): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push('# clip_stacker Debug Report');
  lines.push('');
  lines.push(`**Generated:** ${now}`);
  lines.push('');

  lines.push('## Environment');
  lines.push(...getEnvironmentInfo().map((l) => l.replace(/^- /, '- ')));
  lines.push('');

  lines.push('## Status');
  lines.push(ctx.status || '(empty)');
  lines.push('');

  if (ctx.renderPlan) {
    lines.push('## Render Plan');
    lines.push(`- **Path:** ${ctx.renderPlan.path}`);
    lines.push(`- **Description:** ${ctx.renderPlan.description}`);
    lines.push(`- **Reason:** ${ctx.renderPlan.reason}`);
    lines.push(`- **Will re-encode:** ${ctx.renderPlan.willReencode}`);
    lines.push('');
  }

  lines.push('## Export Settings');
  lines.push(`- Resolution: ${ctx.exportSettings.outputResolution}`);
  lines.push(`- Preset: ${ctx.exportSettings.resolutionPreset}`);
  lines.push(`- Quality: ${ctx.exportSettings.quality}`);
  lines.push(`- Encoder path used: ${ctx.encoderPath || 'n/a'}`);
  lines.push('');

  const timelineClips = ctx.clips.filter((c) => {
    if (!c.groupId) return true;
    const group = ctx.clipGroups.find((g) => g.id === c.groupId);
    return group ? c.groupVariant === group.activeVariant : true;
  });

  lines.push(`## Clips (${timelineClips.length} on timeline)`);
  if (timelineClips.length === 0) {
    lines.push('(none)');
  } else {
    timelineClips.forEach((clip, i) => lines.push(formatClipSummary(clip, i)));
  }
  lines.push('');

  if (ctx.transitions.length > 0) {
    lines.push('## Transitions');
    ctx.transitions.forEach((t) => {
      lines.push(
        `- After clip ${t.afterClipIndex}: ${t.type} (${t.duration}s)`,
      );
    });
    lines.push('');
  }

  if (ctx.textOverlays.length > 0) {
    lines.push(`## Text Overlays (${ctx.textOverlays.length})`);
    ctx.textOverlays.forEach((o, i) => {
      lines.push(`- ${i + 1}. "${o.text}" @ ${o.startTime}s for ${o.duration}s`);
    });
    lines.push('');
  }

  const lastCommand = getLastFfmpegCommand();
  if (lastCommand) {
    lines.push('## Last FFmpeg Command');
    lines.push('```');
    lines.push('ffmpeg ' + lastCommand.join(' '));
    lines.push('```');
    lines.push('');
  }

  const filterComplex = getLastFfmpegFilterComplex();
  if (filterComplex) {
    lines.push('## filter_complex');
    lines.push('```');
    lines.push(filterComplex);
    lines.push('```');
    lines.push('');
  }

  if (ctx.error !== undefined) {
    lines.push('## Error');
    if (typeof ctx.error === 'string') {
      lines.push(ctx.error);
    } else if (ctx.error instanceof Error) {
      lines.push('```');
      lines.push(ctx.error.message);
      if (ctx.error.stack) {
        lines.push('');
        lines.push(ctx.error.stack);
      }
      lines.push('```');
    } else {
      lines.push(String(ctx.error));
    }
    lines.push('');
  }

  const lastErr = getLastFfmpegError();
  if (lastErr) {
    lines.push('## Last FFmpeg Error Log Line');
    lines.push('```');
    lines.push(lastErr);
    lines.push('```');
    lines.push('');
  }

  const logs = getLastFfmpegLogs(50);
  lines.push(`## FFmpeg Logs (last ${logs.length})`);
  if (logs.length === 0) {
    lines.push('(no logs captured in buffer)');
  } else {
    lines.push('```');
    lines.push(...logs);
    lines.push('```');
  }
  lines.push('');

  lines.push('## FFmpeg Environment Diagnostics');
  getFfmpegEnvironmentDiagnostics().forEach((d) => lines.push(`- ${d}`));

  return lines.join('\n');
}
