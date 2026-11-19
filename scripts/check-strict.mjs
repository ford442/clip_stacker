#!/usr/bin/env node
/**
 * Strictness ratchets. Each entry of `ratchets` in scripts/strict-ratchet.json
 * runs `tsc -p <tsconfig>` and
 *   - fails on any error in a file under one of its `strictDirs`, and
 *   - fails when the errors elsewhere exceed its `baseline` (lower it as
 *     directories are cleaned; `--update` writes the current counts).
 * Test files count like any other file unless the ratchet sets
 * `"excludeTests": true` (then they are reported, not counted).
 *
 * `strict` (tsconfig.strict.json: noUncheckedIndexedAccess +
 * exactOptionalPropertyTypes) covers all of src/ with a zero baseline. The
 * entries after it are the next flags the codebase is moving to.
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
 * @param {{ strictDirs: string[], excludeTests?: boolean }} ratchet
 */
export function classifyErrors(errors, ratchet) {
  const inStrict = (file) => ratchet.strictDirs.some((dir) => file === dir || file.startsWith(`${dir}/`));
  const counted = ratchet.excludeTests ? errors.filter((e) => !TEST_RE.test(e.file)) : errors;
  return {
    strict: counted.filter((e) => inStrict(e.file)),
    elsewhere: counted.filter((e) => !inStrict(e.file)),
    tests: errors.length - counted.length,
  };
}

/** Top-level `src/<dir>` counts, for the report. */
export function countByDir(errors) {
  const counts = new Map();
  for (const { file } of errors) {
    const dir = file.split('/').slice(0, 2).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function runTsc(tsconfig) {
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  const run = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const errors = parseTscErrors(`${run.stdout}\n${run.stderr}`);
  if (run.status !== 0 && errors.length === 0) {
    console.error(run.stdout, run.stderr);
    process.exit(run.status ?? 1);
  }
  return errors;
}

function main() {
  const update = process.argv.includes('--update');
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  let failed = false;
  for (const ratchet of config.ratchets) {
    const tag = `[${ratchet.name}]`;
    const { strict, elsewhere, tests } = classifyErrors(runTsc(ratchet.tsconfig), ratchet);
    for (const e of strict) console.error(`${e.file}(${e.line}): ${e.code} ${e.message}`);
    const dirs = countByDir(elsewhere)
      .map(([dir, n]) => `${dir} ${n}`)
      .join(', ');
    console.log(
      `${tag} ${strict.length} in strict dirs (${ratchet.strictDirs.join(', ') || 'none'}), ` +
        `${elsewhere.length} elsewhere (baseline ${ratchet.baseline})${dirs ? `: ${dirs}` : ''}` +
        (tests > 0 ? `; ${tests} in tests (not counted)` : ''),
    );
    if (update) {
      ratchet.baseline = elsewhere.length;
      console.log(`${tag} baseline set to ${elsewhere.length}`);
    }
    if (strict.length > 0) {
      console.error(`${tag} strict directories must have 0 errors.`);
      failed = true;
    }
    if (!update && elsewhere.length > ratchet.baseline) {
      console.error(`${tag} ${elsewhere.length} errors outside the strict dirs exceeds the baseline ${ratchet.baseline}.`);
      failed = true;
    }
    if (!update && elsewhere.length < ratchet.baseline) {
      console.log(`${tag} below baseline — run \`npm run typecheck:strict -- --update\` to lock in ${elsewhere.length}.`);
    }
  }
  if (update) fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  if (failed) process.exit(1);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
