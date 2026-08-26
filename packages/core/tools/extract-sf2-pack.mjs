#!/usr/bin/env node
// Gomidas — SoundFont pack extractor (GMD-50 drums, GMD-57 melodic).
//
// WHY THIS EXISTS: the browser build fetches the 1.35MB sonivox bank, whose Standard kit is a
// 20ms kick sampled at 20kHz with a single velocity layer, and whose melodic instruments are no
// better. The desktop app loads FluidR3, whose kick is 283ms of 44.1kHz stereo and whose snare
// has seven velocity layers. That gap — not our envelope code — is why web audio sounds like
// cardboard.
//
// FluidR3 is 151MB and gitignored, so it cannot ship to the browser and cannot be a build input
// on a fresh clone. This tool runs ONCE on a machine that has it and emits small, committed
// packs. Two modes:
//
//   DRUM (--bank 128, the default)   one .json + one .bin for a set of kits
//     assets/drumkits/<name>.json    zone table (the SAME shape core/sf2.ts produces) + samples
//     assets/drumkits/<name>.bin     the samples, concatenated
//
//   MELODIC (--bank 0 --split)       one shared manifest + ONE .bin PER PROGRAM
//     assets/instruments-gm/<name>.json        every program's zone table, small, fetched once
//     assets/instruments-gm/<name>-024.bin     that program's samples only
//
// --split exists because MELODIC PRESETS SHARE ALMOST NO SAMPLES. Measured on FluidR3 bank 0:
// guitars 24-31 use 83 samples summed per-program and 82 unique; basses 32-39, 65 and 65. So
// per-program blobs cost nothing in total size and mean a score using one guitar downloads ~1MB
// instead of the 5.89MB family. Drums are the opposite — one kit is one unit — so they stay
// single-blob, and their output is byte-for-byte what GMD-50 committed.
//
// One file per sample INSIDE one blob is the point: a single sprite re-encoded as one stream
// would smear each hit into the next across the codec's window, and lossy containers add priming
// silence that shifts every subsequent offset. Per-sample files mean the runtime hands each slice
// straight to decodeAudioData, and a drum attack stays exactly where it was.
//
// FLAC is the default for two reasons. It is lossless (a 96k Opus cymbal swishes) and has no
// encoder delay to eat the transient — that is the drum argument. The melodic argument is
// stronger: these zones LOOP, the runtime derives loop points as (startLoop - start) / rate in
// frames, and Opus adds priming delay and forces 48kHz, so every sustained note would click at
// each loop boundary. decodeAudioData handles FLAC in Chrome, Firefox and Safari.
// Measured: GM Standard kit 11MB PCM -> 5.6MB FLAC, 2.2MB AAC 128k, 1.6MB Opus 96k.
// Melodic guitars+basses: 19.99MB PCM -> 9.06MB FLAC.
//
// Usage (from the repo root, after `npm --prefix packages/core run build`):
//   node packages/core/tools/extract-sf2-pack.mjs                       # the GM drum kit
//   node packages/core/tools/extract-sf2-pack.mjs --bank 0 --split \
//        --programs 24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39 \
//        --out assets/instruments-gm --name gm-melodic
//
// Deterministic: same inputs -> byte-identical outputs, so a re-run produces an empty diff.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

const sf2Path  = path.resolve(repoRoot, opt('sf2', 'assets/soundfont/FluidR3_GM.sf2'));
const bankNo   = parseInt(opt('bank', '128'), 10);
const split    = flag('split');
const outDir   = path.resolve(repoRoot, opt('out', 'assets/drumkits'));
const name     = opt('name', 'gm-standard');
const codec    = opt('codec', 'flac');
const programs = opt('programs', '0').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

const CODECS = {
  flac: { ext: 'flac', mime: 'audio/flac', ffmpeg: ['-c:a', 'flac', '-compression_level', '8'] },
  opus: { ext: 'opus', mime: 'audio/ogg',  ffmpeg: ['-c:a', 'libopus', '-b:a', '96k'] },
  aac:  { ext: 'm4a',  mime: 'audio/mp4',  ffmpeg: ['-c:a', 'aac', '-b:a', '128k'] }
};

