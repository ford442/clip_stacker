import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM scripts without type declarations
import { parseArgs } from './render.mjs';
// @ts-expect-error — plain ESM scripts without type declarations
import { presetSettings } from './session.mjs';
// @ts-expect-error — plain ESM scripts without type declarations
import { TOOLS, callTool } from './mcp.mjs';

describe('cs', () => {
  it('parses commands, positionals, flags and options', () => {
    expect(parseArgs(['render', 'p.json', '--out', 'o.mp4', '--gpu', '--preset', '720p30'])).toEqual({
      command: 'render',
      options: { _: ['p.json'], out: 'o.mp4', gpu: true, preset: '720p30' },
    });
    expect(parseArgs(['stems', 'p.json', '--normalize', '--float', '--no-master']).options).toMatchObject({ normalize: true, float: true, 'no-master': true });
  });

  it('maps presets to export settings (the export grid is 30 fps)', () => {
    expect(presetSettings('1080p30')).toEqual({ outputResolution: '1920x1080' });
    expect(presetSettings('4k')).toEqual({ outputResolution: '3840x2160' });
    expect(presetSettings('320x180')).toEqual({ outputResolution: '320x180' });
    expect(presetSettings(undefined)).toEqual({});
    expect(() => presetSettings('1080p60')).toThrow(/30 fps/);
    expect(() => presetSettings('wide')).toThrow(/Unknown preset/);
  });
});

describe('cs mcp', () => {
  it('lists one tool per project API call, each with an object input schema', () => {
    const names = (TOOLS as Array<{ name: string; inputSchema: { type: string } }>).map((tool) => tool.name);
    expect(names).toEqual(['load_project', 'get_state', 'apply_ops', 'ops_schema', 'import_timeline', 'export_timeline', 'export_stems', 'render', 'undo']);
    for (const tool of TOOLS as Array<{ inputSchema: { type: string } }>) expect(tool.inputSchema.type).toBe('object');
  });

  it('calls window.clipStacker.project through the session and flags refusals as errors', async () => {
    const calls: unknown[][] = [];
    const session = {
      mediaRoot: 'http://127.0.0.1:1/__cs_media/',
      call: async (...args: unknown[]) => {
        calls.push(args);
        return args[0] === 'apply' ? { ok: false, errors: ['ops[0] (trim): locked'] } : { clips: [] };
      },
    };
    const state = await callTool(session, 'get_state', {});
    expect(JSON.parse(state.content[0].text)).toEqual({ clips: [] });
    const refused = await callTool(session, 'apply_ops', { ops: [{ op: 'trim', clipId: 'a' }] });
    expect(refused.isError).toBe(true);
    expect(calls[1]).toEqual(['apply', [{ op: 'trim', clipId: 'a' }], { mediaRoot: 'http://127.0.0.1:1/__cs_media/' }]);
    expect((await callTool(session, 'nope', {})).isError).toBe(true);
  });
});
