// voicesToRelease — which voices under one key a note-off actually ends (GMD-49).
//
// The SF2 instrument stores voices per key, and that list conflates two things: the several
// voices ONE note-on spawns for a layered preset, and a key struck again while an earlier
// instance still rings (ties, let ring, fast repeated notes on one string). It used to release
// the whole list, so the first note's note-off killed the second note that had only just started.
//
// The other two instruments already did the right thing — createSfzInstrument shifts FIFO, the
// tone placeholder releases list[0] — so only the DEFAULT instrument for every track had it.
import { describe, it, expect, beforeAll } from 'vitest';

let voicesToRelease;

beforeAll(async () => {
  const fs = await import('node:fs/promises');
  const url = new URL('../dist/core/webaudio.js', import.meta.url);
  const src = await fs.readFile(url, 'utf8');
  const win = {};
  new Function('window', 'module', src)(win, { exports: {} });
  voicesToRelease = win.GomidasWebAudio.voicesToRelease;
});

const voice = (noteId, extra = {}) => ({ noteId, ...extra });
const ids = (list) => list.map((v) => v.noteId);

describe('voicesToRelease', () => {
  it('releases every voice of a layered note together', () => {
    // One note-on, four zones (the zones.slice(0, 4) cap) — all share a noteId.
    const list = [voice(7), voice(7), voice(7), voice(7)];
    expect(voicesToRelease(list)).toHaveLength(4);
  });

  it('releases only the older instance when a key is retriggered', () => {
    // THE BUG: this used to return both, so the note-off of the first note silenced the second.
    const list = [voice(1), voice(2)];
    expect(ids(voicesToRelease(list))).toEqual([1]);
  });

  it('releases a layered older instance without touching the newer one', () => {
    const list = [voice(1), voice(1), voice(2), voice(2)];
    expect(ids(voicesToRelease(list))).toEqual([1, 1]);
  });

  it('takes the oldest by id, not by array position', () => {
    // forget() splices voices out as they end, so the list is not ordered by construction.
    const list = [voice(9), voice(4), voice(6)];
    expect(ids(voicesToRelease(list))).toEqual([4]);
  });

  it('successive note-offs walk the instances oldest-first', () => {
    let list = [voice(1), voice(2), voice(3)];
    const released = voicesToRelease(list);
    expect(ids(released)).toEqual([1]);
    list = list.filter((v) => !released.includes(v));      // what forget() does
    expect(ids(voicesToRelease(list))).toEqual([2]);
  });

  it('never releases a one-shot — a crash is not as long as the 16th it sits on', () => {
    const list = [voice(1, { oneShot: true }), voice(2, { oneShot: true })];
    expect(voicesToRelease(list)).toEqual([]);
  });

  it('skips one-shots when choosing the oldest, rather than being blocked by them', () => {
    const list = [voice(1, { oneShot: true }), voice(2), voice(3)];
    expect(ids(voicesToRelease(list))).toEqual([2]);
  });

  it('is safe on an empty or missing list', () => {
    expect(voicesToRelease([])).toEqual([]);
    expect(voicesToRelease(undefined)).toEqual([]);
    expect(voicesToRelease(null)).toEqual([]);
  });

  it('treats voices with no id as one instance, so older data still releases', () => {
    const list = [{}, {}];
    expect(voicesToRelease(list)).toHaveLength(2);
  });
});
