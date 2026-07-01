// Beat-lane (time-grid tab view) adaptive subdivision + swing feel.
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const { laneBeatK, swungTickInBar, dynamicsToVelocity, ottavaSemitones, WHOLE_TICKS } = C;

const bar = (durs) => ({ voices: [{ beats: durs.map((d) => ({ duration: d })) }] });
const QUARTER = WHOLE_TICKS / 4;    // 960 — simple-meter beat unit

describe('laneBeatK (simple meter)', () => {
  it('all quarters -> 1 subdivision per beat', () => {
    expect(laneBeatK(bar([4, 4, 4, 4]), QUARTER, false)).toBe(1);
  });
  it('eighths present -> 2 per beat', () => {
    expect(laneBeatK(bar([8, 8, 8, 8]), QUARTER, false)).toBe(2);
  });
  it('sixteenths present -> 4 per beat', () => {
    expect(laneBeatK(bar([16, 16]), QUARTER, false)).toBe(4);
  });
  it('adapts to the SMALLEST value in the bar', () => {
    expect(laneBeatK(bar([4, 8, 16, 4]), QUARTER, false)).toBe(4);
  });
  it('ignores tuplet beats when choosing the grid', () => {
    const tupletBar = { voices: [{ beats: [
      { duration: 8, tupletNumerator: 3, tupletDenominator: 2 },
      { duration: 4 },
    ] }] };
    // only the straight quarter counts -> 1 per beat
    expect(laneBeatK(tupletBar, QUARTER, false)).toBe(1);
  });
});

describe('laneBeatK (compound meter)', () => {
  const DOTTED_QUARTER = WHOLE_TICKS * 3 / 8;   // 1440 — 6/8 counted-beat unit
  it('eighths in 6/8 -> 3 per dotted-quarter beat', () => {
    expect(laneBeatK(bar([8, 8, 8, 8, 8, 8]), DOTTED_QUARTER, true)).toBe(3);
  });
});

describe('swungTickInBar', () => {
  it('is identity at a beat boundary', () => {
    expect(swungTickInBar(0)).toBe(0);
    expect(swungTickInBar(QUARTER)).toBe(QUARTER);
  });
  it('pushes the mid-beat eighth later (long-short swing)', () => {
    // Straight 480 (half of a 960 quarter) swings out toward ~640 (2/3 of the beat).
    expect(swungTickInBar(480)).toBe(640);
  });
});

describe('dynamicsToVelocity', () => {
  it('non-numeric -> default mf 0.85', () => expect(dynamicsToVelocity(undefined)).toBe(0.85));
  it('linear in the middle', () => expect(dynamicsToVelocity(5)).toBeCloseTo(0.8, 10));
  it('clamps loud to 1.0', () => expect(dynamicsToVelocity(20)).toBe(1.0));
  it('clamps soft to 0.2', () => expect(dynamicsToVelocity(-20)).toBe(0.2));
});

describe('ottavaSemitones', () => {
  const OT = { Regular: 0, Va8: 1, Vb8: 2, Ma15: 3, Mb15: 4 };
  it('regular / missing enum / non-numeric -> 0', () => {
    expect(ottavaSemitones(OT.Regular, OT)).toBe(0);
    expect(ottavaSemitones(1, null)).toBe(0);
    expect(ottavaSemitones('x', OT)).toBe(0);
  });
  it('octave and double-octave shifts', () => {
    expect(ottavaSemitones(OT.Va8, OT)).toBe(12);
    expect(ottavaSemitones(OT.Vb8, OT)).toBe(-12);
    expect(ottavaSemitones(OT.Ma15, OT)).toBe(24);
    expect(ottavaSemitones(OT.Mb15, OT)).toBe(-24);
  });
});
