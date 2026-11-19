import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';

const mediaMocks = vi.hoisted(() => ({
  getMediaInfo: vi.fn(),
  createClipId: vi.fn(),
}));

vi.mock('../media/media', () => ({
  MIN_CLIP_DURATION: 0.1,
  getMediaInfo: mediaMocks.getMediaInfo,
  createClipId: mediaMocks.createClipId,
}));

import { decodeDataUrl, isDataUrl } from './dataUrl';
import { applyProjectData } from './applyProjectData';
import { downloadRemoteMedia } from './remoteMedia';

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The production CSP's `connect-src` blocks `fetch('data:…')`; happy-dom
 * enforces no CSP, so every test here makes fetch throw the way the browser
 * does. A regression that routes embedded media back through fetch fails.
 */
function blockFetchLikeCsp() {
  const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('decodeDataUrl', () => {
  it('recognizes data: URLs only', () => {
    expect(isDataUrl('data:video/mp4;base64,AAAA')).toBe(true);
    expect(isDataUrl('DATA:,hello')).toBe(true);
    expect(isDataUrl('https://example.com/data:,x')).toBe(false);
    expect(isDataUrl('blob:https://example.com/1')).toBe(false);
  });

  it('decodes base64 payloads with their media type', async () => {
    const bytes = Uint8Array.from({ length: 257 }, (_, i) => (i * 37) & 0xff);
    const blob = decodeDataUrl(`data:video/mp4;base64,${toBase64(bytes)}`);
    expect(blob.type).toBe('video/mp4');
    expect(await bytesOf(blob)).toEqual(Array.from(bytes));
  });

  it('decodes every padding length, unpadded and URL-safe base64', async () => {
    for (const length of [0, 1, 2, 3, 4, 5]) {
      const bytes = Uint8Array.from({ length }, (_, i) => 250 + i);
      const standard = toBase64(bytes);
      const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(await bytesOf(decodeDataUrl(`data:;base64,${standard}`))).toEqual(Array.from(bytes));
      expect(await bytesOf(decodeDataUrl(`data:;base64,${urlSafe}`))).toEqual(Array.from(bytes));
    }
  });

  it('decodes payloads larger than one atob chunk', async () => {
    const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => (i * 13) & 0xff);
    const blob = decodeDataUrl(`data:application/octet-stream;base64,${toBase64(bytes)}`);
    const decoded = new Uint8Array(await blob.arrayBuffer());
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(bytes[0]);
    expect(decoded[1024 * 1024]).toBe(bytes[1024 * 1024]);
    expect(decoded[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });

  it('decodes percent-encoded (non-base64) payloads', async () => {
    const blob = decodeDataUrl('data:text/plain;charset=utf-8,h%C3%A9llo');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('héllo');
  });

  it('rejects malformed input', () => {
    expect(() => decodeDataUrl('https://example.com/a.mp4')).toThrow(/Not a data: URL/);
    expect(() => decodeDataUrl('data:video/mp4;base64,@@@@')).toThrow(/corrupt/);
  });
});

describe('embedded media restore never fetches', () => {
  beforeEach(() => {
    mediaMocks.getMediaInfo.mockReset().mockResolvedValue({ duration: 4, objectUrl: 'blob:restored' });
    mediaMocks.createClipId.mockReset().mockReturnValue('restored-clip-id');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloadRemoteMedia decodes a data: URL without fetch', async () => {
    const fetchMock = blockFetchLikeCsp();
    const onProgress = vi.fn();
    const blob = await downloadRemoteMedia('data:video/mp4;base64,AAEC', onProgress);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(blob.type).toBe('video/mp4');
    expect(await bytesOf(blob)).toEqual([0, 1, 2]);
    expect(onProgress).toHaveBeenLastCalledWith(1, false);
  });

  it('applyProjectData restores embedded clips while fetch is blocked', async () => {
    const fetchMock = blockFetchLikeCsp();
    const project: Project = {
      mediaMode: 'embed',
      clips: [
        {
          id: 'saved-a',
          title: 'a.mp4',
          kind: 'video',
          duration: 4,
          trimStart: 0.5,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: 'a.mp4',
          fileType: 'video/mp4',
          sourceMediaDataUrl: 'data:video/mp4;base64,AAECAw==',
        },
      ],
    };

    const result = await applyProjectData(project, []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.mediaDownloadWarnings).toEqual([]);
    expect(result.clips).toHaveLength(1);
    const restored = result.clips[0];
    expect(restored?.file.name).toBe('a.mp4');
    expect(restored?.file.type).toBe('video/mp4');
    expect(restored?.trimStart).toBe(0.5);
    expect(restored?.remoteSourceUrl).toBeUndefined();
    expect(await bytesOf(restored!.file)).toEqual([0, 1, 2, 3]);
  });
});
