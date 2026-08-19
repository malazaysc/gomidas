// GMD-73 — per-piece percussion make-up gain, a FLOOR under each drum piece.
//
// FluidR3 authors an ACOUSTIC kit balance: its snare is at 0 dB attenuation (exactly level with
// every melodic zone, which are all 0 dB too) and everything that carries the groove sits under it
// — kick -3.84 dB, open hat -4.29, crash -6.02, closed hat -8.33, china -8.51, all measured from
// the committed pack at velocity 102 including each sample's own peak. That is what "the drums are
// too soft" is, and it is why measuring the drum track in isolation (GMD-55) found nothing wrong.
//
// Both banks this exercises are COMMITTED, so neither may be skipped: a suite that vanishes when a
// file is renamed reports success having checked nothing, which is the failure mode CLAUDE.md
// records for `pnpm sweep`. Missing file -> loud failure, never a green skip.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import SF from '../core/sf2.ts';

const { percussionMakeupGain, attenuationGain, parseSf2, zonesFor,
        PERCUSSION_FLOOR_DB, MAKEUP_MAX_DB } = SF;

const dB = g => 20 * Math.log10(g);
const TARGETED = Object.keys(PERCUSSION_FLOOR_DB).map(Number).sort((a, b) => a - b);

/** Level a zone plays at, in dB relative to a melodic note at the same velocity. */
const levelDb = (key, attenuationDb) =>
  dB(attenuationGain(attenuationDb) * percussionMakeupGain(key, attenuationDb));

describe('percussionMakeupGain', () => {
  it('leaves every untargeted key exactly alone', () => {
    // Whatever the bank says about them. Snare/toms/clap are out because raising them would move
    // the kit's peak (GMD-42 left 6 dB of headroom, and the user's call was a rebalance, not a
    // lift); side stick 37 and the aux percussion are out because nobody has decided them — see
    // 'pins the attenuated keys it deliberately does NOT raise' below.
    for (const key of [37, 38, 39, 40, 41, 43, 45, 47, 48, 50, 54, 56, 60, 75, 81]) {
      expect(percussionMakeupGain(key, 0), 'key ' + key).toBe(1);
      expect(percussionMakeupGain(key, 21), 'key ' + key).toBe(1);
    }
  });

  it('brings a FluidR3 kick up to the snare/melodic reference', () => {
    // The kick's zone attenuation is 10 in pack units = -3.76 dB through the EMU divisor, so the
    // make-up is +3.76 dB and the result is 0. Before this it read -3.76.
    expect(dB(percussionMakeupGain(36, 10))).toBeCloseTo(3.76, 1);
    expect(levelDb(36, 10)).toBeCloseTo(0, 2);
    expect(levelDb(35, 10)).toBeCloseTo(0, 2);
  });

  it('raises each targeted piece to its floor', () => {
    // key, the pack's attenuation, the floor it must reach.
    const cases = [[42, 21, -5], [44, 21, -5], [46, 11, -3], [49, 16, -4], [52, 21, -4],
                   [55, 18, -4], [57, 20, -4], [51, 19.5, -5], [53, 21, -5], [59, 21, -5]];
    for (const [key, att, floor] of cases) {
      expect(levelDb(key, att), 'key ' + key).toBeCloseTo(floor, 2);
    }
  });

  it('BOOSTS ONLY — a bank that already plays a piece loud enough is never cut', () => {
    // The rule that keeps the fallback path from regressing: a two-way normalisation would pull
    // sonivox's hats and cymbals DOWN by up to 4.25 dB, which is this ticket's own symptom made
    // worse on the one path nobody hears until they are offline.
    for (const key of TARGETED) {
      expect(percussionMakeupGain(key, 0), 'key ' + key + ' at 0 attenuation').toBe(1);
      expect(percussionMakeupGain(key, 2), 'key ' + key + ' barely attenuated')
        .toBeGreaterThanOrEqual(1);
    }
    // A piece already above its floor keeps the bank's level, not the floor's.
    expect(levelDb(42, 2)).toBeCloseTo(-0.75, 2);   // sonivox's closed hat, untouched
    expect(levelDb(42, 21)).toBeCloseTo(-5, 2);     // FluidR3's, raised
  });

  it('clamps a pathological bank', () => {
    // 200 pack units is -75 dB; without the clamp the make-up would be a +70 dB boost.
    expect(dB(percussionMakeupGain(36, 200))).toBeCloseTo(MAKEUP_MAX_DB, 6);
    expect(MAKEUP_MAX_DB).toBeGreaterThan(0);
  });

  it('never lifts a piece past the melodic reference', () => {
    // The kit's peak must not move: no floor may be positive, or the snare stops being the loudest
    // hit and the mix bounce climbs into the WaveShaper knee.
    for (const key of TARGETED) expect(PERCUSSION_FLOOR_DB[key], 'key ' + key).toBeLessThanOrEqual(0);
  });

  it('is a no-op on a bad key', () => {
    expect(percussionMakeupGain(NaN, 10)).toBe(1);
    expect(percussionMakeupGain(-1, 10)).toBe(1);
    expect(percussionMakeupGain(999, 10)).toBe(1);
  });
});

