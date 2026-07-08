# Repository Guidelines

## Project Structure & Module Organization

This is a React 18 + TypeScript Vite app for browser-based clip editing and MP4 rendering with FFmpeg WebAssembly. Source lives in `src/`: `main.tsx` bootstraps React, `App.tsx` owns app-level state, `components/` contains UI panels, `ffmpeg/` contains FFmpeg WASM orchestration, `utils/` contains media/project/render helpers, `hooks/` contains shared React hooks, and `types/` holds shared TypeScript types. Tests are colocated with source as `*.test.ts` or `*.test.tsx`. Static deployment assets live in `public/`; built output goes to `dist/` and should be treated as generated.

## Build, Test, and Development Commands

- `npm install`: install dependencies for local development.
- `npm run dev`: start the Vite dev server with the headers needed for FFmpeg WASM.
- `npm test -- --run`: run the Vitest suite once, matching CI behavior.
- `npm run test:coverage`: run tests with coverage reporting.
- `npm run build`: produce the production build in `dist/`.
- `npm run preview`: serve the built app locally for verification.
- `npm run deploy`: build, then upload `dist/` using `deploy.py`.

## Coding Style & Naming Conventions

Use TypeScript with strict checking. Follow the existing style: two-space indentation, single quotes, semicolons, named exports for reusable components/functions, and `PascalCase` for React components such as `ClipLibrary.tsx`. Utilities should use descriptive `camelCase` names, for example `calculateRenderPlan` or `serializeProjectWithMedia`. Prefer the `@/` alias for imports from `src` when it improves readability. Keep comments focused on non-obvious behavior, especially around FFmpeg, memory cleanup, and browser media APIs.

## Testing Guidelines

Vitest runs in the `happy-dom` environment and includes `src/**/*.test.ts` and `src/**/*.test.tsx`. Add tests beside the module being changed, using names like `project.test.ts` or `ffmpegService.load.test.ts`. Cover render-plan decisions, project serialization, transition logic, and failure paths when editing shared utilities. Before submitting, run `npm test -- --run` and `npm run build`.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits, sometimes with conventional prefixes, for example `fix: harden Extract Audio...` or `Chore: improve FFmpeg robustness...`. Keep commits focused and explain user-visible behavior changes. Pull requests should include a concise summary, test results, linked issues when applicable, and screenshots or recordings for UI changes. Note any changes affecting deployment headers, remote storage endpoints, FFmpeg loading, or generated media behavior.

## Security & Configuration Tips

Do not commit secrets, storage auth tokens, or private endpoint credentials. Preserve COOP/COEP headers in Vite and Apache configuration because SharedArrayBuffer and FFmpeg WASM depend on them.

## Cursor Cloud specific instructions

Single-service product: a React + TypeScript Vite frontend (no backend to run; `contabo_storage_manager/` is an optional external storage backend, not started here). Standard commands live in `package.json` / README (`npm test -- --run`, `npm run build`, `npm run dev`, `npm run preview`).

Non-obvious caveats:

- Dependencies are installed with `npm install`, not `npm ci`: the committed `package-lock.json` historically drifted from `package.json` (missing optional `@esbuild/*` platform packages), which makes `npm ci` abort.
- `npm run dev` does not render in a CSP-enforcing browser as-is. `index.html` ships a static `Content-Security-Policy` meta tag with `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-inline'`), which blocks Vite's injected inline React-refresh/HMR preamble script and leaves a blank page with `@vitejs/plugin-react can't detect preamble` console errors. To run/verify the app in the browser, use the production build instead: `npm run build` then `npm run preview` (serves on `http://localhost:4173/`, no inline scripts, CSP-clean). Do not relax the CSP just to make dev mode load unless that is the actual task.
- FFmpeg WASM needs cross-origin isolation; both the dev and preview servers already set the required COOP/COEP headers, so use those servers rather than a generic static server.

## Text overlay fonts

Text overlays (`TextOverlay`) carry an optional `font` id (string). When omitted or unknown on load, the overlay falls back to the default Roboto Regular for backward compatibility with old projects.

Bundled fonts live in `public/fonts/` and are registered in one place:

- `src/utils/textOverlay.ts` — `BUNDLED_FONTS`, `getBundledFont(id)`, `resolveFontFileForOverlay`, `buildDrawtextFilter`
- `src/ffmpeg/core.ts` — `ensureFont` / `ensureFontsForOverlays`, `FONT_URL_BY_VIRTUAL` (virtual name → fetch URL)
- `src/utils/canvas-renderer.ts` — `drawTextLayer` sets `ctx.font` using the CSS `familyName`
- `src/styles/fonts.css` — `@font-face` declarations (required for Canvas2D metrics)
- `src/utils/project.ts` — `applyProjectData` resolves font ids with safe fallback; `serializeProject` round-trips the id as-is

Adding a font:

1. Place a license-safe `.ttf` in `public/fonts/`.
2. Add an entry to `BUNDLED_FONTS` with stable `id`, display `label`, CSS `familyName`, `fileName`, and `virtualName` (the name written to the FFmpeg VFS).
3. Add a matching `@font-face` in `src/styles/fonts.css` pointing at `/fonts/<fileName>`.
4. If the virtual name is new, add a URL mapping in `FONT_URL_BY_VIRTUAL` in `core.ts`.
5. Add or update tests in `textOverlay.test.ts` (filter strings) and `project.test.ts` (round-trip + unknown fallback).
6. Update docs (README table + this section).

Current small set (license notes):
- Roboto Regular/Bold — Apache License 2.0 (Google)
- DejaVu Serif / Sans Mono — Bitstream Vera fonts (public domain-like) + DejaVu additions (free)

Never embed user-supplied custom fonts (out of scope).
