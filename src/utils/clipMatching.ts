/**
 * Clip matching — detect when a newly uploaded file is an edited version
 * of an existing clip so the two can be grouped for A/B comparison.
 */

/** Suffixes stripped when comparing base names. */
const NORMALIZE_SUFFIXES = [
  '_edited',
  '_edit',
  '_final',
  '_v1', '_v2', '_v3', '_v4', '_v5',
  '_cut',
  '_trim',
  '_processed',
  '_export',
  '_output',
  '_render',
  ' copy',
  ' - copy',
  ' - Copy',
  '(1)', '(2)', '(3)',
];

/**
 * Suffixes that indicate an intentional alternate edit — only these trigger
 * automatic A/B grouping. Generic duplicates like "video (1).mp4" or
 * "video copy.mp4" are left as separate sequential clips.
 */
const AUTO_GROUP_SUFFIXES = [
  '_edited',
  '_edit',
  '_final',
  '_v1', '_v2', '_v3', '_v4', '_v5',
  '_cut',
  '_trim',
  '_processed',
  '_export',
  '_output',
  '_render',
];

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function endsWithSuffix(filename: string, suffix: string): boolean {
  return filename.toLowerCase().endsWith(suffix.toLowerCase());
}

/**
 * Strip the file extension and any common "edited version" suffixes from a
 * filename to obtain a normalised base name.
 *
 * Example: "myvideo_edited.mp4" → "myvideo"
 */
export function normaliseBaseName(filename: string): string {
  let base = stripExtension(filename);

  const sorted = [...NORMALIZE_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suffix of sorted) {
    if (endsWithSuffix(base, suffix)) {
      base = base.slice(0, base.length - suffix.length);
      break;
    }
  }

  return base.trim();
}

/** True when the filename ends with a suffix that should auto-create an A/B group. */
export function hasAutoGroupSuffix(filename: string): boolean {
  const withoutExt = stripExtension(filename);
  return AUTO_GROUP_SUFFIXES.some((suffix) => endsWithSuffix(withoutExt, suffix));
}

/**
 * Determine whether `candidateName` is a likely edited version of `existingName`.
 *
 * Returns true when the normalised base names are equal AND the raw filenames
 * are different (so we don't match a file to itself).
 */
export function isEditedVersion(existingName: string, candidateName: string): boolean {
  if (existingName === candidateName) return false;
  return normaliseBaseName(existingName) === normaliseBaseName(candidateName);
}

/**
 * Given a list of existing clip file names and a new file name, find the index
 * of the first existing clip that the new file appears to be an edited version of.
 *
 * Returns -1 if no match is found.
 */
export function findMatchingClipIndex(existingNames: string[], newName: string): number {
  if (!hasAutoGroupSuffix(newName)) return -1;

  for (let i = 0; i < existingNames.length; i++) {
    if (isEditedVersion(existingNames[i], newName)) {
      return i;
    }
  }
  return -1;
}