// The pack is generated once on a machine that has the 151MB FluidR3 bank and then committed, so
// the FILE is what the floors are calibrated against. A re-extract that changes an attenuation has
// to fail here rather than in someone's ears — which means pinning the pack's OWN numbers. Asserting
// that the result lands on the floor would prove nothing: it does so by construction, for any input.
const packPath = fileURLToPath(new URL('../../../assets/drumkits/gm-standard.json', import.meta.url));

describe('against the committed FluidR3 pack', () => {
  it('is present — this suite may never silently skip', () => {
    expect(existsSync(packPath), packPath + ' is committed; a missing pack is a failure, not a skip')
      .toBe(true);
  });

  const head = JSON.parse(readFileSync(packPath, 'utf8'));
  const VEL = 102;   // dynamic F — what a real GP import writes on nearly every beat (GMD-73)

  /** The zones the SF2 instrument would pick for this key, in the order it caps them. */
  const zonesAt = key => head.kits[0].zones
    .filter(z => key >= z.keyLo && key <= z.keyHi && VEL >= z.velLo && VEL <= z.velHi)
    .slice(0, 4);

  it('still carries the attenuations the floors were calibrated against', () => {
    // THE golden assertion. Every number here was read off the committed pack; if a re-extract
    // moves one, the floor above it is stale and this fails.
    const PINNED = { 35: 10, 36: 10, 42: 21, 44: 21, 46: 11, 49: 16,
                     51: 19.5, 52: 21, 53: 21, 55: 18, 57: 20, 59: 21 };
    expect(Object.keys(PINNED).map(Number).sort((a, b) => a - b)).toEqual(TARGETED);
    for (const key of TARGETED) {
      const zs = zonesAt(key);
      expect(zs.length, 'no zone for key ' + key).toBeGreaterThan(0);
      // Every zone of a key must agree, or the make-up would flatten a layered dynamic.
      for (const z of zs) expect(z.attenuationDb, 'key ' + key).toBe(PINNED[key]);
    }
  });

  it('has something to raise for every floor it declares', () => {
    // A floor on a piece the pack already plays loud enough is dead weight and hides a typo.
    for (const key of TARGETED) {
      expect(percussionMakeupGain(key, zonesAt(key)[0].attenuationDb), 'key ' + key)
        .toBeGreaterThan(1);
    }
  });

  it('leaves the snare and the toms bit-identical', () => {
    // The regression that matters most: the kit's peak is the snare, and it must not move.
    for (const key of [38, 40, 41, 43, 45, 47, 48, 50]) {
      for (const z of zonesAt(key)) {
        expect(z.attenuationDb, 'key ' + key + ' is no longer at the reference').toBe(0);
        expect(percussionMakeupGain(key, z.attenuationDb), 'key ' + key).toBe(1);
      }
    }
  });

  it('pins the attenuated keys it deliberately does NOT raise', () => {
    // "Absent from the table" does not mean "already at the reference" — these are not, and the
    // gap is a decision nobody has taken, not a measurement nobody made. Pinned so it stays
    // visible: side stick 37 shares PIECE_KEYS.snare with keys this PR leaves at 0 dB, and the
    // aux percussion sits under the rebalanced kit.
    const UNRAISED = { 37: 10, 60: 10, 61: 10, 63: 10, 64: 10, 65: 5, 66: 8, 67: 12, 68: 15,
                       71: 5, 72: 5, 73: 10 };
    for (const [k, att] of Object.entries(UNRAISED)) {
      const key = Number(k);
      expect(TARGETED, 'key ' + key + ' is now targeted — move it out of UNRAISED')
        .not.toContain(key);
      expect(zonesAt(key)[0].attenuationDb, 'key ' + key).toBe(att);
      expect(percussionMakeupGain(key, att), 'key ' + key).toBe(1);
    }
    // Side stick was level with the kick before this change and is 3.76 dB under it after.
    expect(dB(attenuationGain(zonesAt(37)[0].attenuationDb)))
      .toBeCloseTo(dB(attenuationGain(zonesAt(36)[0].attenuationDb)), 6);
    expect(levelDb(36, zonesAt(36)[0].attenuationDb) - levelDb(37, zonesAt(37)[0].attenuationDb))
      .toBeCloseTo(3.76, 1);
  });

  it('closes the gap it was filed for', () => {
    // Before: kick -3.76 dB and closed hat -7.90 dB under a melodic note of the same velocity.
    const kick = zonesAt(36)[0], hat = zonesAt(42)[0], snare = zonesAt(38)[0];
    const before = z => dB(attenuationGain(z.attenuationDb));
    expect(before(kick)).toBeCloseTo(-3.76, 1);
    expect(before(hat)).toBeCloseTo(-7.90, 1);
    expect(before(snare)).toBeCloseTo(0, 6);
    // After: the kick is at the snare, and the hat — the most frequent hit in most grooves — has
    // come up nearly 3 dB while staying clearly below it.
    expect(levelDb(36, kick.attenuationDb)).toBeCloseTo(0, 1);
    expect(levelDb(42, hat.attenuationDb) - before(hat)).toBeGreaterThan(2.5);
    expect(levelDb(42, hat.attenuationDb)).toBeLessThan(levelDb(38, snare.attenuationDb) - 3);
  });
});

