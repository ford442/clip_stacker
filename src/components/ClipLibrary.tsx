import type { Clip, ClipGroup } from '../types';
import { getClipDuration } from '../utils/project';

interface Props {
  clips: Clip[];
  selectedClipId: string | null;
  clipGroups: ClipGroup[];
  onSelect: (id: string) => void;
  onToggleVariant: (groupId: string, variant: 'A' | 'B') => void;
}

export function ClipLibrary({ clips, selectedClipId, clipGroups, onSelect, onToggleVariant }: Props) {
  // Build a map from clip id → its group (if any)
  const groupByClipId = new Map<string, ClipGroup>();
  for (const group of clipGroups) {
    if (group.variants.A) groupByClipId.set(group.variants.A.id, group);
    if (group.variants.B) groupByClipId.set(group.variants.B.id, group);
  }

  // Clips that are NOT part of any A/B group
  const ungroupedClips = clips.filter((c) => !c.groupId);
  // Groups that have at least one variant
  const activeGroups = clipGroups.filter((g) => g.variants.A || g.variants.B);

  const renderSingleClip = (clip: Clip) => (
    <li
      key={clip.id}
      className={`clip-item${clip.id === selectedClipId ? ' selected' : ''}`}
      onClick={() => onSelect(clip.id)}
    >
      <div className="row">
        <strong className="clip-title">{clip.title}</strong>
        <span className="muted">{clip.kind.toUpperCase()}</span>
      </div>
      <div className="muted">
        {getClipDuration(clip).toFixed(1)}s · trim {clip.trimStart.toFixed(1)}s →{' '}
        {Number.isFinite(clip.trimEnd) ? `${clip.trimEnd.toFixed(1)}s` : 'end'}
      </div>
    </li>
  );

  const renderGroup = (group: ClipGroup) => {
    const { A, B } = group.variants;
    const active = group.activeVariant;
    const activeClip = group.variants[active];

    return (
      <li key={group.id} className="clip-group">
        <div className="clip-group-header">
          <span className="clip-group-label">A/B Group</span>
        </div>
        {(['A', 'B'] as const).map((slot) => {
          const clip = group.variants[slot];
          if (!clip) return null;
          const isActive = active === slot;
          const isSelected = clip.id === selectedClipId;
          return (
            <div
              key={slot}
              className={`clip-item clip-variant${isSelected ? ' selected' : ''}${isActive ? ' variant-active' : ''}`}
              onClick={() => onSelect(clip.id)}
            >
              <div className="row">
                <span className="variant-badge">{slot}</span>
                <strong className="clip-title">{clip.title}</strong>
                <button
                  type="button"
                  className={`variant-timeline-btn${isActive ? ' on-timeline' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onToggleVariant(group.id, slot); }}
                  title={isActive ? 'On timeline' : 'Add to timeline'}
                >
                  {isActive ? '● Timeline' : 'Use'}
                </button>
              </div>
              <div className="muted">
                {getClipDuration(clip).toFixed(1)}s · trim {clip.trimStart.toFixed(1)}s →{' '}
                {Number.isFinite(clip.trimEnd) ? `${clip.trimEnd.toFixed(1)}s` : 'end'}
              </div>
            </div>
          );
        })}
        {/* Show placeholder for missing B slot */}
        {A && !B && (
          <div className="clip-item clip-variant variant-empty">
            <span className="variant-badge">B</span>
            <span className="muted"> Upload an edited version to compare</span>
          </div>
        )}
        {activeClip && (
          <div className="clip-group-active-note muted">
            Timeline: {active} — {activeClip.title}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="panel library-panel">
      <h2>Library</h2>
      {clips.length === 0 && activeGroups.length === 0 && (
        <p className="muted">No clips yet. Add clips above.</p>
      )}
      <ul className="clip-list">
        {activeGroups.map(renderGroup)}
        {ungroupedClips.map(renderSingleClip)}
      </ul>
    </section>
  );
}
