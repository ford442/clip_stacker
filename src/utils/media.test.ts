import { describe, expect, it } from 'vitest';
import { detectMediaElementHasAudio, isImageFile } from './media';

function fakeVideo(
  extras: { audioTracks?: { length: number }; mozHasAudio?: boolean } = {},
): HTMLVideoElement {
  const el = document.createElement('video');
  Object.assign(el, extras);
  return el;
}

describe('detectMediaElementHasAudio', () => {
  it('returns true for HTMLAudioElement', () => {
    expect(detectMediaElementHasAudio(document.createElement('audio'))).toBe(true);
  });

  it('uses audioTracks when the browser exposes them', () => {
    expect(detectMediaElementHasAudio(fakeVideo({ audioTracks: { length: 1 } }))).toBe(true);
    expect(detectMediaElementHasAudio(fakeVideo({ audioTracks: { length: 0 } }))).toBe(false);
  });

  it('uses mozHasAudio when audioTracks is unavailable', () => {
    expect(detectMediaElementHasAudio(fakeVideo({ mozHasAudio: false }))).toBe(false);
    expect(detectMediaElementHasAudio(fakeVideo({ mozHasAudio: true }))).toBe(true);
  });

  it('returns undefined when the browser cannot tell', () => {
    expect(detectMediaElementHasAudio(fakeVideo())).toBeUndefined();
  });
});

describe('isImageFile', () => {
  it('matches image MIME types and still extensions', () => {
    expect(isImageFile({ type: 'image/png', name: 'x.bin' })).toBe(true);
    expect(isImageFile({ type: '', name: 'still.JPEG' })).toBe(true);
    expect(isImageFile({ type: 'video/mp4', name: 'clip.mp4' })).toBe(false);
  });
});
