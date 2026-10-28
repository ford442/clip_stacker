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
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.test.helpers.ts', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
