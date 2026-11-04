import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import boundaries from 'eslint-plugin-boundaries';
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
    // Typed rules (they need the TS program). A promise nobody awaits or
    // catches turns a failure into an unhandled rejection and a silent bug;
    // mark intentional fire-and-forget calls with `void`.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Layering (#365): types → core (pure domain modules and the engines) →
    // store → actions / playback services → hooks / context → components →
    // app. A layer imports only itself and the layers to its left, so
    // webgpu/, wasm/ and every worker stay free of stores and React. Tests
    // are exempt: an integration test may drive a store from below.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/**/*.test.helpers.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
      'boundaries/elements': [
        { type: 'types', partialMatch: false, pattern: 'src/types/**' },
        {
          type: 'core',
          partialMatch: false,
          pattern: 'src/{utils,export,timeline,finishing,captions,project,media,composition,remote,audio,webgpu,wasm,ffmpeg,gpu-chores}/**',
        },
        { type: 'store', partialMatch: false, pattern: 'src/store/**' },
        { type: 'actions', partialMatch: false, pattern: 'src/{actions,playback}/**' },
        { type: 'hooks', partialMatch: false, pattern: 'src/{hooks,context}/**' },
        { type: 'components', partialMatch: false, pattern: 'src/components/**' },
        { type: 'app', partialMatch: false, pattern: 'src/app/**' },
      ],
      // The entry files sit in src/ itself; element patterns match folders.
      'boundaries/files': [{ pattern: 'src/{App.tsx,main.tsx,vite-env.d.ts}', category: 'entry' }],
    },
    rules: {
      // A file outside every layer is an error: a new top-level directory
      // must be given a place in the stack above.
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          policies: [
            { allow: { to: { module: { origin: 'external' } } } },
            { allow: { to: { module: { origin: 'core' } } } },
            { from: { element: { type: 'types' } }, allow: { to: { element: { type: 'types' } } } },
            {
              // Shared types may name a domain type (`import type`), never a value.
              from: { element: { type: 'types' } },
              allow: { to: { element: { type: 'core' } }, dependency: { kind: 'type' } },
            },
            {
              from: { element: { type: 'core' } },
              allow: { to: { element: { types: { anyOf: ['types', 'core'] } } } },
            },
            {
              from: { element: { type: 'store' } },
              allow: { to: { element: { types: { anyOf: ['types', 'core', 'store'] } } } },
            },
            {
              from: { element: { type: 'actions' } },
              allow: { to: { element: { types: { anyOf: ['types', 'core', 'store', 'actions'] } } } },
            },
            {
              from: { element: { type: 'hooks' } },
              allow: {
                to: { element: { types: { anyOf: ['types', 'core', 'store', 'actions', 'hooks'] } } },
              },
            },
            {
              from: { element: { type: 'components' } },
              allow: {
                to: {
                  element: { types: { anyOf: ['types', 'core', 'store', 'actions', 'hooks', 'components'] } },
                },
              },
            },
            { from: { element: { type: 'app' } }, allow: { to: { element: { type: '*' } } } },
            { from: { file: { categories: 'entry' } }, allow: { to: { element: { type: '*' } } } },
            { from: { file: { categories: 'entry' } }, allow: { to: { file: { categories: 'entry' } } } },
            {
              // Pure domain code, the engines and workers never touch React.
              from: { element: { types: { anyOf: ['types', 'core'] } } },
              disallow: { to: { module: { origin: 'external', source: ['react', 'react-dom', 'react/*', 'react-dom/*', 'zustand', 'zustand/*'] } } },
              message: 'core / types modules must not import React or zustand (they run in workers and tests without a DOM)',
            },
          ],
        },
      ],
    },
  },
  {
    // Split a module before it passes 700 lines (tests are exempt): files
    // grew past this unnoticed when it was only a convention.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'max-lines': ['error', { max: 700 }],
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
      // Unused bindings are errors; prefix an intentionally unused one with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
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
