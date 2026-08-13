// Gomidas — effect chain schema + DSP curve maths (GMD-35, docs/WEB_PORT.md §5).
//
// THE RULE (§5.1): effects are stored as DATA THAT EITHER BACKEND CAN RENDER ITS OWN WAY. The web
// build renders a chain with Web Audio nodes; the desktop build will render the same chain with
// juce::dsp. If the schema leaks Web-Audio concepts, the .gomidas format forks and the two
// products drift apart — which is the single failure this file exists to prevent.
//
//   - No node names, no AudioParam references, no Web-Audio-only semantics.
//   - Real units where meaningful (dB, Hz, seconds, ratio); 0..1 for abstract amounts.
//   - `ir` is an IDENTIFIER, not a path or a blob. Each backend resolves it to its own asset.
//   - Unknown `type` values are PRESERVED on load/save and skipped at render time, so a file
//     written by a newer build still round-trips through an older one.
//
// Pure data + maths, no AudioContext (§9).

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

const FX_SCHEMA_VERSION = 1;

interface ParamSpec { min: number; max: number; def: number; unit: string }

/**
 * The known effect types and their parameter ranges. Documenting the range of every param is a
 * §5.1 requirement: a backend that clamps differently is a backend that sounds different.
 */
const FX_TYPES: Record<string, Record<string, ParamSpec>> = {
  compressor: {
    threshold: { min: -60, max: 0, def: -18, unit: 'dB' },
    ratio:     { min: 1, max: 20, def: 4, unit: 'ratio' },
    attack:    { min: 0, max: 1, def: 0.003, unit: 's' },
    release:   { min: 0, max: 2, def: 0.25, unit: 's' },
    knee:      { min: 0, max: 40, def: 6, unit: 'dB' }
  },
  drive: {
    // mode is a string enum, handled separately: 'overdrive' | 'distortion' | 'fuzz'
    drive: { min: 0, max: 1, def: 0.6, unit: 'amount' },
    tone:  { min: 0, max: 1, def: 0.5, unit: 'amount' },
    level: { min: 0, max: 1, def: 0.8, unit: 'amount' }
  },
  chorus: {
    rate:    { min: 0.05, max: 8, def: 0.8, unit: 'Hz' },
    depth:   { min: 0, max: 1, def: 0.4, unit: 'amount' },
    mix:     { min: 0, max: 1, def: 0.3, unit: 'amount' },
    delayMs: { min: 1, max: 40, def: 22, unit: 'ms' }
  },
  flanger: {
    rate:     { min: 0.05, max: 8, def: 0.4, unit: 'Hz' },
    depth:    { min: 0, max: 1, def: 0.6, unit: 'amount' },
    feedback: { min: 0, max: 0.95, def: 0.5, unit: 'amount' },
    mix:      { min: 0, max: 1, def: 0.4, unit: 'amount' },
    delayMs:  { min: 0.5, max: 12, def: 4, unit: 'ms' }
  },
  phaser: {
    rate:  { min: 0.05, max: 8, def: 0.5, unit: 'Hz' },
    depth: { min: 0, max: 1, def: 0.6, unit: 'amount' },
    mix:   { min: 0, max: 1, def: 0.5, unit: 'amount' }
  },
  tremolo: {
    rate:  { min: 0.1, max: 20, def: 5, unit: 'Hz' },
    depth: { min: 0, max: 1, def: 0.6, unit: 'amount' }
  },
  wah: {
    freq: { min: 200, max: 3000, def: 800, unit: 'Hz' },
    q:    { min: 0.5, max: 12, def: 5, unit: 'Q' },
    mix:  { min: 0, max: 1, def: 1, unit: 'amount' }
  },
  delay: {
    timeMs:   { min: 10, max: 2000, def: 375, unit: 'ms' },
    feedback: { min: 0, max: 0.95, def: 0.35, unit: 'amount' },
    tone:     { min: 500, max: 12000, def: 3000, unit: 'Hz' },
    mix:      { min: 0, max: 1, def: 0.25, unit: 'amount' }
  },
  cab: {
    // The IR that matters more than the distortion algorithm (§5): a dry DI through a
    // waveshaper sounds like a bee in a jar; the same signal through a 4x12 sounds like an amp.
    mix: { min: 0, max: 1, def: 1, unit: 'amount' }
  },
  reverb: {
    mix: { min: 0, max: 1, def: 0.2, unit: 'amount' }
  },
  eq3: {
    low:  { min: -18, max: 18, def: 0, unit: 'dB' },
    mid:  { min: -18, max: 18, def: 0, unit: 'dB' },
    high: { min: -18, max: 18, def: 0, unit: 'dB' }
  }
};

