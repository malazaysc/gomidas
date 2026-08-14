// buildSequence — the model -> flat MIDI event list walk (the heart of playback).
// Hand-built plain-object scores (same shape alphaTab produces) exercised end to end.
// Event tuple: [tick, channel, key, velocity, isNoteOn, program, isPercussion].
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

// ── tiny score-model builders ────────────────────────────────────────────────
const note = (realValue, extra = {}) => ({ realValue, ...extra });
const nbeat = (duration, notes, extra = {}) => ({ duration, notes, isRest: false, isEmpty: false, ...extra });
const rest = (duration) => ({ duration, notes: [], isRest: true, isEmpty: false });
const voice = (beats, index = 0) => ({ index, beats });
const bar = (...voices) => ({ voices });
const mbar = (extra = {}) => ({ timeSignatureNumerator: 4, timeSignatureDenominator: 4, ...extra });
const track = (bars, pb = {}) => ({
  playbackInfo: { program: 24, primaryChannel: 0, ...pb },
  percussionArticulations: [],
  staves: [{ bars }],
});
const score = (masterBars, tracks) => ({ masterBars, tracks });

// alphaTab enums the walk consults (only the members it reads).
const OPTS = { tripletFeel: { NoTripletFeel: 0, Triplet8th: 1 } };
const build = (s, extra) => C.buildSequence(s, { ...OPTS, ...extra });

const ons = (events) => events.filter((e) => e[4] === true);
const offs = (events) => events.filter((e) => e[4] === false);

describe('buildSequence — basic notes', () => {
  const s = score([mbar()], [track([bar(voice([nbeat(4, [note(40)]), nbeat(4, [note(45)])]))])]);

  it('emits a note-on/off pair per note at the right ticks', () => {
    const { events } = build(s);
    expect(events).toHaveLength(4);
    expect(events[0].slice(0, 3)).toEqual([0, 0, 40]);      // note-on E2 at tick 0
    expect(events[0][4]).toBe(true);
    expect(events[0][3]).toBeCloseTo(0.85, 10);             // default mf velocity
    expect(events[1].slice(0, 5)).toEqual([960, 0, 40, 0, false]);
    expect(events[2].slice(0, 3)).toEqual([960, 0, 45]);    // 2nd note starts at the quarter
    expect(events[3].slice(0, 5)).toEqual([1920, 0, 45, 0, false]);
  });

  it('carries program + non-percussion flag through', () => {
    const { events } = build(s);
    expect(events[0][5]).toBe(24);     // program
    expect(events[0][6]).toBe(false);  // isPercussion
  });

  it('pads the bar to its time signature: lengthTicks = 3840 (4/4)', () => {
    expect(build(s).lengthTicks).toBe(3840);
  });

  it('builds a primary-track tickMap on voice 0, ascending', () => {
    const { tickMap } = build(s);
    expect(tickMap.map((m) => m.tick)).toEqual([0, 960]);
  });

  it('a rest produces no events but still advances time', () => {
    const s2 = score([mbar()], [track([bar(voice([rest(4), nbeat(4, [note(50)])]))])]);
    const { events } = build(s2);
    expect(events).toHaveLength(2);
    expect(events[0].slice(0, 3)).toEqual([960, 0, 50]);   // note starts after the rest
  });
});

describe('buildSequence — articulation shaping in context', () => {
  it('a dead note is shorter + quieter', () => {
    const s = score([mbar()], [track([bar(voice([nbeat(4, [note(40, { isDead: true })])]))])]);
    const [on, off] = build(s).events;
    expect(on[3]).toBeCloseTo(0.51, 10);   // 0.85 * 0.6
    expect(off[0]).toBe(115);              // round(960 * 0.12)
  });
});

describe('buildSequence — ties', () => {
  it('a tie destination extends the ringing note instead of re-triggering', () => {
    const s = score([mbar()], [track([bar(voice([
      nbeat(4, [note(40)]),
      nbeat(4, [note(40, { isTieDestination: true })]),
    ]))])]);
    const { events } = build(s);
    expect(events).toHaveLength(2);                 // one on, one (extended) off
    expect(events[0].slice(0, 5)).toEqual([0, 0, 40, expect.any(Number), true]);
    expect(events[1].slice(0, 5)).toEqual([1920, 0, 40, 0, false]);   // off pushed to 1920
  });
});

describe('buildSequence — triplet-feel swing', () => {
  it('swings the off-beat eighth later (480 -> 640)', () => {
    const s = score([mbar({ tripletFeel: 1 })],
      [track([bar(voice([nbeat(8, [note(40)]), nbeat(8, [note(42)])]))])]);
    const noteOns = ons(build(s).events);
    expect(noteOns[0][0]).toBe(0);
    expect(noteOns[1][0]).toBe(640);   // swungTickInBar(480)
  });
});

describe('buildSequence — repeats', () => {
  it('a x2 repeat plays the bar twice and doubles the length', () => {
    const s = score([mbar({ isRepeatStart: true, repeatCount: 2 })],
      [track([bar(voice([nbeat(4, [note(40)])]))])]);
    const { events, lengthTicks } = build(s);
    expect(ons(events)).toHaveLength(2);           // played twice
    expect(ons(events)[1][0]).toBe(3840);          // 2nd pass starts a full bar later
    expect(lengthTicks).toBe(7680);
  });
});

