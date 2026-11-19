/**
 * The slate an offline clip shows (`Clip.offline`): a dark, striped frame
 * with "MEDIA OFFLINE" and the missing file's name, at the clip's size.
 *
 * Drawn once per name and size on an `OffscreenCanvas` (main thread and
 * workers alike) and handed out as a fresh `VideoFrame` per request, so the
 * compositor treats it like any decoded frame. Null where the realm has no
 * `OffscreenCanvas` / `VideoFrame` (tests), and the layer is then skipped.
 */

const MAX_SLATE_SIZE = 1920;
const cache = new Map<string, OffscreenCanvas>();

function slateCanvas(name: string, width: number, height: number): OffscreenCanvas | null {
  const key = `${width}x${height}:${name}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#1b1d22';
  ctx.fillRect(0, 0, width, height);
  // Diagonal warning stripes, as the timeline's offline lane item has.
  ctx.strokeStyle = 'rgba(255, 196, 0, 0.18)';
  ctx.lineWidth = Math.max(4, Math.round(height / 24));
  const step = ctx.lineWidth * 3;
  for (let x = -height; x < width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffc400';
  ctx.font = `bold ${Math.max(14, Math.round(height / 10))}px sans-serif`;
  ctx.fillText('MEDIA OFFLINE', width / 2, height * 0.42);
  ctx.fillStyle = '#e8e8e8';
  ctx.font = `${Math.max(10, Math.round(height / 22))}px sans-serif`;
  const label = name.length > 60 ? `${name.slice(0, 57)}…` : name;
  ctx.fillText(label, width / 2, height * 0.58, width * 0.9);
  if (cache.size > 16) cache.clear();
  cache.set(key, canvas);
  return canvas;
}

/** Slate size for a clip: its own size, capped, 16:9 when unknown. */
export function offlineSlateSize(width?: number, height?: number): { width: number; height: number } {
  const w = width && width > 0 ? width : 1280;
  const h = height && height > 0 ? height : 720;
  const scale = Math.min(1, MAX_SLATE_SIZE / Math.max(w, h));
  return { width: Math.max(2, Math.round(w * scale)), height: Math.max(2, Math.round(h * scale)) };
}

/** A slate frame for an offline clip (the caller closes it), or null where it cannot be drawn. */
export function offlineSlateFrame(
  clip: { title: string; offline?: { fileName: string } | undefined; videoWidth?: number | undefined; videoHeight?: number | undefined },
  timestamp = 0,
): VideoFrame | null {
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') return null;
  const { width, height } = offlineSlateSize(clip.videoWidth, clip.videoHeight);
  try {
    const canvas = slateCanvas(clip.offline?.fileName ?? clip.title, width, height);
    return canvas ? new VideoFrame(canvas, { timestamp }) : null;
  } catch {
    return null;
  }
}
