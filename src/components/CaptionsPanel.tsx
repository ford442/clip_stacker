/**
 * Captions tab of the Inspector: the caption track's list, the editor for the
 * selected cue, import/export actions, and the project-wide caption style.
 *
 * The lane in the timeline handles retiming by drag; this panel is where text
 * and exact timings are typed, and where a `.srt` / `.ass` file enters or
 * leaves the project.
 */

import { memo, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { CaptionEntry, TextOverlayStyle } from '../types';
import {
  settingsStore,
  uiActions,
  useEditorCaptions,
  useEditorCaptionStyle,
  useSelectedCaptionId,
} from '../store';
import { usePlayheadTime } from '../hooks/usePlayheadTime';
import { isValidFfmpegColor } from '../utils/color';
import { BUNDLED_FONTS } from '../utils/textOverlay';
import {
  DEFAULT_CAPTION_STYLE,
  formatSrtTimestamp,
  resolveCaptionStyle,
} from '../utils/subtitles';
import {
  CAPTION_EXPORT_MODE_LABELS,
  type CaptionExportMode,
} from '../ffmpeg/captions';

export interface CaptionsPanelProps {
  onAdd: (startSec: number) => string;
  onUpdate: (caption: CaptionEntry) => void;
  onDelete: (id: string) => void;
  onStyleChange: (style: Partial<TextOverlayStyle>) => void;
  onImport: (file: File) => Promise<void>;
  onExportSrt: () => void;
  onClear: () => void;
}

const EXPORT_MODES: CaptionExportMode[] = ['none', 'burn', 'soft'];

const EXPORT_MODE_HINTS: Record<CaptionExportMode, string> = {
  none: 'Captions stay on the timeline and are not written into the MP4.',
  burn:
    'Captions are drawn into the picture with libass after the render. Always visible, but the video is re-encoded once more and they cannot be turned off.',
  soft:
    'Captions become a mov_text subtitle track alongside the video. Toggle-able in VLC, QuickTime and Chrome; the video streams are copied, not re-encoded.',
};

function CaptionsPanelImpl({
  onAdd,
  onUpdate,
  onDelete,
  onStyleChange,
  onImport,
  onExportSrt,
  onClear,
}: CaptionsPanelProps) {
  const captions = useEditorCaptions();
  const captionStyle = useEditorCaptionStyle();
  const selectedCaptionId = useSelectedCaptionId();
  const playheadTime = usePlayheadTime() ?? 0;
  const captionExportMode = useStore(settingsStore, (s) => s.captionExportMode);
  const importInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const selected = captions.find((c) => c.id === selectedCaptionId) ?? null;
  const effectiveStyle = resolveCaptionStyle(selected ?? undefined, captionStyle);

  // Selecting a chip in the timeline lane should reveal it here too.
  useEffect(() => {
    if (!selectedCaptionId) return;
    itemRefs.current[selectedCaptionId]?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [selectedCaptionId, captions.length]);

  const setStyleField = <K extends keyof TextOverlayStyle>(
    field: K,
    value: TextOverlayStyle[K],
  ) => {
    onStyleChange({ ...captionStyle, [field]: value });
  };

  const setTiming = (caption: CaptionEntry, field: 'startSec' | 'endSec', raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    onUpdate({ ...caption, [field]: Math.max(0, value) });
  };

  return (
    <div className="inspector-fields captions-panel">
      <div className="inspector-group-label">Caption track</div>

      <div className="captions-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onAdd(playheadTime)}
          title="Add a caption at the preview playhead (shortcut: C)"
        >
          + Add caption
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => importInputRef.current?.click()}
          title="Replace the caption track with the cues from a .srt or .ass file"
        >
          Import .srt / .ass
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onExportSrt}
          disabled={captions.length === 0}
          title="Download the caption track as a .srt sidecar file (no re-encode)"
        >
          Export .srt
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onClear}
          disabled={captions.length === 0}
          title="Remove every caption (undoable)"
        >
          Clear all
        </button>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".srt,.ass,.ssa,text/plain"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first so re-picking the same file fires `change` again.
          event.target.value = '';
          if (file) void onImport(file);
        }}
      />

      {captions.length === 0 ? (
        <p className="inspector-hint">
          No captions yet. Press <kbd>C</kbd> to add one at the playhead, import an
          existing <code>.srt</code>/<code>.ass</code> file, or double-click the{' '}
          <strong>CC</strong> lane in the timeline.
        </p>
      ) : (
        <ul className="captions-list">
          {captions.map((caption, index) => (
            <li
              key={caption.id}
              ref={(node) => {
                itemRefs.current[caption.id] = node;
              }}
              className={`captions-list-item${caption.id === selectedCaptionId ? ' is-selected' : ''}`}
            >
              <button
                type="button"
                className="captions-list-button"
                onClick={() =>
                  uiActions.setSelectedCaptionId(
                    caption.id === selectedCaptionId ? null : caption.id,
                  )
                }
                aria-expanded={caption.id === selectedCaptionId}
              >
                <span className="captions-list-index">{index + 1}</span>
                <span className="captions-list-time">
                  {formatSrtTimestamp(caption.startSec)} →{' '}
                  {formatSrtTimestamp(caption.endSec)}
                </span>
                <span className="captions-list-text">
                  {caption.text.replace(/\s*\n\s*/g, ' ⏎ ')}
                </span>
              </button>

              {caption.id === selectedCaptionId && (
                <div className="captions-editor">
                  <label>
                    Text
                    <textarea
                      rows={2}
                      value={caption.text}
                      onChange={(e) => onUpdate({ ...caption, text: e.target.value })}
                      placeholder="Caption text (Enter for a new line)"
                    />
                  </label>

                  <div className="captions-timing-row">
                    <label title="Cue in-point, in seconds on the output timeline">
                      Start (s)
                      <input
                        type="number"
                        min="0"
                        step="0.05"
                        value={caption.startSec}
                        onChange={(e) => setTiming(caption, 'startSec', e.target.value)}
                      />
                    </label>
                    <label title="Cue out-point, in seconds on the output timeline">
                      End (s)
                      <input
                        type="number"
                        min="0"
                        step="0.05"
                        value={caption.endSec}
                        onChange={(e) => setTiming(caption, 'endSec', e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() =>
                        onUpdate({
                          ...caption,
                          startSec: playheadTime,
                          endSec: playheadTime + (caption.endSec - caption.startSec),
                        })
                      }
                      title="Move this cue so it starts at the preview playhead, keeping its length"
                    >
                      ⤓ Playhead
                    </button>
                  </div>

                  <button
                    type="button"
                    className="btn-secondary captions-delete"
                    onClick={() => onDelete(caption.id)}
                  >
                    Delete caption
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="inspector-group-label">Style</div>
      <p className="inspector-hint">
        Applies to every cue. Position is the caption's bottom centre, as a
        fraction of the output size.
      </p>

      <label>
        Font
        <select
          value={effectiveStyle.font ?? DEFAULT_CAPTION_STYLE.font}
          onChange={(e) => setStyleField('font', e.target.value)}
        >
          {BUNDLED_FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.label}
            </option>
          ))}
        </select>
      </label>

      <label title="Font size in pixels at the output resolution">
        Size ({effectiveStyle.fontsize}px)
        <input
          type="range"
          min="12"
          max="120"
          step="1"
          value={effectiveStyle.fontsize}
          onChange={(e) => setStyleField('fontsize', Number(e.target.value))}
        />
      </label>

      <div className="captions-timing-row">
        <label title="Text colour">
          Colour
          <input
            type="color"
            value={
              isValidFfmpegColor(effectiveStyle.fontcolor) &&
              effectiveStyle.fontcolor.startsWith('#')
                ? effectiveStyle.fontcolor
                : '#ffffff'
            }
            onChange={(e) => setStyleField('fontcolor', e.target.value)}
          />
        </label>
        <label
          className="inspector-checkbox-label"
          title="Draw a filled box behind the text so it stays readable over bright footage"
        >
          <input
            type="checkbox"
            checked={effectiveStyle.box}
            onChange={(e) => setStyleField('box', e.target.checked)}
          />
          Background box
        </label>
      </div>

      <div className="captions-timing-row">
        <label title="Horizontal centre of the caption, 0 = left edge, 1 = right edge">
          X ({effectiveStyle.x.toFixed(2)})
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={effectiveStyle.x}
            onChange={(e) => setStyleField('x', Number(e.target.value))}
          />
        </label>
        <label title="Bottom of the caption, 0 = top edge, 1 = bottom edge">
          Y ({effectiveStyle.y.toFixed(2)})
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={effectiveStyle.y}
            onChange={(e) => setStyleField('y', Number(e.target.value))}
          />
        </label>
      </div>

      <div className="inspector-group-label">Export</div>
      <label title="How captions are attached to the rendered MP4">
        Caption export
        <select
          value={captionExportMode}
          onChange={(e) =>
            settingsStore
              .getState()
              .setCaptionExportMode(e.target.value as CaptionExportMode)
          }
        >
          {EXPORT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {CAPTION_EXPORT_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
      <p className="inspector-hint">{EXPORT_MODE_HINTS[captionExportMode]}</p>
    </div>
  );
}

export const CaptionsPanel = memo(CaptionsPanelImpl);
