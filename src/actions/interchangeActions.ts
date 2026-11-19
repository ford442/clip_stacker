/**
 * Timeline interchange, relinking and stems, bound to the stores. One
 * implementation behind the File menu, `window.clipStacker.project` and the
 * `?test_harness` API (and through it `cs` and the MCP server).
 *
 * - `exportCurrentTimeline(format)` — the open project as OTIO / FCPXML / EDL.
 * - `importTimelineIntoEditor(text, …)` — a timeline file becomes the project:
 *   each clip's media is found by name (the library, picked files, a media
 *   root URL), then content hash, then Drive id; whatever is not found loads
 *   offline. Replaces the project (like opening one); not an undo step.
 * - `relinkOfflineClips(files)` — swap media into offline clips, one undo step.
 * - `exportStemsFromEditor(options)` — BWF stems + timeline + manifest, zipped.
 */

import type { Clip, Project, SerializedClip } from '../types';
import { editorStore } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { renderJobStore } from '../store/renderJobStore';
import { driveLibraryStore } from '../store/driveLibraryStore';
import { selectTimelineClips } from '../store/selectors';
import { applyProjectData, serializeProject } from '../project';
import { selectProjectSnapshot } from '../project/snapshot';
import { fingerprintMedia } from '../project/mediaStore';
import { relinkClip } from '../project/offlineClips';
import { allSequenceClips } from '../timeline/sequenceModel';
import { getMediaInfo } from '../media/media';
import {
  INTERCHANGE_FILE_TYPES,
  exportTimeline,
  importTimeline,
  type InterchangeFormat,
  type MediaFacts,
  type MediaReference,
} from '../interchange';
import { baseName, needsHashes, planRelink, type RelinkCandidate, type RelinkMatch } from '../interchange/relink';
import type { TimecodeRateId } from '../types';
import { exportStems, type StemExportOptions, type StemsReport } from '../export/exportStems';

/** The open project as its saved JSON (what a save writes). */
export function currentProject(): Project {
  const settings = settingsStore.getState();
  return serializeProject(selectProjectSnapshot(editorStore.getState(), settings), {
    layoutReferenceResolution: settings.exportSettings.outputResolution,
  });
}

function projectName(): string {
  return settingsStore.getState().exportSettings.filename.trim() || 'Clip Stacker';
}

/** Hashes the session already knows (proxy records, offline records), by file name. */
function knownMediaFacts(): Record<string, MediaFacts> {
  const facts: Record<string, MediaFacts> = {};
  for (const clip of allSequenceClips(editorStore.getState())) {
    const name = clip.offline?.fileName ?? clip.file.name;
    const hash = clip.offline?.hash ?? clip.proxy?.hash;
    const driveId = clip.offline?.driveId;
    if (hash || driveId) facts[name] = { ...(hash ? { hash } : {}), ...(driveId ? { driveId } : {}) };
  }
  return facts;
}

export interface ExportedTimeline {
  text: string;
  fileName: string;
  mime: string;
}

/** The open project as timeline text, named after the export file name. */
export function exportCurrentTimeline(format: InterchangeFormat, options: { mediaRoot?: string } = {}): ExportedTimeline {
  const project = currentProject();
  const [width, height] = settingsStore.getState().exportSettings.outputResolution.split('x').map(Number);
  const media = knownMediaFacts();
  if (options.mediaRoot) {
    for (const clip of project.clips) {
      if (clip.source) continue;
      media[clip.fileName] = { ...(media[clip.fileName] ?? {}), url: new URL(encodeURIComponent(clip.fileName), options.mediaRoot).href };
    }
  }
  const text = exportTimeline(project, format, {
    name: projectName(),
    ...(width && width > 0 ? { width } : {}),
    ...(height && height > 0 ? { height } : {}),
    media,
  });
  const type = INTERCHANGE_FILE_TYPES[format];
  return { text, fileName: `${projectName()}${type.extension}`, mime: type.mime };
}

