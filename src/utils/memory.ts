import type { Clip } from '../types';

/**
 * Default memory usage threshold for warning the user.
 * Set to 2 GB, a conservative limit for browser-based video editing.
 */
export const DEFAULT_MEMORY_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Get the current memory usage from the browser's performance API if available.
 * (Chrome/Edge only; returns null on other browsers)
 */
export function getCurrentMemoryUsage(): number | null {
  if (typeof performance !== 'undefined' && 'memory' in performance) {
    const memory = (performance as any).memory;
    if (memory && typeof memory.usedJSHeapSize === 'number') {
      return memory.usedJSHeapSize;
    }
  }
  return null;
}

/**
 * Get the memory limit from the browser's performance API if available.
 * (Chrome/Edge only; returns null on other browsers)
 */
export function getMemoryLimit(): number | null {
  if (typeof performance !== 'undefined' && 'memory' in performance) {
    const memory = (performance as any).memory;
    if (memory && typeof memory.jsHeapSizeLimit === 'number') {
      return memory.jsHeapSizeLimit;
    }
  }
  return null;
}

/**
 * Format bytes into a human-readable string (e.g., "123 MB", "1.5 GB")
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

/**
 * Calculate the total size of all source media files in bytes.
 * This is a rough estimate based on file.size (which is available before upload).
 */
export function calculateTotalSourceBytes(clips: Clip[]): number {
  return clips.reduce((sum, clip) => sum + clip.file.size, 0);
}

/**
 * Estimate the projected memory usage for a render operation.
 * The estimate includes:
 * - Total source media bytes (all clips loaded into FFmpeg WASM VFS)
 * - Estimated intermediate files (typically 1-2x the total source size during encoding)
 * - Output file estimate (depends on codec/bitrate but typically significant)
 *
 * This is a conservative estimate. Actual usage may vary based on FFmpeg internals,
 * encoding settings, and browser overhead.
 */
export function estimateRenderMemoryUsage(clips: Clip[]): number {
  const sourceBytes = calculateTotalSourceBytes(clips);
  // Estimate 2x multiplier for intermediates during encoding (codec-dependent)
  const intermediateMultiplier = 2;
  // Total estimate: source + intermediates
  return sourceBytes * (1 + intermediateMultiplier);
}

/**
 * Check if estimated render memory usage will be high (> threshold).
 * Returns true if estimated usage exceeds the threshold.
 * Uses the default 2GB threshold unless a custom threshold is provided.
 */
export function isHighMemoryUsage(clips: Clip[], thresholdBytes = DEFAULT_MEMORY_THRESHOLD_BYTES): boolean {
  return estimateRenderMemoryUsage(clips) > thresholdBytes;
}

/**
 * Get a memory status string for display (for development/debugging).
 * Returns null if performance.memory API is not available.
 */
export function getMemoryStatus(): string | null {
  const used = getCurrentMemoryUsage();
  const limit = getMemoryLimit();
  if (used === null || limit === null) return null;

  const usedStr = formatBytes(used);
  const limitStr = formatBytes(limit);
  const percent = Math.round((used / limit) * 100);
  return `${usedStr} / ${limitStr} (${percent}%)`;
}
