/**
 * Content-Security-Policy for clip_stacker.
 *
 * connect-src and media-src use https: because storage endpoints and remote
 * media URLs are user-configurable (Contabo/S3 signed URLs, etc.).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // blob: required for @ffmpeg/util toBlobURL dynamic imports of the WASM core
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' blob: https: wss:",
].join('; ');

/** Dev/preview CSP — adds WebSocket hosts required by Vite HMR. */
export const DEV_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace(
  "connect-src 'self' blob: https: wss:",
  "connect-src 'self' blob: https: wss: ws://localhost:5173 ws://127.0.0.1:5173",
);
