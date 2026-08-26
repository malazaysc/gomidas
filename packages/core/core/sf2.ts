// Gomidas — SoundFont 2 reader (GMD-36, docs/WEB_PORT.md §6.2 step 2).
//
// WHY NOT TinySoundFont-in-WASM, which §6.2 prefers: emscripten is not installed and pulling in
// the ~1GB SDK would make it a build dependency of the whole project — including the desktop
// build, which already has TSF natively and gains nothing. §6.2 lists "a JS SoundFont player" as
// the documented fallback "if the TSF build proves painful", so this is that.
//
// The trade is sound quality: TSF-in-WASM would be sample-identical to the desktop app, while
// this is an independent interpretation of the same bank. Note-for-note it is the same samples,
// but envelopes, filters and modulators are approximated (see the deliberate omissions below).
// Revisit if the difference turns out to matter.
//
// Pure binary -> data (§9): parses to a preset/zone/sample table with no AudioContext, so it is
// golden-testable against the bundled sonivox.sf2.
//
// DELIBERATELY NOT IMPLEMENTED: modulators (SF2 §8.4 default modulators, velocity->filter etc.),
// LFOs, vibrato, chorus/reverb sends. A GM bank still plays recognisably without them; adding
// them silently and wrongly would be worse.
//
// The low-pass filter (gens 8/9) IS implemented, as of GMD-80/81 — it had to be. FluidR3 voices
// its guitars as a dry copy plus a low-passed copy of the SAME sample layered under it; unparsed,
// the two read as identical zones and sum to +6dB of broadband guitar. It is applied STATICALLY:
// modEnvToFilterFc / modLfoToFilterFc (gens 11/10) sweep the cutoff in TinySoundFont and we hold
// it at its initial value. 4 of the 17 packed presets use them (30, 35, 38, the drum kit).

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

/** The generator ids this reader understands. Everything else is ignored, not guessed at. */
const GEN = {
  startAddrsOffset: 0, endAddrsOffset: 1,
  startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, endAddrsCoarseOffset: 12,
  startloopAddrsCoarseOffset: 45, endloopAddrsCoarseOffset: 50,
  pan: 17,
  delayVolEnv: 33, attackVolEnv: 34, holdVolEnv: 35, decayVolEnv: 36,
  sustainVolEnv: 37, releaseVolEnv: 38,
  initialFilterFc: 8, initialFilterQ: 9,
  modLfoToFilterFc: 10, modEnvToFilterFc: 11,
  delayModEnv: 25, attackModEnv: 26, holdModEnv: 27, decayModEnv: 28, sustainModEnv: 29,
  instrument: 41, keyRange: 43, velRange: 44,
  initialAttenuation: 48, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57,
  overridingRootKey: 58
};

function readChunks(view: DataView, start: number, end: number): Array<{ id: string; start: number; end: number }> {
  const out: Array<{ id: string; start: number; end: number }> = [];
  let p = start;
  while (p + 8 <= end) {
    const id = String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
    const size = view.getUint32(p + 4, true);
    out.push({ id, start: p + 8, end: Math.min(end, p + 8 + size) });
    p += 8 + size + (size & 1);        // chunks are word-aligned
  }
  return out;
}

