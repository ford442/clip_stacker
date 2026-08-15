import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { CONTENT_SECURITY_POLICY, DEV_CONTENT_SECURITY_POLICY } from './src/utils/csp';

/**
 * Serve .1ijs (UTF-16LE dual-encoded JS) with an explicit charset so browsers
 * can decode the module source. Without this, many static servers treat .1ijs
 * as application/octet-stream and the ?utf16=1 path fails.
 */
function utf16JsMimePlugin(): Plugin {
  const setMime: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    if (url.includes('.1ijs')) {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-16le');
    }
    next();
  };
  return {
    name: 'clip-stacker-utf16-js-mime',
    configureServer(server) {
      server.middlewares.use(setMime);
    },
    configurePreviewServer(server) {
      server.middlewares.use(setMime);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), utf16JsMimePlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: 'localhost',
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': DEV_CONTENT_SECURITY_POLICY,
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
