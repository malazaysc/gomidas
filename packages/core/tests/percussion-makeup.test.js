// GMD-73 — per-piece percussion make-up gain.
//
// FluidR3 authors an ACOUSTIC kit balance: its snare is at 0 dB attenuation (exactly level with
// every melodic zone, which are all 0 dB too) and everything that carries the groove sits under it
// — kick -3.84 dB, open hat -4.29, crash -6.02, closed hat -8.33, china -8.51, all measured from
// the committed pack at velocity 102 including each sample's own peak. That is what "the drums are
// too soft" is, and it is why measuring the drum track in isolation (GMD-55) found nothing wrong.
//
// The table is the contract. If it drifts, drums go back to sounding like a snare with faint
// company, and nothing else in the build would notice.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import SF from '../core/sf2.ts';

const { percussionMakeupGain, attenuationGain, PERCUSSION_TARGET_DB,
        MAKEUP_MIN_DB, MAKEUP_MAX_DB } = SF;

const dB = g => 20 * Math.log10(g);

/** Level a zone plays at, in dB relative to a melodic note at the same velocity. */
const levelDb = (key, attenuationDb) =>
  dB(attenuationGain(attenuationDb) * percussionMakeupGain(key, attenuationDb));

describe('percussionMakeupGain', () => {
  it('leaves every untargeted key exactly alone', () => {
    // Snare, toms and clap are already AT the reference, and the aux percussion is not part of the
    // kit balance. Touching them would move the kit's peak, which GMD-42's 6 dB of headroom cannot
    // absorb — the user's call was an internal rebalance, not a lift.
    for (const key of [37, 38, 39, 40, 41, 43, 45, 47, 48, 50, 54, 56, 60, 75, 81]) {
      expect(percussionMakeupGain(key, 0), 'key ' + key).toBe(1);
      expect(percussionMakeupGain(key, 21), 'key ' + key).toBe(1);
    }
  });

  it('brings a FluidR3 kick up to the snare/guitar reference', () => {
    // The kick's zone attenuation is 10 in pack units = -3.76 dB through the EMU divisor, so the
    // make-up is +3.76 dB and the result is 0. Before this it read -3.76.
    expect(dB(percussionMakeupGain(36, 10))).toBeCloseTo(3.76, 1);
    expect(levelDb(36, 10)).toBeCloseTo(0, 2);
    expect(levelDb(35, 10)).toBeCloseTo(0, 2);
  });

  it('lands each targeted piece on its declared target', () => {
    // key, the pack's attenuation, the target it must reach.
    const cases = [[42, 21, -5], [44, 21, -5], [46, 11, -3], [49, 16, -4], [52, 21, -4],
                   [55, 18, -4], [57, 20, -4], [51, 19.5, -5], [53, 21, -5], [59, 21, -5]];
    for (const [key, att, target] of cases) {
      expect(levelDb(key, att), 'key ' + key).toBeCloseTo(target, 2);
    }
  });

  it('only ever moves a piece TOWARD its target, in either direction', () => {
    // sonivox — the fallback bank when the pack fetch fails — authors the same kit nearly flat
    // (closed hat -0.75 dB, crash -2.26). A fixed FluidR3-derived boost would over-play it; a
    // target cuts instead, so whichever bank loaded lands on one defined balance.
    expect(dB(percussionMakeupGain(42, 2))).toBeLessThan(0);      // hat already loud -> cut
    expect(levelDb(42, 2)).toBeCloseTo(-5, 2);
    expect(dB(percussionMakeupGain(42, 21))).toBeGreaterThan(0);  // FluidR3's hat -> boost
    expect(levelDb(42, 21)).toBeCloseTo(-5, 2);
  });

  it('clamps a pathological bank at both ends', () => {
    // 200 pack units is -75 dB; without the clamp the make-up would be a +70 dB boost.
    expect(dB(percussionMakeupGain(36, 200))).toBeCloseTo(MAKEUP_MAX_DB, 6);
    // A zone already far above its target must not be cut into inaudibility.
    expect(dB(percussionMakeupGain(59, 0))).toBeCloseTo(-5, 6);
    expect(dB(percussionMakeupGain(36, -50))).toBeCloseTo(0, 6);
    expect(MAKEUP_MIN_DB).toBeLessThan(0);
    expect(MAKEUP_MAX_DB).toBeGreaterThan(0);
  });

  it('never boosts a piece past the melodic reference', () => {
    // The kit's peak must not move: no target may be positive, or the snare stops being the
    // loudest hit and the mix bounce climbs into the WaveShaper knee.
    for (const [key, target] of Object.entries(PERCUSSION_TARGET_DB)) {
      expect(target, 'key ' + key).toBeLessThanOrEqual(0);
    }
  });

  it('is a no-op on a bad key', () => {
    expect(percussionMakeupGain(NaN, 10)).toBe(1);
    expect(percussionMakeupGain(-1, 10)).toBe(1);
    expect(percussionMakeupGain(999, 10)).toBe(1);
  });
});

// The pack is generated once on a machine that has the 151MB FluidR3 bank and then committed, so
// the FILE is what the table is calibrated against. A re-extract that changes an attenuation has
// to fail here rather than in someone's ears.
const dir = fileURLToPath(new URL('../../../assets/drumkits/', import.meta.url));
const jsonPath = dir + 'gm-standard.json';
const havePack = existsSync(jsonPath);
const head = havePack ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;

describe.skipIf(!havePack)('against the committed FluidR3 pack', () => {
  const VEL = 102;   // dynamic F — what a real GP import writes on nearly every beat (GMD-73)

  /** The zones the SF2 instrument would pick for this key, in the order it caps them. */
  const zonesAt = key => head.kits[0].zones
    .filter(z => key >= z.keyLo && key <= z.keyHi && VEL >= z.velLo && VEL <= z.velHi)
    .slice(0, 4);

  it('has a zone for every key the table targets', () => {
    // A target on a key the kit cannot play is dead weight and hides a typo.
    for (const key of Object.keys(PERCUSSION_TARGET_DB).map(Number)) {
      expect(zonesAt(key).length, 'no zone for key ' + key).toBeGreaterThan(0);
    }
  });

  it('lands every targeted piece within 1 dB of its target', () => {
    // 1 dB, not exact: the target is set against the zone attenuation, while the audible level also
    // carries each sample's own normalisation (0.88..1.0 peak across the kit, i.e. up to ~1.2 dB).
    for (const key of Object.keys(PERCUSSION_TARGET_DB).map(Number)) {
      const z = zonesAt(key)[0];
      expect(levelDb(key, z.attenuationDb), 'key ' + key).toBeCloseTo(PERCUSSION_TARGET_DB[key], 0);
    }
  });

  it('leaves the snare and the toms bit-identical', () => {
    // The regression that matters most: the kit's peak is the snare, and it must not move.
    for (const key of [38, 40, 41, 43, 45, 47, 48, 50]) {
      for (const z of zonesAt(key)) {
        expect(percussionMakeupGain(key, z.attenuationDb), 'key ' + key).toBe(1);
      }
    }
  });

  it('closes the gap it was filed for', () => {
    // Before: kick -3.84 dB and closed hat -8.33 dB under a guitar note at the same velocity.
    const kick = zonesAt(36)[0], hat = zonesAt(42)[0], snare = zonesAt(38)[0];
    const before = k => dB(attenuationGain(k.attenuationDb));
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
