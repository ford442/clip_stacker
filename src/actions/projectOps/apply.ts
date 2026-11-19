/**
 * Apply validated `ProjectOp`s to a draft of the open timeline, then commit
 * the draft in one undo step (`editorStore.commitProjectEdit`) — or nothing,
 * when any op is refused. Each op is the pure edit the UI's own action runs
 * (`timeline/editModes.ts`, `trackModel.ts`, the finishing preset path), so a
 * locked lane refuses a script the way it refuses a drag.
 */

import type {
  CaptionEntry,
  Clip,
  ClipAnimatableProp,
  ClipAutomationProp,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  ProjectTimecode,
  SyncMarker,
  TextOverlay,
  TextOverlayStyle,
  Track,
  TrackKind,
} from '../../types';
import type { Keyframe } from '../../timeline/keyframes';
import { editorStore } from '../../store/editorStore';
import { settingsStore } from '../../store/settingsStore';
import { createClipId } from '../../media/media';
import { getClipDuration } from '../../timeline/clipTiming';
import {
  baseLaneOrder,
  dropEdit,
  duplicateItem,
  normalizeBaseLane,
  remapBaseTransitions,
  rippleDelete,
  type DropEditMode,
  type EditResult,
  type EditState,
} from '../../timeline/editModes';
import { finalize, lockedReason, untrimmableReason } from '../../timeline/editModeCore';
import { duplicateClip, splitClipAt } from '../../timeline/clipOperations';
import {
  addTrack,
  findClipTrack,
  getEffectiveTimelineClips,
  removeClipFromTracks,
  renameTrack,
  replaceClipOnTrackAfterSplit,
  setTrackAudioFx,
  setTrackDuck,
  setTrackLocked,
  setTrackMuted,
} from '../../timeline/trackModel';
import { placeTextOverlayOnTrack, removeTextOverlayFromTracks } from '../../timeline/titleTracks';
import { planAddClip } from '../../timeline/planAddClip';
import { resolveClipOutputWindow } from '../../composition/previewComposition';
import { sourceTimeAtOutputLocal, wrapOutputLocalToCycle, outputLocalAtSourceOffset } from '../../timeline/timeRemap';
import { normalizeBusEffects, normalizeLaneDuck, normalizeMasterBus, type MasterBusSettings } from '../../audio/audioBus';
import { parseFinishingPreset, resolvePresetFinishing } from '../../finishing/finishingPresets';
import type { FinishingSettings } from '../../finishing/finishing';
import { isTimecodeRateId, normalizeTimecode, timecodeRate } from '../../interchange/timecode';
import { createCaptionId } from '../../captions/subtitles';
import { clipFromMedia, loadOpMedia, type LoadedMedia } from './media';
import { SET_CLIP_FIELDS, type ProjectOp } from './spec';
import { validateProjectOps } from './schema';

interface Draft extends EditState {
  clipGroups: ClipGroup[];
  textOverlays: TextOverlay[];
  captions: CaptionEntry[];
  captionStyle: Partial<TextOverlayStyle>;
  markers: SyncMarker[];
  masterBus: MasterBusSettings | undefined;
  finishing: FinishingSettings | null;
  exportSettings: ExportSettings | null;
  timecode: ProjectTimecode | null;
}

export interface OpError {
  index: number;
  op: string;
  message: string;
}

export interface ApplyResult {
  ok: boolean;
  /** Path-specific validation errors or the op that was refused. */
  errors: string[];
  refused?: OpError;
  /** Per op: ids it created (`clipId`, `trackId`, `markerId`, `overlayId`). */
  results: Array<Record<string, string>>;
}

class Refused extends Error {}
const refuse = (message: string): never => {
  throw new Refused(message);
};

function clipOf(draft: Draft, clipId: unknown): Clip {
  const clip = draft.clips.find((c) => c.id === clipId);
  return clip ?? refuse(`no clip has id "${String(clipId)}"`);
}

function trackOf(draft: Draft, trackId: unknown): Track {
  const track = draft.tracks.find((t) => t.id === trackId);
  return track ?? refuse(`no lane has id "${String(trackId)}"`);
}

function unlocked(track: Track): Track {
  return track.locked ? refuse(lockedReason(track)) : track;
}

function commitEdit(draft: Draft, result: EditResult): void {
  if (!result.ok) refuse(result.reason);
  else Object.assign(draft, result.state);
}

