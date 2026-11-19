import { describe, expect, it } from 'vitest';
import { needsHashes, planRelink, type RelinkCandidate } from './relink';

const candidates: RelinkCandidate[] = [
  { key: 'drive-1', source: 'drive', name: 'a.mp4', driveId: 'D1' },
  { key: 'lib-1', source: 'library', name: 'a.mp4' },
  { key: 'file-1', source: 'file', name: 'media/B.MOV', hash: 'ABCDEF0123456789' },
  { key: 'drive-2', source: 'drive', name: 'other.mp4', driveId: 'D2' },
];

describe('planRelink', () => {
  it('matches by name (library first), then case, then hash, then Drive id', () => {
    const plan = planRelink(
      [
        { clipId: 'c1', reference: { name: 'a.mp4' } },
        { clipId: 'c2', reference: { name: 'b.mov' } },
        { clipId: 'c3', reference: { name: 'renamed.mov', hash: 'abcdef0123456789' } },
        { clipId: 'c4', reference: { name: 'gone.mp4', driveId: 'D2' } },
        { clipId: 'c5', reference: { name: 'missing.mp4', hash: 'ffff' } },
      ],
      candidates,
    );
    expect(plan.matches.map((m) => [m.clipId, m.candidate.key, m.by])).toEqual([
      ['c1', 'lib-1', 'name'],
      ['c2', 'file-1', 'name-ignoring-case'],
      ['c3', 'file-1', 'hash'],
      ['c4', 'drive-2', 'drive'],
    ]);
    expect(plan.unresolved).toEqual(['c5']);
  });

  it('asks for hashes only when an unmatched reference has one', () => {
    expect(needsHashes([{ clipId: 'x', reference: { name: 'a.mp4', hash: 'aa' } }], candidates)).toBe(false);
    expect(needsHashes([{ clipId: 'x', reference: { name: 'zz.mp4', hash: 'aa' } }], candidates)).toBe(true);
    expect(needsHashes([{ clipId: 'x', reference: { name: 'zz.mp4' } }], candidates)).toBe(false);
  });
});
