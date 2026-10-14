import { describe, expect, it } from 'vitest';
import { createMemoryMediaStore, fingerprintMedia, FINGERPRINT_EDGE_BYTES } from './mediaStore';

describe('createMemoryMediaStore', () => {
  it('puts, gets, and deletes by key', async () => {
    const store = createMemoryMediaStore();
    const blob = new Blob([new Uint8Array([1, 2])]);
    expect(await store.get('k')).toBeNull();
    await store.put('k', blob);
    expect(await store.has('k')).toBe(true);
    expect(await store.get('k')).toBe(blob);
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
    // Deleting a missing key is a no-op.
    await store.delete('k');
  });

  it('is not persistent', () => {
    expect(createMemoryMediaStore().persistent).toBe(false);
  });
});

describe('fingerprintMedia', () => {
  it('is stable for the same bytes and differs for different bytes', async () => {
    const a = await fingerprintMedia(new Blob([new Uint8Array([1, 2, 3])]));
    const a2 = await fingerprintMedia(new Blob([new Uint8Array([1, 2, 3])]));
    const b = await fingerprintMedia(new Blob([new Uint8Array([1, 2, 4])]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a2).toBe(a);
    expect(b).not.toBe(a);
  });

  it('sees a change in the tail of a large file', async () => {
    const size = FINGERPRINT_EDGE_BYTES * 3;
    const one = new Uint8Array(size);
    const two = new Uint8Array(size);
    two[size - 1] = 7;
    expect(await fingerprintMedia(new Blob([one]))).not.toBe(await fingerprintMedia(new Blob([two])));
  });
});