function laneEnd(draft: Draft, track: Track): number {
  const byId = new Map(draft.clips.map((c) => [c.id, c]));
  return track.items.reduce((end, item) => {
    const clip = byId.get(item.clipId);
    return clip ? Math.max(end, item.startTime + getClipDuration(clip)) : end;
  }, 0);
}

/** Where a placed clip sits on the output (main-lane positions from segment maths). */
function outputWindow(draft: Draft, clipId: string): { start: number; end: number } {
  const window = resolveClipOutputWindow(getEffectiveTimelineClips(draft.tracks, draft.clips, draft.clipGroups), draft.clipGroups, draft.transitions, clipId);
  return window ?? refuse(`clip "${clipId}" is not on a lane`);
}

const mode = (op: ProjectOp, fallback: DropEditMode): DropEditMode => (op['mode'] === 'insert' || op['mode'] === 'overwrite' ? op['mode'] : fallback);

type Handler = (draft: Draft, op: ProjectOp, media: LoadedMedia | undefined) => Record<string, string> | void;

const HANDLERS: Record<string, Handler> = {
  addClip(draft, op, media) {
    if (!media) return refuse('media did not load');
    const id = typeof op['id'] === 'string' ? op['id'] : createClipId();
    if (draft.clips.some((c) => c.id === id)) refuse(`a clip already has id "${id}"`);
    const clip = clipFromMedia(media, id, typeof op['title'] === 'string' ? op['title'] : media.file.name);
    if (typeof op['trimStart'] === 'number') clip.trimStart = op['trimStart'];
    if (typeof op['trimEnd'] === 'number') clip.trimEnd = op['trimEnd'];
    if (typeof op['trackId'] === 'string') {
      const track = unlocked(trackOf(draft, op['trackId']));
      draft.clips = [...draft.clips, clip];
      const start = typeof op['startTime'] === 'number' ? op['startTime'] : laneEnd(draft, track);
      commitEdit(draft, dropEdit(draft, mode(op, 'overwrite'), id, track.id, start));
    } else {
      const plan = planAddClip(draft.clips, draft.tracks, draft.clipGroups, clip);
      draft.clips = plan.clips;
      if (plan.tracks) draft.tracks = normalizeBaseLane(plan.tracks, plan.clips, draft.transitions);
      if (plan.clipGroups) draft.clipGroups = plan.clipGroups;
    }
    return { clipId: id };
  },
  placeClip(draft, op) {
    clipOf(draft, op['clipId']);
    unlocked(trackOf(draft, op['trackId']));
    commitEdit(draft, dropEdit(draft, mode(op, 'overwrite'), String(op['clipId']), String(op['trackId']), Number(op['startTime'])));
  },
  move(draft, op) {
    const clip = clipOf(draft, op['clipId']);
    const from = findClipTrack(draft.tracks, clip.id) ?? refuse(`clip "${clip.id}" is not on a lane`);
    unlocked(from.track);
    const target = unlocked(typeof op['trackId'] === 'string' ? trackOf(draft, op['trackId']) : from.track);
    commitEdit(draft, dropEdit(draft, mode(op, 'overwrite'), clip.id, target.id, Number(op['startTime'])));
  },
  trim(draft, op) {
    const clip = clipOf(draft, op['clipId']);
    const at = findClipTrack(draft.tracks, clip.id);
    if (at) unlocked(at.track);
    const reason = untrimmableReason(clip);
    if (reason) refuse(reason);
    const trimStart = typeof op['trimStart'] === 'number' ? op['trimStart'] : clip.trimStart;
    const trimEnd = typeof op['trimEnd'] === 'number' ? op['trimEnd'] : Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    if (!(trimEnd > trimStart) || trimEnd > clip.duration + 1e-6) refuse(`trim [${trimStart}, ${trimEnd}] is outside the clip (0–${clip.duration}s)`);
    const clips = draft.clips.map((c) => (c.id === clip.id ? { ...c, trimStart, trimEnd } : c));
    commitEdit(draft, finalize(draft, draft.tracks, clips));
  },
  split(draft, op) {
    const source = clipOf(draft, op['clipId']);
    const at = findClipTrack(draft.tracks, source.id) ?? refuse(`clip "${source.id}" is not on a lane`);
    unlocked(at.track);
    const placed = outputWindow(draft, source.id);
    const time = Number(op['time']);
    if (time <= placed.start || time >= placed.end) refuse(`time ${time}s is not inside the clip (${placed.start}–${placed.end}s)`);
    const sourceTime = sourceTimeAtOutputLocal(source, wrapOutputLocalToCycle(source, time - placed.start).cycleLocalT);
    const split = splitClipAt(source, sourceTime) ?? refuse('the split point must be at least 0.1s inside the trimmed region');
    const [left, right] = split;
    const rightStart = placed.start + outputLocalAtSourceOffset(source, sourceTime - source.trimStart);
    const prevOrder = baseLaneOrder(draft.tracks);
    const tracks = replaceClipOnTrackAfterSplit(draft.tracks, source.id, left.id, right.id, rightStart);
    const clips = draft.clips.flatMap((c) => (c.id === source.id ? [left, right] : [c]));
    draft.transitions = remapBaseTransitions(prevOrder, baseLaneOrder(tracks), draft.transitions, new Map([[right.id, source.id]]));
    draft.tracks = normalizeBaseLane(tracks, clips, draft.transitions);
    draft.clips = clips;
    return { clipId: right.id };
  },
  duplicate(draft, op) {
    const source = clipOf(draft, op['clipId']);
    const copy = duplicateClip(source);
    commitEdit(draft, duplicateItem({ ...draft, clips: [...draft.clips, copy] }, source.id, copy, mode(op, 'insert')));
    return { clipId: copy.id };
  },
  removeClip(draft, op) {
    const clip = clipOf(draft, op['clipId']);
    const at = findClipTrack(draft.tracks, clip.id);
    if (at) unlocked(at.track);
    if (at && op['ripple'] === true) {
      commitEdit(draft, rippleDelete(draft, clip.id));
      return;
    }
    const prevOrder = baseLaneOrder(draft.tracks);
    const tracks = removeClipFromTracks(draft.tracks, clip.id);
    const clips = draft.clips.filter((c) => c.id !== clip.id);
    draft.transitions = remapBaseTransitions(prevOrder, baseLaneOrder(tracks), draft.transitions);
    draft.tracks = normalizeBaseLane(tracks, clips, draft.transitions);
    draft.clips = clips;
  },
  setClip(draft, op) {
    const clip = clipOf(draft, op['clipId']);
    const at = findClipTrack(draft.tracks, clip.id);
    if (at) unlocked(at.track);
    const fields = op['fields'] as Record<string, unknown>;
    const next: Clip = { ...clip };
    for (const key of Object.keys(SET_CLIP_FIELDS)) {
      if (fields[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = fields[key];
    }
    const clips = draft.clips.map((c) => (c.id === clip.id ? next : c));
    commitEdit(draft, finalize(draft, draft.tracks, clips));
  },
  setTransition(draft, op) {
    const order = baseLaneOrder(draft.tracks);
    const slot = typeof op['afterClipIndex'] === 'number' ? op['afterClipIndex'] : order.indexOf(String(op['clipId']));
    if (!(slot >= 1 && slot < order.length)) refuse('the transition must go into a main-lane clip after the first (clipId or afterClipIndex ≥ 1)');
    const base = draft.tracks.find((t) => t.kind === 'video');
    if (base) unlocked(base);
    const rest = draft.transitions.filter((t) => t.afterClipIndex !== slot);
    const transition: ClipTransition = {
      afterClipIndex: slot,
      type: String(op['type']),
      duration: typeof op['duration'] === 'number' ? op['duration'] : 0.5,
      ...(op['params'] && typeof op['params'] === 'object' ? { params: { ...(op['params'] as Record<string, number>) } } : {}),
    };
    const transitions = [...rest, transition].sort((a, b) => a.afterClipIndex - b.afterClipIndex);
    commitEdit(draft, finalize({ ...draft, transitions }, draft.tracks, draft.clips));
  },
  setKeyframes(draft, op) {
    const clip = clipOf(draft, op['clipId']);
    const prop = String(op['prop']);
    const keyframes = (op['keyframes'] as Keyframe[]).map((k) => ({ t: k.t, value: k.value })).sort((a, b) => a.t - b.t);
    const next: Clip = { ...clip };
    if (prop === 'volume' || prop === 'pan' || prop === 'playbackRate') {
      const automation = { ...(clip.automation ?? {}) };
      if (keyframes.length > 0) automation[prop as ClipAutomationProp] = keyframes;
      else delete automation[prop as ClipAutomationProp];
      if (Object.keys(automation).length > 0) next.automation = automation;
      else delete next.automation;
    } else {
      const lanes = { ...(clip.keyframes ?? {}) };
      if (keyframes.length > 0) lanes[prop as ClipAnimatableProp] = keyframes;
      else delete lanes[prop as ClipAnimatableProp];
      next.keyframes = Object.keys(lanes).length > 0 ? lanes : undefined;
    }
    commitEdit(draft, finalize(draft, draft.tracks, draft.clips.map((c) => (c.id === clip.id ? next : c))));
  },
  addTrack(draft, op) {
    const before = new Set(draft.tracks.map((t) => t.id));
    let tracks = addTrack(draft.tracks, op['kind'] as TrackKind);
    const added = tracks.find((t) => !before.has(t.id)) ?? refuse('the lane could not be added');
    if (typeof op['label'] === 'string') tracks = renameTrack(tracks, added.id, op['label']);
    draft.tracks = tracks;
    return { trackId: added.id };
  },
  setTrack(draft, op) {
    const track = trackOf(draft, op['trackId']);
    let tracks = draft.tracks;
    if (typeof op['label'] === 'string') tracks = renameTrack(tracks, track.id, op['label']);
    if (typeof op['muted'] === 'boolean') tracks = setTrackMuted(tracks, track.id, op['muted']);
    if (typeof op['locked'] === 'boolean') tracks = setTrackLocked(tracks, track.id, op['locked']);
    draft.tracks = tracks;
  },
  setTrackAudioFx(draft, op) {
    const track = unlocked(trackOf(draft, op['trackId']));
    if (track.kind === 'text') refuse('a titles lane has no audio bus');
    const raw = op['fx'] as unknown[];
    const fx = normalizeBusEffects(raw);
    if ((fx?.length ?? 0) !== raw.length) refuse('fx holds an effect that is not a valid BusEffect (see audio/audioBus.ts)');
    draft.tracks = setTrackAudioFx(draft.tracks, track.id, fx);
  },
  setDuck(draft, op) {
    const track = unlocked(trackOf(draft, op['trackId']));
    if (track.kind === 'text') refuse('a titles lane has no audio bus');
    const duck = op['off'] === true ? 'off' : op['duck'] === undefined ? undefined : normalizeLaneDuck(op['duck']);
    if (op['duck'] !== undefined && op['off'] !== true && !duck) refuse('duck is not valid LaneDuckSettings');
    draft.tracks = setTrackDuck(draft.tracks, track.id, duck);
  },
  setMasterBus(draft, op) {
    draft.masterBus = op['masterBus'] === undefined ? undefined : normalizeMasterBus(op['masterBus']);
    if (op['masterBus'] !== undefined && draft.masterBus === undefined && Object.keys(op['masterBus'] as object).length > 0) {
      refuse('masterBus is not valid MasterBusSettings');
    }
  },
  setFinishing(draft, op) {
    const parsed = parseFinishingPreset(op['preset']);
    if (!parsed.ok) refuse(`preset: ${parsed.errors.join('; ')}`);
    else draft.finishing = resolvePresetFinishing(parsed.preset, draft.finishing ?? settingsStore.getState().finishing);
  },
  addMarker(draft, op) {
    const id = typeof op['id'] === 'string' ? op['id'] : `marker-${createClipId()}`;
    draft.markers = [...draft.markers, { id, time: Number(op['time']), text: String(op['text']) }];
    return { markerId: id };
  },
  setCaptions(draft, op) {
    const captions = (op['captions'] as Array<Partial<CaptionEntry>>).map((cue, i): CaptionEntry => {
      const startSec = Number(cue.startSec);
      const endSec = Number(cue.endSec);
      if (!(Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) || typeof cue.text !== 'string') {
        refuse(`captions[${i}] needs startSec < endSec and text`);
      }
      return { id: typeof cue.id === 'string' ? cue.id : createCaptionId(), startSec, endSec, text: String(cue.text), ...(cue.style ? { style: cue.style } : {}) };
    });
    draft.captions = captions;
    if (op['style'] && typeof op['style'] === 'object') draft.captionStyle = { ...(op['style'] as Partial<TextOverlayStyle>) };
  },
  setTextOverlay(draft, op) {
    const fields = op['overlay'] as Partial<TextOverlay>;
    const existing = typeof fields.id === 'string' ? draft.textOverlays.find((o) => o.id === fields.id) : undefined;
    if (op['remove'] === true) {
      if (!existing) refuse(`no title has id "${String(fields.id)}"`);
      draft.textOverlays = draft.textOverlays.filter((o) => o.id !== existing!.id);
      draft.tracks = removeTextOverlayFromTracks(draft.tracks, existing!.id);
      return;
    }
    const overlay: TextOverlay = {
      id: typeof fields.id === 'string' ? fields.id : `title-${createClipId()}`,
      text: 'Title',
      fontsize: 48,
      fontcolor: '#ffffff',
      x: 0.1,
      y: 0.1,
      scrolling: false,
      scrollSpeed: 20,
      box: false,
      boxColor: 'black@0.5',
      ...(existing ?? {}),
      ...fields,
    } as TextOverlay;
    draft.textOverlays = existing ? draft.textOverlays.map((o) => (o.id === overlay.id ? overlay : o)) : [...draft.textOverlays, overlay];
    if (typeof op['trackId'] === 'string') {
      const track = unlocked(trackOf(draft, op['trackId']));
      if (track.kind !== 'text') refuse(`lane "${track.id}" is not a titles lane`);
      draft.tracks = placeTextOverlayOnTrack(draft.tracks, overlay.id, track.id, typeof op['startTime'] === 'number' ? op['startTime'] : 0);
    }
    return { overlayId: overlay.id };
  },
  setExportSettings(draft, op) {
    draft.exportSettings = { ...(draft.exportSettings ?? settingsStore.getState().exportSettings), ...(op['settings'] as Partial<ExportSettings>) };
  },
  setTimecode(draft, op) {
    const current = draft.timecode ?? settingsStore.getState().timecode;
    const rate = typeof op['rate'] === 'string' && isTimecodeRateId(op['rate']) ? op['rate'] : current.rate;
    const start = typeof op['start'] === 'string' ? normalizeTimecode(op['start'], timecodeRate(rate)) : current.start;
    if (start === null) refuse(`"${String(op['start'])}" is not timecode (HH:MM:SS:FF)`);
    else draft.timecode = { start, rate };
  },
};

function draftFromStores(): Draft {
  const editor = editorStore.getState();
  return {
    clips: editor.clips,
    tracks: editor.tracks,
    transitions: editor.transitions,
    clipGroups: editor.clipGroups,
    textOverlays: editor.textOverlays,
    captions: editor.captions,
    captionStyle: editor.captionStyle,
    markers: editor.masterAudioMarkers,
    masterBus: editor.masterBus,
    finishing: null,
    exportSettings: null,
    timecode: null,
  };
}

/**
 * Validate, then apply `input` (an op, ops, or their JSON) to the open
 * timeline as one undo step. Nothing changes unless every op succeeds.
 */
export async function applyProjectOps(input: unknown, options: { mediaRoot?: string } = {}): Promise<ApplyResult> {
  const validated = validateProjectOps(input);
  if (!validated.ok) return { ok: false, errors: validated.errors, results: [] };
  const { ops } = validated;
  let media: Map<number, LoadedMedia>;
  try {
    media = await loadOpMedia(ops, options.mediaRoot);
  } catch (error) {
    const index = (error as { index?: number }).index ?? 0;
    const refused = { index, op: ops[index]?.op ?? '', message: (error as Error).message };
    return { ok: false, errors: [`ops[${index}] (${refused.op}): ${refused.message}`], refused, results: [] };
  }
  const draft = draftFromStores();
  const results: Array<Record<string, string>> = [];
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!;
    try {
      results.push(HANDLERS[op.op]!(draft, op, media.get(index)) ?? {});
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      for (const loaded of media.values()) URL.revokeObjectURL(loaded.objectUrl);
      const refused = { index, op: op.op, message: error.message };
      return { ok: false, errors: [`ops[${index}] (${op.op}): ${error.message}`], refused, results: [] };
    }
  }
  editorStore.getState().commitProjectEdit(
    {
      clips: draft.clips,
      tracks: draft.tracks,
      transitions: draft.transitions,
      clipGroups: draft.clipGroups,
      textOverlays: draft.textOverlays,
      captions: draft.captions,
      captionStyle: draft.captionStyle,
      masterAudioMarkers: draft.markers,
      masterBus: draft.masterBus,
    },
    draft.finishing ?? undefined,
  );
  const settings = settingsStore.getState();
  if (draft.exportSettings) settings.setExportSettings(draft.exportSettings);
  if (draft.timecode) settings.setTimecode(draft.timecode);
  return { ok: true, errors: [], results };
}
