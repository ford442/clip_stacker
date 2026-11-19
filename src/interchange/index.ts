/**
 * Timeline interchange: OpenTimelineIO, FCPXML 1.11 and CMX 3600 EDL.
 *
 * Pure (no React, no store): a saved project (`Project`) goes out as text and
 * text comes back as a `Project` plus the media each clip needs, which the
 * app relinks (`relink.ts`) and loads through its normal load path. See
 * `mapping.ts` for what maps to what, and `docs/interchange.md`.
 */

import type { Project } from '../types';
import { readEdl, writeEdl, type ReadEdlOptions } from './edl';
import { writeFcpxml } from './fcpxml';
import { readFcpxml } from './fcpxmlRead';
import { fromInterchange, type FromInterchangeResult } from './fromInterchange';
import type { InterchangeFormat } from './mapping';
import { readOtio, writeOtio } from './otio';
import { toInterchange, type ToInterchangeOptions } from './toInterchange';

export type { InterchangeFormat } from './mapping';
export type { MediaFacts, ToInterchangeOptions } from './toInterchange';
export type { MediaReference } from './model';

export { INTERCHANGE_FILE_TYPES, INTERCHANGE_FORMATS, isInterchangeFormat } from './formats';

/** The format of a timeline file, from its name and then its content; null when it is none of them. */
export function detectInterchangeFormat(text: string, fileName = ''): InterchangeFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'otio') return 'otio';
  if (ext === 'fcpxml' || ext === 'fcpxmld') return 'fcpxml';
  if (ext === 'edl') return 'edl';
  const head = text.slice(0, 2048).trimStart();
  if (head.startsWith('{') && head.includes('"OTIO_SCHEMA"')) return 'otio';
  if (head.startsWith('<') && /<fcpxml[\s>]/.test(head)) return 'fcpxml';
  if (/^TITLE:/im.test(head) || /^\d{3,}\s+\S+\s+\S+\s+[CDW]/m.test(head)) return 'edl';
  return null;
}

/** A saved project as timeline text. */
export function exportTimeline(project: Project, format: InterchangeFormat, options: ToInterchangeOptions = {}): string {
  const timeline = toInterchange(project, options);
  switch (format) {
    case 'otio':
      return writeOtio(timeline);
    case 'fcpxml':
      return writeFcpxml(timeline);
    case 'edl':
      return writeEdl(timeline);
  }
}

export interface ImportTimelineOptions extends ReadEdlOptions {
  format?: InterchangeFormat;
  fileName?: string;
}

export interface ParsedTimeline extends FromInterchangeResult {
  format: InterchangeFormat;
  name: string;
}

/** Timeline text as a saved project, plus the media its clips need. Throws on an unreadable file. */
export function importTimeline(text: string, options: ImportTimelineOptions = {}): ParsedTimeline {
  const format = options.format ?? detectInterchangeFormat(text, options.fileName);
  if (!format) throw new Error('Not a timeline file this app reads (OTIO, FCPXML or CMX 3600 EDL).');
  const timeline = format === 'otio' ? readOtio(text) : format === 'fcpxml' ? readFcpxml(text) : readEdl(text, options);
  return { ...fromInterchange(timeline), format, name: timeline.name };
}
