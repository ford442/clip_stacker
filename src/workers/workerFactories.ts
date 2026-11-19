/**
 * Every `new Worker` in the app. Vite bundles a worker only when it sees the
 * literal `new Worker(new URL('…', import.meta.url), …)`, so each one is
 * spelled out here and clients import the factory (`createWorkerClient`
 * takes it as a callback). ESLint forbids `new Worker` outside `src/workers/`.
 */

export function createAudioRenderWorker(): Worker {
  return new Worker(new URL('../audio/audioRender.worker.ts', import.meta.url), { type: 'module' });
}

export function createTimeStretchWorker(): Worker {
  return new Worker(new URL('../audio/timeStretch.worker.ts', import.meta.url), { type: 'module' });
}

export function createAudioAnalysisWorker(): Worker {
  return new Worker(new URL('../wasm/audioAnalysisWorker.ts', import.meta.url), { type: 'module' });
}

export function createGpuChoresWorker(): Worker {
  return new Worker(new URL('../gpu-chores/worker/gpuChores.worker.ts', import.meta.url), { type: 'module' });
}

export function createPreviewWorker(): Worker {
  return new Worker(new URL('../webgpu/preview.worker.ts', import.meta.url), { type: 'module' });
}

export function createWhisperWorker(): Worker {
  return new Worker(new URL('../wasm/whisperWorker.ts', import.meta.url), { type: 'module' });
}

export function createFfmpegWorker(): Worker {
  return new Worker(new URL('../ffmpeg/ffmpeg.worker.ts', import.meta.url), { type: 'module' });
}