// The fallback bank, which is what plays when the pack fetch fails — offline, an SPA host answering
// the .bin with index.html, an IndexedDB miss plus a network error. It is committed too, and it is
// the bank the boost-only rule exists for.
const sonivoxPath = fileURLToPath(new URL('../../../assets/soundfont/sonivox.sf2', import.meta.url));

describe('against the committed sonivox fallback bank', () => {
  it('is present — this suite may never silently skip', () => {
    expect(existsSync(sonivoxPath), sonivoxPath + ' is committed').toBe(true);
  });

  const buf = readFileSync(sonivoxPath);
  const bank = parseSf2(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const preset = bank.findDrumPreset(0);

  it('authors its kit nearly flat, which is why the rule is boost-only', () => {
    // Measured: closed hat -0.75 dB, crash -2.26. A two-way normalisation would cut these to the
    // -5 / -4 floors. If this ever stops being true the boost-only argument needs re-checking.
    const at = key => dB(attenuationGain(zonesFor(preset, key, 102)[0].attenuationDb));
    expect(at(42)).toBeCloseTo(-0.75, 1);
    expect(at(49)).toBeCloseTo(-2.26, 1);
    expect(at(36)).toBeCloseTo(0, 6);
  });

  it('is never made quieter than it already is', () => {
    // The concrete regression the review caught: hats and cymbals down 1.7-4.25 dB on the exact
    // path where the good samples are already unavailable.
    for (const key of TARGETED) {
      for (const z of zonesFor(preset, key, 102)) {
        expect(percussionMakeupGain(key, z.attenuationDb), 'key ' + key).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
