/**
 * Audio-reactive frequency analysis helpers for canvas rendering.
 */

/**
 * Bass energy 0..1 from AnalyserNode byte frequency data (legacy path).
 * Prefer {@link bassLevelFromWasmBands} when WASM analysis is available.
 */
export function bassLevelFromAnalyserBytes(freqData: Uint8Array): number {
  if (freqData.length === 0) return 0;
  const bassEnd = Math.max(1, Math.floor(freqData.length / 4));
  let sum = 0;
  for (let i = 0; i < bassEnd; i++) sum += freqData[i]!;
  return sum / bassEnd / 255;
}

/** Bass energy from WASM 8-band output (bands 0–1) or pre-aggregated bass. */
export function bassLevelFromWasmBands(bands: ArrayLike<number>, bass?: number): number {
  if (typeof bass === 'number' && Number.isFinite(bass)) return Math.max(0, Math.min(1, bass));
  if (bands.length === 0) return 0;
  const b0 = bands[0] ?? 0;
  const b1 = bands[1] ?? b0;
  return Math.max(0, Math.min(1, (b0 + b1) / 2));
}