export interface ImportTimelineRequest {
  text: string;
  fileName?: string;
  format?: InterchangeFormat;
  /** Media files the user picked (a folder, several files). */
  files?: File[];
  /** Base URL media files are fetched from by name (same origin; the `cs` CLI serves one). */
  mediaRoot?: string;
  /** Timecode rate of an EDL that does not say. */
  rate?: TimecodeRateId;
}

export interface ImportReport {
  format: InterchangeFormat;
  name: string;
  clipCount: number;
  /** Clips that came in offline (file names). */
  offline: string[];
  /** How each found clip was matched. */
  relinked: Array<{ clipId: string; fileName: string; by: RelinkMatch['by']; source: RelinkCandidate['source'] }>;
  warnings: string[];
}

interface CandidateSource {
  candidate: RelinkCandidate;
  file?: File;
}

function libraryCandidates(): CandidateSource[] {
  const seen = new Set<File>();
  const out: CandidateSource[] = [];
  for (const clip of allSequenceClips(editorStore.getState())) {
    if (clip.offline || clip.source || !clip.file || seen.has(clip.file)) continue;
    seen.add(clip.file);
    out.push({ candidate: { key: `library:${clip.id}`, source: 'library', name: clip.file.name, ...(clip.proxy ? { hash: clip.proxy.hash } : {}) }, file: clip.file });
  }
  return out;
}

function fileCandidates(files: File[]): CandidateSource[] {
  return files.map((file, i) => ({ candidate: { key: `file:${i}`, source: 'file', name: baseName(file.webkitRelativePath || file.name) }, file }));
}

function driveCandidates(): CandidateSource[] {
  return driveLibraryStore.getState().items.map((item) => ({
    candidate: { key: `drive:${item.fileId}`, source: 'drive', name: item.name, driveId: item.fileId },
  }));
}

async function fetchFromRoot(mediaRoot: string, name: string): Promise<File | null> {
  try {
    const response = await fetch(new URL(encodeURIComponent(name), mediaRoot));
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type });
  } catch {
    return null;
  }
}

/** Fill in content hashes, only when an unmatched reference has one to match. */
async function hashCandidates(requests: Parameters<typeof needsHashes>[0], sources: CandidateSource[]): Promise<void> {
  if (!needsHashes(requests, sources.map((s) => s.candidate))) return;
  for (const source of sources) {
    if (source.file && !source.candidate.hash) source.candidate.hash = await fingerprintMedia(source.file);
  }
}

/** Resolve media references to files; what is left gets an offline record. */
async function resolveImportMedia(
  media: Map<string, MediaReference>,
  request: Pick<ImportTimelineRequest, 'files' | 'mediaRoot'>,
): Promise<{ files: Map<string, File>; matches: RelinkMatch[]; unresolved: string[] }> {
  const requests = [...media].map(([clipId, reference]) => ({ clipId, reference }));
  const sources = [...libraryCandidates(), ...fileCandidates(request.files ?? []), ...driveCandidates()];
  if (request.mediaRoot) {
    const names = [...new Set(requests.map((r) => baseName(r.reference.name)))];
    const fetched = await Promise.all(names.map((name) => fetchFromRoot(request.mediaRoot!, name)));
    fetched.forEach((file, i) => {
      if (file) sources.push({ candidate: { key: `root:${i}`, source: 'file', name: names[i]! }, file });
    });
  }
  await hashCandidates(requests, sources);
  const plan = planRelink(requests, sources.map((s) => s.candidate));
  const byKey = new Map(sources.map((s) => [s.candidate.key, s]));
  const files = new Map<string, File>();
  const matches: RelinkMatch[] = [];
  const unresolved = [...plan.unresolved];
  for (const match of plan.matches) {
    const file = byKey.get(match.candidate.key)?.file;
    if (file) {
      files.set(match.clipId, file);
      matches.push(match);
    } else {
      // A Drive match needs an interactive download: it stays offline with the id.
      media.set(match.clipId, { ...media.get(match.clipId)!, ...(match.candidate.driveId ? { driveId: match.candidate.driveId } : {}) });
      unresolved.push(match.clipId);
    }
  }
  return { files, matches, unresolved };
}

