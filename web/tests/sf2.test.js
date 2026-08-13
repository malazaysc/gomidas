// GMD-36 — SoundFont 2 reader, golden-tested against the bundled sonivox GM bank.
// A wrong offset here means a wrong sample at a wrong pitch, so the real file is the test.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import SF from '../core/sf2.ts';

const { parseSf2, zonesFor, rateFor, timecentsToSeconds } = SF;
const bankPath = fileURLToPath(new URL('../../assets/soundfont/sonivox.sf2', import.meta.url));
const haveBank = existsSync(bankPath);

function load() {
  const buf = readFileSync(bankPath);
  return parseSf2(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

describe('units', () => {
  it('converts timecents to seconds', () => {
    expect(timecentsToSeconds(0)).toBeCloseTo(1, 9);          // 0 tc = 1 second
    // -12000 tc is 2^-10 = 0.9766ms — the spec's "approximately 1ms" default, not exactly 1ms.
    expect(timecentsToSeconds(-12000)).toBeCloseTo(Math.pow(2, -10), 12);
    expect(timecentsToSeconds(-12000)).toBeCloseTo(0.001, 3);
    expect(timecentsToSeconds(1200)).toBeCloseTo(2, 9);
  });
});

describe('malformed input', () => {
  it('rejects a non-RIFF buffer instead of producing garbage', () => {
    expect(() => parseSf2(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer)).toThrow(/RIFF/);
  });

  it('rejects a RIFF that is not a SoundFont', () => {
    const b = new Uint8Array(16);
    b.set([0x52, 0x49, 0x46, 0x46]);            // "RIFF"
    b.set([0x57, 0x41, 0x56, 0x45], 8);         // "WAVE"
    expect(() => parseSf2(b.buffer)).toThrow(/SoundFont/);
  });
});

describe.skipIf(!haveBank)('bundled sonivox GM bank', () => {
  it('parses presets, samples and PCM', () => {
    const sf = load();
    expect(sf.presets.length).toBeGreaterThan(100);   // a GM bank has ~128 melodic + drums
    expect(sf.samples.length).toBeGreaterThan(50);
    expect(sf.pcm.length).toBeGreaterThan(100000);
  });

  it('exposes the General MIDI program map', () => {
    const sf = load();
    // Spot-check the programs the editor actually uses for guitar/bass tracks.
    for (const program of [0 /* piano */, 24 /* nylon guitar */, 27 /* clean electric */, 33 /* finger bass */, 48 /* strings */]) {
      const p = sf.findPreset(0, program);
      expect(p, 'no preset for GM program ' + program).not.toBeNull();
      expect(p.zones.length, 'no zones for program ' + program).toBeGreaterThan(0);
    }
  });

  it('has a percussion bank for channel 9', () => {
    const sf = load();
    // GM drums live in bank 128. Fall back through findPreset if the bank is laid out oddly.
    const drums = sf.presets.find(p => p.bank === 128) || sf.findPreset(128, 0);
    expect(drums).toBeTruthy();
    expect(drums.zones.length).toBeGreaterThan(0);
  });

  it('every zone points at a real sample and a sane key range', () => {
    const sf = load();
    for (const preset of sf.presets) {
      for (const z of preset.zones) {
        expect(z.sampleIndex).toBeGreaterThanOrEqual(0);
        expect(z.sampleIndex).toBeLessThan(sf.samples.length);
        expect(z.keyLo).toBeLessThanOrEqual(z.keyHi);
        expect(z.velLo).toBeLessThanOrEqual(z.velHi);
      }
    }
  });

  it('sample offsets stay inside the PCM block', () => {
    const sf = load();
    for (const s of sf.samples) {
      expect(s.start).toBeLessThanOrEqual(s.end);
      expect(s.end).toBeLessThanOrEqual(sf.pcm.length + 1);
      if (s.end > s.start) expect(s.sampleRate).toBeGreaterThan(0);
    }
  });

  it('finds playable zones across a piano keyboard', () => {
    const sf = load();
    const piano = sf.findPreset(0, 0);
    for (const key of [36, 48, 60, 72, 84]) {
      expect(zonesFor(piano, key, 100).length, 'no zone for key ' + key).toBeGreaterThan(0);
    }
  });

  it('plays the root key at (near) unity rate and transposes by octave', () => {
    const sf = load();
    const piano = sf.findPreset(0, 0);
    const z = zonesFor(piano, 60, 100)[0];
    const s = sf.samples[z.sampleIndex];
    const root = z.rootKey != null ? z.rootKey : s.originalPitch;
    const atRoot = rateFor(z, s, root, s.sampleRate);
    // NOT exactly 1: the sample carries a pitchCorrection in cents (this bank's piano is -32c)
    // and the zone may add tuning. Applying that is the point — assert the expected offset
    // rather than unity, or we would be testing that the correction is ignored.
    const expected = Math.pow(2, (z.tuneCents + (s.pitchCorrection || 0)) / 1200);
    expect(atRoot).toBeCloseTo(expected, 6);
    expect(Math.abs(1200 * Math.log2(atRoot))).toBeLessThan(100);   // within a semitone of unity
    const octaveUp = rateFor(z, s, root + 12, s.sampleRate);
    expect(octaveUp / atRoot).toBeCloseTo(2, 2);
  });

  it('resamples correctly when the output rate differs from the sample rate', () => {
    const sf = load();
    const z = zonesFor(sf.findPreset(0, 0), 60, 100)[0];
    const s = sf.samples[z.sampleIndex];
    const at44k = rateFor(z, s, 60, 44100);
    const at48k = rateFor(z, s, 60, 48000);
    expect(at44k / at48k).toBeCloseTo(48000 / 44100, 6);
  });

  it('produces envelopes in a plausible range', () => {
    const sf = load();
    const z = zonesFor(sf.findPreset(0, 0), 60, 100)[0];
    for (const v of [z.attack, z.decay, z.release]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(60);
    }
    expect(z.sustain).toBeGreaterThanOrEqual(0);
    expect(z.sustain).toBeLessThanOrEqual(1);
  });
});
