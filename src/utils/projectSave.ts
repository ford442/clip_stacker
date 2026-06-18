import type { Clip, ClipTransition, TextOverlay } from '../types';

export interface ProjectSaveSummary {
  clipCount: number;
  textOverlayCount: number;
  transitionCount: number;
  isEmpty: boolean;
}

export function summarizeProjectForSave(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
): ProjectSaveSummary {
  const clipCount = clips.length;
  const textOverlayCount = textOverlays.length;
  const transitionCount = transitions.length;
  return {
    clipCount,
    textOverlayCount,
    transitionCount,
    isEmpty: clipCount === 0 && textOverlayCount === 0,
  };
}

export const EMPTY_PROJECT_SAVE_MESSAGE =
  'Save cancelled — the project is empty. Add clips or text overlays before saving.';

export function describeProjectSaveExportStatus(summary: ProjectSaveSummary): string {
  if (summary.clipCount > 0) {
    return 'Exporting project JSON with embedded source media...';
  }
  return 'Exporting project JSON...';
}

export function describeProjectSaveSuccessMessage(summary: ProjectSaveSummary): string {
  const parts: string[] = [];

  if (summary.clipCount > 0) {
    parts.push(
      `${summary.clipCount} clip${summary.clipCount === 1 ? '' : 's'}`,
    );
  }
  if (summary.textOverlayCount > 0) {
    parts.push(
      `${summary.textOverlayCount} text overlay${summary.textOverlayCount === 1 ? '' : 's'}`,
    );
  }

  if (summary.clipCount > 0) {
    const detail = parts.join(' and ');
    return `Project JSON exported (${detail}) with embedded source media.`;
  }

  if (summary.textOverlayCount > 0) {
    return `Project JSON exported (${parts.join(' and ')}) — no source media to embed.`;
  }

  return 'Project JSON exported.';
}

export function describeRemoteSaveStartStatus(summary: ProjectSaveSummary): string {
  if (summary.clipCount > 0) {
    return `Uploading clip 1/${summary.clipCount}...`;
  }
  return 'Saving project manifest to remote storage...';
}

export function describeRemoteSaveSuccessMessage(
  projectName: string,
  summary: ProjectSaveSummary,
): string {
  if (summary.clipCount === 0 && summary.textOverlayCount > 0) {
    return `Remote save complete (${projectName}) — text overlays only, no source media uploaded.`;
  }
  if (summary.clipCount > 0) {
    return `Remote save complete (${projectName}) — ${summary.clipCount} clip${summary.clipCount === 1 ? '' : 's'} uploaded.`;
  }
  return `Remote save complete (${projectName}).`;
}