function readName(view: DataView, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(at + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

interface Sf2Sample {
  name: string; start: number; end: number;
  startLoop: number; endLoop: number;
  sampleRate: number; originalPitch: number; pitchCorrection: number;
  sampleType: number;
}

interface Sf2Zone {
  keyLo: number; keyHi: number; velLo: number; velHi: number;
  sampleIndex: number;
  rootKey: number | null;
  tuneCents: number;
  /** SF2 gen 57: >0 means "cut every sounding voice of this class" (closed hat chokes open hat). */
  exclusiveClass: number;
  attenuationDb: number;
  /** SF2 gen 8: lowpass cutoff in ABSOLUTE cents. 13500 (~20kHz) is the spec default = open. */
  filterFc: number;
  /** SF2 gen 9: lowpass resonance in centibels. 0 = no resonant peak. */
  filterQ: number;
  /** SF2 gen 11: cents the MODULATION envelope adds to the cutoff at its full level. */
  filterModEnv: number;
  /** SF2 gen 29 as a fraction: where that envelope SETTLES. 1 = it holds its full level. */
  modEnvSustain: number;
  /**
   * Seconds before that envelope starts to fall: delay + attack + hold. The DECAY is kept separate
   * in `modEnvDecay` because whether it counts depends on `modEnvSustain`, which a preset zone can
   * still change after this is computed. Folding them here would understate a slow sweep.
   */
  modEnvSettle: number;
  /** Seconds of that envelope's decay, added to the settle only when it actually decays. */
  modEnvDecay: number;
  pan: number;
  loopMode: number;
  attack: number; hold: number; decay: number; sustain: number; release: number;
  offsets: { start: number; end: number; startLoop: number; endLoop: number };
}

interface Sf2Preset { bank: number; program: number; name: string; zones: Sf2Zone[] }

/** timecents -> seconds (SF2's logarithmic time unit). -12000 tc = 1ms, 0 tc = 1s. */
function timecentsToSeconds(tc: number): number {
  return Math.pow(2, tc / 1200);
}

function parseSf2(buffer: ArrayBuffer): {
  presets: Sf2Preset[];
  samples: Sf2Sample[];
  pcm: Int16Array;
  findPreset(bank: number, program: number): Sf2Preset | null;
  findDrumPreset(program: number): Sf2Preset | null;
} {
  const view = new DataView(buffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('not a RIFF file');
  const form = readName(view, 8, 4);
  if (form !== 'sfbk') throw new Error('not a SoundFont (form=' + form + ')');

  const top = readChunks(view, 12, view.byteLength);
  let pdta: Array<{ id: string; start: number; end: number }> = [];
  let smplChunk: { start: number; end: number } | null = null;

  for (const c of top) {
    if (c.id !== 'LIST') continue;
    const listType = readName(view, c.start, 4);
    const inner = readChunks(view, c.start + 4, c.end);
    if (listType === 'pdta') pdta = inner;
    else if (listType === 'sdta') {
      const smpl = inner.find(x => x.id === 'smpl');
      if (smpl) smplChunk = smpl;
    }
  }
  if (!pdta.length) throw new Error('missing pdta');

  const chunk = (id: string) => pdta.find(c => c.id === id) || null;
  const readIndexed = <T>(id: string, size: number, fn: (at: number) => T): T[] => {
    const c = chunk(id);
    if (!c) return [];
    const out: T[] = [];
    for (let at = c.start; at + size <= c.end; at += size) out.push(fn(at));
    return out;
  };

  // ---- raw tables ----
  const phdr = readIndexed('phdr', 38, (at) => ({
    name: readName(view, at, 20),
    program: view.getUint16(at + 20, true),
    bank: view.getUint16(at + 22, true),
    bagIndex: view.getUint16(at + 24, true)
  }));
  const pbag = readIndexed('pbag', 4, (at) => ({ genIndex: view.getUint16(at, true) }));
  const pgen = readIndexed('pgen', 4, (at) => ({ op: view.getUint16(at, true), amount: at + 2 }));
  const inst = readIndexed('inst', 22, (at) => ({
    name: readName(view, at, 20), bagIndex: view.getUint16(at + 20, true)
  }));
  const ibag = readIndexed('ibag', 4, (at) => ({ genIndex: view.getUint16(at, true) }));
  const igen = readIndexed('igen', 4, (at) => ({ op: view.getUint16(at, true), amount: at + 2 }));
  const shdr = readIndexed('shdr', 46, (at): Sf2Sample => ({
    name: readName(view, at, 20),
    start: view.getUint32(at + 20, true),
    end: view.getUint32(at + 24, true),
    startLoop: view.getUint32(at + 28, true),
    endLoop: view.getUint32(at + 32, true),
    sampleRate: view.getUint32(at + 36, true),
    originalPitch: view.getUint8(at + 40),
    pitchCorrection: view.getInt8(at + 41),
    sampleType: view.getUint16(at + 44, true)
  }));

  const genAmountS16 = (i: number) => view.getInt16(pgenOrIgen(i), true);
  let currentGenTable: Array<{ op: number; amount: number }> = pgen;
  function pgenOrIgen(i: number): number { return currentGenTable[i].amount; }

  /** Collect generators for the zone spanning [from, to) of a gen table. */
  function collect(table: Array<{ op: number; amount: number }>, from: number, to: number): Record<number, number> {
    currentGenTable = table;
    const gens: Record<number, number> = {};
    for (let i = from; i < to && i < table.length; i++) gens[table[i].op] = i;
    return gens;
  }
  const rangeOf = (table: Array<{ op: number; amount: number }>, idx: number) => {
    currentGenTable = table;
    const at = table[idx].amount;
    return { lo: view.getUint8(at), hi: view.getUint8(at + 1) };
  };
  const valueOf = (table: Array<{ op: number; amount: number }>, idx: number) => {
    currentGenTable = table;
    return view.getInt16(table[idx].amount, true);
  };

  // ---- instruments -> zones ----
  function instrumentZones(instIndex: number): Sf2Zone[] {
    const start = inst[instIndex].bagIndex;
    const end = instIndex + 1 < inst.length ? inst[instIndex + 1].bagIndex : ibag.length;
    const zones: Sf2Zone[] = [];
    let globalGens: Record<number, number> = {};

    for (let b = start; b < end && b < ibag.length; b++) {
      const gFrom = ibag[b].genIndex;
      const gTo = b + 1 < ibag.length ? ibag[b + 1].genIndex : igen.length;
      const gens = collect(igen, gFrom, gTo);

      if (gens[GEN.sampleID] == null) { globalGens = gens; continue; }   // a global zone
      const merged: Record<number, number> = { ...globalGens, ...gens };
      const num = (op: number, def: number) => (merged[op] != null ? valueOf(igen, merged[op]) : def);
      const keyR = merged[GEN.keyRange] != null ? rangeOf(igen, merged[GEN.keyRange]) : { lo: 0, hi: 127 };
      const velR = merged[GEN.velRange] != null ? rangeOf(igen, merged[GEN.velRange]) : { lo: 0, hi: 127 };
      const sustainCb = num(GEN.sustainVolEnv, 0);

      zones.push({
        keyLo: keyR.lo, keyHi: keyR.hi, velLo: velR.lo, velHi: velR.hi,
        sampleIndex: valueOf(igen, merged[GEN.sampleID]),
        rootKey: merged[GEN.overridingRootKey] != null ? num(GEN.overridingRootKey, 60) : null,
        tuneCents: num(GEN.coarseTune, 0) * 100 + num(GEN.fineTune, 0),
        attenuationDb: num(GEN.initialAttenuation, 0) / 10,   // stored in centibels
        filterFc: num(GEN.initialFilterFc, 13500),
        filterQ: num(GEN.initialFilterQ, 0),
        filterModEnv: num(GEN.modEnvToFilterFc, 0),
        // Same 0.1%-decrease encoding as sustainVolEnv below.
        modEnvSustain: Math.max(0, Math.min(1, 1 - num(GEN.sustainModEnv, 0) / 1000)),
        modEnvSettle: timecentsToSeconds(num(GEN.delayModEnv, -12000))
                    + timecentsToSeconds(num(GEN.attackModEnv, -12000))
                    + timecentsToSeconds(num(GEN.holdModEnv, -12000)),
        modEnvDecay: timecentsToSeconds(num(GEN.decayModEnv, -12000)),
        pan: num(GEN.pan, 0) / 1000,                          // -500..500 -> -0.5..0.5
        loopMode: num(GEN.sampleModes, 0),
        exclusiveClass: num(GEN.exclusiveClass, 0),
        attack: timecentsToSeconds(num(GEN.attackVolEnv, -12000)),
        hold: timecentsToSeconds(num(GEN.holdVolEnv, -12000)),
        decay: timecentsToSeconds(num(GEN.decayVolEnv, -12000)),
        // sustain is attenuation in centibels below full: 0 = full level, 1000 = -100dB.
        sustain: Math.max(0, Math.min(1, 1 - sustainCb / 1000)),
        release: timecentsToSeconds(num(GEN.releaseVolEnv, -12000)),
        offsets: {
          start: num(GEN.startAddrsOffset, 0) + num(GEN.startAddrsCoarseOffset, 0) * 32768,
          end: num(GEN.endAddrsOffset, 0) + num(GEN.endAddrsCoarseOffset, 0) * 32768,
          startLoop: num(GEN.startloopAddrsOffset, 0) + num(GEN.startloopAddrsCoarseOffset, 0) * 32768,
          endLoop: num(GEN.endloopAddrsOffset, 0) + num(GEN.endloopAddrsCoarseOffset, 0) * 32768
        }
      });
    }
    return zones;
  }

  // ---- presets -> zones (preset gens are OFFSETS onto the instrument's absolute values) ----
  const presets: Sf2Preset[] = [];
  for (let pi = 0; pi < phdr.length - 1; pi++) {     // last phdr entry is the EOP terminator
    const start = phdr[pi].bagIndex;
    const end = phdr[pi + 1].bagIndex;
    const zones: Sf2Zone[] = [];
    let globalGens: Record<number, number> = {};

    for (let b = start; b < end && b < pbag.length; b++) {
      const gFrom = pbag[b].genIndex;
      const gTo = b + 1 < pbag.length ? pbag[b + 1].genIndex : pgen.length;
      const gens = collect(pgen, gFrom, gTo);
      if (gens[GEN.instrument] == null) { globalGens = gens; continue; }
      const merged: Record<number, number> = { ...globalGens, ...gens };
      const instIndex = valueOf(pgen, merged[GEN.instrument]);
      if (instIndex < 0 || instIndex >= inst.length) continue;

      const pKey = merged[GEN.keyRange] != null ? rangeOf(pgen, merged[GEN.keyRange]) : { lo: 0, hi: 127 };
      const pVel = merged[GEN.velRange] != null ? rangeOf(pgen, merged[GEN.velRange]) : { lo: 0, hi: 127 };
      const pAtten = merged[GEN.initialAttenuation] != null ? valueOf(pgen, merged[GEN.initialAttenuation]) / 10 : 0;
      const pTune = (merged[GEN.coarseTune] != null ? valueOf(pgen, merged[GEN.coarseTune]) * 100 : 0)
                  + (merged[GEN.fineTune] != null ? valueOf(pgen, merged[GEN.fineTune]) : 0);
      // Filter generators are ADDITIVE offsets onto the instrument's absolute value, like tuning
      // and attenuation. This is not a detail: FluidR3 puts Nylon Guitar's per-velocity brightness
      // ONLY here (bags 121-127 -> +0, 113-120 -> -182 ... 0-64 -> -2786 cents), so a reader that
      // takes the instrument value alone plays every dynamic at the same timbre (GMD-81).
      const pFc = merged[GEN.initialFilterFc] != null ? valueOf(pgen, merged[GEN.initialFilterFc]) : 0;
      const pQ = merged[GEN.initialFilterQ] != null ? valueOf(pgen, merged[GEN.initialFilterQ]) : 0;
      const pMe = merged[GEN.modEnvToFilterFc] != null ? valueOf(pgen, merged[GEN.modEnvToFilterFc]) : 0;
      const pMeSus = merged[GEN.sustainModEnv] != null ? valueOf(pgen, merged[GEN.sustainModEnv]) : 0;

      for (const z of instrumentZones(instIndex)) {
        // Preset ranges INTERSECT instrument ranges; a zone outside the preset's window is
        // simply not reachable and must be dropped, not widened.
        const keyLo = Math.max(z.keyLo, pKey.lo), keyHi = Math.min(z.keyHi, pKey.hi);
        const velLo = Math.max(z.velLo, pVel.lo), velHi = Math.min(z.velHi, pVel.hi);
        if (keyLo > keyHi || velLo > velHi) continue;
        zones.push({ ...z, keyLo, keyHi, velLo, velHi,
                     attenuationDb: z.attenuationDb + pAtten, tuneCents: z.tuneCents + pTune,
                     filterFc: z.filterFc + pFc, filterQ: z.filterQ + pQ,
                     filterModEnv: z.filterModEnv + pMe,
                     // Preset-level modEnv TIMING offsets are not folded — the same gap GMD-82
                     // tracks for the volume envelope. No bank we ship uses them.
                     modEnvSustain: Math.max(0, Math.min(1, z.modEnvSustain - pMeSus / 1000)) });
      }
    }
    presets.push({ bank: phdr[pi].bank, program: phdr[pi].program, name: phdr[pi].name, zones });
  }

  const pcm = smplChunk
    ? new Int16Array(buffer, smplChunk.start, Math.floor((smplChunk.end - smplChunk.start) / 2))
    : new Int16Array(0);

  return {
    presets, samples: shdr, pcm,
    findPreset(bank: number, program: number) {
      return presets.find(p => p.bank === bank && p.program === program)
          || presets.find(p => p.bank === 0 && p.program === program)
          || null;
    },
    /**
     * The drum kit for a GM program (channel 9). Kits live in bank 128 and the program picks the
     * kit (0 Standard, 8 Room, 16 Power, 24 Electronic, 32 Jazz, 40 Brush...).
     *
     * NOT findPreset(128, program): its fallback is "same program in bank 0", so an unbundled kit
     * — sonivox only ships 0/8/32/40 — would resolve to a MELODIC preset and the drum track would
     * play an organ. Fall back inside bank 128 instead, and only give up if the bank has no drums.
     */
    findDrumPreset(program: number) {
      return presets.find(p => p.bank === 128 && p.program === program)
          || presets.find(p => p.bank === 128 && p.program === 0)
          || presets.find(p => p.bank === 128)
          || null;
    }
  };
}

/**
 * Velocity -> amplitude, per SF2's default velocity->initialAttenuation modulator (spec §8.4.1:
 * 960 cB, concave, negative unipolar).
 *
 * Working the concave curve through gives amp = (vel/127)^2 to within a rounding error — at
 * vel 64 fluidsynth's table yields 11.9 dB of attenuation, i.e. gain 0.254, and (64/127)^2 is
 * 0.2539 — so this is the default modulator, not an invented curve. Full velocity is unchanged
 * (0 dB); it is soft hits that get quieter, which is what makes ghost notes read as ghost notes.
 *
 * NOTE — divergence from the desktop engine: TinySoundFont uses velocity LINEARLY
 * (noteGainDB = globalGainDB - attenuation - gainToDecibels(1/vel)). Web is the spec-correct one.
 */
function velocityGain(velocity: number): number {
  const v = Math.max(0, Math.min(1, velocity));
  return v * v;
}

/**
 * initialAttenuation -> linear gain, using the EMU/fluidsynth power factor rather than the
 * literal centibel the spec prints.
 *
 * MEASURED, and the reason drums sounded "very low" (GMD-50). Read strictly — gain =
 * 10^(-cB/200) — FluidR3's Standard kit plays its kick 10 dB and its closed hi-hat 21 dB below
 * its snare. That is not a kit; that is a snare with faint company. fluidsynth divides by 531.509
 * instead, with the comment "By the standard this should be -200.0", because the EMU 8k/10k
 * hardware every bank was authored against did not follow the spec here. The same zones then read
 * kick -3.8 dB, hat -7.9 dB, crash -6.0 dB — a balanced kit.
 *
 * Banks are authored against players, not against the document, so match the player. Note this
 * makes web LOUDER than the desktop engine on attenuated zones: TinySoundFont uses the literal
 * -200 (tsf_decibelsToGain on attenuation), so FluidR3 is under-played there too.
 */
const ATTEN_POWER_FACTOR = 531.509;

function attenuationGain(attenuationDb: number): number {
  if (!(attenuationDb > 0)) return 1;
  return Math.pow(10, -(attenuationDb * 10) / ATTEN_POWER_FACTOR);
}

/**
 * Per-piece percussion make-up gain — a FLOOR under each drum piece, so nothing that carries the
 * groove is left buried by the bank that happens to be loaded.
 *
 * MEASURED (GMD-73) by decoding the committed pack and taking samplePeak x attenuationGain x
 * velocityGain(102), in dB relative to an UNATTENUATED melodic zone at the same velocity:
 *
 *   snare 38/40, clap 39, toms 41/43/45/47/48/50   0.00 (50: -0.97)  <- at the reference already
 *   side stick 37 / kick 35/36                    -3.76 / -3.84
 *   open hat 46                                   -4.29
 *   crash 49 / splash 55 / crash2 57              -6.02 / -6.77 / -7.53
 *   ride 51 / bell 53 / ride2 59                  -7.34 / -7.90 / -7.90
 *   pedal hat 44 / closed hat 42                  -7.90 / -8.33
 *   china 52                                      -8.51
 *
 * "Unattenuated melodic zone", not "melodic note": 233 of the 1275 zones in the melodic packs DO
 * carry attenuation — 26 Jazz Guitar -1.51, 35 Fretless Bass -3.39, 39 Synth Bass 2 -3.01, and
 * 38 Synth Bass 1 -6.40 dB. Every guitar and every ordinary bass is at 0, which is why the
 * reference is the right one to calibrate against, but a score on Synth Bass 1 sits 6.4 dB under
 * it and the kick now sits 6.4 dB over that bass rather than 2.6. Levelling the melodic side is
 * not this function's job; knowing the reference is not universal is.
 *
 * So the kit is NOT globally quiet — its snare sits level with a melodic note. FluidR3 authored an
 * ACOUSTIC balance, where everything carrying the groove (kick, hats) sits several dB under the
 * snare waiting for a mixer we do not have. That is what "the drums are too soft" actually is, and
 * why measuring the drum track in isolation (GMD-55) found nothing wrong.
 *
 * BOOST ONLY, deliberately — this raises a piece to its floor and never lowers one to it. sonivox,
 * the fallback bank when the pack fetch fails, authors the same kit nearly flat (closed hat -0.75,
 * crash -2.26 dB), so a two-way normalisation would CUT its hats and cymbals by 1.7-4.25 dB: the
 * ticket's own symptom, made worse, on the degraded path nobody hears until they are offline. The
 * fallback bank's balance is not this function's problem; a buried groove is.
 *
 * Keys absent from the table are left exactly alone, and they are NOT all at the reference. Snare
 * 38/40, clap 39 and the toms 41/43/45/47/48/50 are (0.00 dB — 42/44/46 in that span are the HATS,
 * and they are floored above), and they are out because raising them would move
 * the kit's PEAK, which GMD-42's 6 dB of headroom cannot absorb — the user's call (2026-08-19) was
 * an internal rebalance, not a lift. The aux percussion IS attenuated and is left alone anyway —
 * bongos/congas 60-64 at -3.76, timbales 65/66 at -1.88/-3.01, agogo 67/68 at -4.52/-5.64,
 * whistles 71/72 at -1.88, guiro 73 at -3.76. Undecided, not judged fine: the kit pieces were what
 * the user was shown. Pinned in tests/percussion-makeup.test.js so the omission stays visible.
 *
 * Side stick 37 carries the KICK's attenuation (both -3.76), so raising the kick alone opened a
 * 3.8 dB gap inside PIECE_KEYS.snare — one mixer fader spanning 37/38/40. It gets -2 rather than
 * the snare's 0 (user's call, 2026-08-21): a cross-stick really is quieter than a snare hit, but it
 * should not fall under the kick it used to sit level with.
 *
 * The floor is compared against the zone's ATTENUATION alone, while the table above was measured
 * including each sample's own peak (0.88..1.0 across this kit). So a piece lands within ~0.6 dB of
 * its floor rather than on it — china 52 reads -4.61 against a floor of -4. That is the intended
 * precision: a floor, not a fader.
 *
 * A floor COLLAPSES what sits under it, by definition: splash, crash 2 and china all arrive at -4
 * with crash 1, and the ride bell arrives at -5 with the ride, so FluidR3's ordering inside those
 * groups is gone. That is what the user approved — the floors they were shown are shared per group.
 * A per-key relative offset would keep the ordering; that belongs to GMD-78's preset column, which
 * is where per-piece character is supposed to live.
 *
 * ASSUMES the bank carries no PRESET-level attenuation. parseSf2 folds it into z.attenuationDb
 * (sf2.ts, preset expansion), so a kit preset with a global offset would have its thirteen targeted
 * keys pulled back up to the absolute floors while the untargeted snare and toms kept the offset —
 * the kick would end up ABOVE the snare, the one move the user ruled out. Both committed banks have
 * preset attenuation 0, so it is unreachable today; it becomes reachable the moment GMD-74 re-runs
 * the extractor over more kits, which is noted on that ticket.
 *
 * NOT applied to velocity. On web velocity lands SQUARED (velocityGain above) and picks the zone's
 * velocity layer, so a velocity trim bends the dynamic curve instead of setting a level. Balance
 * belongs in gain. The user's own kit-MIXER trim (window.gomidasDrumGains, GMD-72) is a separate
 * thing and still rides on top of this.
 *
 * Web only, deliberately: the desktop engine reads these same zones through TinySoundFont's
 * literal -200 divisor and a LINEAR velocity curve, so its baseline differs before any make-up
 * applies. That divergence is GMD-53; the desktop half of this work is GMD-79.
 */
const PERCUSSION_FLOOR_DB: Record<number, number> = {
  35: 0,  36: 0,                     // acoustic + standard kick -> snare/melodic level
  37: -2,                            // side stick: under the snare, but not under the kick
  42: -5, 44: -5, 46: -3,            // closed / pedal / open hi-hat
  49: -4, 52: -4, 55: -4, 57: -4,    // crash 1, china, splash, crash 2
  51: -5, 53: -5, 59: -5             // ride 1, ride bell, ride 2
};

/** Upper bound, so a pathological bank cannot turn a floor into a 30 dB boost. */
const MAKEUP_MAX_DB = 6;

function percussionMakeupGain(key: number, attenuationDb: number): number {
  const floor = PERCUSSION_FLOOR_DB[key];
  if (floor == null) return 1;
  const current = 20 * Math.log10(attenuationGain(attenuationDb));   // <= 0, the bank's own level
  const db = Math.min(MAKEUP_MAX_DB, floor - current);
  // Raise to the floor, never cut down to it — see the boost-only paragraph above.
  return db > 0 ? Math.pow(10, db / 20) : 1;
}

/** Zones matching a key+velocity, in file order. Empty means the preset cannot play that note. */
function zonesFor(preset: Sf2Preset, key: number, velocity: number): Sf2Zone[] {
  if (!preset) return [];
  return preset.zones.filter(z => key >= z.keyLo && key <= z.keyHi && velocity >= z.velLo && velocity <= z.velHi);
}

/** Playback rate for a zone, accounting for root key, tuning and the sample's own rate. */
function rateFor(zone: Sf2Zone, sample: Sf2Sample, key: number, outputRate: number): number {
  const root = zone.rootKey != null ? zone.rootKey : sample.originalPitch;
  const cents = (key - root) * 100 + zone.tuneCents + (sample.pitchCorrection || 0);
  return Math.pow(2, cents / 1200) * (sample.sampleRate / outputRate);
}

/** SF2 absolute cents -> Hz. The same curve as TinySoundFont's tsf_cents2Hertz. */
function centsToHertz(cents: number): number {
  return 8.176 * Math.pow(2, cents / 1200);
}

/**
 * The zone's lowpass, or null if it has none. THE one place that decision is made.
 *
 * WHY IT EXISTS (GMD-80): FluidR3's Clean/Overdrive/Distortion Guitar presets layer two copies of
 * every sample — one dry, one low-passed — to give the guitar body. Ignore gens 8/9 and the two
 * layers are indistinguishable, so both play dry and sum coherently: +6.05dB against every
 * single-layer program, measured. The zones were never duplicates.
 *
 * THE CUTOFF IS NOT gen 8 ALONE. TinySoundFont renders
 *     fres = initialFilterFc + modEnvToFilterFc x modEnv + modLfoToFilterFc x lfo
 * and for a great many zones gen 8 is only where that sweep STARTS. Reading gen 8 as the final
 * answer would have shipped Synth Bass 1 through a fixed 120Hz low-pass — darker than anything
 * the bank asks for, and a NEW bug on a program that had none.
 *
 * We render one static biquad, so we take the level the envelope SETTLES at, and ONLY where it
 * settles fast enough for that to be indistinguishable. The measured settle times separate the
 * two cases with nothing in between:
 *
 *   FluidR3 prog 30 Distortion   2ms   870Hz + 2468c at sustain 1.00 -> 3619Hz   static: EXACT
 *   FluidR3 prog 35 Fretless     2ms                                             static: EXACT
 *   FluidR3 prog 38 SynthBass1 252ms   120Hz + 6723c at sustain 0.19 ->  251Hz   a real sweep
 *   FluidR3 drum kit          <=9.5s   14 zones                                  a real sweep
 *   sonivox bank 0        median 1.0s  268 zones (pianos, pads, most of the bank) a real sweep
 *
 * Above the threshold we return NULL — the zone plays unfiltered, exactly as it did before any of
 * this, and GMD-83 is what earns it a moving cutoff. Guessing a point on a one-second sweep would
 * make a piano dark from its first sample; that is the "adding them silently and wrongly would be
 * worse" rule at the top of this file, applied.
 *
 * The LFO term is left out on purpose: it oscillates about zero, so its steady state IS zero.
 *
 * Clamped to TSF's own generator limits, applied at the same point TSF applies them: gen 8 merges
 * into [1500, 13500] BEFORE the envelope is added, and the resolved sum is then tested unclamped —
 * TSF does not clamp it either, so this is parity, not a safety net. Be precise about what the low
 * bound buys: FluidR3's "Chiffer Lead" merges to 1139 cents and 1500 is 19.4Hz, so both are
 * sub-audible and the clamp only keeps the two engines agreeing. A zone whose ENVELOPE drags the
 * resolved cutoff below 1500 would still build a sub-audible biquad, exactly as it does on desktop.
 * The lowest resolved cutoff in either committed pack today is 388Hz.
 *
 * DELIBERATE DIVERGENCE, the only one, and narrower than it first read: TSF's test is
 * `fres <= 13500`, so at EXACTLY the default it still builds a 19913Hz lowpass. We skip that —
 * but only when gen 9 is 0, where the claim "it removes nothing audible" actually holds. Review
 * round 2 found the hole: 180 melodic and 6 drum zones sit at 13500 with a NON-ZERO resonance, up
 * to 10 centibels-per-dB on the closed and pedal hi-hat, and dropping those threw away a top-octave
 * lift that desktop has. Those now build the filter. The residual gap is a ~2dB shelf between
 * 19.9kHz and Nyquist on flat zones, and it buys skipping a biquad on 40% of every score's voices.
 *
 * `filterFc == null` is the OLD-PACK path, not an error: a pack extracted before this shipped
 * carries no filter fields, and must keep playing exactly as it did rather than silently
 * filtering at 0Hz.
 */
/** TSF's generator limits for gens 8 and 9 (GEN_INT_LIMITFC / GEN_INT_LIMITQ). */
const FILTER_FC_MIN = 1500, FILTER_FC_OPEN = 13500, FILTER_Q_MAX = 960;

/**
 * How fast a modulation envelope must reach its sustain for one static biquad to stand in for it.
 * 20ms is an order of magnitude above the 2ms cluster this admits and an order below the 252ms
 * one it rejects — the gap in the measured data is that wide, so the exact number is not delicate.
 */
const MODENV_STATIC_S = 0.02;

function zoneFilter(zone: { filterFc?: number; filterQ?: number; filterModEnv?: number;
                            modEnvSustain?: number; modEnvSettle?: number; modEnvDecay?: number },
                    sampleRate: number): { hz: number; qDb: number } | null {
  if (zone.filterFc == null) return null;                       // old pack: no filter data at all
  const base = Math.max(FILTER_FC_MIN, Math.min(FILTER_FC_OPEN, zone.filterFc));
  // Web Audio's lowpass Q is a resonance in DECIBELS (not the cookbook's dimensionless Q), which
  // is exactly SF2's centibels / 10 — so this lands in the destination unit with no conversion.
  const q = Math.max(0, Math.min(FILTER_Q_MAX, zone.filterQ || 0));
  const modEnv = zone.filterModEnv || 0;
  let cents = base;
  if (modEnv) {
    // The decay counts only if the envelope actually decays, and `modEnvSustain` may have been
    // moved by a preset offset AFTER modEnvSettle was computed — hence the two fields.
    const sustain = zone.modEnvSustain != null ? zone.modEnvSustain : 1;
    const settle = (zone.modEnvSettle != null ? zone.modEnvSettle : Infinity)
                 + (sustain < 1 ? (zone.modEnvDecay || 0) : 0);
    // Written so that a MISSING settle time fails the test rather than passing it.
    if (!(settle <= MODENV_STATIC_S)) return null;
    cents = base + sustain * modEnv;
  }
  // `>` not `>=` when the zone is resonant: see the divergence note above.
  if (q ? cents > FILTER_FC_OPEN : cents >= FILTER_FC_OPEN) return null;
  const hz = centsToHertz(cents);
  if (!(hz > 0) || hz >= 0.499 * sampleRate) return null;
  return { hz, qDb: q / 10 };
}

  const api = { parseSf2, zonesFor, rateFor, timecentsToSeconds, velocityGain, attenuationGain,
                percussionMakeupGain, PERCUSSION_FLOOR_DB, MAKEUP_MAX_DB,
                zoneFilter, centsToHertz, FILTER_FC_MIN, FILTER_FC_OPEN, FILTER_Q_MAX,
                MODENV_STATIC_S, GEN };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasSf2 = api;
}());
