/**
 * `window.clipStacker.project`: the supported, versioned scripting surface
 * (`clipStacker.api.version`), shared by tools in the page, the `?test_harness`
 * API, the `cs` CLI and the MCP server (`scripts/cs/`, through Playwright).
 *
 *   project.getState()                      // the saved project JSON
 *   project.apply(ops, { mediaRoot })       // ProjectOp[]: one undo step, all or nothing
 *   project.validate(ops) / project.schema()
 *   project.importTimeline(text, { format, mediaRoot, files })
 *   project.exportTimeline('otio' | 'fcpxml' | 'edl')
 *   project.exportStems({ normalize, format, trackIds })
 *   project.render({ outputResolution, … })
 *   project.undo() / project.redo() / project.relink({ files })
 *
 * Same-page only, like `finishing.*`: there is no cross-origin `postMessage`
 * listener, so only code already running in the page can drive it. Format
 * and op reference: `docs/project-api.md`, `docs/project-ops.schema.json`.
 */

import type { ExportSettings, Project, RenderPlan } from '../types';
import { editorStore } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { renderJobStore } from '../store/renderJobStore';
import type { InterchangeFormat } from '../interchange';
import { isInterchangeFormat } from '../interchange';
import type { StemExportOptions } from '../export/exportStems';
import {
  currentProject,
  exportCurrentTimeline,
  exportStemsFromEditor,
  importTimelineIntoEditor,
  relinkOfflineClips,
  type ImportReport,
  type ImportTimelineRequest,
  type RelinkReport,
  type StemsDownload,
} from './interchangeActions';
import { applyProjectOps, type ApplyResult } from './projectOps/apply';
import { PROJECT_API_VERSION, projectOpsJsonSchema, validateProjectOps, type ValidateOpsResult } from './projectOps/schema';
import { PROJECT_OPS } from './projectOps/spec';
import { renderBinding } from './renderBinding';

export interface RenderReport {
  ok: boolean;
  /** The rendered file (an object URL in this page), when `ok`. */
  url: string | null;
  fileName: string;
  status: string;
  encoderPath: string;
  plan: RenderPlan | null;
}

export interface ProjectApi {
  version: number;
  schema: () => Record<string, unknown>;
  agentBrief: () => string;
  getState: () => Project;
  validate: (ops: unknown) => ValidateOpsResult;
  apply: (ops: unknown, options?: { mediaRoot?: string }) => Promise<ApplyResult>;
  importTimeline: (text: string, options?: Omit<ImportTimelineRequest, 'text'>) => Promise<ImportReport>;
  exportTimeline: (format: InterchangeFormat, options?: { mediaRoot?: string }) => string;
  exportStems: (options?: Omit<StemExportOptions, 'onProgress' | 'cache'>) => Promise<StemsDownload>;
  relink: (input: { files?: File[] }) => Promise<RelinkReport>;
  render: (settings?: Partial<ExportSettings>) => Promise<RenderReport>;
  undo: () => void;
  redo: () => void;
}

/** What an agent needs to start: the surface, an example, the op list. */
export function projectApiAgentBrief(): string {
  const ops = Object.entries(PROJECT_OPS)
    .map(([name, spec]) => `- ${name}: ${spec.description}`)
    .join('\n');
  return [
    `Clip Stacker project API v${PROJECT_API_VERSION} (window.clipStacker.project).`,
    'Read the project with getState() (the saved project JSON: clips, tracks, transitions, …).',
    'Edit it with apply(ops): an array of ops, applied in order as one undo step; if any op is refused nothing changes and the result names it.',
    'Times are seconds: startTime / time on the output timeline, trimStart / trimEnd in the clip source. Lane ids are tracks[].id; clip ids are clips[].id.',
    'Example: apply([{ "op": "trim", "clipId": "<id>", "trimStart": 1, "trimEnd": 4 }, { "op": "setTransition", "afterClipIndex": 1, "type": "dissolve", "duration": 1 }])',
    'Interchange: exportTimeline("otio" | "fcpxml" | "edl"), importTimeline(text, { mediaRoot }). Stems: exportStems({ normalize }). Render: render({ outputResolution: "1920x1080" }).',
    '',
    'Ops:',
    ops,
    '',
    'JSON Schema: schema() (also docs/project-ops.schema.json).',
  ].join('\n');
}

async function render(settings?: Partial<ExportSettings>): Promise<RenderReport> {
  if (!renderBinding.performRender) throw new Error('The app has not finished loading (no Render action yet).');
  const store = settingsStore.getState();
  if (settings && Object.keys(settings).length > 0) {
    const next: ExportSettings = { ...store.exportSettings, ...settings };
    // An explicit size replaces the preset that would otherwise win.
    if (settings.outputResolution && !settings.resolutionPreset) delete next.resolutionPreset;
    store.setExportSettings(next);
  }
  await renderBinding.performRender();
  const job = renderJobStore.getState();
  const extension = settingsStore.getState().exportSettings.outputFormat === 'prores' ? 'mov' : 'mp4';
  return {
    ok: Boolean(job.outputUrl),
    url: job.outputUrl,
    fileName: `${settingsStore.getState().exportSettings.filename || 'stacked'}.${extension}`,
    status: job.status,
    encoderPath: job.encoderPath,
    plan: job.renderPlan,
  };
}

export function createProjectApi(): ProjectApi {
  return {
    version: PROJECT_API_VERSION,
    schema: projectOpsJsonSchema,
    agentBrief: projectApiAgentBrief,
    getState: currentProject,
    validate: validateProjectOps,
    apply: (ops, options) => applyProjectOps(ops, options),
    importTimeline: (text, options = {}) => importTimelineIntoEditor({ ...options, text }),
    exportTimeline: (format, options) => {
      if (!isInterchangeFormat(format)) throw new Error(`format must be otio, fcpxml or edl (got ${String(format)})`);
      return exportCurrentTimeline(format, options).text;
    },
    exportStems: (options) => exportStemsFromEditor(options),
    relink: (input) => relinkOfflineClips(input),
    render,
    undo: () => editorStore.getState().undo(),
    redo: () => editorStore.getState().redo(),
  };
}

declare global {
  interface ClipStackerGlobal {
    project?: ProjectApi;
    api?: { version: number };
  }
}

/** Install `window.clipStacker.project` and `clipStacker.api`. Returns an uninstall. */
export function installProjectApi(target: Window = window): () => void {
  const api = createProjectApi();
  target.clipStacker = { ...(target.clipStacker ?? {}), project: api, api: { version: PROJECT_API_VERSION } };
  return () => {
    if (target.clipStacker?.project === api) {
      delete target.clipStacker.project;
      delete target.clipStacker.api;
    }
  };
}
