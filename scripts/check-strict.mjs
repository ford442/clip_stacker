#!/usr/bin/env node
/**
 * Strictness ratchet: run `tsc -p tsconfig.strict.json` (noUncheckedIndexedAccess
 * + exactOptionalPropertyTypes) and
 *   - fail on any error in a non-test file under a `strictDirs` entry of
 *     scripts/strict-ratchet.json, and
 *   - fail when the non-test errors elsewhere exceed `baseline` (lower it as
 *     directories are cleaned; `--update` writes the current count).
 * Test files (`*.test.ts(x)`, `*.test.helpers.ts`) are reported, not counted.
 *
 * tsc type-checks every file an included file imports, so the directory list
 * lives here rather than in the tsconfig `include`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'scripts/strict-ratchet.json');
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TEST_RE = /\.test\.tsx?$|\.test\.helpers\.ts$/;

/** @param {string} output tsc --pretty false output */
export function parseTscErrors(output) {
  const errors = [];
  for (const line of output.split('\n')) {
    const m = ERROR_RE.exec(line.trim());
    if (m) errors.push({ file: m[1].replaceAll('\\', '/'), line: Number(m[2]), code: m[4], message: m[5] });
  }
  return errors;
}

/**
 * @param {{ file: string }[]} errors
 * @param {{ strictDirs: string[], baseline: number }} config
 */
export function classifyErrors(errors, config) {
  const inStrict = (file) => config.strictDirs.some((dir) => file === dir || file.startsWith(`${dir}/`));
  const nonTest = errors.filter((e) => !TEST_RE.test(e.file));
  return {
    strict: nonTest.filter((e) => inStrict(e.file)),
    elsewhere: nonTest.filter((e) => !inStrict(e.file)),
    tests: errors.length - nonTest.length,
  };
}

function main() {
  const update = process.argv.includes('--update');
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.strict.json', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const errors = parseTscErrors(`${run.stdout}\n${run.stderr}`);
  if (run.status !== 0 && errors.length === 0) {
    console.error(run.stdout, run.stderr);
    process.exit(run.status ?? 1);
  }
  const { strict, elsewhere, tests } = classifyErrors(errors, config);
  for (const e of strict) console.error(`${e.file}(${e.line}): ${e.code} ${e.message}`);
  console.log(
    `[strict] ${strict.length} in strict dirs (${config.strictDirs.join(', ')}), ` +
      `${elsewhere.length} elsewhere (baseline ${config.baseline}), ${tests} in tests (not counted)`,
  );
  if (update) {
    config.baseline = elsewhere.length;
    fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`[strict] baseline set to ${elsewhere.length}`);
  }
  let failed = false;
  if (strict.length > 0) {
    console.error('[strict] strict directories must have 0 errors.');
    failed = true;
  }
  if (!update && elsewhere.length > config.baseline) {
    console.error(`[strict] ${elsewhere.length} errors outside the strict dirs exceeds the baseline ${config.baseline}.`);
    failed = true;
  }
  if (!update && elsewhere.length < config.baseline) {
    console.log(`[strict] below baseline — run \`npm run typecheck:strict -- --update\` to lock in ${elsewhere.length}.`);
  }
  if (failed) process.exit(1);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
