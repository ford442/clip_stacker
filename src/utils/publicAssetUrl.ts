/**
 * Resolve a path under the Vite `public/` directory to a fetchable URL.
 * Honors `import.meta.env.BASE_URL` so assets work when the app is hosted
 * from a subdirectory (e.g. /clip-stacker/) instead of the domain root.
 */
export function resolvePublicAssetUrl(publicPath: string): string {
  const normalized = publicPath.replace(/^\/+/, '');
  const base = import.meta.env.BASE_URL || '/';

  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL(normalized, document.baseURI).href;
  }

  return new URL(normalized, base).href;
}
