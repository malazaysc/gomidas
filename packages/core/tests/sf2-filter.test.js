// GMD-80 / GMD-81 — the SF2 low-pass filter (gens 8/9).
//
// The bug this exists to prevent is silent in the worst way: with the filter unparsed, FluidR3's
// Clean/Overdrive/Distortion Guitar presets — a dry layer plus a low-passed layer of the SAME
// sample — read as two identical zones and play as two dry voices, summing to +6.05dB of
// broadband guitar against every single-layer program. Nothing errors; the guitar is just loud
// and bright, and drums read as quiet against it.
//
// So the assertions here are of two kinds: the pure rule (which zones filter, at what frequency,
// in what unit), and a GOLDEN against the committed packs, because a re-extract that dropped the
// two fields would put the +6dB back with every test still green.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import SF from '../core/sf2.ts';

const { parseSf2, zoneFilter, centsToHertz } = SF;
const RATE = 44100;

describe('zoneFilter — the rule', () => {
  it('treats the SF2 default as no filter at all', () => {
    // 13500 cents is ~19.9kHz: the spec's "open" value, carried by 510 of the 1275 packed melodic
    // zones. Building a biquad for those would be pure CPU for nothing.
    expect(zoneFilter({ filterFc: 13500, filterQ: 0 }, RATE)).toBeNull();
    expect(zoneFilter({ filterFc: 14400 }, RATE)).toBeNull();   // one drum zone really is above it
  });

  it('is a no-op for a zone that carries no filter fields at all', () => {
    // THE OLD-PACK PATH. A pack extracted before GMD-80 has neither field; it must keep playing
    // exactly as it did. Reading a missing filterFc as 0 would filter every note at 8Hz — silence.
    expect(zoneFilter({}, RATE)).toBeNull();
    expect(zoneFilter({ attenuationDb: 3, pan: 0 }, RATE)).toBeNull();
  });

  it('converts absolute cents to Hz on TinySoundFont\'s curve', () => {
    // 8.176 * 2^(cents/1200), matching tsf_cents2Hertz, so both products filter at one frequency.
    expect(centsToHertz(6900)).toBeCloseTo(440, 0);            // the tuning reference
    expect(zoneFilter({ filterFc: 7935 }, RATE).hz).toBeCloseTo(800.022, 3);   // Clean Guitar's layer
    expect(zoneFilter({ filterFc: 8321 }, RATE).hz).toBeCloseTo(999.846, 3);   // Overdrive Guitar's
  });

  it('reports Q in DECIBELS, which is Web Audio\'s unit for a lowpass', () => {
    // SF2 stores centibels; Web Audio's BiquadFilterNode takes a lowpass resonance in dB (not the
    // cookbook's dimensionless Q). Off by 10x here and every resonant zone rings or goes flat.
    expect(zoneFilter({ filterFc: 7935, filterQ: 30 }, RATE).qDb).toBeCloseTo(3, 9);
    expect(zoneFilter({ filterFc: 7935, filterQ: 0 }, RATE).qDb).toBe(0);
    expect(zoneFilter({ filterFc: 7935 }, RATE).qDb).toBe(0);
  });

  it('resolves the cutoff through a FAST modulation envelope, not from gen 8 alone', () => {
    // FluidR3 Distortion Guitar: 8080 cents (870Hz) that the modulation envelope opens to 3619Hz
    // in 2ms and holds there (sustain 1.0). Taking gen 8 as the answer plays it at 870Hz — four
    // times darker than the bank asks for, which is what review round 1 caught.
    const z = { filterFc: 8080, filterModEnv: 2468, modEnvSustain: 1, modEnvSettle: 0.002 };
    expect(zoneFilter(z, RATE).hz).toBeCloseTo(3619.05, 2);
    // And when the sum clears the open threshold the zone has NO filter, however low gen 8 was.
    expect(zoneFilter({ ...z, filterFc: 11108 }, RATE), '11108 + 2468 = 13576 -> open').toBeNull();
    // A partial sustain lands partway up, as TSF's modEnv would hold it.
    expect(zoneFilter({ ...z, modEnvSustain: 0.5 }, RATE).hz).toBeCloseTo(1774.33, 2);
  });

  it('refuses a SLOW envelope instead of freezing it somewhere', () => {
    const slow = { filterFc: 4651, filterModEnv: 6723, modEnvSustain: 0.19, modEnvSettle: 0.252 };
    expect(zoneFilter(slow, RATE), 'Synth Bass 1 sweeps for 252ms — not a static filter').toBeNull();
    expect(zoneFilter({ ...slow, modEnvSettle: 0.002 }, RATE).hz).toBeCloseTo(251.03, 2);
    // A pack that somehow carries filterModEnv without the settle time must fail CLOSED. Written
    // as `!(x <= T)` in the source precisely so undefined does not sail through the comparison.
    expect(zoneFilter({ filterFc: 4651, filterModEnv: 6723, modEnvSustain: 0.19 }, RATE)).toBeNull();
  });

  it('clamps to TSF\'s generator limits, so a summed offset cannot fall off the end', () => {
    // TSF merges gen 8 into [1500, 13500] and gen 9 into [0, 960] (GEN_INT_LIMITFC/LIMITQ).
    // Unclamped, FluidR3's "Chiffer Lead" sums to 1139 cents = 15.7Hz and plays as silence.
    expect(zoneFilter({ filterFc: 1139 }, RATE).hz).toBeCloseTo(centsToHertz(1500), 6);
    expect(zoneFilter({ filterFc: -3000 }, RATE).hz).toBeCloseTo(centsToHertz(1500), 6);
    expect(zoneFilter({ filterFc: 7935, filterQ: 5000 }, RATE).qDb).toBe(96);
    expect(zoneFilter({ filterFc: 7935, filterQ: -200 }, RATE).qDb).toBe(0);
    // The clamp is applied BEFORE the envelope, exactly where TSF applies it: 14400 clamps to
    // 13500 and the negative envelope then brings it back under the threshold.
    expect(zoneFilter({ filterFc: 14400, filterModEnv: -1000, modEnvSustain: 1, modEnvSettle: 0.002 }, RATE)
      .hz).toBeCloseTo(centsToHertz(12500), 6);
  });

  it('skips a cutoff at or above Nyquist', () => {
    // TSF's own test (lowpassFc < 0.499). Such a filter removes nothing and only rings the biquad.
    // 13100 cents = 15.7kHz: audible at 44.1k, above Nyquist at 22.05k.
    expect(zoneFilter({ filterFc: 13100 }, RATE)).not.toBeNull();
    expect(zoneFilter({ filterFc: 13100 }, 22050)).toBeNull();
  });
});

