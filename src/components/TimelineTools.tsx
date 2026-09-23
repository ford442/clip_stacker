import { memo } from 'react';
import {
  uiActions,
  useDropEditMode,
  useLinkedRipple,
  useSnapEnabled,
  useTimelineTool,
} from '../store';
import type { DropEditMode, TimelineEditTool } from '../utils/editModes';

/**
 * Edit-mode tool cluster for the timeline chrome (#168 follow-up).
 *
 * Pure view over `uiStore`: the sticky tool, overwrite/insert drop mode, the
 * magnet and linked ripple. The edits themselves run through
 * `useTimelineActions` → `utils/editModes.ts`, so lock guards and undo are
 * shared with the keyboard shortcuts listed next to each button.
 */

const TOOLS: { id: TimelineEditTool; label: string; key: string; title: string }[] = [
  { id: 'select', label: 'Select', key: 'V', title: 'Select tool — drag to move clips' },
  { id: 'ripple', label: 'Ripple', key: 'Q', title: 'Ripple trim — Alt+←/→ trims the out-point and later clips follow' },
  { id: 'roll', label: 'Roll', key: 'W', title: 'Roll — Alt+←/→ moves the edit after the selected clip' },
  { id: 'slip', label: 'Slip', key: 'Y', title: 'Slip — Alt+←/→ moves the source window, position stays' },
  { id: 'slide', label: 'Slide', key: 'U', title: 'Slide — Alt+←/→ moves the clip, neighbours compensate' },
];

const MODES: { id: DropEditMode; label: string; key: string; title: string }[] = [
  { id: 'overwrite', label: 'Overwrite', key: 'O', title: 'Drops cover clips already on the lane' },
  { id: 'insert', label: 'Insert', key: 'I', title: 'Drops push later clips on the lane' },
];

function TimelineToolsImpl() {
  const tool = useTimelineTool();
  const mode = useDropEditMode();
  const snap = useSnapEnabled();
  const linked = useLinkedRipple();

  return (
    <div className="timeline-tools" role="toolbar" aria-label="Edit tools">
      <div className="timeline-tools-group" role="group" aria-label="Edit tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`timeline-tool-btn${tool === t.id ? ' is-active' : ''}`}
            aria-pressed={tool === t.id}
            title={`${t.title} (${t.key})`}
            onClick={() => uiActions.setTimelineTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="timeline-tools-group" role="group" aria-label="Drop mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`timeline-tool-btn${mode === m.id ? ' is-active' : ''}`}
            aria-pressed={mode === m.id}
            title={`${m.title} (${m.key})`}
            onClick={() => uiActions.setDropEditMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="timeline-tools-group" role="group" aria-label="Edit options">
        <button
          type="button"
          className={`timeline-tool-btn${snap ? ' is-active' : ''}`}
          aria-pressed={snap}
          title="Snap drops to the playhead, clip edges, markers, captions and beats (N)"
          onClick={() => uiActions.setSnapEnabled((v) => !v)}
        >
          Snap
        </button>
        <button
          type="button"
          className={`timeline-tool-btn${linked ? ' is-active' : ''}`}
          aria-pressed={linked}
          title="Ripple every unlocked lane together instead of only the edited lane"
          onClick={() => uiActions.setLinkedRipple((v) => !v)}
        >
          Link
        </button>
      </div>
    </div>
  );
}

export const TimelineTools = memo(TimelineToolsImpl);
