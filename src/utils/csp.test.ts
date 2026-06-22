import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './csp';

describe('CONTENT_SECURITY_POLICY', () => {
  it('allows blob: scripts for FFmpeg WASM dynamic imports', () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src[^;]*\bblob:/);
  });

  it('allows blob: workers for FFmpeg WASM', () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/worker-src[^;]*\bblob:/);
  });
});
