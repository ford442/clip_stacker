#!/usr/bin/env node
/**
 * `cs`: Clip Stacker without the UI — the real app, headless (session.mjs).
 *
 *   cs render  project.json --out out.mp4 [--media DIR] [--preset 1080p30]
 *   cs import  timeline.otio --out cut.json [--media DIR] [--rate 25]
 *   cs export  project.json --format otio|fcpxml|edl --out cut.otio [--media DIR]
 *   cs stems   project.json --out stems.zip [--media DIR] [--normalize] [--float]
 *   cs mcp     (an MCP server on stdio: scripts/cs/mcp.mjs)
 *
 * Common: --gpu (use the machine's GPU instead of SwiftShader), --headed.
 * Progress is JSON lines on stdout; the last line is the result. Exit codes:
 * 0 done, 2 refused (an offline clip, nothing to render, …), 1 error.
 * Run `npm run build` first: cs serves dist/ as `npm run preview` does.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { openSession, presetSettings } from './session.mjs';

const USAGE = `usage:
  cs render  <project.json> --out <out.mp4> [--media DIR] [--preset 1080p30|WxH]
  cs import  <timeline.otio|.fcpxml|.edl> --out <cut.json> [--media DIR] [--rate 25]
  cs export  <project.json> --format otio|fcpxml|edl --out <file> [--media DIR]
  cs stems   <project.json> --out <stems.zip> [--media DIR] [--normalize] [--float] [--no-master]
  cs mcp
options: --gpu  --headed`;

class Refused extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['gpu', 'headed', 'normalize', 'float', 'no-master'].includes(key)) options[key] = true;
    else options[key] = rest[++i];
  }
  return { command, options };
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function required(options, key, what) {
  const value = key === 0 ? options._[0] : options[key];
  if (!value) throw new Error(`${what} is required\n${USAGE}`);
  return value;
}

async function loadInto(session, projectPath) {
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  const report = await session.call('loadProject', project, session.mediaRoot ? { mediaRoot: session.mediaRoot } : {});
  emit({ event: 'loaded', project: projectPath, ...report });
  if (report.offline.length > 0) throw new Refused(`${report.offline.length} clip(s) offline (pass --media DIR): ${report.offline.join(', ')}`);
  return report;
}

const COMMANDS = {
  async render(session, options) {
    await loadInto(session, required(options, 0, 'a project file'));
    const out = required(options, 'out', '--out');
    const result = await session.call('render', presetSettings(options.preset));
    if (!result.ok) throw new Refused(result.status || 'Render produced no output.');
    const saved = await session.saveUrl(result.url, out);
    return { out: saved, encoderPath: result.encoderPath, plan: result.plan?.description ?? null };
  },
  async import(session, options) {
    const input = required(options, 0, 'a timeline file');
    const out = required(options, 'out', '--out');
    const text = await readFile(input, 'utf8');
    const report = await session.call('importTimeline', text, {
      fileName: path.basename(input),
      ...(session.mediaRoot ? { mediaRoot: session.mediaRoot } : {}),
      ...(options.rate ? { rate: options.rate } : {}),
    });
    const project = await session.call('getState');
    await writeFile(out, `${JSON.stringify(project, null, 2)}\n`);
    return { out: path.resolve(out), format: report.format, clips: report.clipCount, offline: report.offline, relinked: report.relinked.length };
  },
  async export(session, options) {
    await loadInto(session, required(options, 0, 'a project file'));
    const format = required(options, 'format', '--format');
    const out = required(options, 'out', '--out');
    await writeFile(out, await session.call('exportTimeline', format));
    return { out: path.resolve(out), format };
  },
  async stems(session, options) {
    await loadInto(session, required(options, 0, 'a project file'));
    const out = required(options, 'out', '--out');
    const report = await session.call('exportStems', {
      normalize: Boolean(options.normalize),
      format: options.float ? 'float32' : 'pcm24',
      includeMaster: !options['no-master'],
    });
    const saved = await session.saveUrl(report.url, out);
    return { out: saved, files: report.files.map((f) => ({ name: f.fileName, lufs: f.integratedLufs, truePeak: f.truePeakDbtp })) };
  },
};

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'mcp') {
    const { runMcpServer } = await import('./mcp.mjs');
    await runMcpServer();
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`${USAGE}\n`);
    return command ? 1 : 0;
  }
  let session = null;
  try {
    session = await openSession({ gpu: Boolean(options.gpu), headed: Boolean(options.headed), media: options.media ?? null, log: emit });
    const result = await run(session, options);
    emit({ event: 'done', command, ...result });
    return 0;
  } catch (error) {
    const refused = error instanceof Refused;
    emit({ event: refused ? 'refused' : 'error', command, message: error instanceof Error ? error.message : String(error), pageErrors: session?.pageErrors ?? [] });
    return refused ? 2 : 1;
  } finally {
    await session?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => process.exit(code));
}
