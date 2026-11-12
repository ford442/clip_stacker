import { useEffect, useState } from 'react';

/** The CSS media query for a display that can show HDR (high dynamic range). */
export const DISPLAY_HDR_QUERY = '(dynamic-range: high)';

function queryDisplayHdr(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia(DISPLAY_HDR_QUERY);
  } catch {
    return null;
  }
}

/**
 * Whether the window's display is HDR, following changes (the window moves
 * to another monitor, the OS toggles HDR). False where the query is
 * unsupported.
 */
export function useDisplayHdr(): boolean {
  const [hdr, setHdr] = useState(() => queryDisplayHdr()?.matches ?? false);
  useEffect(() => {
    const query = queryDisplayHdr();
    if (!query) return;
    const update = () => setHdr(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return hdr;
}
