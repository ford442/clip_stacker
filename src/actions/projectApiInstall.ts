/**
 * Installs `window.clipStacker.project` at startup without loading it: the
 * implementation (`projectApi.ts`: the interchange formats, the XML and zip
 * libraries, the op machinery) is a separate chunk that the first call
 * loads. So every method returns a Promise; `version` is there at once
 * (`clipStacker.api.version` too), which is what a script waits for.
 */

import type { ProjectApi } from './projectApi';

/** API surface version; must equal `PROJECT_API_VERSION` (a test checks). */
export const PROJECT_API_VERSION_AT_INSTALL = 1;

type Promised<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : T[K] };

/** `window.clipStacker.project`: every `ProjectApi` method, async. */
export type LazyProjectApi = Promised<Omit<ProjectApi, 'version'>> & { version: number };

const METHODS = [
  'schema',
  'agentBrief',
  'getState',
  'validate',
  'apply',
  'importTimeline',
  'exportTimeline',
  'exportStems',
  'relink',
  'render',
  'undo',
  'redo',
] as const satisfies ReadonlyArray<Exclude<keyof ProjectApi, 'version'>>;

let loaded: Promise<ProjectApi> | null = null;
const load = (): Promise<ProjectApi> => (loaded ??= import('./projectApi').then((m) => m.createProjectApi()));

export function createLazyProjectApi(): LazyProjectApi {
  const api: Record<string, unknown> = { version: PROJECT_API_VERSION_AT_INSTALL };
  for (const name of METHODS) {
    api[name] = async (...args: unknown[]) => {
      const impl = await load();
      return (impl[name] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return api as LazyProjectApi;
}

declare global {
  interface ClipStackerGlobal {
    project?: LazyProjectApi;
    api?: { version: number };
  }
}

/** Install `window.clipStacker.project` and `clipStacker.api`. Returns an uninstall. */
export function installProjectApi(target: Window = window): () => void {
  const api = createLazyProjectApi();
  target.clipStacker = { ...(target.clipStacker ?? {}), project: api, api: { version: PROJECT_API_VERSION_AT_INSTALL } };
  return () => {
    if (target.clipStacker?.project === api) {
      delete target.clipStacker.project;
      delete target.clipStacker.api;
    }
  };
}
