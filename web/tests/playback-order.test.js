// computePlaybackOrder — unroll repeat barlines + D.C./D.S. jumps into the bar sequence
// actually played. Silent, nasty-to-debug bugs live here (a wrong repeat = wrong playback).
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const score = (masterBars) => ({ masterBars });

// A stand-in for alphaTab.model.Direction; `directions` on a bar is a Set of these values.
const D = {
  TargetSegno: 'segno', TargetFine: 'fine',
  JumpDaCapo: 'dc', JumpDaCapoAlFine: 'dcAlFine',
  JumpDalSegno: 'ds', JumpDalSegnoAlFine: 'dsAlFine',
};
const dir = (...vals) => ({ directions: new Set(vals) });

describe('computePlaybackOrder — no directions', () => {
  it('plain bars play in order', () => {
    expect(C.computePlaybackOrder(score([{}, {}, {}, {}]), null)).toEqual([0, 1, 2, 3]);
  });

  it('empty / missing score -> empty order', () => {
    expect(C.computePlaybackOrder(score([]), null)).toEqual([]);
    expect(C.computePlaybackOrder(null, null)).toEqual([]);
  });
});

describe('computePlaybackOrder — repeats', () => {
  it('replays from the repeat-start on a x2 repeat end', () => {
    const mbs = [{ isRepeatStart: true }, {}, {}, { repeatCount: 2 }];
    expect(C.computePlaybackOrder(score(mbs), null)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('repeatCount 3 plays the section three times', () => {
    const mbs = [{ isRepeatStart: true }, { repeatCount: 3 }];
    expect(C.computePlaybackOrder(score(mbs), null)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('an implicit repeat-start is bar 0', () => {
    const mbs = [{}, {}, { repeatCount: 2 }];
    expect(C.computePlaybackOrder(score(mbs), null)).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

describe('computePlaybackOrder — jumps', () => {
  it('Da Capo returns to the top once, then plays through', () => {
    const mbs = [{}, {}, dir(D.JumpDaCapo)];
    expect(C.computePlaybackOrder(score(mbs), D)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('D.S. al Fine jumps to the Segno then stops at Fine', () => {
    const mbs = [{}, dir(D.TargetSegno), dir(D.TargetFine), dir(D.JumpDalSegnoAlFine)];
    // 0,1,2,3 -> jump to segno(1) -> 1,2(=Fine, stop)
    expect(C.computePlaybackOrder(score(mbs), D)).toEqual([0, 1, 2, 3, 1, 2]);
  });

  it('a jump fires only once (no infinite loop)', () => {
    const mbs = [{}, dir(D.JumpDaCapo)];
    const order = C.computePlaybackOrder(score(mbs), D);
    expect(order).toEqual([0, 1, 0, 1]);
  });

  it('Fine is inert without an al-Fine jump', () => {
    const mbs = [{}, dir(D.TargetFine), {}];
    expect(C.computePlaybackOrder(score(mbs), D)).toEqual([0, 1, 2]);
  });

  it('passing D=null ignores directions but still repeats', () => {
    const mbs = [{ isRepeatStart: true }, dir(D.JumpDaCapo), { repeatCount: 2 }];
    // D=null: the JumpDaCapo Set is ignored; only the x2 repeat drives the order.
    expect(C.computePlaybackOrder(score(mbs), null)).toEqual([0, 1, 2, 0, 1, 2]);
  });
});
