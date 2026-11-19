/** The interchange formats and their file types: light, for menus (`index.ts` loads the codecs). */

import type { InterchangeFormat } from './mapping';

export const INTERCHANGE_FORMATS: readonly InterchangeFormat[] = ['otio', 'fcpxml', 'edl'];

/** File extension and MIME type each format is saved with. */
export const INTERCHANGE_FILE_TYPES: Readonly<Record<InterchangeFormat, { extension: string; mime: string; label: string }>> = {
  otio: { extension: '.otio', mime: 'application/json', label: 'OpenTimelineIO' },
  fcpxml: { extension: '.fcpxml', mime: 'application/xml', label: 'FCPXML 1.11' },
  edl: { extension: '.edl', mime: 'text/plain', label: 'CMX 3600 EDL' },
};

export function isInterchangeFormat(value: unknown): value is InterchangeFormat {
  return value === 'otio' || value === 'fcpxml' || value === 'edl';
}
