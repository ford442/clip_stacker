import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'dist/',
    'coverage/',
    // Claude Code / agent worktrees and settings: local, not part of the app.
    '.claude/',
    // Emscripten glue (public/wasm), the FFmpeg core and worklets are generated
    // or vendored; native/ and the Python side projects are not part of the app.
    'public/',
    'native/',
    'RIFE/',
    'huggingface/',
    'contabo_storage_manager/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler rules that flag existing prop-to-state syncing and
      // render-time ref reads. Warn until those components are reworked.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  {
    files: ['*.{js,ts}', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // Warn, not error: ~360 of the hits are unused imports copied into the
      // src/ffmpeg/* modules when they were split out of one file.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