function die(msg) { console.error('extract-sf2-pack: ' + msg); process.exit(1); }

if (!CODECS[codec]) die('unknown --codec ' + codec + ' (want ' + Object.keys(CODECS).join('/') + ')');
if (isNaN(bankNo)) die('--bank must be a number');
if (!fs.existsSync(sf2Path)) {
  die('SoundFont not found: ' + sf2Path + '\n' +
      '  FluidR3_GM.sf2 is gitignored (151MB, over GitHub\'s limit). See README "SoundFonts".');
}
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
catch { die('ffmpeg not on PATH — needed to encode the samples (brew install ffmpeg).'); }

const sf2Module = path.join(repoRoot, 'packages/core/dist/core/sf2.js');
if (!fs.existsSync(sf2Module)) die('run `npm --prefix packages/core run build` first (need dist/core/sf2.js)');
const SF2 = require(sf2Module);

// ── read the bank ─────────────────────────────────────────────────────────────
const raw = fs.readFileSync(sf2Path);
const bank = SF2.parseSf2(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round((v || 0) * f) / f;
}

/**
 * Zone table for one preset, plus the bank-sample indices it needs.
 *
 * `localOf`/`sampleIds` are passed in so the caller controls the sharing scope: the drum pack
 * dedupes across every kit into ONE blob, while --split gives each program a fresh pair and so
 * its own self-contained blob.
 */
function zonesOf(preset, localOf, sampleIds) {
  return preset.zones.map(z => {
    if (!localOf.has(z.sampleIndex)) { localOf.set(z.sampleIndex, sampleIds.length); sampleIds.push(z.sampleIndex); }
    // Deliberately the same field set core/sf2.ts emits, so the runtime reuses zonesFor/rateFor
    // unchanged — a pack is a bank, not a second format with a second interpreter.
    const out = {
      keyLo: z.keyLo, keyHi: z.keyHi, velLo: z.velLo, velHi: z.velHi,
      sampleIndex: localOf.get(z.sampleIndex),
      rootKey: z.rootKey, tuneCents: z.tuneCents,
      attenuationDb: round(z.attenuationDb, 3), pan: round(z.pan, 4),
      loopMode: z.loopMode, exclusiveClass: z.exclusiveClass,
      attack: round(z.attack, 5), hold: round(z.hold, 5), decay: round(z.decay, 5),
      sustain: round(z.sustain, 5), release: round(z.release, 5)
    };
    // The lowpass (gens 8/9, GMD-80) is emitted only when the zone actually has one — 13500 cents
    // is "open" and 0 centibels is "no resonance", so writing the defaults would add two numbers
    // to all 1275 zones to say nothing. Absence is also what an OLDER runtime reads as "no
    // filter", which is the behaviour it had before this field existed.
    if (z.filterFc !== 13500) out.filterFc = z.filterFc;
    if (z.filterQ) out.filterQ = z.filterQ;
    return out;
  });
}

function findPreset(program) {
  const p = bank.presets.find(x => x.bank === bankNo && x.program === program);
  if (!p) die('no bank-' + bankNo + ' preset for program ' + program + ' in ' + path.basename(sf2Path));
  return p;
}

// ── encode ────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gomidas-pack-'));

