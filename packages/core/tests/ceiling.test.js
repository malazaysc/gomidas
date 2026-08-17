// Master output ceiling (GMD-42) — the curve that stops the mix hard-clipping.
//
// Why it exists: measured on the sample score via the offline bounce, a SINGLE full-velocity note
// peaks at +2.88 dBFS and the two-track score at +5.77 dBFS, producing 410 hard-clipped samples.
// A voice's peak gain is velocity² × zone attenuation — both top out at 1.0 — so nothing in the
// chain ever budgeted for a second voice.
//
// The two properties that matter, and the reason this is a WaveShaper rather than a compressor:
//   1. below the knee it is EXACTLY y = x, so ordinary material is untouched (no pumping, no
//      transient smearing, and the offline bounce stays deterministic);
//   2. it never returns |y| >= 1, at any input level, so the int16 encode cannot wrap.
import { describe, it, expect, beforeAll } from 'vitest';

let ceilingCurve, CEILING_KNEE, CEILING_RANGE, HEADROOM_GAIN, HEADROOM_DB;

beforeAll(async () => {
  // webaudio.ts emits as a plain <script> global (no module export), so load the compiled file
  // with a stub window and read the published object off it — same trick as envelope-level.test.js.
  const fs = await import('node:fs/promises');
  const url = new URL('../dist/core/webaudio.js', import.meta.url);
  const src = await fs.readFile(url, 'utf8');
  const win = {};
  new Function('window', 'module', src)(win, { exports: {} });
  ({ ceilingCurve, CEILING_KNEE, CEILING_RANGE, HEADROOM_GAIN, HEADROOM_DB } = win.GomidasWebAudio);
});

/** The signal level curve entry `i` answers for, undoing the WaveShaper's ±1 indexing. */
const inputAt = (i, n) => ((i / (n - 1)) * 2 - 1) * CEILING_RANGE;

/** Read the curve the way a WaveShaperNode does: nearest entry for a given signal level. */
function shape(curve, x) {
  const n = curve.length;
  const t = Math.max(-1, Math.min(1, x / CEILING_RANGE));
  return curve[Math.round(((t + 1) / 2) * (n - 1))];
}

describe('ceilingCurve', () => {
  let curve;
  beforeAll(() => { curve = ceilingCurve(); });

  it('is exactly linear below the knee — normal material passes through untouched', () => {
    const n = curve.length;
    for (let i = 0; i < n; i++) {
      const x = inputAt(i, n);
      if (Math.abs(x) > CEILING_KNEE) continue;
      expect(curve[i]).toBeCloseTo(x, 6);
    }
  });

  it('never reaches full scale, however hard it is driven', () => {
    for (const x of [1, 1.5, 2, 2.95, 4, 8, 100]) {
      expect(Math.abs(shape(curve, x))).toBeLessThan(1);
      expect(Math.abs(shape(curve, -x))).toBeLessThan(1);
    }
  });

  it('every entry is inside (-1, 1) — the int16 encode cannot wrap', () => {
    for (let i = 0; i < curve.length; i++) expect(Math.abs(curve[i])).toBeLessThan(1);
  });

  it('is monotonic, so louder in is never quieter out', () => {
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
  });

  it('is odd-symmetric — it must not add a DC offset', () => {
    const n = curve.length;
    for (let i = 0; i < n; i++) expect(curve[i]).toBeCloseTo(-curve[n - 1 - i], 6);
  });

  it('has no corner at the knee: slope is continuous where it engages', () => {
    // Sampled over a real signal delta, not adjacent curve entries — those are ~0.001 apart and
    // float32 rounds their difference to noise.
    const d = 0.05;
    const slope = (x) => (shape(curve, x + d) - shape(curve, x - d)) / (2 * d);
    expect(slope(CEILING_KNEE - 2 * d)).toBeCloseTo(1, 2);     // identity region
    const above = slope(CEILING_KNEE + 2 * d);
    expect(above).toBeLessThan(1);                             // already compressing
    expect(above).toBeGreaterThan(0.85);                       // but gently — no audible corner
  });

  it('covers the measured worst case without hard-clipping it', () => {
    // The loudest thing measured in the app: a six-note chord at +9.38 dBFS, after headroom.
    const worst = Math.pow(10, 9.38 / 20) * HEADROOM_GAIN;
    const out = shape(curve, worst);
    expect(out).toBeLessThan(1);
    expect(out).toBeGreaterThan(CEILING_KNEE);   // the ceiling is doing work here
  });

  it('leaves a single note below the knee — the trim alone handles ordinary playing', () => {
    // One full-velocity note measured at +2.88 dBFS; -6 dB of headroom puts it at -3.1 dBFS.
    const single = Math.pow(10, 2.88 / 20) * HEADROOM_GAIN;
    expect(single).toBeLessThan(CEILING_KNEE);
    expect(shape(curve, single)).toBeCloseTo(single, 3);
  });

  it('headroom is the advertised -6 dB', () => {
    expect(HEADROOM_DB).toBe(-6);
    expect(20 * Math.log10(HEADROOM_GAIN)).toBeCloseTo(-6, 6);
  });
});
