import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

/**
 * `npm run build:wasm:debug` writes -O0 / DWARF modules to
 * native/build-debug/wasm instead of over the committed public/wasm. Serve
 * them at /wasm-debug/ (dev and preview only); `?wasm_debug` points the
 * loaders there (src/wasm/emscriptenLoader.ts).
 */
function wasmDebugPlugin(): Plugin {
  const dir = fileURLToPath(new URL('./native/build-debug/wasm/', import.meta.url));
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    // One plain file name: no subdirectories, no traversal.
    const match = /\/wasm-debug\/([\w.-]+\.(js|wasm))$/.exec(path);
    if (!match) {
      next();
      return;
    }
    readFile(`${dir}${match[1]}`).then(
      (body) => {
        res.setHeader('Content-Type', match[2] === 'wasm' ? 'application/wasm' : 'text/javascript');
        res.end(body);
      },
      () => {
        res.statusCode = 404;
        res.end(`not built: run npm run build:wasm:debug (${match[1]})`);
      },
    );
  };
  return {
    name: 'clip-stacker-wasm-debug',
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), utf16JsMimePlugin(), wasmDebugPlugin()],
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
  worker: {
    format: 'es',
  },
});
