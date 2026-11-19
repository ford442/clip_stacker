import { describe, expect, it } from 'vitest';
import { xxhash64, xxhash64String } from './xxhash64';

/** BigInt XXH64 straight from the spec: an independent oracle for random inputs. */
function referenceXxh64(bytes: Uint8Array, seed = 0n): string {
  const M = (1n << 64n) - 1n;
  const P1 = 0x9e3779b185ebca87n;
  const P2 = 0xc2b2ae3d27d4eb4fn;
  const P3 = 0x165667b19e3779f9n;
  const P4 = 0x85ebca77c2b2ae63n;
  const P5 = 0x27d4eb2f165667c5n;
  const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M;
  const u64 = (at: number) => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]!);
    return v;
  };
  const u32 = (at: number) => {
    let v = 0n;
    for (let i = 3; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]!);
    return v;
  };
  const round = (acc: bigint, input: bigint) => (rotl((acc + input * P2) & M, 31n) * P1) & M;
  const merge = (acc: bigint, val: bigint) => (((acc ^ round(0n, val)) * P1) + P4) & M;
  let at = 0;
  let h: bigint;
  if (bytes.length >= 32) {
    let v1 = (seed + P1 + P2) & M;
    let v2 = (seed + P2) & M;
    let v3 = seed;
    let v4 = (seed - P1) & M;
    while (at + 32 <= bytes.length) {
      v1 = round(v1, u64(at));
      v2 = round(v2, u64(at + 8));
      v3 = round(v3, u64(at + 16));
      v4 = round(v4, u64(at + 24));
      at += 32;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else {
    h = (seed + P5) & M;
  }
  h = (h + BigInt(bytes.length)) & M;
  while (at + 8 <= bytes.length) {
    h = (rotl(h ^ round(0n, u64(at)), 27n) * P1 + P4) & M;
    at += 8;
  }
  if (at + 4 <= bytes.length) {
    h = (rotl(h ^ ((u32(at) * P1) & M), 23n) * P2 + P3) & M;
    at += 4;
  }
  while (at < bytes.length) {
    h = (rotl(h ^ ((BigInt(bytes[at]!) * P5) & M), 11n) * P1) & M;
    at += 1;
  }
  h ^= h >> 33n;
  h = (h * P2) & M;
  h ^= h >> 29n;
  h = (h * P3) & M;
  h ^= h >> 32n;
  return h.toString(16).padStart(16, '0');
}

const ascii = (text: string) => new TextEncoder().encode(text);

describe('xxhash64', () => {
  // Vectors from the reference C implementation (python-xxhash).
  it.each([
    ['', 'ef46db3751d8e999', '95584af7701f808d'],
    ['a', 'd24ec4f1a98c6e5b', '747b860523d69ab6'],
    ['abc', '44bc2cf5ad770999', '01700e64f6f23509'],
    ['Nobody inspects the spammish repetition', 'fbcea83c8a378bf1', '081a876428a9313b'],
  ])('matches the reference for %j', (text, unseeded, seeded) => {
    expect(xxhash64(ascii(text))).toBe(unseeded);
    expect(xxhash64(ascii(text), 12345)).toBe(seeded);
    expect(xxhash64String(text)).toBe(unseeded);
  });

  it('matches the reference over a long input (every stripe and tail path)', () => {
    const bytes = new Uint8Array(771);
    for (let i = 0; i < 768; i++) bytes[i] = i & 0xff;
    bytes.set(ascii('xyz'), 768);
    expect(xxhash64(bytes)).toBe('e921a1b45bd779f8');
    expect(xxhash64(bytes, 12345)).toBe('6b1b5d671fb93b43');
  });

  it('agrees with a BigInt implementation on random inputs of every length class', () => {
    let state = 0x12345678;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let length = 0; length < 140; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = next() & 0xff;
      const seed = next();
      expect(xxhash64(bytes, seed)).toBe(referenceXxh64(bytes, BigInt(seed)));
    }
  });

  it('hashes UTF-8, not UTF-16', () => {
    expect(xxhash64String('é')).toBe(xxhash64(new Uint8Array([0xc3, 0xa9])));
  });
});
