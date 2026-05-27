/**
 * Sanitize and validate export filenames.
 */

/**
 * Sanitize a filename by removing invalid characters and ensuring .mp4 extension.
 * @param filename - The filename to sanitize
 * @returns Sanitized filename with .mp4 extension
 */
export function sanitizeFilename(filename: string): string {
  // Remove any path separators and invalid filesystem characters
  let sanitized = filename
    .replace(/[/\\:*?"<>|]/g, '')
    .trim();

  // If empty after sanitization, use default
  if (!sanitized) {
    sanitized = 'stacked';
  }

  // Remove existing extension if present and ensure .mp4
  sanitized = sanitized.replace(/\.[^.]*$/, '');

  // Truncate to reasonable length (255 is filesystem limit, leave room for extension)
  if (sanitized.length > 250) {
    sanitized = sanitized.substring(0, 250);
  }

  return `${sanitized}.mp4`;
}
