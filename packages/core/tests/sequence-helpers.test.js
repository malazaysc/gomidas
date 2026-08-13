// crescendoFactors (hairpin velocity ramp) + freeMelodicChannel (metronome channel pick).
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

// Standard alphaTab CrescendoType.
const CT = { None: 0, Crescendo: 1, Decrescendo: 2 };
const beats = (types) => types.map((t) => ({ crescendo: t }));

describe('crescendoFactors', () => {
  it('all-flat beats stay at 1.0', () => {
    expect(C.crescendoFactors(beats([0, 0, 0]), CT)).toEqual([1, 1, 1]);
  });

  it('a crescendo run ramps 0.6 -> 1.0 across its span', () => {
    // 3 crescendo beats: fracs 0, 0.5, 1 -> 0.6, 0.8, 1.0
    expect(C.crescendoFactors(beats([1, 1, 1]), CT)).toEqual([0.6, 0.8, 1.0]);
  });

  it('a decrescendo run ramps 1.0 -> 0.6', () => {
    expect(C.crescendoFactors(beats([2, 2, 2]), CT)).toEqual([1.0, 0.8, 0.6]);
  });

  it('a lone hairpin beat gets the peak value (run of 1)', () => {
    expect(C.crescendoFactors(beats([1]), CT)).toEqual([1]);     // frac forced to 1
    expect(C.crescendoFactors(beats([2]), CT)).toEqual([1.0 - 0.4]);
  });

  it('separates adjacent runs of different type', () => {
    // [cresc,cresc] then [dim,dim]: each ramps within its own 2-beat run.
    expect(C.crescendoFactors(beats([1, 1, 2, 2]), CT)).toEqual([0.6, 1.0, 1.0, 0.6]);
  });

  it('leaves flat beats between hairpins at 1.0', () => {
    expect(C.crescendoFactors(beats([0, 1, 1, 0]), CT)).toEqual([1, 0.6, 1.0, 1]);
  });

  it('defaults CT when not supplied', () => {
    expect(C.crescendoFactors(beats([1, 1]))).toEqual([0.6, 1.0]);
  });
});

describe('freeMelodicChannel', () => {
  const track = (ch) => ({ playbackInfo: { primaryChannel: ch } });

  it('returns the first channel not used by any track (and never 9)', () => {
    // tracks on 0 and 1 -> first free is 2.
    expect(C.freeMelodicChannel({ tracks: [track(0), track(1)] })).toBe(2);
  });

  it('always treats channel 9 (percussion) as taken', () => {
    // Only ch9 is a "drum track"; melodic pick must skip it and return 0.
    expect(C.freeMelodicChannel({ tracks: [track(9)] })).toBe(0);
  });

  it('an empty / missing score yields channel 0', () => {
    expect(C.freeMelodicChannel({ tracks: [] })).toBe(0);
    expect(C.freeMelodicChannel(null)).toBe(0);
  });

  it('returns -1 when all 16 channels are taken', () => {
    const tracks = [];
    for (let c = 0; c < 16; c++) tracks.push(track(c));
    expect(C.freeMelodicChannel({ tracks })).toBe(-1);
  });
});