/** Load a saved project (an imported timeline's) into the stores, replacing the open one. */
async function loadProjectIntoEditor(project: Project, resolveMedia: (saved: SerializedClip) => File | null): Promise<ReturnType<typeof applyProjectData>> {
  const applied = await applyProjectData(project, [], { missingMedia: 'offline', resolveMedia });
  editorStore.getState().resetHistory({
    clips: applied.clips,
    tracks: applied.tracks,
    clipGroups: applied.clipGroups,
    sequences: applied.sequences,
    transitions: applied.transitions,
    textOverlays: applied.textOverlays,
    captions: applied.captions,
    captionStyle: applied.captionStyle,
    masterAudioMarkers: applied.masterAudioMarkers,
    selectedClipId: null,
    masterAudio: applied.masterAudio,
    ...(applied.masterBus ? { masterBus: applied.masterBus } : {}),
  });
  const settings = settingsStore.getState();
  settings.setFinishing(applied.finishing);
  settings.setColorManagement(applied.colorManagement);
  settings.setTimecode(applied.timecode);
  return applied;
}

/** Import a timeline file as the project (see the module comment). */
export async function importTimelineIntoEditor(request: ImportTimelineRequest): Promise<ImportReport> {
  const parsed = importTimeline(request.text, {
    ...(request.format ? { format: request.format } : {}),
    ...(request.fileName ? { fileName: request.fileName } : {}),
    ...(request.rate ? { rate: request.rate } : {}),
  });
  const { files, matches, unresolved } = await resolveImportMedia(parsed.media, request);
  const unresolvedIds = new Set(unresolved);
  const project: Project = {
    ...parsed.project,
    clips: parsed.project.clips.map((clip): SerializedClip => {
      if (!unresolvedIds.has(clip.id)) return clip;
      const reference = parsed.media.get(clip.id);
      return {
        ...clip,
        offline: {
          fileName: reference?.name ?? clip.fileName,
          ...(reference?.url ? { url: reference.url } : {}),
          ...(reference?.hash ? { hash: reference.hash } : {}),
          ...(reference?.driveId ? { driveId: reference.driveId } : {}),
        },
      };
    }),
  };
  const applied = await loadProjectIntoEditor(project, (saved) => files.get(saved.id) ?? null);
  const settings = settingsStore.getState();
  if (parsed.name && parsed.name !== 'Clip Stacker') {
    settings.setExportSettings({ ...settings.exportSettings, filename: parsed.name.replace(/[\\/:*?"<>|]+/g, '-') });
  }
  const fileNames = new Map(project.clips.map((clip) => [clip.id, clip.fileName]));
  const report: ImportReport = {
    format: parsed.format,
    name: parsed.name,
    clipCount: applied.clips.length + applied.sequences.reduce((n, seq) => n + seq.clips.length, 0),
    offline: applied.offlineClipFileNames,
    relinked: matches.map((match) => ({
      clipId: match.clipId,
      fileName: fileNames.get(match.clipId) ?? match.candidate.name,
      by: match.by,
      source: match.candidate.source,
    })),
    warnings: [...parsed.warnings, ...applied.mediaDownloadWarnings],
  };
  const offline = report.offline.length;
  renderJobStore
    .getState()
    .setStatus(
      `Imported ${INTERCHANGE_FILE_TYPES[parsed.format].label} "${parsed.name}" (${report.clipCount} clips${
        offline > 0 ? `, ${offline} offline — File → Relink media…` : ''
      }).${report.warnings.length > 0 ? ` ⚠️ ${report.warnings.join(' ')}` : ''}`,
    );
  return report;
}

/** Every offline clip in the project (each sequence's too). */
export function offlineClips(): Clip[] {
  return allSequenceClips(editorStore.getState()).filter((clip) => Boolean(clip.offline));
}

export interface RelinkReport {
  relinked: number;
  remaining: number;
}

/**
 * Swap media into offline clips: `assignments` pins a file to a clip; `files`
 * are matched by name, then hash (a folder pick). One undo step for the open
 * timeline; clips inside other sequences are relinked when those are opened.
 */
export async function relinkOfflineClips(input: { files?: File[]; assignments?: Array<{ clipId: string; file: File }> }): Promise<RelinkReport> {
  const targets = offlineClips();
  const chosen = new Map((input.assignments ?? []).map((a) => [a.clipId, a.file]));
  const pending = targets.filter((clip) => !chosen.has(clip.id));
  if (input.files?.length && pending.length > 0) {
    const requests = pending.map((clip) => ({
      clipId: clip.id,
      reference: { name: clip.offline!.fileName, ...(clip.offline!.hash ? { hash: clip.offline!.hash } : {}) },
    }));
    const sources = fileCandidates(input.files);
    await hashCandidates(requests, sources);
    const plan = planRelink(requests, sources.map((s) => s.candidate));
    const byKey = new Map(sources.map((s) => [s.candidate.key, s.file]));
    for (const match of plan.matches) {
      const file = byKey.get(match.candidate.key);
      if (file) chosen.set(match.clipId, file);
    }
  }
  if (chosen.size === 0) return { relinked: 0, remaining: targets.length };

  // One probe and one object URL per file, shared by every clip cut from it.
  const probed = new Map<File, Awaited<ReturnType<typeof getMediaInfo>>>();
  for (const file of new Set(chosen.values())) probed.set(file, await getMediaInfo(file));
  const editor = editorStore.getState();
  const relinkAll = (clips: Clip[]) =>
    clips.map((clip) => {
      const file = chosen.get(clip.id);
      const info = file ? probed.get(file) : undefined;
      return file && info && clip.offline
        ? relinkClip(clip, { file, objectUrl: info.objectUrl, duration: info.duration, videoWidth: info.videoWidth, videoHeight: info.videoHeight, hasAudio: info.hasAudio })
        : clip;
    });
  const clips = relinkAll(editor.clips);
  editor.commitEdit({ tracks: editor.tracks, clips, transitions: editor.transitions });
  // Nested sequences (not open) hold their own clips: relink them in place too.
  if (editor.sequences.length > 0) {
    editorStore.setState((s) => ({ sequences: s.sequences.map((seq) => ({ ...seq, clips: relinkAll(seq.clips) })) }));
  }
  const remaining = offlineClips().length;
  return { relinked: targets.length - remaining, remaining };
}

export interface StemsDownload extends StemsReport {
  url: string;
  fileName: string;
}

/** Render the stems bundle for the open timeline and publish it as the stems download. */
export async function exportStemsFromEditor(options: StemExportOptions = {}): Promise<StemsDownload> {
  const editor = editorStore.getState();
  const settings = settingsStore.getState();
  const jobs = renderJobStore.getState();
  const timelineClips = selectTimelineClips(editor);
  const poolAudio = editor.clips.filter((clip) => clip.kind === 'audio' && !timelineClips.some((c) => c.id === clip.id));
  const name = projectName();
  jobs.setIsRendering(true);
  jobs.setProgressStage('Exporting stems');
  jobs.setProgressIndeterminate(false);
  try {
    const timeline = exportCurrentTimeline('otio');
    const { bundle, report } = await exportStems(
      {
        clips: [...timelineClips, ...poolAudio],
        groups: editor.clipGroups,
        transitions: editor.transitions,
        tracks: editor.tracks,
        masterBus: editor.masterBus,
        projectName: name,
        timecode: settings.timecode,
        extraFiles: [{ name: timeline.fileName, data: timeline.text }],
      },
      {
        ...options,
        onProgress: (p) => {
          renderJobStore.getState().setProgressStage(`Stems: ${p.stage}`);
          renderJobStore.getState().setProgressValue(p.fraction);
          options.onProgress?.(p);
        },
      },
    );
    const blob = bundle instanceof Blob ? bundle : new Blob([bundle as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const fileName = `${name} stems.zip`;
    renderJobStore.getState().setStemsOutput({ url, fileName });
    renderJobStore.getState().setStatus(`Stems ready: ${report.files.length} files (${fileName}).`);
    return { ...report, url, fileName };
  } catch (error) {
    renderJobStore.getState().setStatus(`Stems export failed: ${(error as Error).message}`);
    throw error;
  } finally {
    const done = renderJobStore.getState();
    done.setIsRendering(false);
    done.setProgressStage('');
    done.setProgressValue(null);
  }
}
