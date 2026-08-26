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
  it('treats the SF2 default as no filter at all — but only when it is FLAT', () => {
    // 13500 cents is ~19.9kHz, the spec's "open" value. TSF's test is `fres <= 13500`, so it does
    // build a filter there; we skip it, because at Q=0 the only thing it does is a ~2dB shelf
    // between 19.9kHz and Nyquist, and it would cost a biquad on 40% of every score's voices.
    expect(zoneFilter({ filterFc: 13500, filterQ: 0 }, RATE)).toBeNull();
    // 14400 clamps to 13500 and is then skipped as flat. The committed drum pack used to carry
    // exactly one such zone; since the per-merge clamp landed, parseSf2 bounds it and the
    // extractor omits it — so this is now a pure unit case, not a golden.
    expect(zoneFilter({ filterFc: 14400 }, RATE)).toBeNull();
    // A RESONANT zone at 13500 is a different thing and review round 2 caught it: the resonance is
    // a top-octave LIFT, which desktop has and dropping it is an audible divergence. 96 zones in
    // the committed packs are like this — 90 melodic (all of program 27's dry layer) and 6 drum,
    // the closed, pedal AND open hi-hat at 10dB. (Round 4 corrected this from "186", which had counted
    // all 180 of program 27's BUILT zones — the very conflation this file warns about below.)
    const hat = zoneFilter({ filterFc: 13500, filterQ: 100 }, RATE);
    expect(hat).not.toBeNull();
    expect(hat.qDb).toBe(10);
    expect(hat.hz).toBeCloseTo(19912.62, 2);
    // Above 13500 both engines agree there is nothing, resonant or not. It takes an ENVELOPE to
    // get there: gen 8 itself is clamped to 13500 first, so a raw 13501 comes back down to it.
    expect(zoneFilter({ filterFc: 13501, filterQ: 100 }, RATE).hz).toBeCloseTo(19912.62, 2);
    expect(zoneFilter({ filterFc: 13500, filterQ: 100, filterModEnv: 100,
                        modEnvSustain: 1, modEnvSettle: 0.002, modEnvDecay: 0 }, RATE)).toBeNull();
  });

  it('counts the mod-env DELAY, and lets a preset\'s sustain re-open the decay', () => {
    // Both latent traps from review round 2 — no shipped bank hits either, but the values are
    // baked into the committed packs, so a re-extract of any other bank would inherit them.
    // gen 25: a zone can sit at gen 8 for a second before the envelope even starts.
    const delayed = { filterFc: 8080, filterModEnv: 2468, modEnvSustain: 1,
                      modEnvSettle: 1.16, modEnvDecay: 0.001 };
    expect(zoneFilter(delayed, RATE), 'a 1.16s delay is not a static filter').toBeNull();
    // And the decay counts only when the envelope decays — which a PRESET offset can turn on after
    // modEnvSettle was computed, so the two are stored apart and combined here.
    const held = { filterFc: 8080, filterModEnv: 2468, modEnvSustain: 1,
                   modEnvSettle: 0.002, modEnvDecay: 3 };
    expect(zoneFilter(held, RATE).hz, 'full sustain never reaches the decay').toBeCloseTo(3619.05, 2);
    expect(zoneFilter({ ...held, modEnvSustain: 0.9 }, RATE),
           'a preset dropping sustain below 1 makes that 3s decay count').toBeNull();
    // And the decay is SCALED by how far the envelope falls — TSF's decay*(1-sustain), not the
    // whole decay. 0.1s of decay to a 0.9 sustain is 10ms of movement, which is static enough;
    // charging the full 100ms would reject a zone desktop filters.
    const shallow = { filterFc: 8080, filterModEnv: 2468, modEnvSustain: 0.9,
                      modEnvSettle: 0.002, modEnvDecay: 0.1 };
    expect(zoneFilter(shallow, RATE), 'decay*(1-sustain) = 10ms, inside the gate').not.toBeNull();
    expect(zoneFilter({ ...shallow, modEnvSustain: 0.1 }, RATE),
           'the same decay to a 0.1 sustain is 90ms — a real sweep').toBeNull();
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
  // Loaded from the built runtime so the version assertion below has something real to compare to.
  let runtimePackVersion;
  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    const win = {}; win.window = win;
    for (const m of ['timebase', 'fx', 'sf2', 'sfz', 'packcache', 'webaudio']) {
      const src = await fs.readFile(new URL(`../dist/core/${m}.js`, import.meta.url), 'utf8');
      new Function('window', 'module', src)(win, { exports: {} });
    }
    runtimePackVersion = win.GomidasWebAudio.PACK_VERSION;
  });

  // Not skipIf: both files are committed. A suite that vanishes when an asset moves reports
  // success having checked nothing — see the drum pack tests.
  it('has both packs to check', () => {
    expect(existsSync(melodicPath)).toBe(true);
    expect(existsSync(drumPath)).toBe(true);
  });

  it('declares the schema version the RUNTIME expects, not a literal repeated here', () => {
    // GMD-80 added six fields whose ABSENCE is meaningful ("old pack, do not filter"), and the
    // packs are served max-age=2592000 while the JS is content-hashed — so a returning visitor
    // pairs new JS with a stale manifest and silently gets the +6dB guitars back. The version is
    // what lets webaudio.ts see that and refetch.
    //
    // Asserted against webaudio's own PACK_VERSION, not against a `2` written here: two literals
    // agreeing proves nothing. Bump the runtime, forget to commit the regenerated packs, and every
    // production visitor burns a second cache-bypassing fetch of the 517KB manifest on every
    // session — while a test comparing 2 to 2 stays green. Assert the positive (GMD-68).
    expect(runtimePackVersion, 'webaudio must export PACK_VERSION').toBeTypeOf('number');
    expect(JSON.parse(readFileSync(melodicPath, 'utf8')).version).toBe(runtimePackVersion);
    expect(JSON.parse(readFileSync(drumPath, 'utf8')).version).toBe(runtimePackVersion);
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
    // Both resolve to a filter — the dry layer carries a 3dB resonance at the open default — but
    // only ONE of them actually removes anything: 800Hz against 19.9kHz. That gap is the +6.05dB.
    const filters = zs.map(z => zoneFilter(z, RATE));
    const audible = filters.filter(f => f && f.hz < 15000);
    expect(audible.length, 'exactly one layer is low-passed').toBe(1);
    expect(audible[0].hz).toBeCloseTo(800.022, 3);
    expect(filters.filter(f => f && f.hz > 15000).length, 'the other is open, with resonance').toBe(1);
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
    // dropped the fields reads as 0 here rather than as a silent +6dB in someone's ears.
    //
    // TWO counts per program, because they answer different questions: `built` is how many zones
    // get a biquad at all, and `lowPassed` is how many of those actually remove anything. A zone
    // sitting at the open default with a resonance is in the first and not the second, and
    // conflating them is what made the first version of this test misread program 27.
    const m = melodic();
    const zones = m.programs.flatMap(p => p.zones);
    const built = z => !!zoneFilter(z, RATE);
    // "Actually removes something" = a cutoff strictly below the open default, not an arbitrary
    // kHz line: 19912.6Hz IS the open value, so a zone sitting exactly there is resonance only.
    const OPEN_HZ = centsToHertz(13500);
    const lowPassed = z => { const f = zoneFilter(z, RATE); return !!f && f.hz < OPEN_HZ; };
    expect(zones.length).toBe(1275);
    expect(zones.filter(built).length).toBe(764);
    expect(zones.filter(lowPassed).length).toBe(674);

    const per = (prog, fn) => m.programs.find(x => x.program === prog).zones.filter(fn).length;
    expect(per(24, lowPassed)).toBe(90);    // Nylon: every zone, per-velocity
    expect(per(25, built)).toBe(0);         // Steel String: no filter data at all
    expect(per(26, lowPassed)).toBe(216);   // Jazz Guitar: every zone
    // Clean Guitar is GMD-80 in one line: 180 zones build a filter, but only 90 of them are a
    // low-pass. The other 90 are the DRY layer, open at 13500 with a 3dB resonance.
    expect(per(27, built)).toBe(180);
    expect(per(27, lowPassed)).toBe(90);
    // Distortion: only the layer whose modEnv-resolved cutoff lands under the open threshold. The
    // other 90 resolve to 5001 + 2468 = 13576 cents, which IS open — filtering them at gen 8's
    // 5001 would be reading half the instruction.
    expect(per(30, lowPassed)).toBe(90);
    expect(per(38, built), 'Synth Bass 1 sweeps for 252ms — left alone entirely').toBe(0);

    const dz = drums().kits[0].zones;
    expect(dz.length).toBe(149);
    expect(dz.filter(built).length).toBe(62);
    // 6 of those are the resonant-at-13500 case: closed, pedal and open hi-hat (keys 42/44/46,
    // a stereo pair each), 10dB of top-octave lift.
    expect(dz.filter(z => z.filterFc === 13500 && built(z)).length).toBe(6);
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

  function buildSf2(opts) {
    const instFc = opts && opts.instFc != null ? opts.instFc : 10361;
    const instQ = opts && opts.instQ != null ? opts.instQ : 40;
    const presetFc = opts && opts.presetFc != null ? opts.presetFc : -2786;
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
      gen(8, presetFc),      // initialFilterFc  -2786 cents by default
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
    const ibag = concat([rec(4, (v) => v.setUint16(0, 0, true)), rec(4, (v) => v.setUint16(0, 8, true))]);
    const igen = concat([
      gen(43, 0, 127),       // keyRange
      gen(8, instFc),        // initialFilterFc: the zone's ABSOLUTE cutoff (3248 Hz by default)
      gen(9, instQ),         // initialFilterQ 4.0 dB by default
      gen(48, 50),           // initialAttenuation 5.0 dB
      gen(51, 1),            // coarseTune +1 semitone
      gen(11, 2000),         // modEnvToFilterFc: the envelope moves the cutoff
      gen(25, 0),            // delayModEnv 0 timecents = a ONE SECOND delay before it starts
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

  const zoneAt = (vel, opts) => {
    const bank = parseSf2(buildSf2(opts));
    const p = bank.findPreset(0, 24);
    const zs = p.zones.filter(z => vel >= z.velLo && vel <= z.velHi);
    expect(zs.length, 'the fixture must resolve to exactly one zone at velocity ' + vel).toBe(1);
    return zs[0];
  };

  it('clamps at EVERY merge, as TSF does — not once at the end', () => {
    // TSF bounds gen 8 into [1500, 13500] on the instrument merge AND again after the preset
    // offset (tsf_region_operator / GEN_INT_LIMITFC). Summing raw and clamping once is a different
    // function whenever the instrument value is itself out of range:
    //
    //   per-merge (TSF, and us):  clamp(16000) = 13500, then 13500 - 2786 = 10714 cents ~ 4.2kHz
    //   clamp-once:               16000 - 2786 = 13214 cents ~ 14.5kHz
    //
    // Nearly two octaves apart. Measured on FluidR3, 64 preset zones diverge under clamp-once
    // (worst 8 cents, none of them packed) — small today, unbounded in principle, free to fix.
    const z = zoneAt(30, { instFc: 16000, instQ: 1200 });
    expect(z.filterFc, 'clamp to 13500 BEFORE the -2786 preset offset').toBe(10714);
    expect(z.filterQ, 'clamp to 960 before the -15 offset').toBe(945);
    // And the SECOND clamp is real too: a preset offset that pushes the sum back out of range must
    // be bounded again, or the extractor writes 16500 into the pack. zoneFilter re-clamps on read,
    // so this is only visible on the parsed field — which is exactly what gets committed.
    const up = zoneAt(30, { instFc: 13500, presetFc: 3000 });
    expect(up.filterFc, 'the sum is clamped as well as each input').toBe(13500);
    const down = zoneAt(30, { instFc: 1500, presetFc: -3000 });
    expect(down.filterFc).toBe(1500);
  });

  it('pins an unset envelope segment to zero, as TSF does', () => {
    // An UNSET generator defaults to -12000 timecents, which converts to 0.977ms rather than 0.
    // TSF pins anything below -11950 to zero (tsf_region_envtosecs: "timecents don't get to zero,
    // and our EG is happier with zero values"). Summing four defaults otherwise accrues ~3.9ms of
    // envelope that does not exist — a fifth of the 20ms budget zoneFilter spends. The fixture's
    // instrument sets delayModEnv and nothing else, so settle must be the delay ALONE.
    const z = zoneAt(100);
    expect(z.modEnvSettle, 'exactly the 1s delay, no phantom attack or hold').toBe(1);
    expect(z.modEnvDecay, 'an unset decay is zero seconds, not 0.977ms').toBe(0);
  });

  it('counts delayModEnv, which is a whole second the cutoff has not moved yet', () => {
    // The gap review round 2 found in the SETTLE COMPOSITION, which the zoneFilter-level tests
    // above cannot see because they hand it a settle time. delayModEnv 0 timecents is 1 second;
    // without it this zone computes a ~2ms settle, passes the static gate, and gets frozen at a
    // cutoff it will not reach for another second. sonivox has 61 zones carrying gen 25.
    const z = zoneAt(100);
    expect(z.filterModEnv).toBe(2000);
    expect(z.modEnvSettle, 'the 1s delay must be in here').toBe(1);
    expect(zoneFilter(z, RATE), 'and it must disqualify the zone').toBeNull();
  });

  it('reads the instrument value straight through when the preset adds nothing', () => {
    const z = zoneAt(100);
    expect(z.filterFc).toBe(10361);
    expect(z.filterQ).toBe(40);
    expect(centsToHertz(z.filterFc)).toBeCloseTo(3248.509, 3);
    expect(z.attenuationDb).toBeCloseTo(5, 9);
    expect(z.tuneCents).toBe(100);
  });

  it('ADDS the preset offset to the cutoff, it does not replace it', () => {
    // 10361 + (-2786) = 7575 cents = 649.8 Hz. Replacing would give -2786 cents (1.7 Hz, silence);
    // ignoring would leave 3248 Hz, which is the bug: every dynamic at the same timbre.
    const z = zoneAt(30);
    expect(z.filterFc).toBe(7575);
    expect(centsToHertz(z.filterFc)).toBeCloseTo(649.819, 3);
    // The other offsets fold the same way, and are asserted here so one fixture covers the rule.
    expect(z.attenuationDb).toBeCloseTo(7, 9);      // 5.0 instrument + 2.0 preset
    expect(z.tuneCents).toBe(100);                  // +1 semitone, no preset tune
    expect(z.filterQ).toBe(25);                     // 40 centibels + (-15) = 2.5 dB
    // Resolved through a fast envelope it would land here; this zone's own delay disqualifies it.
    expect(zoneFilter({ ...z, modEnvSettle: 0.002 }, RATE).hz).toBeCloseTo(2063.05, 2);
    expect(zoneFilter({ ...z, modEnvSettle: 0.002 }, RATE).qDb).toBeCloseTo(2.5, 9);
  });
});

// ── the graph: is the filter actually WIRED? ──────────────────────────────────
//
// Everything above tests the PARSER. Delete the biquad from webaudio.ts and every one of those
// assertions stays green while the guitar goes back to +6dB — which is exactly how this bug
// survived in the first place. So drive the real voice factory and look at the nodes it builds.
//
// This block was written once, deleted by a careless range-replace while editing the goldens, and
// restored when review round 4 noticed that `createSf2Instrument` was exported "for the test" and
// no test imported it. Its absence is silent by construction: that is the whole point of it.
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
    expect(src.connections).toContain(lp);
    expect(lp.connections).toContain(voiceGain());
    expect(src.connections).not.toContain(voiceGain());
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

  it('applies the resonance for a zone that is open but resonant', () => {
    // The round-2 case, end to end: 13500 with Q is a top-octave lift, and it must reach the graph.
    created = [];
    const ctx = fakeContext();
    createSf2Instrument(ctx, bankWith({ filterFc: 13500, filterQ: 100 }), 27, false, new Map())
      .noteOn(60, 0.8, 0);
    expect(filters().length).toBe(1);
    expect(filters()[0].Q.value).toBe(10);
    expect(filters()[0].frequency.value).toBeCloseTo(19912.62, 2);
  });
});
