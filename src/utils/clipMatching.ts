/**
 * Clip matching — detect when a newly uploaded file is an edited version
 * of an existing clip so the two can be grouped for A/B comparison.
 */

/** Suffixes that indicate an edited / alternative version of a file. */
const EDITED_SUFFIXES = [
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
 * Strip the file extension and any common "edited version" suffixes from a
 * filename to obtain a normalised base name.
 *
 * Example: "myvideo_edited.mp4" → "myvideo"
 */
export function normaliseBaseName(filename: string): string {
  // Remove extension
  const withoutExt = filename.replace(/\.[^.]+$/, '');

  // Remove known suffixes (case-insensitive, longest match first)
  const sorted = [...EDITED_SUFFIXES].sort((a, b) => b.length - a.length);
  let base = withoutExt;
  for (const suffix of sorted) {
    const lower = base.toLowerCase();
    const sfxLower = suffix.toLowerCase();
    // Case-insensitive match: compare lowercase versions, then slice using
    // the original suffix length (equal to the matched region's length).
    if (lower.endsWith(sfxLower)) {
      base = base.slice(0, base.length - suffix.length);
      break; // remove at most one suffix
    }
  }

  return base.trim();
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
  const newBase = normaliseBaseName(newName);
  for (let i = 0; i < existingNames.length; i++) {
    const existingBase = normaliseBaseName(existingNames[i]);
    if (existingBase === newBase && existingNames[i] !== newName) {
      return i;
    }
  }
  return -1;
}
