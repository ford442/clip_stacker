import { memo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClipGroup } from '../types';
import {
  editorActions,
  useEditorClip,
  useEditorClipGroups,
  useEditorClips,
  useIsClipSelected,
} from '../store';
import { getClipDuration } from '../utils/clipTiming';
import { LazyBoundary, lazyNamed } from './LazyBoundary';
import { AutoCutPanel } from './AutoCutPanel';
import { ProxyBadge, ProxyPlaybackToggle } from './ProxyBadge';
import { settingsStore } from '../store/settingsStore';
import { useStore } from 'zustand';
import type { IntercutGeneratorConfig } from '../ffmpeg/intercutGenerator';
import type { BatchProcessingOptions } from '../utils/batchClipProcessing';

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
        {' '}
        <ProxyBadge clip={clip} />
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
        {' '}
        <ProxyBadge clip={clip} />
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

const IntercutModal = lazyNamed(() => import('./IntercutModal'), 'IntercutModal');

interface Props extends ClipLibraryActions {
  onGenerateIntercut: (config: IntercutGeneratorConfig) => Promise<boolean>;
  onBatchProcess: (clipIds: string[], options: BatchProcessingOptions) => Promise<boolean>;
}

function ClipLibraryImpl({ onToggleVariant, onDelete, onGenerateIntercut, onBatchProcess }: Props) {
  const clips = useEditorClips();
  const clipGroups = useEditorClipGroups();
  const [intercutOpen, setIntercutOpen] = useState(false);
  // The modal (and the intercut planner/FFmpeg code behind it) loads on first
  // open, then stays mounted so its form keeps its values between openings.
  const [intercutMounted, setIntercutMounted] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchClipIds, setBatchClipIds] = useState<string[]>([]);
  const [batchBackend, setBatchBackend] = useState<BatchProcessingOptions['backend']>('hf-rife');
  const [batchMultiplier, setBatchMultiplier] = useState<2 | 4>(2);
  const [batchOutputFormat, setBatchOutputFormat] = useState<'mp4' | 'prores'>('mp4');
  const [lightVideoCleanup, setLightVideoCleanup] = useState(false);
  const [audioCleanup, setAudioCleanup] = useState(false);
  const [completedBatchIds, setCompletedBatchIds] = useState<string[]>([]);
  const intercutProcessing = useStore(settingsStore, (s) => s.intercutProcessing);
  const processing = useStore(
    settingsStore,
    (s) => s.rifeProcessingClipId !== null || s.isRendering || s.intercutProcessing,
  );

  const ungroupedClipIds = clips.filter((c) => !c.groupId).map((c) => c.id);
  const activeGroups = clipGroups.filter((g) => g.variants.A || g.variants.B);
  const videoClips = clips.filter((c) => c.kind === 'video');
  const videoCount = videoClips.length;
  const selectedBatchClips = videoClips.filter((clip) => batchClipIds.includes(clip.id));
  const canRunBatch = selectedBatchClips.length > 0 &&
    (batchBackend !== 'browser-ffmpeg' ||
      lightVideoCleanup ||
      audioCleanup ||
      batchOutputFormat === 'prores');
  const completedBatchClips = videoClips.filter((clip) => completedBatchIds.includes(clip.id));

  return (
    <section className="panel library-panel">
      <h2>Library</h2>
      {videoCount >= 2 && (
        <button
          type="button"
          className="btn-secondary intercut-library-btn"
          onClick={() => {
            setIntercutMounted(true);
            setIntercutOpen(true);
          }}
          disabled={intercutProcessing}
        >
          ✂️ Create Intercut Clip
        </button>
      )}
      <AutoCutPanel />
      <ProxyPlaybackToggle />
      {videoCount > 0 && (
        <div className="clip-batch">
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={batchOpen}
            onClick={() => setBatchOpen((open) => !open)}
            disabled={processing}
          >
            {batchOpen ? 'Close batch processing' : 'Batch process clips…'}
          </button>
          {batchOpen && (
            <div className="clip-batch-panel">
              <p className="muted">Select video clips, then process them together.</p>
              <div className="clip-batch-selection-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={processing}
                  onClick={() => {
                    setBatchClipIds(videoClips.map((clip) => clip.id));
                    setCompletedBatchIds([]);
                  }}
                >
                  Select all videos
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={processing || batchClipIds.length === 0}
                  onClick={() => {
                    setBatchClipIds([]);
                    setCompletedBatchIds([]);
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="clip-batch-list" role="group" aria-label="Select clips for batch processing">
                {videoClips.map((clip) => (
                  <label key={clip.id} className="inspector-checkbox-label">
                    <input
                      type="checkbox"
                      checked={batchClipIds.includes(clip.id)}
                      disabled={processing}
                      onChange={(event) => {
                        setBatchClipIds((ids) =>
                          event.target.checked
                            ? [...ids, clip.id]
                            : ids.filter((id) => id !== clip.id),
                        );
                        setCompletedBatchIds([]);
                      }}
                    />
                    {clip.title}
                  </label>
                ))}
              </div>
              <label>
                Processing
                <select
                  value={batchBackend}
                  disabled={processing}
                  onChange={(event) =>
                    setBatchBackend(event.target.value as BatchProcessingOptions['backend'])
                  }
                >
                  <option value="hf-rife">HF RIFE interpolation</option>
                  <option value="browser-ffmpeg">Browser FFmpeg cleanup / conversion</option>
                </select>
              </label>
              {batchBackend === 'hf-rife' && (
                <p className="muted">
                  Selected clips are uploaded to the public Hugging Face RIFE Space.
                </p>
              )}
              {batchBackend === 'hf-rife' && (
                <label>
                  RIFE multiplier
                  <select
                    value={batchMultiplier}
                    disabled={processing}
                    onChange={(event) => setBatchMultiplier(Number(event.target.value) as 2 | 4)}
                  >
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </label>
              )}
              <label>
                Output format
                <select
                  value={batchOutputFormat}
                  disabled={processing}
                  onChange={(event) => setBatchOutputFormat(event.target.value as 'mp4' | 'prores')}
                >
                  <option value="mp4">MP4</option>
                  <option value="prores">ProRes MOV</option>
                </select>
              </label>
              <label className="inspector-checkbox-label">
                <input
                  type="checkbox"
                  checked={lightVideoCleanup}
                  disabled={processing}
                  onChange={(event) => setLightVideoCleanup(event.target.checked)}
                />
                Light denoise + deband
              </label>
              <label className="inspector-checkbox-label">
                <input
                  type="checkbox"
                  checked={audioCleanup}
                  disabled={processing}
                  onChange={(event) => setAudioCleanup(event.target.checked)}
                />
                Audio cleanup
              </label>
              <p className="muted">
                Cleanup options run independently of RIFE. ProRes MOV files are substantially larger.
                {batchBackend === 'browser-ffmpeg' &&
                  ' Select cleanup or ProRes output to enable FFmpeg processing.'}
              </p>
              <button
                type="button"
                className="btn-primary"
                disabled={processing || !canRunBatch}
                onClick={async () => {
                  setCompletedBatchIds([]);
                  const options: BatchProcessingOptions = {
                    backend: batchBackend,
                    multiplier: batchMultiplier,
                    outputFormat: batchOutputFormat,
                    lightVideoCleanup,
                    audioCleanup,
                  };
                  if (await onBatchProcess(selectedBatchClips.map((clip) => clip.id), options)) {
                    setCompletedBatchIds(selectedBatchClips.map((clip) => clip.id));
                  }
                }}
              >
                {processing
                  ? '⏳ Processing batch…'
                  : batchBackend === 'hf-rife'
                    ? `✨ Send ${selectedBatchClips.length} to RIFE`
                    : `Process ${selectedBatchClips.length} with FFmpeg`}
              </button>
              {completedBatchClips.length > 0 && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    for (const clip of completedBatchClips) {
                      const link = document.createElement('a');
                      link.href = clip.objectUrl;
                      link.download = clip.file.name;
                      document.body.appendChild(link);
                      link.click();
                      link.remove();
                    }
                  }}
                >
                  Download batch results ({completedBatchClips.length})
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {clips.length === 0 && activeGroups.length === 0 && (
        <p className="muted">No clips yet. Add clips above, or try “Load demo clips”.</p>
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
      {/* Portalled: `.panel`'s backdrop-filter makes it the containing block
          for fixed descendants, and the library zone scrolls, so a modal left
          in place would be clipped to the column. */}
      {intercutMounted && createPortal(
        <LazyBoundary label="Intercut generator" fallback={null}>
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
        </LazyBoundary>,
        document.body,
      )}
    </section>
  );
}

/**
 * Subscribes to the editor store per clip row so inspector edits and selection
 * changes only re-render the affected library items, not the full list.
 */
export const ClipLibrary = memo(ClipLibraryImpl);
