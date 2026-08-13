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
// the low-pass filter generators, LFOs, vibrato, chorus/reverb sends. A GM bank still plays
// recognisably without them; adding them silently and wrongly would be worse.

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
  instrument: 41, keyRange: 43, velRange: 44,
  initialAttenuation: 48, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, scaleTuning: 56,
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
  attenuationDb: number;
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
        pan: num(GEN.pan, 0) / 1000,                          // -500..500 -> -0.5..0.5
        loopMode: num(GEN.sampleModes, 0),
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

      for (const z of instrumentZones(instIndex)) {
        // Preset ranges INTERSECT instrument ranges; a zone outside the preset's window is
        // simply not reachable and must be dropped, not widened.
        const keyLo = Math.max(z.keyLo, pKey.lo), keyHi = Math.min(z.keyHi, pKey.hi);
        const velLo = Math.max(z.velLo, pVel.lo), velHi = Math.min(z.velHi, pVel.hi);
        if (keyLo > keyHi || velLo > velHi) continue;
        zones.push({ ...z, keyLo, keyHi, velLo, velHi,
                     attenuationDb: z.attenuationDb + pAtten, tuneCents: z.tuneCents + pTune });
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
    }
  };
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

  const api = { parseSf2, zonesFor, rateFor, timecentsToSeconds, GEN };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasSf2 = api;
}());