// ── the banks, expanded ───────────────────────────────────────────────────────
const bankPath = fileURLToPath(new URL('../../../assets/soundfont/sonivox.sf2', import.meta.url));

describe('preset filter generators are additive offsets', () => {
  it('parses the bundled sonivox bank with the fields present', () => {
    expect(existsSync(bankPath), 'sonivox.sf2 is committed — it cannot be missing').toBe(true);
    const buf = readFileSync(bankPath);
    const bank = parseSf2(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const zones = bank.presets.flatMap(p => p.zones);
    // Every zone gets a value: absent gen 8 means the 13500 default, never undefined.
    expect(zones.every(z => typeof z.filterFc === 'number')).toBe(true);
    expect(zones.every(z => typeof z.filterQ === 'number')).toBe(true);
    // Corrected during review: the first version of this comment claimed sonivox was untouched
    // because it carries no PRESET-level offsets. True, and irrelevant — 147 of its zones set gen 8
    // at instrument level, and 268 more have a modulation envelope driving the cutoff. What
    // actually keeps the fallback bank nearly unchanged is the settle-time rule: sonivox sweeps
    // slowly (median 1.03s to reach sustain), so only 28 zones qualify for a static filter.
    const filtered = zones.filter(z => zoneFilter(z, RATE));
    expect(filtered.length).toBe(28);
    expect(zones.filter(z => z.filterFc < 13500).length,
           'gen 8 alone would have filtered far more').toBe(147);
  });

  it('leaves a SLOW modulation sweep alone rather than guessing a point on it', () => {
    // sonivox authors most of its bank as "open, closing over about a second" — Piano 1 is
    // 13500 cents with modEnv -4050 at full sustain, i.e. it settles at 1919Hz after a 1s attack.
    // Freezing it there would make every piano note dark from its first sample. GMD-83 owns this.
    const buf = readFileSync(bankPath);
    const bank = parseSf2(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const piano = bank.findPreset(0, 0).zones[0];
    expect(piano.filterModEnv).toBeLessThan(0);
    expect(piano.modEnvSettle).toBeGreaterThan(0.5);
    expect(zoneFilter(piano, RATE), 'a 1s sweep must not become a static filter').toBeNull();
  });
});

// ── golden: the committed packs ───────────────────────────────────────────────
const melodicPath = fileURLToPath(new URL('../../../assets/instruments-gm/gm-melodic.json', import.meta.url));
const drumPath = fileURLToPath(new URL('../../../assets/drumkits/gm-standard.json', import.meta.url));

describe('the committed packs carry the filter', () => {
  // Not skipIf: both files are committed. A suite that vanishes when an asset moves reports
  // success having checked nothing — see the drum pack tests.
  it('has both packs to check', () => {
    expect(existsSync(melodicPath)).toBe(true);
    expect(existsSync(drumPath)).toBe(true);
  });

  const melodic = () => JSON.parse(readFileSync(melodicPath, 'utf8'));
  const drums = () => JSON.parse(readFileSync(drumPath, 'utf8'));

  it('gives program 27 two layers per note that differ ONLY by the filter', () => {
    // This is GMD-80 itself. Clean Guitar, middle C, mezzo-forte: two zones, one sample, one of
    // them low-passed at 800Hz. Before the fix both played dry and summed to +6.05dB.
    const p27 = melodic().programs.find(p => p.program === 27);
    const zs = p27.zones.filter(z => 60 >= z.keyLo && 60 <= z.keyHi && 102 >= z.velLo && 102 <= z.velHi);
    expect(zs.length).toBe(2);
    expect(zs[0].sampleIndex).toBe(zs[1].sampleIndex);              // the same sample, twice
    expect(zs[0].attenuationDb).toBe(zs[1].attenuationDb);          // at the same level
    const filters = zs.map(z => zoneFilter(z, RATE));
    expect(filters.filter(Boolean).length, 'exactly one layer is filtered').toBe(1);
    expect(filters.find(Boolean).hz).toBeCloseTo(800.022, 3);
  });

  it('keeps Nylon Guitar\'s per-velocity brightness, which lives on the PRESET bags', () => {
    // GMD-81's other half: prog 24 has one zone per (key, velocity) and the cutoff is what makes
    // a soft note dark. Take one key across the dynamic range — the cutoffs must DESCEND.
    const p24 = melodic().programs.find(p => p.program === 24);
    const hzAt = (vel) => {
      const z = p24.zones.find(z => 60 >= z.keyLo && 60 <= z.keyHi && vel >= z.velLo && vel <= z.velHi);
      const f = zoneFilter(z, RATE);
      return f ? f.hz : Infinity;
    };
    const loud = hzAt(127), mid = hzAt(100), soft = hzAt(30);
    expect(loud).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(soft);
    // The measured span: -2786 cents from the loudest layer to the softest is a 5x drop in cutoff.
    expect(loud / soft).toBeCloseTo(Math.pow(2, 2786 / 1200), 1);
  });

  it('filters the zones the bank asks it to, and no others', () => {
    // Pinned counts, measured off FluidR3 by expanding every packed preset. A re-extract that
    // dropped the two fields reads as 0 here rather than as a silent +6dB in someone's ears.
    const m = melodic();
    const zones = m.programs.flatMap(p => p.zones);
    expect(zones.length).toBe(1275);
    expect(zones.filter(z => zoneFilter(z, RATE)).length).toBe(674);
    const per = (prog) => {
      const p = m.programs.find(x => x.program === prog);
      return p.zones.filter(z => zoneFilter(z, RATE)).length;
    };
    expect(per(24)).toBe(90);     // Nylon: every zone, per-velocity
    expect(per(25)).toBe(0);      // Steel String: none — its layers are genuinely different samples
    expect(per(26)).toBe(216);    // Jazz Guitar: every zone
    expect(per(27)).toBe(90);     // Clean: half — the second layer of each pair
    // Distortion: only the layer whose modEnv-resolved cutoff lands under the open threshold. The
    // other 90 zones resolve to 5001 + 2468 = 13576 cents, which IS open — filtering them at
    // gen 8's 5001 would be reading half the instruction.
    expect(per(30)).toBe(90);
    const dz = drums().kits[0].zones;
    expect(dz.length).toBe(149);
    expect(dz.filter(z => zoneFilter(z, RATE)).length).toBe(56);
  });
});

// ── the graph: is the filter actually WIRED? ──────────────────────────────────
//
// Everything above tests the PARSER. Delete the biquad from webaudio.ts and every one of those
// assertions stays green while the guitar goes back to +6dB — which is exactly how this bug
// survived in the first place. So drive the real voice factory and look at the nodes it builds.
describe('createSf2Instrument wires the zone lowpass', () => {
  let createSf2Instrument;
  let created;

  const param = (v) => ({
    value: v, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; }, setTargetAtTime() { return this; },
    cancelScheduledValues() { return this; }
  });

  function fakeContext() {
    const mk = (kind) => {
      const node = {
        kind, connections: [],
        connect(to) { this.connections.push(to); }, disconnect() {}, start() {}, stop() {},
        gain: param(1), pan: param(0), frequency: param(350), Q: param(1),
        playbackRate: param(1), detune: param(0),
        type: kind === 'createBiquadFilter' ? 'lowpass' : 'peaking',
        buffer: null, loop: false, loopStart: 0, loopEnd: 0, onended: null
      };
      created.push(node);
      return node;
    };
    return new Proxy({
      currentTime: 0, sampleRate: RATE, state: 'running', destination: mk('destination'),
      createBuffer: () => ({ length: 8, duration: 0.1, sampleRate: RATE, numberOfChannels: 1,
                             getChannelData: () => new Float32Array(8) })
    }, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k.startsWith('create')
                                          ? () => mk(k) : undefined)) });
  }

  /** A one-zone bank, so the graph under test has exactly one voice in it. */
  function bankWith(zone) {
    const preset = { bank: 0, program: 27, name: 'test', zones: [Object.assign({
      keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIndex: 0, rootKey: 60, tuneCents: 0,
      attenuationDb: 0, pan: 0, loopMode: 0, exclusiveClass: 0,
      attack: 0.001, hold: 0, decay: 0, sustain: 1, release: 0.3
    }, zone)] };
    return {
      presets: [preset], samples: [{ start: 0, end: 8, startLoop: 0, endLoop: 8,
                                     sampleRate: RATE, originalPitch: 60, pitchCorrection: 0 }],
      pcm: new Int16Array(8), findPreset: () => preset, findDrumPreset: () => preset
    };
  }

  const filters = () => created.filter(n => n.kind === 'createBiquadFilter');
  // The FIRST gain the factory builds is the instrument's shared output; the voice's own gain is
  // the one after it. Picking the wrong one silently turns the wiring assertions into noise.
  const voiceGain = () => created.filter(n => n.kind === 'createGain').slice(-1)[0];

  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    const win = {};
    win.window = win;
    for (const m of ['timebase', 'fx', 'sf2', 'sfz', 'packcache', 'webaudio']) {
      const src = await fs.readFile(new URL(`../dist/core/${m}.js`, import.meta.url), 'utf8');
      new Function('window', 'module', src)(win, { exports: {} });
    }
    createSf2Instrument = win.GomidasWebAudio.createSf2Instrument;
    expect(typeof createSf2Instrument, 'the factory must be exported to be testable').toBe('function');
  });

  it('inserts a lowpass at the zone cutoff, between the sample and its envelope', () => {
    created = [];
    const ctx = fakeContext();
    createSf2Instrument(ctx, bankWith({ filterFc: 7935, filterQ: 30 }), 27, false, new Map())
      .noteOn(60, 0.8, 0);
    expect(filters().length, 'a filtered zone gets exactly one biquad').toBe(1);
    const lp = filters()[0];
    expect(lp.type).toBe('lowpass');
    expect(lp.frequency.value).toBeCloseTo(800.022, 3);
    expect(lp.Q.value).toBeCloseTo(3, 9);            // 30 centibels -> 3 dB, Web Audio's unit
    // Order matters: the filter shapes the SOURCE and the envelope still owns the level. Wired
    // after the gain instead, the release ramp would be smeared by the filter's own decay.
    const src = created.find(n => n.kind === 'createBufferSource');
    const gain = voiceGain();
    expect(src.connections).toContain(lp);
    expect(lp.connections).toContain(gain);
    expect(src.connections).not.toContain(gain);
  });

  it('builds no filter node at all for an open zone', () => {
    created = [];
    const ctx = fakeContext();
    createSf2Instrument(ctx, bankWith({ filterFc: 13500, filterQ: 0 }), 27, false, new Map())
      .noteOn(60, 0.8, 0);
    expect(filters().length).toBe(0);
    const src = created.find(n => n.kind === 'createBufferSource');
    expect(src.connections, 'an unfiltered zone keeps its direct connection').toContain(voiceGain());
  });

  it('builds no filter for a pack zone that predates the fields', () => {
    created = [];
    const ctx = fakeContext();
    const bank = bankWith({});
    delete bank.presets[0].zones[0].filterFc;
    delete bank.presets[0].zones[0].filterQ;
    createSf2Instrument(ctx, bank, 27, false, new Map()).noteOn(60, 0.8, 0);
    expect(filters().length).toBe(0);
  });
});

