import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureWhisperHttpProvider,
  parseTranscriptionResponse,
  whisperHttpCaptionProvider,
} from './whisperHttpCaptionProvider';

afterEach(() => {
  configureWhisperHttpProvider(null);
  vi.unstubAllGlobals();
});

describe('parseTranscriptionResponse', () => {
  it('reads OpenAI verbose_json segments', () => {
    expect(
      parseTranscriptionResponse({
        segments: [{ start: 0.5, end: 1.5, text: 'hello' }],
      }),
    ).toEqual([{ startSec: 0.5, endSec: 1.5, text: 'hello' }]);
  });

  it('reads whisper.cpp server millisecond offsets', () => {
    expect(
      parseTranscriptionResponse({
        transcription: [{ offsets: { from: 500, to: 1500 }, text: 'hello' }],
      }),
    ).toEqual([{ startSec: 0.5, endSec: 1.5, text: 'hello' }]);
  });

  it('reads Transformers.js chunk timestamps', () => {
    expect(
      parseTranscriptionResponse({
        chunks: [{ timestamp: [1, 2], text: 'hi' }],
      }),
    ).toEqual([{ startSec: 1, endSec: 2, text: 'hi' }]);
  });

  it('ignores rows without usable timings and non-object payloads', () => {
    expect(parseTranscriptionResponse({ segments: [{ text: 'no times' }] })).toEqual([]);
    expect(parseTranscriptionResponse(null)).toEqual([]);
    expect(parseTranscriptionResponse('nope')).toEqual([]);
  });
});

describe('whisperHttpCaptionProvider', () => {
  it('is unavailable without an endpoint, and for non-https endpoints', async () => {
    expect(await whisperHttpCaptionProvider.isAvailable()).toBe(false);
    configureWhisperHttpProvider('http://example.com/inference');
    expect(await whisperHttpCaptionProvider.isAvailable()).toBe(false);
    configureWhisperHttpProvider('https://example.com/inference');
    expect(await whisperHttpCaptionProvider.isAvailable()).toBe(true);
  });

  it('posts the audio and maps the response onto the output timeline', async () => {
    configureWhisperHttpProvider('https://example.com/inference');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ segments: [{ start: 0, end: 1, text: 'hello' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cues = await whisperHttpCaptionProvider.transcribe(
      new Blob([new Uint8Array(8)], { type: 'audio/wav' }),
      { timeOffsetSec: 5, language: 'en' },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/inference');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(cues).toHaveLength(1);
    expect(cues[0].startSec).toBe(5);
    expect(cues[0].endSec).toBe(6);
    expect(cues[0].text).toBe('hello');
  });

  it('surfaces a failed request as an error', async () => {
    configureWhisperHttpProvider('https://example.com/inference');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' }),
    );
    await expect(
      whisperHttpCaptionProvider.transcribe(new Blob([new Uint8Array(4)])),
    ).rejects.toThrow(/503/);
  });
});
