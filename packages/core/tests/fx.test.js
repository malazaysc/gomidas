// GMD-35 — effect chain schema. This is the file that stops the .gomidas format forking
// between the two products, so the round-trip and unknown-type rules are pinned hard.
import { describe, it, expect } from 'vitest';
import F from '../core/fx.ts';

const { normalizeChain, defaultParams, isKnownType, chainIsEmpty, makeDriveCurve,
        FX_TYPES, FX_SCHEMA_VERSION } = F;

describe('schema shape', () => {
  it('normalises an empty input into a valid empty chain', () => {
    const n = normalizeChain(null);
    expect(n).toEqual({ version: FX_SCHEMA_VERSION, chain: [], sends: { delay: 0, reverb: 0 } });
  });

  it('fills defaults for a type given with no params', () => {
    const n = normalizeChain({ chain: [{ type: 'delay' }] });
    expect(n.chain[0].params.timeMs).toBe(FX_TYPES.delay.timeMs.def);
    expect(n.chain[0].bypass).toBe(false);
  });

  it('clamps out-of-range values rather than trusting the file', () => {
    const n = normalizeChain({ chain: [{ type: 'delay', params: { feedback: 5, timeMs: -100 } }] });
    expect(n.chain[0].params.feedback).toBe(0.95);   // runaway feedback would be a howl
    expect(n.chain[0].params.timeMs).toBe(10);
  });

  it('ignores garbage params without dropping the effect', () => {
    const n = normalizeChain({ chain: [{ type: 'chorus', params: { rate: 'fast', depth: null } }] });
    expect(n.chain.length).toBe(1);
    expect(n.chain[0].params.rate).toBe(FX_TYPES.chorus.rate.def);
  });

  it('skips entries that are not effects at all', () => {
    const n = normalizeChain({ chain: [null, 'drive', 42, { noType: true }, { type: 'wah' }] });
    expect(n.chain.length).toBe(1);
    expect(n.chain[0].type).toBe('wah');
  });

  it('clamps sends and defaults missing ones to zero', () => {
    expect(normalizeChain({ sends: { reverb: 2, delay: -1 } }).sends).toEqual({ delay: 0, reverb: 1 });
    expect(normalizeChain({ sends: { reverb: 0.15 } }).sends).toEqual({ delay: 0, reverb: 0.15 });
  });
});

describe('forward compatibility', () => {
  it('PRESERVES an unknown effect type instead of deleting it', () => {
    // The failure this prevents: an older build opens a newer file, saves, and silently
    // destroys effects it did not recognise.
    const exotic = { type: 'quantum-flux', params: { entanglement: 0.7 }, bypass: false };
    const n = normalizeChain({ chain: [{ type: 'drive' }, exotic] });
    expect(n.chain.length).toBe(2);
    expect(n.chain[1]).toMatchObject({ type: 'quantum-flux', params: { entanglement: 0.7 } });
    expect(n.chain[1]._unknown).toBe(true);   // marked so the renderer skips it
  });

  it('round-trips a file through normalise twice without drift', () => {
    const original = {
      version: 1,
      chain: [
        { type: 'compressor', bypass: false, params: { threshold: -18, ratio: 4, attack: 0.003, release: 0.25, knee: 6 } },
        { type: 'drive', params: { mode: 'overdrive', drive: 0.6, tone: 0.5, level: 0.8 } },
        { type: 'cab', params: { ir: '4x12-v30', mix: 1 } },
        { type: 'future-thing', params: { x: 1 } }
      ],
      sends: { delay: 0.2, reverb: 0.15 }
    };
    const once = normalizeChain(original);
    const twice = normalizeChain(once);
    expect(twice).toEqual(once);              // idempotent
    expect(JSON.parse(JSON.stringify(once))).toEqual(once);   // survives JSON
  });

  it('keeps `ir` as an identifier, never resolving it to a path', () => {
    const n = normalizeChain({ chain: [{ type: 'cab', params: { ir: 'greenback-1960' } }] });
    expect(n.chain[0].params.ir).toBe('greenback-1960');
    expect(String(n.chain[0].params.ir)).not.toMatch(/[/\\.]/);   // no path, no extension
  });

  it('rejects an invalid drive mode but keeps the effect', () => {
    const n = normalizeChain({ chain: [{ type: 'drive', params: { mode: 'plasma' } }] });
    expect(n.chain[0].params.mode).toBe('overdrive');
  });
});

describe('schema stays backend-agnostic (§5.1)', () => {
  it('declares a documented range and unit for every parameter', () => {
    for (const [type, spec] of Object.entries(FX_TYPES)) {
      for (const [param, s] of Object.entries(spec)) {
        expect(typeof s.unit, `${type}.${param}`).toBe('string');
        expect(s.min, `${type}.${param}`).toBeLessThan(s.max);
        expect(s.def, `${type}.${param}`).toBeGreaterThanOrEqual(s.min);
        expect(s.def, `${type}.${param}`).toBeLessThanOrEqual(s.max);
      }
    }
  });

  it('uses no Web-Audio-specific vocabulary in type or param names', () => {
    // If JUCE cannot express it with juce::dsp, it does not belong in the schema.
    const banned = /node|audioparam|biquad|waveshaper|convolver|gainnode|oscillator|context/i;
    for (const [type, spec] of Object.entries(FX_TYPES)) {
      expect(type).not.toMatch(banned);
      for (const param of Object.keys(spec)) expect(`${type}.${param}`).not.toMatch(banned);
    }
  });
});

describe('emptiness', () => {
  it('knows when there is nothing to render, so the graph can skip building inserts', () => {
    expect(chainIsEmpty(null)).toBe(true);
    expect(chainIsEmpty({ chain: [{ type: 'drive', bypass: true }] })).toBe(true);
    expect(chainIsEmpty({ chain: [{ type: 'unknown-x' }] })).toBe(true);      // skipped at render
    expect(chainIsEmpty({ chain: [{ type: 'drive' }] })).toBe(false);
    expect(chainIsEmpty({ sends: { reverb: 0.2 } })).toBe(false);             // a send counts
  });
});

describe('waveshaper curves', () => {
  const modes = ['overdrive', 'distortion', 'fuzz'];

  it('produces a bounded, monotonic-ish curve for each mode', () => {
    for (const mode of modes) {
      const curve = makeDriveCurve(mode, 0.7, 512);
      expect(curve.length).toBe(512);
      for (const v of curve) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);   // must never exceed full scale
      }
      expect(curve[0]).toBeLessThan(0);
      expect(curve[curve.length - 1]).toBeGreaterThan(0);
    }
  });

  it('passes near-silence through near-linearly at low drive', () => {
    const curve = makeDriveCurve('overdrive', 0, 1001);
    const mid = Math.floor(1001 / 2);
    expect(Math.abs(curve[mid])).toBeLessThan(0.01);   // zero in -> ~zero out
  });

  it('compresses harder as drive rises', () => {
    const soft = makeDriveCurve('overdrive', 0.1, 512);
    const hard = makeDriveCurve('fuzz', 1.0, 512);
    // Measure how squared-off the top half is: fuzz should flatten sooner.
    const flatness = (c) => c[Math.floor(c.length * 0.75)] / c[c.length - 1];
    expect(flatness(hard)).toBeGreaterThan(flatness(soft));
  });

  it('is deterministic — the same inputs give the same curve', () => {
    expect(Array.from(makeDriveCurve('distortion', 0.5, 64)))
      .toEqual(Array.from(makeDriveCurve('distortion', 0.5, 64)));
  });
});
