import { memo, useState } from 'react';
import type { ClipGroup } from '../types';
import {
  editorActions,
  useEditorClip,
  useEditorClipGroups,
  useEditorClips,
  useIsClipSelected,
} from '../store';
import { getClipDuration } from '../utils/project';
import { IntercutModal } from './IntercutModal';
import { settingsStore } from '../store/settingsStore';
import { useStore } from 'zustand';
import type { IntercutGeneratorConfig } from '../ffmpeg/intercutGenerator';

interface ClipLibraryActions {
  onToggleVariant: (groupId: string, variant: 'A' | 'B') => void;
  onDelete: (id: string) => void;
}

interface ClipLibraryItemProps extends ClipLibraryActions {
  clipId: string;
}

function ClipLibraryItem({ clipId, onToggleVariant: _onToggleVariant, onDelete }: ClipLibraryItemProps) {
  const clip = useEditorClip(clipId);
  const isSelected = useIsClipSelected(clipId);
  if (!clip) return null;

  return (
    <li
      className={`clip-item${isSelected ? ' selected' : ''}`}
      onClick={() => editorActions.setSelectedClipId(clip.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          editorActions.setSelectedClipId(clip.id);
        }
      }}
      role="listitem"
      aria-label={`Clip: ${clip.title}, ${clip.kind.toUpperCase()}`}
      tabIndex={0}
    >
      <div className="row">
        {clip.posterUrl && (
          <img className="clip-library-poster" src={clip.posterUrl} alt="" />
        )}
        <strong className="clip-title">{clip.title}</strong>
        <span className="muted">{clip.kind.toUpperCase()}</span>
        <button
          type="button"
          className="project-delete-btn"
          onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
          title="Delete clip (Delete or Backspace key)"
          aria-label={`Delete clip ${clip.title}`}
        >
          ×
        </button>
      </div>
      <div className="muted">
        {getClipDuration(clip).toFixed(1)}s · trim {clip.trimStart.toFixed(1)}s →{' '}
        {Number.isFinite(clip.trimEnd) ? `${clip.trimEnd.toFixed(1)}s` : 'end'}
        {clip.rifeProcessed && (
          <span className="rife-badge" title={`Processed with RIFE ${clip.rifeMode === 'boomerang' ? 'Boomerang' : `${clip.rifeMultiplier ?? 2}× interpolation`}`}>
            {clip.rifeMode === 'boomerang' ? ' 🔁' : ` ✨${clip.rifeMultiplier ?? 2}×`}
          </span>
        )}
      </div>
    </li>
  );
}

const MemoClipLibraryItem = memo(ClipLibraryItem);

interface VariantRowProps extends ClipLibraryActions {
  group: ClipGroup;
  slot: 'A' | 'B';
}

