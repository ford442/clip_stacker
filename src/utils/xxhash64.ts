/**
 * XXH64 (xxHash, 64-bit) in plain TypeScript: the content hash behind the
 * render cache's frame and segment keys (`export/renderKey.ts`).
 *
 * The output is the reference algorithm's, byte for byte (the tests pin it
 * against vectors from the C implementation), so moving the hash into the
 * media engine later (`xxhash.h`) changes no stored key. It runs in every
 * realm — main, the preview worker, tests — with no WASM load and no async
 * step, which `crypto.subtle` cannot offer per frame.
 *
 * 64-bit lanes are kept as two uint32 halves; multiplication is done in
 * 16-bit limbs so nothing leaves the exact range of a double.
 */

const P1_HI = 0x9e3779b1;
const P1_LO = 0x85ebca87;
const P2_HI = 0xc2b2ae3d;
const P2_LO = 0x27d4eb4f;
const P3_HI = 0x165667b1;
const P3_LO = 0x9e3779f9;
const P4_HI = 0x85ebca77;
const P4_LO = 0xc2b2ae63;
const P5_HI = 0x27d4eb2f;
const P5_LO = 0x165667c5;

/** A 64-bit lane as two uint32 halves, mutated in place. */
class U64 {
  hi: number;
  lo: number;

  constructor(hi = 0, lo = 0) {
    this.hi = hi >>> 0;
    this.lo = lo >>> 0;
  }

  set(hi: number, lo: number): this {
    this.hi = hi >>> 0;
    this.lo = lo >>> 0;
    return this;
  }

  add(hi: number, lo: number): this {
    const low = this.lo + lo;
    this.lo = low >>> 0;
    this.hi = (this.hi + hi + (low > 0xffffffff ? 1 : 0)) >>> 0;
    return this;
  }

  sub(hi: number, lo: number): this {
    const low = this.lo - lo;
    this.lo = low >>> 0;
    this.hi = (this.hi - hi - (low < 0 ? 1 : 0)) >>> 0;
    return this;
  }

  /** this = this × (hi, lo) mod 2^64. */
  mul(hi: number, lo: number): this {
    const al = this.lo;
    const a0 = al & 0xffff;
    const a1 = al >>> 16;
    const b0 = lo & 0xffff;
    const b1 = lo >>> 16;
    const p00 = a0 * b0;
    const p01 = a0 * b1;
    const p10 = a1 * b0;
    const p11 = a1 * b1;
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    const low = ((mid << 16) | (p00 & 0xffff)) >>> 0;
    const carry = p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
    this.hi = (carry + Math.imul(this.hi, lo) + Math.imul(al, hi)) >>> 0;
    this.lo = low;
    return this;
  }

  rotl(bits: number): this {
    const { hi, lo } = this;
    if (bits === 32) return this.set(lo, hi);
    if (bits < 32) {
      return this.set((hi << bits) | (lo >>> (32 - bits)), (lo << bits) | (hi >>> (32 - bits)));
    }
    const b = bits - 32;
    return this.set((lo << b) | (hi >>> (32 - b)), (hi << b) | (lo >>> (32 - b)));
  }

  xor(hi: number, lo: number): this {
    return this.set(this.hi ^ hi, this.lo ^ lo);
  }

  /** this ^= this >>> bits (bits < 64). */
  xorShiftRight(bits: number): this {
    const { hi, lo } = this;
    if (bits >= 32) return this.set(hi, lo ^ (hi >>> (bits - 32)));
    return this.set(hi ^ (hi >>> bits), lo ^ ((lo >>> bits) | (hi << (32 - bits))));
  }

  hex(): string {
    return this.hi.toString(16).padStart(8, '0') + this.lo.toString(16).padStart(8, '0');
  }
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0);
}

/** acc = rotl(acc + input × P2, 31) × P1 */
function round(acc: U64, input: U64): U64 {
  return acc.add(input.mul(P2_HI, P2_LO).hi, input.lo).rotl(31).mul(P1_HI, P1_LO);
}

const scratch = new U64();
const zero = new U64();

function mergeRound(acc: U64, val: U64): void {
  zero.set(0, 0);
  scratch.set(val.hi, val.lo);
  round(zero, scratch);
  acc.xor(zero.hi, zero.lo).mul(P1_HI, P1_LO).add(P4_HI, P4_LO);
}

/** XXH64 of `bytes` with a 32-bit `seed`, as 16 lowercase hex digits. */
export function xxhash64(bytes: Uint8Array, seed = 0): string {
  const length = bytes.length;
  const seedLo = seed >>> 0;
  let at = 0;
  const h = new U64();
  const lane = new U64();

  if (length >= 32) {
    const v1 = new U64(0, seedLo).add(P1_HI, P1_LO).add(P2_HI, P2_LO);
    const v2 = new U64(0, seedLo).add(P2_HI, P2_LO);
    const v3 = new U64(0, seedLo);
    const v4 = new U64(0, seedLo).sub(P1_HI, P1_LO);
    const limit = length - 32;
    while (at <= limit) {
      round(v1, lane.set(readU32(bytes, at + 4), readU32(bytes, at)));
      round(v2, lane.set(readU32(bytes, at + 12), readU32(bytes, at + 8)));
      round(v3, lane.set(readU32(bytes, at + 20), readU32(bytes, at + 16)));
      round(v4, lane.set(readU32(bytes, at + 28), readU32(bytes, at + 24)));
      at += 32;
    }
    h.set(v1.hi, v1.lo).rotl(1);
    const t = new U64(v2.hi, v2.lo).rotl(7);
    h.add(t.hi, t.lo);
    t.set(v3.hi, v3.lo).rotl(12);
    h.add(t.hi, t.lo);
    t.set(v4.hi, v4.lo).rotl(18);
    h.add(t.hi, t.lo);
    mergeRound(h, v1);
    mergeRound(h, v2);
    mergeRound(h, v3);
    mergeRound(h, v4);
  } else {
    h.set(0, seedLo).add(P5_HI, P5_LO);
  }

  h.add(Math.floor(length / 0x100000000), length >>> 0);

  const k1 = new U64();
  while (at + 8 <= length) {
    k1.set(0, 0);
    round(k1, lane.set(readU32(bytes, at + 4), readU32(bytes, at)));
    h.xor(k1.hi, k1.lo).rotl(27).mul(P1_HI, P1_LO).add(P4_HI, P4_LO);
    at += 8;
  }
  if (at + 4 <= length) {
    k1.set(0, readU32(bytes, at)).mul(P1_HI, P1_LO);
    h.xor(k1.hi, k1.lo).rotl(23).mul(P2_HI, P2_LO).add(P3_HI, P3_LO);
    at += 4;
  }
  while (at < length) {
    k1.set(0, bytes[at]!).mul(P5_HI, P5_LO);
    h.xor(k1.hi, k1.lo).rotl(11).mul(P1_HI, P1_LO);
    at += 1;
  }

  h.xorShiftRight(33).mul(P2_HI, P2_LO).xorShiftRight(29).mul(P3_HI, P3_LO).xorShiftRight(32);
  return h.hex();
}

const encoder = new TextEncoder();

/** XXH64 of a string's UTF-8 bytes. */
export function xxhash64String(text: string, seed = 0): string {
  return xxhash64(encoder.encode(text), seed);
}
