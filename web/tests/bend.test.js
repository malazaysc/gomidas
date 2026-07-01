// Pitch-bend MIDI emission — the reset-to-centre-before-note-end ordering is the subtle,
// easy-to-regress part (a missed reset leaves the whole channel detuned).
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const { bendValueToSemitones, semitonesToWheel, emitBendEvents } = C;

describe('bendValueToSemitones', () => {
  it('4 quarter-tones = a whole-tone (2 semitone) bend', () => {
    expect(bendValueToSemitones(4)).toBe(2);
  });
  it('undefined/null -> 0', () => {
    expect(bendValueToSemitones(undefined)).toBe(0);
    expect(bendValueToSemitones(null)).toBe(0);
  });
});

describe('semitonesToWheel', () => {
  it('centre is 8192', () => expect(semitonesToWheel(0)).toBe(8192));
  it('+12 semitones saturates at 16383', () => expect(semitonesToWheel(12)).toBe(16383));
  it('-12 semitones bottoms at 0', () => expect(semitonesToWheel(-12)).toBe(0));
  it('+2 semitones is a proportional wheel value', () => {
    expect(semitonesToWheel(2)).toBe(9557);   // round(8192 + (2/12)*8192)
  });
  it('clamps beyond the ±12 range', () => {
    expect(semitonesToWheel(24)).toBe(16383);
    expect(semitonesToWheel(-99)).toBe(0);
  });
});

describe('emitBendEvents', () => {
  // A full whole-tone bend across the note: value 0 -> 4 (quarter-tones) over offset 0..60.
  const bendPoints = [{ offset: 0, value: 0 }, { offset: 60, value: 4 }];

  it('starts at centre and ends with a reset to centre', () => {
    const events = [];
    emitBendEvents(events, /*channel*/ 2, /*program*/ 25, /*onTick*/ 0, /*offTick*/ 960, bendPoints);

    // Every event is a kind-1 (pitch-bend) tuple on the right channel/program.
    for (const e of events) {
      expect(e[1]).toBe(2);   // channel
      expect(e[5]).toBe(25);  // program
      expect(e[7]).toBe(1);   // kind == pitch-bend
    }

    // First traced point is the curve start (value 0 -> centre wheel).
    expect(events[0][0]).toBe(0);
    expect(events[0][8]).toBe(8192);

    // Last two events: hold the end value, then reset to centre just before note end.
    const reset = events[events.length - 1];
    const hold = events[events.length - 2];
    expect(reset[0]).toBe(959.5);       // offTick - 0.5
    expect(reset[8]).toBe(8192);        // centred again
    expect(hold[0]).toBe(959.25);       // offTick - 0.75
    expect(hold[8]).toBe(9557);         // held at +2 semitones (whole tone)
  });

  it('the reset tick sorts before a note-on at offTick', () => {
    const events = [];
    emitBendEvents(events, 0, 0, 0, 100, bendPoints);
    const resetTick = events[events.length - 1][0];
    expect(resetTick).toBeLessThan(100);
  });

  it('no bend points -> no events emitted', () => {
    const events = [];
    const ret = emitBendEvents(events, 0, 0, 0, 960, []);
    expect(events).toHaveLength(0);
    expect(ret).toBe(events);
  });

  it('does not mutate the caller bendPoints array (sorts a copy)', () => {
    const pts = [{ offset: 60, value: 4 }, { offset: 0, value: 0 }];
    const snapshot = JSON.stringify(pts);
    emitBendEvents([], 0, 0, 0, 960, pts);
    expect(JSON.stringify(pts)).toBe(snapshot);
  });
});