// ── preset generators are OFFSETS: a synthetic bank ───────────────────────────
//
// This exists because mutation testing found the hole. Deleting `+ pFc` from the preset expansion
// left every other test in this file green: the golden tests read the COMMITTED pack, and that
// pack was generated by the very code path under test, so it already has the offsets folded in.
// sonivox cannot cover it either — measured, it carries no preset-level filter generators at all,
// and FluidR3 is 151MB and gitignored, so it cannot be the fixture.
//
// So build the smallest legal SoundFont that exercises the rule: one sample, one instrument zone
// with absolute values, one preset with two velocity bags of which ONE carries offsets. This is
// how FluidR3 stores Nylon Guitar's per-velocity brightness, which is the half of GMD-81 that
// makes a soft note darker rather than merely quieter.
describe('preset generators fold onto the instrument value', () => {
  const enc = (name) => { const b = new Uint8Array(20); for (let i = 0; i < name.length && i < 19; i++) b[i] = name.charCodeAt(i); return b; };

  function buildSf2() {
    const parts = [];
    const chunk = (id, body) => {
      const head = new Uint8Array(8);
      for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
      new DataView(head.buffer).setUint32(4, body.length, true);
      const pad = body.length & 1 ? new Uint8Array(1) : new Uint8Array(0);
      return concat([head, body, pad]);
    };
    const concat = (arrs) => {
      const total = arrs.reduce((a, x) => a + x.length, 0);
      const out = new Uint8Array(total);
      let at = 0; for (const x of arrs) { out.set(x, at); at += x.length; }
      return out;
    };
    const rec = (size, fill) => { const b = new Uint8Array(size); fill(new DataView(b.buffer), b); return b; };
    // gen record: op (u16) + a 2-byte amount, read as int16 for values and lo/hi for ranges
    const gen = (op, a, b) => rec(4, (v) => { v.setUint16(0, op, true); if (b == null) v.setInt16(2, a, true); else { v.setUint8(2, a); v.setUint8(3, b); } });

    const phdr = concat([
      rec(38, (v, b) => { b.set(enc('Test'), 0); v.setUint16(20, 24, true); v.setUint16(22, 0, true); v.setUint16(24, 0, true); }),
      rec(38, (v, b) => { b.set(enc('EOP'), 0); v.setUint16(24, 2, true); })          // terminator
    ]);
    // bag 0 owns pgen[0..2], bag 1 owns pgen[3..4]; the terminal bag bounds the last one.
    const pbag = concat([
      rec(4, (v) => v.setUint16(0, 0, true)),
      rec(4, (v) => v.setUint16(0, 5, true)),
      rec(4, (v) => v.setUint16(0, 7, true))
    ]);
    const pgen = concat([
      gen(44, 0, 64),        // velRange 0-64: the soft layer, and the one carrying offsets
      gen(8, -2786),         // initialFilterFc  -2786 cents
      gen(48, 20),           // initialAttenuation +2.0 dB
      gen(9, -15),           // initialFilterQ   -1.5 dB
      gen(41, 0),            // instrument (terminal generator)
      gen(44, 65, 127),      // velRange 65-127: the loud layer, no offsets
      gen(41, 0),
      gen(0, 0)              // terminal record
    ]);
    const inst = concat([
      rec(22, (v, b) => { b.set(enc('Inst'), 0); v.setUint16(20, 0, true); }),
      rec(22, (v, b) => { b.set(enc('EOI'), 0); v.setUint16(20, 1, true); })
    ]);
    // The terminal bag must point PAST the sampleID at igen[5], or the zone reads as a global one
    // (no sampleID -> not a zone) and the preset comes back empty.
    const ibag = concat([rec(4, (v) => v.setUint16(0, 0, true)), rec(4, (v) => v.setUint16(0, 6, true))]);
    const igen = concat([
      gen(43, 0, 127),       // keyRange
      gen(8, 10361),         // initialFilterFc: the zone's ABSOLUTE cutoff (3248 Hz)
      gen(9, 40),            // initialFilterQ 4.0 dB
      gen(48, 50),           // initialAttenuation 5.0 dB
      gen(51, 1),            // coarseTune +1 semitone
      gen(53, 0),            // sampleID (terminal generator)
      gen(0, 0)
    ]);
    const shdr = concat([
      rec(46, (v, b) => { b.set(enc('Smp'), 0); v.setUint32(20, 0, true); v.setUint32(24, 8, true);
                          v.setUint32(28, 0, true); v.setUint32(32, 8, true); v.setUint32(36, 44100, true);
                          v.setUint8(40, 60); v.setUint16(44, 1, true); }),
      rec(46, (v, b) => b.set(enc('EOS'), 0))
    ]);
    const pdta = chunk('LIST', concat([enc('pdta').slice(0, 4),
      chunk('phdr', phdr), chunk('pbag', pbag), chunk('pgen', pgen),
      chunk('inst', inst), chunk('ibag', ibag), chunk('igen', igen), chunk('shdr', shdr)]));
    const sdta = chunk('LIST', concat([enc('sdta').slice(0, 4), chunk('smpl', new Uint8Array(16))]));
    const body = concat([enc('sfbk').slice(0, 4), sdta, pdta]);
    const file = chunk('RIFF', body);
    return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  }

  const zoneAt = (vel) => {
    const bank = parseSf2(buildSf2());
    const p = bank.findPreset(0, 24);
    const zs = p.zones.filter(z => vel >= z.velLo && vel <= z.velHi);
    expect(zs.length, 'the fixture must resolve to exactly one zone at velocity ' + vel).toBe(1);
    return zs[0];
  };

  it('reads the instrument value straight through when the preset adds nothing', () => {
    const z = zoneAt(100);
    expect(z.filterFc).toBe(10361);
    expect(zoneFilter(z, RATE).hz).toBeCloseTo(3248.509, 3);
    expect(zoneFilter(z, RATE).qDb).toBeCloseTo(4, 9);
    expect(z.attenuationDb).toBeCloseTo(5, 9);
    expect(z.tuneCents).toBe(100);
  });

  it('ADDS the preset offset to the cutoff, it does not replace it', () => {
    // 10361 + (-2786) = 7575 cents = 649.8 Hz. Replacing would give -2786 cents (1.7 Hz, silence);
    // ignoring would leave 3248 Hz, which is the bug: every dynamic at the same timbre.
    const z = zoneAt(30);
    expect(z.filterFc).toBe(7575);
    expect(zoneFilter(z, RATE).hz).toBeCloseTo(649.819, 3);
    // The other offsets fold the same way, and are asserted here so one fixture covers the rule.
    expect(z.attenuationDb).toBeCloseTo(7, 9);      // 5.0 instrument + 2.0 preset
    expect(z.tuneCents).toBe(100);                  // +1 semitone, no preset tune
    expect(zoneFilter(z, RATE).qDb).toBeCloseTo(2.5, 9);   // 40 centibels + (-15) = 2.5 dB
  });
});
