import type { Plugin } from 'vite';

/**
 * Content-Security-Policy for clip_stacker — the single source for the
 * `<meta>` tag Vite writes into index.html (`cspMetaPlugin`) and the
 * dev/preview server headers in vite.config.ts. `public/.htaccess` repeats it
 * for Apache; csp.test.ts fails if that copy drifts.
 *
 * connect-src and media-src use https: because storage endpoints and remote
 * media URLs are user-configurable (Contabo/S3 signed URLs, etc.).
 *
 * Google Drive import needs exactly: the Identity Services script + stylesheet
 * and the Picker script/frames, all on drive-auth.html (the editor does not
 * embed them). Nothing broader.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // blob: required for @ffmpeg/util toBlobURL dynamic imports of the WASM core
  "script-src 'self' 'wasm-unsafe-eval' blob: https://accounts.google.com/gsi/client https://apis.google.com",
  "frame-src https://accounts.google.com/gsi/ https://docs.google.com https://content.googleapis.com",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' blob: https: wss:",
].join('; ');

/** Dev-server CSP — adds WebSocket hosts required by Vite HMR. */
export const DEV_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace(
  "connect-src 'self' blob: https: wss:",
  "connect-src 'self' blob: https: wss: ws://localhost:5173 ws://127.0.0.1:5173",
);

/**
 * Directives browsers ignore — and log a console error for — when the policy
 * arrives in a `<meta>` element instead of a header. They still apply through
 * the server headers (.htaccess, dev/preview).
 */
const META_IGNORED_DIRECTIVES = new Set(['frame-ancestors', 'report-uri', 'sandbox']);

/** `policy` minus the directives a `<meta>` policy cannot carry. */
export function toMetaContentSecurityPolicy(policy: string): string {
  return policy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => {
      const name = directive.split(/\s+/, 1)[0]?.toLowerCase();
      return Boolean(name) && !META_IGNORED_DIRECTIVES.has(name);
    })
    .join('; ');
}

const CSP_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i;

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Insert the CSP `<meta>` right after `<meta charset>` (or at the top of
 * `<head>`), ahead of every script so the whole document is covered.
 * Throws when the page already declares one: a second, hand-written copy is
 * exactly the drift this generator exists to prevent.
 */
export function injectCspMeta(html: string, policy: string): string {
  if (CSP_META_RE.test(html)) {
    throw new Error(
      'index.html must not declare its own Content-Security-Policy <meta>; it is generated from src/utils/csp.ts.',
    );
  }
  const tag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(
    toMetaContentSecurityPolicy(policy),
  )}" />`;
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (charset) {
    const end = charset.index + charset[0].length;
    return `${html.slice(0, end)}\n    ${tag}${html.slice(end)}`;
  }
  const head = /<head[^>]*>/i.exec(html);
  if (!head) throw new Error('index.html has no <head> to put the CSP <meta> in.');
  const end = head.index + head[0].length;
  return `${html.slice(0, end)}\n    ${tag}${html.slice(end)}`;
}

/**
 * Writes the CSP `<meta>` into index.html: the production policy for builds,
 * the dev-server policy (HMR WebSockets) under `vite` serve, matching the
 * header each server sends.
 */
export function cspMetaPlugin(): Plugin {
  return {
    name: 'clip-stacker-csp-meta',
    transformIndexHtml(html, ctx) {
      return injectCspMeta(
        html,
        ctx.server ? DEV_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY,
      );
    },
  };
}
