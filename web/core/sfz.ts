// Gomidas — SFZ-lite parser (GMD-34, docs/WEB_PORT.md §6.2 step 1).
//
// The bundled CC0 instruments use NINE opcodes between them:
//   lokey hikey key pitch_keycenter sample ampeg_decay ampeg_release loop_mode bend_up bend_down
// No velocity layers, no round-robins, no filters, no LFOs — one sample per key with a few
// stretched ranges. This parses that subset faithfully and ignores the rest of the spec.
//
// lovel/hivel ARE parsed even though nothing uses them today: velocity layers are the most
// likely next requirement, and a region list that silently drops them would be worse than
// useless when a third-party library arrives.
//
// Pure text -> data. No fetch, no AudioContext (§9), so it is golden-testable against the two
// bundled files.
//
// No top-level import/export — emits as a plain <script> global.

// SCOPE NOTE: body wrapped in an IIFE so nothing leaks into the shared script global scope.
(function () {

interface SfzRegion {
  sample: string;
  lokey: number;
  hikey: number;
  pitchKeycenter: number;
  lovel: number;
  hivel: number;
  ampegDecay: number;
  ampegRelease: number;
  loopMode: string | null;
  bendUp: number;    // cents
  bendDown: number;  // cents
  volume: number;    // dB
  tune: number;      // cents
}

const DEFAULTS = {
  lokey: 0, hikey: 127, pitchKeycenter: 60,
  lovel: 0, hivel: 127,
  ampegDecay: 0, ampegRelease: 0.3,
  loopMode: null as string | null,
  bendUp: 200, bendDown: -200,
  volume: 0, tune: 0
};

/** SFZ note names: c4 = 60 in the convention FreePats uses (c-1 = 0). Numeric keys pass through. */
function parseKey(raw: string): number {
  const v = String(raw).trim();
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(v);
  if (!m) return NaN;
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let semi = base[m[1].toLowerCase()];
  if (m[2] === '#') semi++;
  else if (m[2] === 'b') semi--;
  return semi + (parseInt(m[3], 10) + 1) * 12;
}

/**
 * Parse an .sfz into a flat region list.
 *
 * SFZ is HIERARCHICAL: <global> then <group> then <region>, each inheriting from the one above,
 * and a <group> resets whatever the previous group set. The bundled bass relies on this — its
 * ampeg_decay/release live on a <group> and its bend range on <global>. Flattening that wrong
 * gives every note the default envelope, which is audible as wrong release times rather than as
 * an error.
 */
function parseSfz(text: string): SfzRegion[] {
  // Strip comments first: `//` to end of line. (No /* */ in the SFZ spec.)
  const cleaned = String(text || '').replace(/\/\/[^\n\r]*/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  const regions: SfzRegion[] = [];
  let global: Record<string, string> = {};
  let group: Record<string, string> = {};
  let current: Record<string, string> | null = null;
  let scope: 'global' | 'group' | 'region' | null = null;

  const flush = () => {
    if (scope === 'region' && current) regions.push(build({ ...global, ...group, ...current }));
    current = null;
  };

  for (const tok of tokens) {
    const header = /^<([a-z]+)>$/i.exec(tok);
    if (header) {
      flush();
      const name = header[1].toLowerCase();
      if (name === 'global') { global = {}; group = {}; scope = 'global'; current = global; }
      else if (name === 'group') { group = {}; scope = 'group'; current = group; }
      else if (name === 'region') { scope = 'region'; current = {}; }
      else { scope = null; current = null; }   // <curve>, <effect>, … : ignored
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq <= 0 || !current) continue;
    current[tok.slice(0, eq).toLowerCase()] = tok.slice(eq + 1);
  }
  flush();
  return regions;
}

function build(op: Record<string, string>): SfzRegion {
  const num = (k: string, d: number) => {
    const v = parseFloat(op[k]);
    return Number.isFinite(v) ? v : d;
  };
  const key = op.key != null ? parseKey(op.key) : NaN;
  const lokey = Number.isFinite(key) ? key : (op.lokey != null ? parseKey(op.lokey) : DEFAULTS.lokey);
  const hikey = Number.isFinite(key) ? key : (op.hikey != null ? parseKey(op.hikey) : DEFAULTS.hikey);
  // pitch_keycenter defaults to `key` when set, which is what makes the terse one-line
  // `key=NN sample=…` regions play at the right pitch.
  const center = op.pitch_keycenter != null ? parseKey(op.pitch_keycenter)
               : (Number.isFinite(key) ? key : DEFAULTS.pitchKeycenter);
  return {
    sample: (op.sample || '').replace(/\\/g, '/'),
    lokey: Number.isFinite(lokey) ? lokey : DEFAULTS.lokey,
    hikey: Number.isFinite(hikey) ? hikey : DEFAULTS.hikey,
    pitchKeycenter: Number.isFinite(center) ? center : DEFAULTS.pitchKeycenter,
    lovel: num('lovel', DEFAULTS.lovel),
    hivel: num('hivel', DEFAULTS.hivel),
    ampegDecay: num('ampeg_decay', DEFAULTS.ampegDecay),
    ampegRelease: num('ampeg_release', DEFAULTS.ampegRelease),
    loopMode: op.loop_mode || DEFAULTS.loopMode,
    bendUp: num('bend_up', DEFAULTS.bendUp),
    bendDown: num('bend_down', DEFAULTS.bendDown),
    volume: num('volume', DEFAULTS.volume),
    tune: num('tune', DEFAULTS.tune)
  };
}

/**
 * Pick the region for a key+velocity. Later regions win ties, matching SFZ's "last match" rule.
 * Returns null when nothing covers the key — the caller must not silently play the wrong sample.
 */
function findRegion(regions: SfzRegion[], key: number, velocity: number = 100): SfzRegion | null {
  let found: SfzRegion | null = null;
  for (const r of regions) {
    if (key >= r.lokey && key <= r.hikey && velocity >= r.lovel && velocity <= r.hivel) found = r;
  }
  return found;
}

/** Playback rate for a key, from the region's centre. Pure so it can be tested without audio. */
function playbackRateFor(region: SfzRegion, key: number): number {
  const semitones = key - region.pitchKeycenter + (region.tune || 0) / 100;
  return Math.pow(2, semitones / 12);
}

/** Every distinct sample path a region list references — the fetch list. */
function sampleList(regions: SfzRegion[]): string[] {
  const seen = new Set<string>();
  for (const r of regions) if (r.sample) seen.add(r.sample);
  return [...seen];
}

  const api = { parseSfz, parseKey, findRegion, playbackRateFor, sampleList, DEFAULTS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasSfz = api;
}());
