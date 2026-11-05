/**
 * Where an export reads the project's live audio state when the caller does
 * not pass it: the lanes / master bus and the export settings' master
 * limiter. The stores register these (`editorStore`, `settingsStore`)
 * when they are created, so this layer never imports a store; until then the
 * defaults describe an empty project.
 */

import type { Track } from '../types';
import type { MasterBusSettings } from '../audio/audioBus';
import type { MasterLimiterSettings } from '../audio/audioEffects';

export interface ExportStateSource {
  /** The editor's current lanes and master bus. */
  audioBus(): { tracks: Track[]; masterBus?: MasterBusSettings };
  /** `ExportSettings.masterLimiter`, as stored (normalized by the caller). */
  masterLimiter(): MasterLimiterSettings | undefined;
}

const source: ExportStateSource = {
  audioBus: () => ({ tracks: [] }),
  masterLimiter: () => undefined,
};

export function registerExportStateSource(next: Partial<ExportStateSource>): void {
  Object.assign(source, next);
}

export function exportStateSource(): Readonly<ExportStateSource> {
  return source;
}
