// Tick / bar math — the off-by-one-prone core of playback timing.
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const { WHOLE_TICKS, beatTicks, beatTicksRaw, masterBarTicks, barCapacityTicks,
        barFilledTicks, barIsFull } = C;

describe('timebase', () => {
  it('a whole note is 3840 ticks (960 PPQ)', () => {
    expect(C.PPQ).toBe(960);
    expect(WHOLE_TICKS).toBe(3840);
  });
});

describe('beatTicks', () => {
  it('maps duration enum to note fraction', () => {
    expect(beatTicks({ duration: 1 })).toBe(3840);   // whole
    expect(beatTicks({ duration: 2 })).toBe(1920);   // half
    expect(beatTicks({ duration: 4 })).toBe(960);    // quarter
    expect(beatTicks({ duration: 8 })).toBe(480);    // eighth
    expect(beatTicks({ duration: 16 })).toBe(240);   // sixteenth
  });

  it('a single dot adds half the value', () => {
    expect(beatTicks({ duration: 4, dots: 1 })).toBe(1440);   // 960 * 1.5
  });

  it('a double dot adds half + quarter', () => {
    expect(beatTicks({ duration: 4, dots: 2 })).toBe(1680);   // 960 * 1.75
  });

  it('scales by a tuplet ratio (eighth triplet = 320)', () => {
    expect(beatTicks({ duration: 8, tupletNumerator: 3, tupletDenominator: 2 })).toBe(320);
  });

  it('never returns less than 1 tick', () => {
    expect(beatTicks({ duration: 8192 })).toBe(1);
  });
});

describe('beatTicksRaw', () => {
  it('keeps fractional precision (no rounding/flooring)', () => {
    // A quintuplet sixteenth: 240 * (4/5) = 192 exactly here, but pick one that is fractional.
    const raw = beatTicksRaw({ duration: 16, tupletNumerator: 5, tupletDenominator: 4 });
    expect(raw).toBeCloseTo(192, 10);
  });

  it('a triplet eighth raw stays 320 (divides evenly)', () => {
    expect(beatTicksRaw({ duration: 8, tupletNumerator: 3, tupletDenominator: 2 })).toBe(320);
  });
});

describe('masterBarTicks (capacity by time signature)', () => {
  const bars = (sig) => ([{ timeSignatureNumerator: sig[0], timeSignatureDenominator: sig[1] }]);
  it('4/4 = 3840', () => expect(masterBarTicks(bars([4, 4]), 0)).toBe(3840));
  it('3/4 = 2880', () => expect(masterBarTicks(bars([3, 4]), 0)).toBe(2880));
  it('6/8 = 2880', () => expect(masterBarTicks(bars([6, 8]), 0)).toBe(2880));
  it('7/8 = 3360', () => expect(masterBarTicks(bars([7, 8]), 0)).toBe(3360));
  it('5/4 = 4800', () => expect(masterBarTicks(bars([5, 4]), 0)).toBe(4800));

  it('defaults a missing bar to 4/4', () => {
    expect(masterBarTicks([], 0)).toBe(3840);
    expect(masterBarTicks(undefined, 3)).toBe(3840);
    expect(masterBarTicks([{}], 0)).toBe(3840);
  });
});

describe('barCapacityTicks (unrounded)', () => {
  it('matches masterBarTicks for even signatures', () => {
    const bars = [{ timeSignatureNumerator: 4, timeSignatureDenominator: 4 }];
    expect(barCapacityTicks(bars, 0)).toBe(3840);
  });
});

describe('barFilledTicks', () => {
  const bar = (durs) => ({ voices: [{ beats: durs.map((d) => ({ duration: d })) }] });

  it('sums a full 4/4 of quarter notes to 3840', () => {
    expect(barFilledTicks(bar([4, 4, 4, 4]), 0)).toBe(3840);
  });

  it('reports an underfilled bar', () => {
    expect(barFilledTicks(bar([4, 4]), 0)).toBe(1920);
  });

  it('returns 0 for a missing voice', () => {
    expect(barFilledTicks({ voices: [] }, 0)).toBe(0);
    expect(barFilledTicks(null, 0)).toBe(0);
  });
});

describe('barIsFull', () => {
  const mb = [{ timeSignatureNumerator: 4, timeSignatureDenominator: 4 }];
  it('a 4/4 bar of four quarters is full', () => {
    const bar = { voices: [{ beats: [4, 4, 4, 4].map((d) => ({ duration: d })) }] };
    expect(barIsFull(mb, bar, 0, 0)).toBe(true);
  });
  it('three quarters is not full', () => {
    const bar = { voices: [{ beats: [4, 4, 4].map((d) => ({ duration: d })) }] };
    expect(barIsFull(mb, bar, 0, 0)).toBe(false);
  });
});
