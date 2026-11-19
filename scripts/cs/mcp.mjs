#!/usr/bin/env node
/**
 * `cs mcp`: an MCP server (stdio) over a headless Clip Stacker session, so an
 * MCP client (Claude Code included) can cut, grade, mix and render without
 * the UI. Each tool is one call into `window.clipStacker.project` through the
 * Playwright page (`session.mjs`); paths are on this machine.
 *
 *   claude mcp add clip-stacker -- node scripts/cs/mcp.mjs --media ./media
 *
 * Local only: stdio transport, no listening socket. The page never sees
 * credentials; Drive import stays interactive (in the app).
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openSession, presetSettings } from './session.mjs';

const FORMAT = { type: 'string', enum: ['otio', 'fcpxml', 'edl'] };

/** Tool definitions: JSON Schema inputs, each mapped to one API call below. */
export const TOOLS = [
  {
    name: 'load_project',
    description: 'Open a saved Clip Stacker project (a .json path or the JSON itself). Media is found by file name in the media folder.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to a project .json.' }, project: { type: 'object', description: 'The project JSON itself.' } },
    },
  },
  {
    name: 'get_state',
    description: 'The open project as its saved JSON: clips (ids, trims), tracks (lane ids, placements), transitions, titles, captions, finishing, buses.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apply_ops',
    description: 'Apply ProjectOps (one undo step, all or nothing): addClip, placeClip, move, trim, split, duplicate, removeClip, setClip, setTransition, setKeyframes, addTrack, setTrack, setTrackAudioFx, setDuck, setMasterBus, setFinishing, addMarker, setCaptions, setTextOverlay, setExportSettings, setTimecode. Call `ops_schema` for the JSON Schema.',
    inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object' } } }, required: ['ops'] },
  },
  {
    name: 'ops_schema',
    description: 'The JSON Schema of ProjectOp and an agent brief.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'import_timeline',
    description: 'Replace the project with a timeline file (OTIO, FCPXML or CMX 3600 EDL). Missing media imports offline.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, format: FORMAT, rate: { type: 'string', description: 'EDL timecode rate when it does not say (e.g. "25").' } }, required: ['path'] },
  },
  {
    name: 'export_timeline',
    description: 'Write the open timeline as OTIO, FCPXML 1.11 or CMX 3600 EDL.',
    inputSchema: { type: 'object', properties: { format: FORMAT, path: { type: 'string' } }, required: ['format', 'path'] },
  },
  {
    name: 'export_stems',
    description: 'Write one Broadcast WAV per lane plus the master (zipped with the timeline and a manifest).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, normalize: { type: 'boolean' }, float: { type: 'boolean' }, includeMaster: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'render',
    description: 'Render the open timeline to an MP4 at a preset (720p30, 1080p30, 1440p30, 4k30 or WIDTHxHEIGHT).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, preset: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'undo',
    description: 'Undo the last edit (an apply_ops batch is one step).',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

/** Run one tool against a session; returns an MCP tool result. */
export async function callTool(session, name, args = {}) {
  const media = session.mediaRoot ? { mediaRoot: session.mediaRoot } : {};
  switch (name) {
    case 'load_project': {
      const project = args.project ?? JSON.parse(await readFile(String(args.path), 'utf8'));
      return text(await session.call('loadProject', project, media));
    }
    case 'get_state':
      return text(await session.call('getState'));
    case 'apply_ops': {
      const result = await session.call('apply', args.ops, media);
      return { ...text(result), isError: !result.ok };
    }
    case 'ops_schema':
      return text({ brief: await session.call('agentBrief'), schema: await session.call('schema') });
    case 'import_timeline': {
      const file = String(args.path);
      const options = { fileName: path.basename(file), ...media, ...(args.format ? { format: args.format } : {}), ...(args.rate ? { rate: args.rate } : {}) };
      return text(await session.call('importTimeline', await readFile(file, 'utf8'), options));
    }
    case 'export_timeline':
      await writeFile(String(args.path), await session.call('exportTimeline', args.format));
      return text(`Wrote ${path.resolve(String(args.path))}`);
    case 'export_stems': {
      const report = await session.call('exportStems', {
        normalize: Boolean(args.normalize),
        format: args.float ? 'float32' : 'pcm24',
        includeMaster: args.includeMaster !== false,
      });
      const out = await session.saveUrl(report.url, String(args.path));
      return text({ out, files: report.files });
    }
    case 'render': {
      const result = await session.call('render', presetSettings(args.preset));
      if (!result.ok) return { ...text(result.status || 'Render produced no output.'), isError: true };
      return text({ out: await session.saveUrl(result.url, String(args.path)), encoderPath: result.encoderPath });
    }
    case 'undo':
      await session.call('undo');
      return text('Undone.');
    default:
      return { ...text(`Unknown tool "${name}".`), isError: true };
  }
}

/** Start the server on stdio; the browser session opens on the first tool call. */
export async function runMcpServer(argv = process.argv.slice(2)) {
  const mediaIndex = argv.indexOf('--media');
  const media = mediaIndex >= 0 ? argv[mediaIndex + 1] : null;
  const gpu = argv.includes('--gpu');
  let session = null;
  const ready = async () => (session ??= await openSession({ gpu, media, log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`) }));

  const server = new Server({ name: 'clip-stacker', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(await ready(), request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  });
  const shutdown = async () => {
    await session?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('end', () => void shutdown());
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
