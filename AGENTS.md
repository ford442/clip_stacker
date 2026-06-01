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
