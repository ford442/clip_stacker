/**
 * AudioWorklet registration for pitch-preserving time stretch.
 * Offline remapping (schedule / export) uses the same WSOLA WASM via
 * `remapClipAudioBuffer`; this worklet covers live constant-rate stretch
 * when a node graph needs real-time tempo without baking a buffer.
 */

const WORKLET_URL = new URL('../../public/worklets/time-stretch-processor.js', import.meta.url);

let registeredContexts = new WeakSet<BaseAudioContext>();

export async function ensureTimeStretchWorklet(
  ctx: BaseAudioContext,
): Promise<boolean> {
  if (typeof AudioWorkletNode === 'undefined') return false;
  if (!(ctx instanceof AudioContext) && !(ctx as AudioContext).audioWorklet) {
    return false;
  }
  const audioCtx = ctx as AudioContext;
  if (!audioCtx.audioWorklet) return false;
  if (registeredContexts.has(audioCtx)) return true;
  try {
    // Prefer public path in the browser; fall back to import.meta URL for tests.
    const url =
      typeof document !== 'undefined'
        ? new URL('worklets/time-stretch-processor.js', document.baseURI).href
        : WORKLET_URL.href;
    await audioCtx.audioWorklet.addModule(url);
    registeredContexts.add(audioCtx);
    return true;
  } catch (err) {
    console.warn('[timeStretchWorklet] register failed:', err);
    return false;
  }
}

/**
 * Create a worklet node that applies a constant tempo ratio (1 = passthrough).
 * Returns null when AudioWorklet is unavailable.
 */
export async function createTimeStretchNode(
  ctx: AudioContext,
  tempo = 1,
): Promise<AudioWorkletNode | null> {
  const ok = await ensureTimeStretchWorklet(ctx);
  if (!ok) return null;
  try {
    const node = new AudioWorkletNode(ctx, 'time-stretch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { tempo },
    });
    const params = node.parameters as unknown as Map<string, AudioParam>;
    const rateParam = params.get('tempo');
    if (rateParam) rateParam.value = tempo;
    return node;
  } catch {
    return null;
  }
}