function wavHeader(frames, rate) {
  const h = Buffer.alloc(44);
  const dataBytes = frames * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Encode the given bank samples into one blob; returns { blob, samples } with byte offsets. */
function encodeSamples(sampleIds, tag) {
  const chunks = [];
  const samples = [];
  let offset = 0;

  for (let i = 0; i < sampleIds.length; i++) {
    const s = bank.samples[sampleIds[i]];
    const frames = s.end - s.start;
    if (frames <= 0) die('sample ' + s.name + ' is empty');

    const pcm = Buffer.alloc(frames * 2);
    for (let k = 0; k < frames; k++) pcm.writeInt16LE(bank.pcm[s.start + k], k * 2);

    const wav = path.join(tmp, tag + i + '.wav');
    fs.writeFileSync(wav, Buffer.concat([wavHeader(frames, s.sampleRate), pcm]));
    const enc = path.join(tmp, tag + i + '.' + CODECS[codec].ext);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, ...CODECS[codec].ffmpeg, enc]);
    const bytes = fs.readFileSync(enc);
    chunks.push(bytes);
    fs.rmSync(wav, { force: true }); fs.rmSync(enc, { force: true });

    samples.push({
      name: s.name.trim(),
      // start/end are sample-relative here (the blob holds one file per sample), which keeps the
      // runtime's loop math — (startLoop - start) / rate — working with no special case.
      start: 0, end: frames,
      startLoop: Math.max(0, s.startLoop - s.start),
      endLoop: Math.max(0, s.endLoop - s.start),
      sampleRate: s.sampleRate,
      originalPitch: s.originalPitch,
      pitchCorrection: s.pitchCorrection,
      offset, length: bytes.length
    });
    offset += bytes.length;
  }
  return { blob: Buffer.concat(chunks), samples };
}

fs.mkdirSync(outDir, { recursive: true });
let report = '';

if (!split) {
  // ── single-blob pack (drums) — output is byte-identical to what GMD-50 committed ──
  const kits = [];
  const sampleIds = [];
  const localOf = new Map();
  for (const program of programs) {
    const preset = findPreset(program);
    kits.push({ program, name: preset.name.trim(), zones: zonesOf(preset, localOf, sampleIds) });
  }

  const { blob, samples } = encodeSamples(sampleIds, 'k');
  const header = {
    format: 'gomidas-drumkit',
    version: 1,
    source: path.basename(sf2Path),
    codec, mime: CODECS[codec].mime,
    blob: name + '.bin',
    // Guards the pair: a JSON read against a stale .bin would decode garbage silently.
    blobBytes: blob.length,
    kits, samples
  };
  fs.writeFileSync(path.join(outDir, name + '.bin'), blob);
  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(header, null, 1) + '\n');

  const seconds = samples.reduce((a, s) => a + (s.end - s.start) / s.sampleRate, 0);
  report = kits.map(k => k.program + ':' + k.name).join(', ') + '\n' +
    '  ' + samples.length + ' samples, ' + seconds.toFixed(1) + 's, ' +
    (blob.length / 1048576).toFixed(2) + 'MB ' + codec +
    ' -> ' + path.relative(repoRoot, outDir) + '/' + name + '.{json,bin}';
} else {
  // ── per-program packs (melodic) — one shared manifest, one blob each ──
  const out = [];
  let total = 0;
  for (const program of programs) {
    const preset = findPreset(program);
    const sampleIds = [];
    const zones = zonesOf(preset, new Map(), sampleIds);   // fresh map: no sharing across blobs
    const blobName = name + '-' + String(program).padStart(3, '0') + '.bin';
    const { blob, samples } = encodeSamples(sampleIds, 'p' + program + '_');
    fs.writeFileSync(path.join(outDir, blobName), blob);
    total += blob.length;
    out.push({ program, name: preset.name.trim(), blob: blobName, blobBytes: blob.length, zones, samples });
    console.log('  ' + String(program).padStart(3) + ' ' + preset.name.trim().padEnd(24) +
                (blob.length / 1048576).toFixed(2).padStart(7) + 'MB  ' + samples.length + ' samples');
  }

  const header = {
    format: 'gomidas-sf2-pack',
    version: 1,
    source: path.basename(sf2Path),
    bank: bankNo,
    codec, mime: CODECS[codec].mime,
    programs: out
  };
  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(header, null, 1) + '\n');

  const manifestBytes = fs.statSync(path.join(outDir, name + '.json')).size;
  report = out.length + ' programs, ' + (total / 1048576).toFixed(2) + 'MB ' + codec +
    ' + ' + (manifestBytes / 1024).toFixed(0) + 'KB manifest' +
    ' -> ' + path.relative(repoRoot, outDir) + '/' + name + '.json + ' + out.length + ' .bin';
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('extract-sf2-pack: ' + report);
