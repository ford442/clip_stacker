import type { Clip } from '../types';
import { proxyActions, useProxyState } from '../store/proxyStore';
import { planProxy, proxyBadgeFor } from '../utils/proxyMedia';

/**
 * Library row chip: Original / Building / Proxy, plus a "Build proxy" action
 * for clips big enough to need one. Audio-only clips and stills render nothing.
 */
export function ProxyBadge({ clip }: { clip: Clip }) {
  const building = useProxyState((s) => s.building);
  const ready = useProxyState((s) => s.ready);
  const queued = useProxyState((s) => s.queue.includes(clip.id));
  const error = useProxyState((s) => s.errors[clip.id]);

  if (clip.kind !== 'video' || clip.stillImage) return null;
  const badge = proxyBadgeFor(clip, { building, ready });
  const plan = planProxy(clip);

  if (badge === 'building') {
    const pct = Math.round((building[clip.id]?.progress ?? 0) * 100);
    return (
      <span className="proxy-badge proxy-badge-building" title="Building preview proxy">
        Building {pct}%
      </span>
    );
  }
  if (badge === 'proxy') {
    const proxy = clip.proxy!;
    return (
      <span
        className="proxy-badge proxy-badge-ready"
        title={`Preview reads a ${proxy.width}×${proxy.height} proxy; export reads the original`}
      >
        Proxy
      </span>
    );
  }
  return (
    <>
      <span
        className="proxy-badge proxy-badge-original"
        title={error ? `Proxy build failed: ${error}` : 'Preview decodes the original file'}
      >
        Original{error ? ' ⚠' : ''}
      </span>
      {plan.ok && (
        <button
          type="button"
          className="proxy-build-btn"
          disabled={queued}
          onClick={(e) => {
            e.stopPropagation();
            proxyActions.requestProxy(clip.id);
          }}
          title={`Build a ${plan.width}×${plan.height} preview proxy for smoother scrubbing`}
          aria-label={`Build preview proxy for ${clip.title}`}
        >
          {queued ? 'Queued' : 'Build proxy'}
        </button>
      )}
    </>
  );
}

/** "Use proxies for playback" — shown once any proxy exists. */
export function ProxyPlaybackToggle() {
  const enabled = useProxyState((s) => s.enabled);
  const anyReady = useProxyState((s) => Object.keys(s.ready).length > 0);
  if (!anyReady) return null;
  return (
    <label className="proxy-toggle" title="Off decodes the original files in preview; export always does">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => proxyActions.setEnabled(e.target.checked)}
      />{' '}
      Use proxies for playback
    </label>
  );
}
