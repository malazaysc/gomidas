// GMD-34 — SFZ-lite parser, golden-tested against the two bundled CC0 instruments.
// If these break, the web build plays the wrong sample at the wrong pitch.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import S from '../core/sfz.ts';

const { parseSfz, parseKey, findRegion, playbackRateFor, sampleList } = S;
const asset = (p) => fileURLToPath(new URL('../../../assets/instruments/' + p, import.meta.url));

describe('key names', () => {
  it('parses numeric keys and note names on the c4=60 convention', () => {
    expect(parseKey('60')).toBe(60);
    expect(parseKey('c4')).toBe(60);
    expect(parseKey('a4')).toBe(69);      // A440
    expect(parseKey('c-1')).toBe(0);
    expect(parseKey('g#3')).toBe(56);
    expect(parseKey('ab3')).toBe(56);     // enharmonic
  });
});

describe('hierarchy', () => {
  it('inherits <global> and <group> into each <region>', () => {
    const r = parseSfz(`
      <global> bend_up=1200 bend_down=-1200
      <group> ampeg_decay=0.5 ampeg_release=0.3
      <region> key=40 sample=a.flac
      <region> key=41 sample=b.flac
    `);
    expect(r.length).toBe(2);
    // Getting this wrong gives every note the DEFAULT envelope — audible as wrong release,
    // not as an error, which is why it is pinned.
    expect(r[0].ampegDecay).toBe(0.5);
    expect(r[0].ampegRelease).toBe(0.3);
    expect(r[1].bendUp).toBe(1200);
  });

  it('a new <group> resets the previous group but keeps <global>', () => {
    const r = parseSfz(`
      <global> bend_up=1200
      <group> ampeg_release=0.9
      <region> key=40 sample=a.flac
      <group>
      <region> key=41 sample=b.flac
    `);
    expect(r[0].ampegRelease).toBe(0.9);
    expect(r[1].ampegRelease).toBe(0.3);   // back to the default
    expect(r[1].bendUp).toBe(1200);        // global survives
  });

  it('a region overrides the group', () => {
    const r = parseSfz(`<group> ampeg_release=0.9 <region> key=40 sample=a.flac ampeg_release=0.1`);
    expect(r[0].ampegRelease).toBe(0.1);
  });

  it('strips // comments without eating opcodes', () => {
    const r = parseSfz(`
      // Name: something with = signs and <region> in the text
      <region> key=40 sample=a.flac // trailing note
    `);
    expect(r.length).toBe(1);
    expect(r[0].sample).toBe('a.flac');
  });

  it('ignores unknown headers instead of turning them into regions', () => {
    const r = parseSfz(`<curve> v000=0 <region> key=40 sample=a.flac`);
    expect(r.length).toBe(1);
  });
});

describe('key mapping', () => {
  it('key=NN sets lokey, hikey AND pitch_keycenter together', () => {
    const [r] = parseSfz(`<region> key=45 sample=a.flac`);
    expect([r.lokey, r.hikey, r.pitchKeycenter]).toEqual([45, 45, 45]);
  });

  it('supports a stretched range with an explicit centre', () => {
    const [r] = parseSfz(`<region> lokey=26 hikey=28 pitch_keycenter=28 sample=E.flac`);
    expect([r.lokey, r.hikey, r.pitchKeycenter]).toEqual([26, 28, 28]);
  });

  it('picks the LAST matching region, per the SFZ last-match rule', () => {
    const regions = parseSfz(`
      <region> lokey=0 hikey=127 sample=fallback.flac
      <region> key=40 sample=exact.flac
    `);
    expect(findRegion(regions, 40).sample).toBe('exact.flac');
    expect(findRegion(regions, 41).sample).toBe('fallback.flac');
  });

  it('returns null rather than guessing when no region covers the key', () => {
    const regions = parseSfz(`<region> key=40 sample=a.flac`);
    expect(findRegion(regions, 90)).toBeNull();
  });

  it('honours velocity layers when present', () => {
    const regions = parseSfz(`
      <region> key=40 lovel=0 hivel=63 sample=soft.flac
      <region> key=40 lovel=64 hivel=127 sample=hard.flac
    `);
    expect(findRegion(regions, 40, 30).sample).toBe('soft.flac');
    expect(findRegion(regions, 40, 100).sample).toBe('hard.flac');
  });
});

describe('pitch', () => {
  it('plays the centre key at 1.0 and transposes by equal temperament', () => {
    const [r] = parseSfz(`<region> lokey=26 hikey=28 pitch_keycenter=28 sample=E.flac`);
    expect(playbackRateFor(r, 28)).toBeCloseTo(1, 10);
    expect(playbackRateFor(r, 40)).toBeCloseTo(2, 10);    // an octave up
    expect(playbackRateFor(r, 16)).toBeCloseTo(0.5, 10);  // an octave down
  });

  it('applies the tune opcode in cents', () => {
    const [r] = parseSfz(`<region> key=60 tune=100 sample=a.flac`);
    expect(playbackRateFor(r, 60)).toBeCloseTo(Math.pow(2, 1 / 12), 10);
  });
});

// ---- golden tests against the real bundled instruments -------------------------------------
const guitar = asset('classical-guitar/classical-guitar.sfz');
const bass = asset('electric-bass/electric-bass.sfz');
const haveAssets = existsSync(guitar) && existsSync(bass);

describe.skipIf(!haveAssets)('bundled CC0 instruments', () => {
  it('parses the electric bass with its global bend range and group envelope', () => {
    const regions = parseSfz(readFileSync(bass, 'utf8'));
    expect(regions.length).toBeGreaterThan(10);
    // Gomidas widened these to +/-12 semitones to match the TSF engine — if the parse loses
    // them, web bends are a whole tone instead of an octave.
    expect(regions[0].bendUp).toBe(1200);
    expect(regions[0].bendDown).toBe(-1200);
    expect(regions[0].ampegDecay).toBe(0.5);
    expect(regions[0].ampegRelease).toBe(0.3);
    expect(regions.every(r => r.sample.endsWith('.flac'))).toBe(true);
  });

  it('covers a bass guitar range including the open E', () => {
    const regions = parseSfz(readFileSync(bass, 'utf8'));
    expect(findRegion(regions, 28)).not.toBeNull();   // E1, open low E
    expect(findRegion(regions, 43)).not.toBeNull();   // G2
  });

  it('parses the classical guitar and covers standard tuning', () => {
    const regions = parseSfz(readFileSync(guitar, 'utf8'));
    expect(regions.length).toBeGreaterThan(10);
    for (const key of [40, 45, 50, 55, 59, 64]) {     // E2 A2 D3 G3 B3 E4
      expect(findRegion(regions, key), 'no region for key ' + key).not.toBeNull();
    }
  });

  it('every region references a sample, and the list is deduplicated', () => {
    for (const f of [guitar, bass]) {
      const regions = parseSfz(readFileSync(f, 'utf8'));
      expect(regions.every(r => r.sample.length > 0)).toBe(true);
      const list = sampleList(regions);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
