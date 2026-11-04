/**
 * Built-in demo media so a new user (or a tester) can try trimming, splitting,
 * transitions and export without their own files. Two short generated clips
 * (test pattern + tone, 640x360 H.264/AAC) live in `public/demo/` and are
 * imported through the normal add-clips path, so they behave like any upload.
 */

export interface DemoClipSpec {
  /** File name the clip is imported under (becomes the clip title). */
  fileName: string;
  /** Path under the app base, e.g. `demo/demo-clip-a.mp4`. */
  path: string;
}

export const DEMO_CLIPS: readonly DemoClipSpec[] = [
  { fileName: 'demo-a (test pattern, 440 Hz).mp4', path: 'demo/demo-clip-a.mp4' },
  { fileName: 'demo-b (colour bars, pulsing 660 Hz).mp4', path: 'demo/demo-clip-b.mp4' },
];

function appBaseUrl(): string {
  if (typeof document !== 'undefined') return document.baseURI;
  if (typeof window !== 'undefined') return window.location.href;
  return 'http://localhost/';
}

/** Resolve a `public/` path against the page, so a sub-path deploy works. */
export function demoClipUrl(path: string, base: string = appBaseUrl()): string {
  return new URL(path, base).href;
}

/** Fetch the demo clips as `File`s. Throws if any request fails. */
export async function fetchDemoClips(
  fetchImpl: typeof fetch = fetch,
  specs: readonly DemoClipSpec[] = DEMO_CLIPS,
): Promise<File[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const response = await fetchImpl(demoClipUrl(spec.path));
      if (!response.ok) {
        throw new Error(`Could not load ${spec.path} (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      return new File([blob], spec.fileName, { type: 'video/mp4' });
    }),
  );
}
