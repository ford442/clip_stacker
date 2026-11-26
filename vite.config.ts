import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// `.js` resolves to csp.ts for both TypeScript and Vite's config bundler, and
// keeps the import extension-explicit for Vite's planned native config loader.
import {
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
  cspMetaPlugin,
} from './src/utils/csp.js';
import { APP_COOP, DRIVE_AUTH_COOP, isDriveAuthDocument } from './src/remote/driveAuth.js';

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

/**
 * Pin every emitted stylesheet to UTF-8. Without an HTTP charset, a BOM or an
 * @charset rule a browser decodes a linked stylesheet with the encoding of the
 * document that links it, and the minifier drops any @charset we write in the
 * source. A host that serves index.html as UTF-16 (the .1ijs experiment's
 * iconv workflow) would otherwise turn the whole stylesheet into mojibake and
 * leave the page unstyled.
 */
function cssCharsetPlugin(): Plugin {
  return {
    name: 'clip-stacker-css-charset',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !fileName.endsWith('.css')) continue;
        const css = typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString('utf8');
        if (!css.startsWith('@charset')) asset.source = `@charset "UTF-8";${css}`;
      }
    },
  };
}

// COOP/COEP make the page cross-origin isolated: SharedArrayBuffer and the
// multi-threaded FFmpeg core depend on them. drive-auth.html drops both so
// the Google sign-in popup and the Drive Picker iframe can load.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': APP_COOP,
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** The sign-in document must not inherit the app's isolating COOP or COEP. */
function driveAuthCoopMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (isDriveAuthDocument(req.url)) {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: number | string | readonly string[]) => {
        const header = name.toLowerCase();
        if (header === 'cross-origin-opener-policy') return setHeader(name, DRIVE_AUTH_COOP);
        if (header === 'cross-origin-embedder-policy') {
          res.removeHeader(name);
          return res;
        }
        return setHeader(name, value);
      }) as typeof res.setHeader;
    }
    next();
  };
}

/**
 * Content hash of everything that decides a rendered pixel: the app source
 * (shaders, plan maths), the WASM modules and the bundled fonts. The render
 * cache keys on it (`__CLIP_STACKER_BUILD_ID__`, `utils/buildId.ts`), so a
 * redeploy that changes how frames are drawn never reuses old frames, and
 * one that does not keeps the cache.
 */
function renderBuildId(): string {
  const hash = createHash('sha256');
  const root = fileURLToPath(new URL('.', import.meta.url));
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (/\.test(\.helpers)?\.tsx?$/.test(name)) continue;
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        // Relative, so every checkout of the same commit builds the same id.
        hash.update(relative(root, path).split(sep).join('/'));
        hash.update(readFileSync(path));
      }
    }
  };
  for (const dir of ['src', 'public/wasm', 'public/fonts']) visit(join(root, dir));
  return hash.digest('hex').slice(0, 16);
}

/** The commit being built: CI's `GITHUB_SHA`, else `git rev-parse HEAD`. */
function commitSha(): string {
  const fromEnv = process.env.GITHUB_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const BUILD_ID = renderBuildId();
const COMMIT_SHA = commitSha();

/** `<meta name="clip-stacker-build|commit">` so the live page names its build. */
function buildInfoMetaPlugin(): Plugin {
  return {
    name: 'clip-stacker-build-info-meta',
    transformIndexHtml() {
      return [
        { tag: 'meta', attrs: { name: 'clip-stacker-build', content: BUILD_ID }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'clip-stacker-commit', content: COMMIT_SHA }, injectTo: 'head' },
      ];
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __CLIP_STACKER_BUILD_ID__: JSON.stringify(BUILD_ID),
    __CLIP_STACKER_COMMIT_SHA__: JSON.stringify(COMMIT_SHA),
  },
  plugins: [
    {
      name: 'clip-stacker-drive-auth-coop',
      configureServer(server) {
        server.middlewares.use(driveAuthCoopMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(driveAuthCoopMiddleware());
      },
    },
    react(),
    utf16JsMimePlugin(),
    wasmDebugPlugin(),
    cspMetaPlugin(),
    buildInfoMetaPlugin(),
    cssCharsetPlugin(),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        driveAuth: fileURLToPath(new URL('./drive-auth.html', import.meta.url)),
      },
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    headers: {
      ...CROSS_ORIGIN_ISOLATION_HEADERS,
      'Content-Security-Policy': DEV_CONTENT_SECURITY_POLICY,
    },
  },
  preview: {
    headers: {
      ...CROSS_ORIGIN_ISOLATION_HEADERS,
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
});
