export type TrackKind = 'video' | 'audio' | 'text';

/**
 * A placement on a timeline track.
 *
 * On `video` / `audio` tracks `clipId` is a {@link Clip} id. On a `text` track
 * it is a {@link TextOverlay} id — the holding track's `kind` selects which
 * pool the id resolves against, so no schema change was needed to add titles
 * tracks (see AGENTS.md, "Text tracks vs the caption track").
 */
export interface TrackItem {
  clipId: string;
  /** Output-timeline position in seconds. */
  startTime: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  label?: string;
  items: TrackItem[];
  muted?: boolean;
  locked?: boolean;
  /** Row height in pixels for the timeline UI. */
  height?: number;
  /**
   * The lane bus's insert chain (`utils/audioBus.ts`), run by the media
   * engine on the lane's summed audio in preview and export. Omitted = dry.
   */
  audioFx?: import('../utils/audioBus').BusEffect[];
  /**
   * Sidechain duck under another lane, `'off'`, or omitted for the legacy
   * step (audio lanes only) — see `LaneDuck`.
   */
  duck?: import('../utils/audioBus').LaneDuck;
}

export interface SerializedTrack {
  id: string;
  kind: TrackKind;
  label?: string;
  items: TrackItem[];
  muted?: boolean;
  locked?: boolean;
  height?: number;
  audioFx?: import('../utils/audioBus').BusEffect[];
  duck?: import('../utils/audioBus').LaneDuck;
}