describe('buildSequence — percussion', () => {
  it('maps a percussion articulation index to its GM drum key on channel 9', () => {
    const drumTrack = {
      playbackInfo: { program: 0, primaryChannel: 9 },
      percussionArticulations: [{ outputMidiNumber: 36 }, { outputMidiNumber: 38 }],
      staves: [{ bars: [bar(voice([nbeat(4, [note(0, { percussionArticulation: 1 })])]))] }],
    };
    const { events } = build(score([mbar()], [drumTrack]));
    expect(events[0][1]).toBe(9);      // channel 9
    expect(events[0][2]).toBe(38);     // articulation[1].outputMidiNumber
    expect(events[0][6]).toBe(true);   // isPercussion
  });

  it('scales percussion velocity by a per-piece drum gain', () => {
    const drumTrack = {
      playbackInfo: { program: 0, primaryChannel: 9 },
      percussionArticulations: [{ outputMidiNumber: 36 }],
      staves: [{ bars: [bar(voice([nbeat(4, [note(0, { percussionArticulation: 0 })])]))] }],
    };
    const { events } = build(score([mbar()], [drumTrack]), { drumGains: { 36: 0.5 } });
    expect(events[0][3]).toBeCloseTo(0.425, 10);   // 0.85 * 0.5
  });
});

describe('buildSequence — metronome', () => {
  it('adds an accented downbeat + 3 weak clicks on a free melodic channel', () => {
    const s = score([mbar()], [track([bar(voice([nbeat(4, [note(40)])]))])]);
    const { events } = build(s, { metronomeOn: true });
    // Track ch0 is used, so the click lands on channel 1 (first free, never 9).
    const clicks = ons(events).filter((e) => e[1] === 1);
    expect(clicks).toHaveLength(4);                       // one per 4/4 beat
    expect(clicks.map((e) => e[0])).toEqual([0, 960, 1920, 2880]);
    expect(clicks[0][2]).toBe(84);                        // accented downbeat key
    expect(clicks[0][3]).toBe(1.0);
    expect(clicks[1][2]).toBe(72);                        // weak-beat key
    expect(clicks[1][3]).toBeCloseTo(0.7, 10);
    expect(clicks[0][5]).toBe(115);                       // GM woodblock program
  });
});

// The scheduler contract. Both consumers depend on it: the web scheduler walks the list with a
// running cursor (selectWindow) and seeks into it with a binary search (indexAtOrAfter), and it
// applies events in ARRAY order. Emission order is per note and per track, so without the sort
// the list is not ascending — which is how bends went silent on web (GMD-43): the note-off was
// applied before that note's own bend events, dropping the voice the bend needed to ramp.
describe('buildSequence — event list is tick-sorted', () => {
  const ascending = (events) => events.every((e, i) => i === 0 || events[i - 1][0] <= e[0]);

  it('a chord (several notes at one tick) still comes out ascending', () => {
    const s = score([mbar()], [track([bar(voice([nbeat(4, [note(40), note(45), note(50)])]))])]);
    expect(ascending(build(s).events)).toBe(true);
  });

  it('two tracks interleave rather than concatenating track by track', () => {
    const bars = [bar(voice([nbeat(4, [note(40)]), nbeat(4, [note(41)])]))];
    const s = score([mbar()], [track(bars, { primaryChannel: 0 }), track(bars, { primaryChannel: 1 })]);
    const { events } = build(s);
    expect(ascending(events)).toBe(true);
    // Both tracks' downbeats land before either track's second beat.
    expect(events.slice(0, 2).map((e) => e[1]).sort()).toEqual([0, 1]);
  });

  it('the metronome click track merges in ascending too', () => {
    const s = score([mbar()], [track([bar(voice([nbeat(4, [note(40)]), nbeat(4, [note(41)])]))])]);
    expect(ascending(build(s, { metronomeOn: true }).events)).toBe(true);
  });

  it('a bent note: every bend event sits between its note-on and note-off IN ARRAY ORDER', () => {
    const bendPoints = [{ offset: 0, value: 0 }, { offset: 60, value: 4 }];
    const s = score([mbar()], [track([bar(voice([nbeat(4, [note(40, { bendPoints })]), nbeat(4, [note(45)])]))])]);
    const { events } = build(s);
    expect(ascending(events)).toBe(true);

    const onIdx = events.findIndex((e) => e[4] === true && e[2] === 40);
    const offIdx = events.findIndex((e) => e[4] === false && e[2] === 40);
    const bendIdx = events.map((e, i) => [e, i]).filter(([e]) => e.length >= 9 && e[7] === 1).map(([, i]) => i);

    expect(bendIdx.length).toBeGreaterThan(0);
    expect(onIdx).toBeLessThan(Math.min(...bendIdx));
    expect(Math.max(...bendIdx)).toBeLessThan(offIdx);
  });
});
