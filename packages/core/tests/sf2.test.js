// GMD-36 — SoundFont 2 reader, golden-tested against the bundled sonivox GM bank.
// A wrong offset here means a wrong sample at a wrong pitch, so the real file is the test.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import SF from '../core/sf2.ts';

const { parseSf2, zonesFor, rateFor, timecentsToSeconds, velocityGain, attenuationGain } = SF;
const bankPath = fileURLToPath(new URL('../../../assets/soundfont/sonivox.sf2', import.meta.url));
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

  // GMD-51 — SF2 §8.4.1 default velocity->attenuation modulator (960 cB, concave).
  it('maps velocity through the default modulator curve, not linearly', () => {
    expect(velocityGain(1)).toBeCloseTo(1, 9);          // full velocity is 0 dB, unchanged
    expect(velocityGain(0)).toBe(0);
    // The reference point: fluidsynth's concave table gives 11.9 dB of attenuation at MIDI 64,
    // i.e. gain 0.254. If this ever drifts back to linear it would read 0.504.
    expect(velocityGain(64 / 127)).toBeCloseTo(Math.pow(10, -11.9 / 20), 2);
    // Monotonic, and a ghost note is far quieter than an accent (this is the audible point).
    expect(velocityGain(0.3)).toBeLessThan(velocityGain(0.6));
    expect(velocityGain(0.9) / velocityGain(0.3)).toBeGreaterThan(8);
    // Clamped, never negative gain from a bad velocity.
    expect(velocityGain(-1)).toBe(0);
    expect(velocityGain(4)).toBe(1);
  });

  // GMD-50 — the EMU/fluidsynth attenuation factor. Read as literal centibels instead, FluidR3's
  // kick sits 10 dB under its snare and its hi-hat 21 dB under, which is the "drums are very low"
  // report. These are the two numbers that separate the readings.
  it('converts initialAttenuation with the factor banks were authored against', () => {
    expect(attenuationGain(0)).toBe(1);
    const dB = (g) => 20 * Math.log10(g);
    expect(dB(attenuationGain(21))).toBeCloseTo(-7.9, 1);    // closed hat: NOT -21
    expect(attenuationGain(10)).toBeGreaterThan(Math.pow(10, -10 / 20));
    // Still monotonic, still bounded — a bigger attenuation is always quieter, never a boost.
    expect(attenuationGain(20)).toBeLessThan(attenuationGain(10));
    expect(attenuationGain(-5)).toBe(1);
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

  // GMD-51 — percussion interpretation. Both defects below are provable against this bank.
  it('resolves a drum kit inside bank 128, never falling through to a melodic preset', () => {
    const sf = load();
    // sonivox ships kits 0/8/32/40 only. findPreset's "same program in bank 0" fallback answers
    // program 16 with Organ 1 — a drum track playing an organ. findDrumPreset stays in bank 128.
    expect(sf.findPreset(128, 16).bank).toBe(0);
    expect(sf.findDrumPreset(16).bank).toBe(128);
    expect(sf.findDrumPreset(0).name).toMatch(/standard/i);
    // A kit the bank does have must still resolve to itself, not to the Standard fallback.
    expect(sf.findDrumPreset(8).program).toBe(8);
  });

  it('reads the exclusive class that lets a closed hi-hat choke the open one', () => {
    const sf = load();
    const kit = sf.findDrumPreset(0);
    const classOf = (key) => {
      const z = zonesFor(kit, key, 100)[0];
      return z && z.exclusiveClass;
    };
    // GM 42 closed / 44 pedal / 46 open hat share one class: only one of them may sound.
    expect(classOf(42)).toBeGreaterThan(0);
    expect(classOf(44)).toBe(classOf(42));
    expect(classOf(46)).toBe(classOf(42));
    // A kick is not in a choke group — it must ring through the hats.
    expect(classOf(36) || 0).not.toBe(classOf(42));
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
