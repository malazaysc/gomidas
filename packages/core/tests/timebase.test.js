// GMD-33 — timebase + scheduler window selection.
// Off-by-one errors here are audible as dropped or doubled notes, so they get pinned.
import { describe, it, expect } from 'vitest';
import T from '../core/timebase.ts';

const { PPQ, secondsPerTick, tickToSeconds, secondsToTick, selectWindow,
        indexAtOrAfter, loopActive, wrapTick, windowSegments } = T;

// [tick, channel, key, velocity, on, program, percussion]
const ev = (tick, key = 60) => [tick, 0, key, 1, true, 24, false];

describe('timebase', () => {
  it('uses 960 PPQ, matching alphaTab and the native engine', () => {
    expect(PPQ).toBe(960);
  });

  it('a quarter note at 120bpm is half a second', () => {
    expect(tickToSeconds(960, 120)).toBeCloseTo(0.5, 10);
    expect(tickToSeconds(3840, 120)).toBeCloseTo(2.0, 10);   // a 4/4 bar
  });

  it('tempo scales inversely', () => {
    expect(tickToSeconds(960, 60)).toBeCloseTo(1.0, 10);
    expect(tickToSeconds(960, 240)).toBeCloseTo(0.25, 10);
  });

  it('practice rate scales time, which is why slow-down is pitch-independent', () => {
    // Half speed = twice the wall-clock, same pitch — nothing is time-stretched, the tempo
    // map is simply read more slowly.
    expect(tickToSeconds(960, 120, 0.5)).toBeCloseTo(1.0, 10);
    expect(tickToSeconds(960, 120, 1.5)).toBeCloseTo(1 / 3, 10);
  });

  it('tick <-> seconds round-trips', () => {
    for (const [tick, bpm, rate] of [[0, 120, 1], [960, 90, 1], [12345, 143, 0.75]]) {
      expect(secondsToTick(tickToSeconds(tick, bpm, rate), bpm, rate)).toBeCloseTo(tick, 6);
    }
  });

  it('falls back to sane values instead of dividing by zero', () => {
    expect(Number.isFinite(secondsPerTick(0))).toBe(true);
    expect(Number.isFinite(secondsPerTick(120, 0))).toBe(true);
    expect(secondsPerTick(0)).toBe(secondsPerTick(120));      // bpm 0 -> 120
  });
});

describe('scheduler window', () => {
  const events = [ev(0), ev(240), ev(480), ev(960), ev(1920)];

  it('selects a half-open range so boundary notes are not scheduled twice', () => {
    const first = selectWindow(events, 0, 480);
    expect(first.events.map(e => e[0])).toEqual([0, 240]);    // 480 excluded
    const second = selectWindow(events, 480, 960, first.nextIndex);
    expect(second.events.map(e => e[0])).toEqual([480]);      // picked up here, once
  });

  it('consecutive windows cover every event exactly once', () => {
    const seen = [];
    let idx = 0;
    for (let t = 0; t < 2400; t += 240) {
      const sel = selectWindow(events, t, t + 240, idx);
      seen.push(...sel.events.map(e => e[0]));
      idx = sel.nextIndex;
    }
    expect(seen).toEqual([0, 240, 480, 960, 1920]);
  });

  it('resumes from the cursor rather than rescanning from zero', () => {
    const sel = selectWindow(events, 960, 2000, 3);
    expect(sel.events.map(e => e[0])).toEqual([960, 1920]);
    expect(sel.nextIndex).toBe(5);
  });

  it('skips events behind the window after a backwards seek', () => {
    // Cursor stale at 0 but the window has moved on: the old events must not replay.
    const sel = selectWindow(events, 960, 1000, 0);
    expect(sel.events.map(e => e[0])).toEqual([960]);
  });

  it('includes fractional ticks (pitch-bend resets sort just before a note-on)', () => {
    const withBend = [[959.75, 0, 0, 0, false, 24, false, 1, 8192], ev(960)];
    const sel = selectWindow(withBend, 900, 1000);
    expect(sel.events.length).toBe(2);
    expect(sel.events[0][0]).toBe(959.75);
  });

  it('an empty window returns nothing and does not move the cursor', () => {
    const sel = selectWindow(events, 1000, 1200, 4);
    expect(sel.events).toEqual([]);
    expect(sel.nextIndex).toBe(4);
  });

  it('indexAtOrAfter finds the resume point for a seek', () => {
    expect(indexAtOrAfter(events, 0)).toBe(0);
    expect(indexAtOrAfter(events, 481)).toBe(3);
    expect(indexAtOrAfter(events, 960)).toBe(3);     // inclusive of an exact hit
    expect(indexAtOrAfter(events, 99999)).toBe(5);
    expect(indexAtOrAfter([], 10)).toBe(0);
  });
});

describe('A/B loop', () => {
  const loop = { start: 960, end: 3840 };

  it('is inactive when cleared with the native -1/-1 sentinel', () => {
    expect(loopActive({ start: -1, end: -1 })).toBe(false);
    expect(loopActive(null)).toBe(false);
    expect(loopActive({ start: 100, end: 100 })).toBe(false);   // empty range
    expect(loopActive(loop)).toBe(true);
  });

  it('wraps a position past the loop end back into the range', () => {
    expect(wrapTick(500, loop)).toBe(500);        // before the loop: untouched
    expect(wrapTick(3839, loop)).toBe(3839);
    expect(wrapTick(3840, loop)).toBe(960);       // exactly at the end -> back to start
    expect(wrapTick(4000, loop)).toBe(1120);
  });

  it('wraps correctly even after skipping several repetitions', () => {
    // A stalled tab can leave the position far past the end; a single subtraction would
    // still be out of range and the playhead would drift.
    const span = loop.end - loop.start;              // 2880
    expect(wrapTick(loop.start + span * 3 + 100, loop)).toBe(loop.start + 100);
  });

  it('splits a window that crosses the loop boundary', () => {
    const segs = windowSegments(3800, 3900, loop);
    expect(segs.length).toBe(2);
    expect(segs[0]).toMatchObject({ from: 3800, to: 3840, offset: 0 });
    // Second segment restarts at the loop start, offset by one span so context time keeps moving
    // forward even though the sequence tick jumped backwards.
    expect(segs[1].from).toBe(960);
    expect(segs[1].offset).toBe(2880);
  });

  it('leaves a window inside the loop alone', () => {
    expect(windowSegments(1000, 1100, loop)).toEqual([{ from: 1000, to: 1100, offset: 0 }]);
  });

  it('is a no-op passthrough with no loop set', () => {
    expect(windowSegments(0, 100, null)).toEqual([{ from: 0, to: 100, offset: 0 }]);
  });

  it('terminates on a pathologically short loop instead of hanging the page', () => {
    const segs = windowSegments(0, 10000, { start: 0, end: 1 });
    expect(segs.length).toBeLessThanOrEqual(64);
  });
});
