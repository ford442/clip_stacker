import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ZIP_ONLY_MESSAGE = 'Build zip archives with createZipBundle (src/export/container/zipBundle.ts), the only fflate import.';
const XML_ONLY_MESSAGE = 'Parse or build XML through src/interchange/xml.ts, the only fast-xml-parser import.';
const RESTRICTED_LIBRARIES = [
  { name: 'fflate', message: ZIP_ONLY_MESSAGE, owner: 'src/export/container/zipBundle.ts' },
  { name: 'fast-xml-parser', message: XML_ONLY_MESSAGE, owner: 'src/interchange/xml.ts' },
];
const TEST_FILES = ['src/**/*.test.{ts,tsx}', 'src/**/*.test.helpers.ts'];

/** `no-restricted-imports` blocks: every library is off-limits except in its owner (and tests). */
function restrictedImportBlocks() {
  const rule = (libraries) => [
    'error',
    {
      paths: libraries.map(({ name, message }) => ({ name, message })),
      patterns: libraries.map(({ name, message }) => ({ group: [`${name}/*`], message })),
    },
  ];
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      ignores: [...RESTRICTED_LIBRARIES.map(({ owner }) => owner), ...TEST_FILES],
      rules: { 'no-restricted-imports': rule(RESTRICTED_LIBRARIES) },
    },
    ...RESTRICTED_LIBRARIES.map(({ owner }) => ({
      files: [owner],
      rules: { 'no-restricted-imports': rule(RESTRICTED_LIBRARIES.filter((library) => library.owner !== owner)) },
    })),
  ];
}

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
    // Parked HuggingFace Spaces the app does not call (spaces/README.md).
    'spaces/',
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
      // Every hook rule is an error: the tree is clean, so a warning would
      // only be the first of a new pile. Sync props to state during render
      // (or derive it), and read refs in effects / handlers, not in render.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/refs': 'error',
    },
  },
  {
    // `any` switches type checking off for everything it touches. Use
    // `unknown` and narrow, or type the mock (`vi.mocked`, `Partial<T>`).
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
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
          pattern: 'src/{utils,export,timeline,finishing,captions,project,media,composition,remote,audio,webgpu,wasm,ffmpeg,gpu-chores,workers,interchange}/**',
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
    // Every worker goes through the typed RPC (src/workers/workerRpc.ts);
    // the literal `new Worker(new URL(...))` Vite needs lives in
    // src/workers/workerFactories.ts. The second selector is the dynamic
    // `import('fflate')` half of the fflate rule below.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/workers/**', 'src/**/*.test.{ts,tsx}', 'src/**/*.test.helpers.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Worker']",
          message: 'Create workers in src/workers/workerFactories.ts and talk to them through createWorkerClient (src/workers/workerRpc.ts).',
        },
        {
          selector: 'ImportExpression[source.value=/^fflate($|\\u002f)/]',
          message: ZIP_ONLY_MESSAGE,
        },
        {
          selector: 'ImportExpression[source.value=/^fast-xml-parser($|\\u002f)/]',
          message: XML_ONLY_MESSAGE,
        },
      ],
    },
  },
  // fflate is the zip writer behind src/export/container/zipBundle.ts, as
  // Mediabunny is the container library behind the rest of that directory;
  // fast-xml-parser is the XML reader / writer behind src/interchange/xml.ts.
  // ESLint replaces a rule's options per block rather than merging them, so
  // each wrapper is exempt from its own library and nothing else.
  ...restrictedImportBlocks(),
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
