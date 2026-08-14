// GMD-50 — the committed drum pack (assets/drumkits/), produced by tools/extract-drumkit.mjs.
//
// The pack is generated once on a machine that has the 151MB FluidR3 bank and then committed, so
// nothing in CI can regenerate it. That makes the FILE the contract: if an offset, a zone or the
// blob length is wrong, drums decode as garbage or fall silent at runtime with no other warning.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import SF from '../core/sf2.ts';

const dir = fileURLToPath(new URL('../../../assets/drumkits/', import.meta.url));
const jsonPath = dir + 'gm-standard.json';
const havePack = existsSync(jsonPath);
const head = havePack ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;

describe.skipIf(!havePack)('gm-standard drum pack', () => {
  it('declares the format the loader expects', () => {
    expect(head.format).toBe('gomidas-drumkit');
    expect(head.version).toBe(1);
    expect(head.codec).toBeTruthy();
    expect(head.blob).toBe('gm-standard.bin');
  });

  it('matches its blob byte-for-byte', () => {
    // The loader refuses to decode on a mismatch; catch it here instead of in someone's browser.
    expect(statSync(dir + head.blob).size).toBe(head.blobBytes);
  });

  it('packs the samples contiguously with no gap, overlap or truncation', () => {
    let at = 0;
    for (const s of head.samples) {
      expect(s.offset, 'gap or overlap before ' + s.name).toBe(at);
      expect(s.length).toBeGreaterThan(0);
      at += s.length;
    }
    expect(at).toBe(head.blobBytes);
  });

  it('every zone points at a sample in this pack', () => {
    for (const kit of head.kits) {
      expect(kit.zones.length).toBeGreaterThan(0);
      for (const z of kit.zones) {
        expect(z.sampleIndex).toBeGreaterThanOrEqual(0);
        expect(z.sampleIndex).toBeLessThan(head.samples.length);
        expect(z.keyLo).toBeLessThanOrEqual(z.keyHi);
        expect(z.velLo).toBeLessThanOrEqual(z.velHi);
      }
    }
  });

  it('carries the zone fields the SF2 instrument reads', () => {
    const z = head.kits[0].zones[0];
    for (const field of ['keyLo', 'keyHi', 'velLo', 'velHi', 'sampleIndex', 'tuneCents',
                         'attenuationDb', 'pan', 'loopMode', 'exclusiveClass',
                         'attack', 'hold', 'decay', 'sustain', 'release']) {
      expect(z[field], 'zone is missing ' + field).toBeDefined();
    }
    for (const s of head.samples) {
      expect(s.sampleRate).toBeGreaterThan(0);
      expect(s.end).toBeGreaterThan(s.start);
    }
  });

  it('is a real kit, not the cardboard one this replaces', () => {
    const kit = head.kits.find(k => k.program === 0);
    const zones = (key) => kit.zones.filter(z => key >= z.keyLo && key <= z.keyHi);
    const longest = (key) => Math.max(...zones(key).map(z => {
      const s = head.samples[z.sampleIndex];
      return (s.end - s.start) / s.sampleRate;
    }));
    // sonivox's kick is 402 frames at 20kHz = 20ms, which is the whole complaint. FluidR3's is
    // 283ms at 44.1kHz. Assert the floor that separates a drum from a click.
    expect(longest(36), 'kick is too short to be a kick').toBeGreaterThan(0.15);
    expect(longest(38), 'snare is too short').toBeGreaterThan(0.2);
    expect(longest(49), 'crash has no tail').toBeGreaterThan(2);
    for (const s of head.samples) expect(s.sampleRate).toBeGreaterThanOrEqual(44100);
    // Velocity layers are the other half of it: one layer per key is a drum machine, not a kit.
    expect(zones(38).length).toBeGreaterThan(4);
  });

  it('keeps the hi-hat choke group, and does not choke the kick', () => {
    const kit = head.kits.find(k => k.program === 0);
    const classOf = (key) => {
      const z = kit.zones.find(z => key >= z.keyLo && key <= z.keyHi);
      return z ? z.exclusiveClass : 0;
    };
    expect(classOf(42)).toBeGreaterThan(0);
    expect(classOf(46)).toBe(classOf(42));   // closed hat must cut the open one
    expect(classOf(36)).not.toBe(classOf(42));
  });

  it('selects a plausible zone for every piece the drum palette can write', () => {
    const kit = head.kits.find(k => k.program === 0);
    const preset = { zones: kit.zones };
    // The 17-piece kit view (fretboard.js KIT_PIECES) plus the tex registration chord.
    for (const key of [36, 38, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 59]) {
      const zs = SF.zonesFor(preset, key, 100);
      expect(zs.length, 'no zone for GM drum key ' + key).toBeGreaterThan(0);
    }
  });
});
