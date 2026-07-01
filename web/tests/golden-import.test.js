// Golden import->MIDI test: parse REAL alphaTex with the REAL alphaTab engine (in Node),
// walk it through buildSequence, and snapshot the event list. Unlike build-sequence.test.js
// (hand-built plain objects), this runs against the genuine alphaTab model, so it catches
// (a) any drift between our assumed model shape and alphaTab's, and (b) regressions in the
// walk against real parsed scores. Snapshots live in web/tests/__snapshots__ (committed).
import { describe, it, expect } from 'vitest';
import * as at from '@coderline/alphatab';
import C from '../core/gomidas-core.js';

function parseTex(tex) {
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(tex, new at.Settings());
  return imp.readScore();
}

// The alphaTab enums buildSequence consults (Ottava isn't exported by the Node build; the
// walk treats a missing enum as "no octave shift", which is correct for these fixtures).
const enums = {
  tripletFeel: at.model.TripletFeel,
  crescendoType: at.model.CrescendoType,
  direction: at.model.Direction,
};

const build = (tex) => C.buildSequence(parseTex(tex), enums);

// Round velocities so the golden snapshot is stable across float noise.
const normalize = (events) => events.map((e) => [e[0], e[1], e[2], Math.round(e[3] * 1e4) / 1e4, e[4], e[5], e[6]]);

describe('golden import -> MIDI (real alphaTab model)', () => {
  it('a mixed-duration phrase with a rest', () => {
    const { events, lengthTicks, tickMap } = build('. 3.3.4 0.3.4 | 3.3.8 2.3.8 r.4 |');
    // Structural invariants (meaningful even if the snapshot is later reset):
    expect(events.length % 2).toBe(0);                        // every note-on has a note-off
    const noteOns = events.filter((e) => e[4] === true);
    expect(noteOns).toHaveLength(4);                          // 2 + 2 sounded notes (rest is silent)
    expect(noteOns[0][0]).toBe(0);                            // first note at tick 0
    expect(lengthTicks).toBe(7680);                           // two 4/4 bars
    // tickMap is ascending.
    const ticks = tickMap.map((m) => m.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    // Full golden:
    expect({ events: normalize(events), lengthTicks }).toMatchSnapshot();
  });

  it('whole and half notes', () => {
    const { events, lengthTicks } = build('. 3.3.1 | 3.3.2 5.3.2 |');
    const noteOns = events.filter((e) => e[4] === true);
    expect(noteOns).toHaveLength(3);
    expect(noteOns[0][0]).toBe(0);                            // whole note at bar 0
    expect(noteOns[1][0]).toBe(3840);                         // first half note at bar 1
    expect(noteOns[2][0]).toBe(3840 + 1920);                 // second half note mid-bar
    expect(lengthTicks).toBe(7680);
    expect({ events: normalize(events), lengthTicks }).toMatchSnapshot();
  });

  it('parses the same note pitches the app would play (sanity on realValue)', () => {
    // 0.3.4 == open string 3. In standard guitar tuning that is a fixed MIDI pitch;
    // assert it is a plausible guitar note so a tuning/realValue regression is caught.
    const { events } = build('. 0.3.4 |');
    const key = events[0][2];
    expect(key).toBeGreaterThanOrEqual(40);   // >= E2
    expect(key).toBeLessThanOrEqual(72);      // <= C5
  });
});