function VariantRow({ group, slot, onToggleVariant, onDelete }: VariantRowProps) {
  const clipId = group.variants[slot]?.id;
  const clip = useEditorClip(clipId ?? null);
  const isSelected = useIsClipSelected(clipId ?? '');
  if (!clip || !clipId) return null;

  const isActive = group.activeVariant === slot;

  return (
    <div
      className={`clip-item clip-variant${isSelected ? ' selected' : ''}${isActive ? ' variant-active' : ''}`}
      onClick={() => editorActions.setSelectedClipId(clip.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          editorActions.setSelectedClipId(clip.id);
        }
      }}
      role="listitem"
      aria-label={`Variant ${slot}: ${clip.title}`}
      tabIndex={0}
    >
      <div className="row">
        <span className="variant-badge">{slot}</span>
        {clip.posterUrl && (
          <img className="clip-library-poster" src={clip.posterUrl} alt="" />
        )}
        <strong className="clip-title">{clip.title}</strong>
        <button
          type="button"
          className={`variant-timeline-btn${isActive ? ' on-timeline' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleVariant(group.id, slot); }}
          title={isActive ? 'Active variant on timeline' : 'Switch timeline to this variant'}
          aria-label={`${isActive ? 'Active variant' : 'Use variant'} ${slot}: ${clip.title}`}
        >
          {isActive ? '● Active' : 'Use'}
        </button>
        <button
          type="button"
          className="project-delete-btn"
          onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
          title="Delete clip (Delete or Backspace key)"
          aria-label={`Delete clip ${clip.title}`}
        >
          ×
        </button>
      </div>
      <div className="muted">
        {getClipDuration(clip).toFixed(1)}s · trim {clip.trimStart.toFixed(1)}s →{' '}
        {Number.isFinite(clip.trimEnd) ? `${clip.trimEnd.toFixed(1)}s` : 'end'}
        {clip.rifeProcessed && (
          <span className="rife-badge" title={`Processed with RIFE ${clip.rifeMode === 'boomerang' ? 'Boomerang' : `${clip.rifeMultiplier ?? 2}× interpolation`}`}>
            {clip.rifeMode === 'boomerang' ? ' 🔁' : ` ✨${clip.rifeMultiplier ?? 2}×`}
          </span>
        )}
      </div>
    </div>
  );
}

const MemoVariantRow = memo(VariantRow);

interface ClipGroupBlockProps extends ClipLibraryActions {
  group: ClipGroup;
}

function ClipGroupBlock({ group, onToggleVariant, onDelete }: ClipGroupBlockProps) {
  const { A, B } = group.variants;
  const active = group.activeVariant;
  const activeClipId = group.variants[active]?.id ?? null;
  const activeClip = useEditorClip(activeClipId);

  return (
    <li key={group.id} className="clip-group">
      <div className="clip-group-header">
        <span className="clip-group-label">Compare variants</span>
      </div>
      {(['A', 'B'] as const).map((slot) => (
        <MemoVariantRow
          key={slot}
          group={group}
          slot={slot}
          onToggleVariant={onToggleVariant}
          onDelete={onDelete}
        />
      ))}
      {A && !B && (
        <div className="clip-item clip-variant variant-empty">
          <span className="variant-badge">B</span>
          <span className="muted"> Upload an edited version to compare</span>
        </div>
      )}
      {activeClip && (
        <div className="clip-group-active-note muted">
          On timeline: Variant {active} ({activeClip.title})
        </div>
      )}
    </li>
  );
}

const MemoClipGroupBlock = memo(ClipGroupBlock);

interface Props extends ClipLibraryActions {
  onGenerateIntercut: (config: IntercutGeneratorConfig) => Promise<boolean>;
}

function ClipLibraryImpl({ onToggleVariant, onDelete, onGenerateIntercut }: Props) {
  const clips = useEditorClips();
  const clipGroups = useEditorClipGroups();
  const [intercutOpen, setIntercutOpen] = useState(false);
  const intercutProcessing = useStore(settingsStore, (s) => s.intercutProcessing);

  const ungroupedClipIds = clips.filter((c) => !c.groupId).map((c) => c.id);
  const activeGroups = clipGroups.filter((g) => g.variants.A || g.variants.B);
  const videoCount = clips.filter((c) => c.kind === 'video').length;

  return (
    <section className="panel library-panel">
      <h2>Library</h2>
      {videoCount >= 2 && (
        <button
          type="button"
          className="btn-secondary intercut-library-btn"
          onClick={() => setIntercutOpen(true)}
          disabled={intercutProcessing}
        >
          ✂️ Create Intercut Clip
        </button>
      )}
      {clips.length === 0 && activeGroups.length === 0 && (
        <p className="muted">No clips yet. Add clips above.</p>
      )}
      <ul className="clip-list" role="list" aria-label="Clip library">
        {activeGroups.map((group) => (
          <MemoClipGroupBlock
            key={group.id}
            group={group}
            onToggleVariant={onToggleVariant}
            onDelete={onDelete}
          />
        ))}
        {ungroupedClipIds.map((clipId) => (
          <MemoClipLibraryItem
            key={clipId}
            clipId={clipId}
            onToggleVariant={onToggleVariant}
            onDelete={onDelete}
          />
        ))}
      </ul>
      <IntercutModal
        isOpen={intercutOpen}
        generating={intercutProcessing}
        onClose={() => {
          if (!settingsStore.getState().intercutProcessing) setIntercutOpen(false);
        }}
        onGenerate={async (config) => {
          const ok = await onGenerateIntercut(config);
          if (ok) setIntercutOpen(false);
          return ok;
        }}
      />
    </section>
  );
}

/**
 * Subscribes to the editor store per clip row so inspector edits and selection
 * changes only re-render the affected library items, not the full list.
 */
export const ClipLibrary = memo(ClipLibraryImpl);
