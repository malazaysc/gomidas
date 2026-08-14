// envelopeLevelAt — the level a scheduled gain envelope has at an arbitrary time.
//
// Why it exists (GMD-48): releaseVoice must not read gain.value. Notes are scheduled ahead, so
// for most of them the automation has not run when the note-off is scheduled and .value returns
// the GainNode default of 1.0 — above the note's own peak. A voice records the envelope it
// scheduled and releases from this function's answer instead.
import { describe, it, expect, beforeAll } from 'vitest';

let envelopeLevelAt;

beforeAll(async () => {
  // webaudio.ts emits as a plain <script> global (no module export), so load the compiled file
  // with a stub window/AudioContext and read the published object off it.
  const fs = await import('node:fs/promises');
  const url = new URL('../dist/core/webaudio.js', import.meta.url);
  const src = await fs.readFile(url, 'utf8');
  const win = {};
  new Function('window', 'module', src)(win, { exports: {} });
  envelopeLevelAt = win.GomidasWebAudio.envelopeLevelAt;
});

// The SF2 shape every track uses: silence -> linear attack to peak -> exponential approach to
// sustain (setTargetAtTime).
const sf2Env = (t0 = 10, peak = 0.6, attack = 0.01, sustain = 0.3, tau = 0.1) => [
  { t: t0, v: 0.0001, kind: 'set' },
  { t: t0 + attack, v: peak, kind: 'lin' },
  { t: t0 + attack, v: sustain, kind: 'target', tau },
];

describe('envelopeLevelAt', () => {
  it('is silent before the note starts', () => {
    expect(envelopeLevelAt(sf2Env(), 9.5)).toBeCloseTo(0.0001, 6);
  });

  it('rises linearly through the attack', () => {
    const env = sf2Env(10, 0.6, 0.01);
    expect(envelopeLevelAt(env, 10.005)).toBeCloseTo(0.3, 3);   // halfway up
    expect(envelopeLevelAt(env, 10.01)).toBeCloseTo(0.6, 6);    // at the peak
  });

  it('decays exponentially toward sustain, never jumping above the peak', () => {
    const env = sf2Env(10, 0.6, 0.01, 0.3, 0.1);
    const atPeak = envelopeLevelAt(env, 10.01);
    const later = envelopeLevelAt(env, 10.11);                  // one time constant in
    expect(later).toBeLessThan(atPeak);
    expect(later).toBeGreaterThan(0.3);
    expect(later).toBeCloseTo(0.3 + 0.3 * Math.exp(-1), 4);
    expect(envelopeLevelAt(env, 20)).toBeCloseTo(0.3, 3);       // settled at sustain
  });

  // The actual regression: a palm mute ends ~110ms in, long before the note would have decayed.
  it('a short note releases from its real level, NOT from 1.0', () => {
    const env = sf2Env(10, 0.6061, 0.01, 0.3, 2.0);
    const level = envelopeLevelAt(env, 10.11);                  // note-off 110ms in
    expect(level).toBeLessThanOrEqual(0.6061);                  // never above its own peak
    expect(level).toBeGreaterThan(0.5);                         // and not collapsed either
  });

  it('never returns more than the largest value the envelope schedules', () => {
    const env = sf2Env(10, 0.42);
    for (let t = 9.9; t < 12; t += 0.01) expect(envelopeLevelAt(env, t)).toBeLessThanOrEqual(0.42 + 1e-9);
  });

  it('handles the SFZ shape: immediate peak, then approach to 70%', () => {
    const env = [{ t: 5, v: 0.8, kind: 'set' }, { t: 5, v: 0.56, kind: 'target', tau: 0.5 }];
    expect(envelopeLevelAt(env, 4.9)).toBeCloseTo(0.8, 6);      // before the note: holds
    expect(envelopeLevelAt(env, 5)).toBeCloseTo(0.8, 6);
    expect(envelopeLevelAt(env, 5.5)).toBeCloseTo(0.56 + 0.24 * Math.exp(-1), 4);
  });

  it('handles the tone placeholder shape: two exponential ramps', () => {
    const env = [{ t: 0, v: 0.0001, kind: 'set' },
                 { t: 0.008, v: 0.3, kind: 'exp' },
                 { t: 0.25, v: 0.2, kind: 'exp' }];
    expect(envelopeLevelAt(env, 0.008)).toBeCloseTo(0.3, 6);
    const mid = envelopeLevelAt(env, 0.129);
    expect(mid).toBeLessThan(0.3);
    expect(mid).toBeGreaterThan(0.2);
  });

  it('holds the last value past the end of the envelope', () => {
    expect(envelopeLevelAt(sf2Env(10, 0.6, 0.01, 0.25, 0.05), 100)).toBeCloseTo(0.25, 4);
  });

  it('an empty envelope is silence, not full gain', () => {
    expect(envelopeLevelAt([], 3)).toBeCloseTo(0.0001, 6);
    expect(envelopeLevelAt(undefined, 3)).toBeCloseTo(0.0001, 6);
  });
});
