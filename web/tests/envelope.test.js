// .gomidas project envelope — versioned wrap + legacy raw-score fallback. The load path
// must NEVER throw (old files, hand-edited files, garbage all resolve to *something*).
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const { buildEnvelope, parseEnvelope } = C;

describe('buildEnvelope', () => {
  it('stamps the version and carries score + instruments + mix', () => {
    const env = buildEnvelope('SCORE', { instruments: { 0: 'guitar' }, mix: { master: null } });
    expect(env.gomidasVersion).toBe(1);
    expect(env.score).toBe('SCORE');
    expect(env.instruments).toEqual({ 0: 'guitar' });
    expect(env.mix).toEqual({ master: null });
  });

  it('fills empty defaults when opts omitted', () => {
    const env = buildEnvelope('SCORE');
    expect(env.instruments).toEqual({});
    expect(env.mix).toBeNull();
  });
});

describe('parseEnvelope', () => {
  it('round-trips a built envelope', () => {
    const built = buildEnvelope({ masterBars: [] }, { instruments: { 1: 'bass' }, mix: { master: { vol: 1 } } });
    const parsed = parseEnvelope(JSON.stringify(built));
    expect(parsed.legacy).toBe(false);
    expect(parsed.scoreJson).toEqual({ masterBars: [] });
    expect(parsed.instruments).toEqual({ 1: 'bass' });
    expect(parsed.mix).toEqual({ master: { vol: 1 } });
  });

  it('treats a legacy raw-score JSON string as a score (legacy=true)', () => {
    const raw = JSON.stringify({ masterBars: [], tracks: [] });
    const parsed = parseEnvelope(raw);
    expect(parsed.legacy).toBe(true);
    expect(parsed.scoreJson).toBe(raw);        // handed through untouched to the loader
    expect(parsed.instruments).toBeNull();
    expect(parsed.mix).toBeNull();
  });

  it('never throws on unparseable input', () => {
    const parsed = parseEnvelope('this is not json {{{');
    expect(parsed.legacy).toBe(true);
    expect(parsed.scoreJson).toBe('this is not json {{{');
  });

  it('an envelope missing a score field falls back to legacy', () => {
    const parsed = parseEnvelope(JSON.stringify({ gomidasVersion: 1 }));
    expect(parsed.legacy).toBe(true);
  });

  it('defaults instruments/mix when the envelope omits them', () => {
    const parsed = parseEnvelope(JSON.stringify({ gomidasVersion: 1, score: 'S' }));
    expect(parsed.legacy).toBe(false);
    expect(parsed.instruments).toEqual({});
    expect(parsed.mix).toBeNull();
  });
});
