# Architecture Update

Following the recent refactoring phase, the codebase has been significantly modularized to improve maintainability and readability.

## Changes Made:
- \`src/index.css\` (~1700 lines) was broken down into modular CSS files located in \`src/styles/\` (\`base.css\`, \`components.css\`, \`layout.css\`, \`variables.css\`, etc.)
- \`src/ffmpeg/ffmpegService.ts\` (~1800 lines) was transformed into a barrel file that exports smaller, focused modules (\`audio.ts\`, \`video.ts\`, \`merge.ts\`, \`mux.ts\`, \`plan.ts\`, etc.).
- \`src/ffmpeg/core.ts\` currently houses the core FFmpeg orchestration logic (~1282 lines).
- \`src/App.tsx\` handles the main UI layout and major React hooks (~1099 lines).

## Future Recommendations:
- Extract remaining state and logic from \`src/App.tsx\` into custom hooks (e.g., \`useProjectSaveLoad\`, \`useRenderState\`, \`useMediaExtraction\`).
- Break down \`src/ffmpeg/core.ts\` further by separating the loader/initialization logic and the progress/logging systems once circular dependencies are fully untangled.
