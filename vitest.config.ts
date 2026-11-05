import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
    // Emscripten glue uses `new URL(..., import.meta.url)`; Vite must not rewrite it.
    server: {
      deps: {
        external: [/\/public\/wasm\//],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.test.helpers.{ts,tsx}', 'src/**/*.d.ts'],
      // Floors for the pure domain directories, a few points under what the
      // suite measures today (`npm run test:coverage -- --run`), so they
      // ratchet without flaking. Raise them as coverage grows; never lower
      // one to land a change. Browser-glue dirs (export, webgpu, components,
      // ffmpeg) are left to the e2e harness.
      thresholds: {
        'src/timeline/**': { lines: 89, statements: 85, functions: 90, branches: 74 },
        'src/finishing/**': { lines: 93, statements: 91, functions: 94, branches: 76 },
        'src/captions/**': { lines: 81, statements: 76, functions: 87, branches: 75 },
        'src/project/**': { lines: 84, statements: 81, functions: 84, branches: 75 },
        'src/composition/**': { lines: 81, statements: 79, functions: 87, branches: 69 },
        'src/store/**': { lines: 89, statements: 86, functions: 83, branches: 73 },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
