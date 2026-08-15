import { describe, expect, it } from 'vitest';
import {
  encodeUtf16LeWithBom,
  rewriteJsImportsToUtf16,
} from './utf16-dual-encode.mjs';

describe('utf16-dual-encode', () => {
  it('rewrites .js module specifiers to .1ijs without touching source maps', () => {
    const input = [
      'import x from"./chunk-abc.js";',
      "import('./lazy-def.js');",
      'new URL("./worker-ghi.js", import.meta.url);',
      '//# sourceMappingURL=index-xyz.js.map',
    ].join('\n');

    const out = rewriteJsImportsToUtf16(input);
    expect(out).toContain('./chunk-abc.1ijs');
    expect(out).toContain('./lazy-def.1ijs');
    expect(out).toContain('./worker-ghi.1ijs');
    expect(out).toContain('sourceMappingURL=index-xyz.js.map');
    expect(out).not.toContain('sourceMappingURL=index-xyz.1ijs.map');
  });

  it('encodes UTF-16LE with BOM like iconv -t UTF-16LE', () => {
    const buf = encodeUtf16LeWithBom('ok\n');
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
    // 'o' 'k' '\\n' as LE code units
    expect(buf.subarray(2).equals(Buffer.from('ok\n', 'utf16le'))).toBe(true);
    // Roughly 2× payload for ASCII + 2-byte BOM
    expect(buf.byteLength).toBe(2 + 3 * 2);
  });
});
