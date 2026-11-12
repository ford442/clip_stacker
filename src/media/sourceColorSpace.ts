/**
 * What colour space a clip's source is, as read from the file or overridden
 * by the user (`Clip.colorSpaceOverride`). Pure.
 *
 * The override replaces the file's tags in the `VideoDecoderConfig`
 * (`colorSpace` there wins over in-band VUI, per the WebCodecs spec), so
 * every decoded `VideoFrame` — preview worker and GPU export — carries it,
 * and `importExternalTexture` converts from it. Use it for a file that is
 * mistagged or untagged (an HLG phone clip saved without VUI, a P3 screen
 * recording tagged Rec.709). The `<video>` fallback path cannot be
 * overridden and keeps the file's own tags.
 */

import type { SourceColorSpaceOverride } from '../types';
import type { OutputVideoColorSpace } from '../finishing/colorManagement';

/** Tag fields as strings: the DOM lib's enums predate bt2020 / pq / hlg / smpte432. */
type ColorTags = OutputVideoColorSpace;

interface OverrideDef {
  id: SourceColorSpaceOverride;
  label: string;
  colorSpace: Readonly<ColorTags>;
}

/** The picker order of the Inspector's "Interpret as" select. */
export const SOURCE_COLOR_SPACE_OVERRIDES: readonly OverrideDef[] = [
  {
    id: 'rec709',
    label: 'Rec.709',
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
  },
  {
    id: 'srgb',
    label: 'sRGB',
    colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false },
  },
  {
    id: 'display-p3',
    label: 'Display P3',
    colorSpace: { primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false },
  },
  {
    id: 'rec2020-pq',
    label: 'Rec.2020 PQ',
    colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
  },
  {
    id: 'rec2020-hlg',
    label: 'Rec.2020 HLG',
    colorSpace: { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false },
  },
];

export function isSourceColorSpaceOverride(value: unknown): value is SourceColorSpaceOverride {
  return SOURCE_COLOR_SPACE_OVERRIDES.some((def) => def.id === value);
}

/** The complete decoder `colorSpace` for an override. */
export function colorSpaceForOverride(id: SourceColorSpaceOverride): VideoColorSpaceInit {
  const def = SOURCE_COLOR_SPACE_OVERRIDES.find((candidate) => candidate.id === id);
  return { ...(def ?? SOURCE_COLOR_SPACE_OVERRIDES[0]!).colorSpace } as VideoColorSpaceInit;
}

const PRIMARIES_LABEL: Record<string, string> = {
  bt709: 'Rec.709',
  bt2020: 'Rec.2020',
  smpte432: 'Display P3',
  smpte170m: 'Rec.601',
  bt470bg: 'Rec.601 (PAL)',
};

const TRANSFER_LABEL: Record<string, string> = {
  pq: 'PQ',
  hlg: 'HLG',
  'iec61966-2-1': 'sRGB',
  linear: 'linear',
};

/**
 * "Rec.2020 PQ", "Display P3", "Rec.709", "sRGB"… for decoder tags; "untagged"
 * when the file says nothing (decoded and shown as Rec.709).
 */
export function describeVideoColorSpace(colorSpace: VideoColorSpaceInit | null | undefined): string {
  if (!colorSpace || (colorSpace.primaries == null && colorSpace.transfer == null)) {
    return 'untagged (shown as Rec.709)';
  }
  const primariesTag = (colorSpace.primaries as string | null | undefined) ?? 'bt709';
  const transferTag = (colorSpace.transfer as string | null | undefined) ?? 'bt709';
  for (const def of SOURCE_COLOR_SPACE_OVERRIDES) {
    if (def.colorSpace.primaries === primariesTag && def.colorSpace.transfer === transferTag) {
      return def.label;
    }
  }
  const primaries = PRIMARIES_LABEL[primariesTag] ?? primariesTag;
  const transfer = TRANSFER_LABEL[transferTag];
  return transfer ? `${primaries} ${transfer}` : primaries;
}

/**
 * The Inspector's one line: "Source: Rec.2020 PQ (from file)", or
 * "Source: Display P3 (override; file: Rec.709)".
 */
export function sourceColorSpaceLine(
  fromFile: VideoColorSpaceInit | null | undefined,
  override: SourceColorSpaceOverride | undefined,
): string {
  const file = describeVideoColorSpace(fromFile);
  if (!override) return `Source: ${file} (from file)`;
  return `Source: ${describeVideoColorSpace(colorSpaceForOverride(override))} (override; file: ${file})`;
}
