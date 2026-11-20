import { useEffect, useState } from 'react';
import { RENDER_CACHE_BUDGETS, useRenderCacheStore, renderCacheStore } from '../../store/renderCacheStore';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Export tab → Render cache: the per-browser render cache, smart render and
 * preview cache settings, what the cache holds, and Clear.
 */
export function RenderCacheFields() {
  const settings = useRenderCacheStore((s) => s.settings);
  const usage = useRenderCacheStore((s) => s.usage);
  const storage = useRenderCacheStore((s) => s.storage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void renderCacheStore.getState().refresh().catch(() => undefined);
  }, []);

  const update = renderCacheStore.getState().update;
  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await renderCacheStore.getState().clear();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label
        className="inspector-checkbox-label"
        title="Keep each rendered segment, keyed by its content, and reuse it when a later export draws the same frames."
      >
        <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        Render cache
      </label>
      <label
        className="inspector-checkbox-label"
        title="Copy the source's encoded frames wherever the timeline shows an H.264 clip untouched at the output size."
      >
        <input
          type="checkbox"
          checked={settings.smartRender}
          onChange={(e) => update({ smartRender: e.target.checked })}
        />
        Smart render (copy untouched source GOPs)
      </label>
      <label title="Least recently used segments are removed past this size.">
        Cache budget
        <select
          value={settings.budgetBytes}
          onChange={(e) => update({ budgetBytes: Number(e.target.value) })}
          disabled={!settings.enabled}
        >
          {(RENDER_CACHE_BUDGETS.includes(settings.budgetBytes)
            ? RENDER_CACHE_BUDGETS
            : [...RENDER_CACHE_BUDGETS, settings.budgetBytes].sort((a, b) => a - b)
          ).map((bytes) => (
            <option key={bytes} value={bytes}>
              {formatBytes(bytes)}
            </option>
          ))}
        </select>
      </label>
      <p className="inspector-hint" data-testid="render-cache-usage">
        {usage
          ? `${usage.entries} segment${usage.entries === 1 ? '' : 's'}, ${formatBytes(usage.bytes)} of ${formatBytes(usage.budgetBytes)}` +
            (usage.persistent ? ' (kept across reloads)' : ' (memory only: this browser has no writable OPFS)')
          : 'Opening the cache…'}
        {storage && storage.quota > 0
          ? ` · site storage ${formatBytes(storage.usage)} of ${formatBytes(storage.quota)}`
          : ''}
      </p>
      <label
        className="inspector-checkbox-label"
        title="Keep composed preview frames in GPU memory so a heavy stack plays back smoothly once rendered."
      >
        <input
          type="checkbox"
          checked={settings.previewCache}
          onChange={(e) => update({ previewCache: e.target.checked })}
        />
        Preview cache (RAM preview)
      </label>
      <label
        className="inspector-checkbox-label"
        title="While playback is paused, render the frames after the playhead into the preview cache."
      >
        <input
          type="checkbox"
          checked={settings.backgroundRender}
          disabled={!settings.previewCache}
          onChange={(e) => update({ backgroundRender: e.target.checked })}
        />
        Background render while idle
      </label>
      <button type="button" className="btn-secondary" onClick={() => void clear()} disabled={busy}>
        {busy ? 'Clearing…' : 'Clear render cache'}
      </button>
      {error && <p className="inspector-hint">Could not clear: {error}</p>}
      <p className="inspector-hint">
        Cached segments are re-used only when every input matches — media, edits, finishing, colour and the
        encoder settings — so a changed title re-encodes just the frames it covers. Copied spans keep the
        source&apos;s quality and bitrate; Force re-encode turns copying off. <code>?no_render_cache</code> turns
        both off for one page load.
      </p>
    </>
  );
}