const DRIVE_MODES = ['overdrive', 'distortion', 'fuzz'];
const SEND_NAMES = ['delay', 'reverb'];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}

function isKnownType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(FX_TYPES, type);
}

/** Defaults for a known type; empty for an unknown one (which is preserved, not invented). */
function defaultParams(type: string): Record<string, number | string> {
  const spec = FX_TYPES[type];
  if (!spec) return {};
  const out: Record<string, number | string> = {};
  for (const k of Object.keys(spec)) out[k] = spec[k].def;
  if (type === 'drive') out.mode = 'overdrive';
  if (type === 'cab') out.ir = '4x12-v30';
  if (type === 'reverb') out.ir = 'hall-medium';
  return out;
}

/**
 * Validate and normalise a chain, CLAMPING numbers into range and filling defaults.
 *
 * Unknown types survive untouched with a `_unknown` marker so the renderer can skip them while
 * save still writes them back exactly as they arrived. Dropping them here would mean an older
 * build silently deletes a newer build's effects on open+save.
 */
function normalizeChain(input: any): { version: number; chain: any[]; sends: Record<string, number> } {
  const src = input && typeof input === 'object' ? input : {};
  const rawChain = Array.isArray(src.chain) ? src.chain : [];
  const chain: any[] = [];

  for (const raw of rawChain) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') continue;
    const type = raw.type;
    if (!isKnownType(type)) {
      chain.push({ ...raw, _unknown: true });     // preserved verbatim, skipped at render
      continue;
    }
    const spec = FX_TYPES[type];
    const params: Record<string, number | string> = defaultParams(type);
    const given = raw.params && typeof raw.params === 'object' ? raw.params : {};
    for (const key of Object.keys(spec)) {
      const v = Number(given[key]);
      if (Number.isFinite(v)) params[key] = clamp(v, spec[key].min, spec[key].max);
    }
    if (type === 'drive' && DRIVE_MODES.indexOf(given.mode) >= 0) params.mode = given.mode;
    // `ir` is an identifier — pass any string through; each backend resolves it to its own asset
    // and falls back if it does not have that one.
    if ((type === 'cab' || type === 'reverb') && typeof given.ir === 'string' && given.ir) params.ir = given.ir;
    chain.push({ type, bypass: raw.bypass === true, params });
  }

  const sends: Record<string, number> = {};
  const rawSends = src.sends && typeof src.sends === 'object' ? src.sends : {};
  for (const name of SEND_NAMES) {
    const v = Number(rawSends[name]);
    sends[name] = Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  }

  return { version: FX_SCHEMA_VERSION, chain, sends };
}

/** True when nothing would be rendered — lets the graph skip building an insert chain at all. */
function chainIsEmpty(chain: any): boolean {
  const n = normalizeChain(chain);
  const active = n.chain.filter((e: any) => !e.bypass && !e._unknown);
  return active.length === 0 && SEND_NAMES.every(s => !n.sends[s]);
}

/**
 * Waveshaper transfer curve. Pure, so it is snapshot-tested rather than judged by ear.
 *
 * WaveShaperNode aliases (§8) — `oversample: '4x'` mitigates but does not eliminate it, which is
 * why a lot of browser guitar tone sounds buzzy at high gain. These curves stay deliberately
 * soft: a credible amp sim, not a boutique modeller.
 */
function makeDriveCurve(mode: string, amount: number, samples: number = 2048): Float32Array {
  const k = clamp(amount, 0, 1);
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;   // -1..1
    let y: number;
    if (mode === 'fuzz') {
      // Hard, asymmetric clip.
      const g = 1 + k * 60;
      y = Math.tanh(x * g) * (x >= 0 ? 1 : 0.85);
    } else if (mode === 'distortion') {
      const g = 1 + k * 30;
      y = Math.tanh(x * g);
    } else {
      // Overdrive: soft cubic-ish knee, the classic "warm" shape.
      const g = 1 + k * 8;
      const xa = x * g;
      y = Math.abs(xa) < 1 ? xa - (xa * xa * xa) / 3 : Math.sign(xa) * (2 / 3);
      y *= 1 / (1 + k);   // keep output roughly level as drive rises
    }
    curve[i] = clamp(y, -1, 1);
  }
  return curve;
}

  const api = { FX_SCHEMA_VERSION, FX_TYPES, DRIVE_MODES, SEND_NAMES,
                normalizeChain, defaultParams, isKnownType, chainIsEmpty, makeDriveCurve, clamp };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasFx = api;
}());
