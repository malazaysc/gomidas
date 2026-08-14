#!/usr/bin/env node
// Gomidas — drum-kit extractor (GMD-50).
//
// WHY THIS EXISTS: the browser build fetches the 1.35MB sonivox bank, whose Standard kit is a
// 20ms kick sampled at 20kHz with a single velocity layer. The desktop app loads FluidR3, whose
// kick is 283ms of 44.1kHz stereo and whose snare has seven velocity layers. That gap — not our
// envelope code — is why web drums sound like cardboard.
//
// FluidR3 is 151MB and gitignored, so it cannot ship to the browser and cannot be a build input
// on a fresh clone. This tool runs ONCE on a machine that has it and emits a small, committed
// drum-only pack:
//
//   assets/drumkits/<name>.json   zone table (the SAME shape core/sf2.ts produces) + sample index
//   assets/drumkits/<name>.bin    the samples, each encoded as its OWN complete audio file,
//                                 concatenated; the JSON holds byte offsets into it
//
// One file per sample INSIDE one blob is the point: a single sprite re-encoded as one stream
// would smear each hit into the next across the codec's window, and lossy containers add priming
// silence that shifts every subsequent offset. Per-sample files mean the runtime hands each slice
// straight to decodeAudioData, and a drum attack stays exactly where it was.
//
// FLAC is the default for the same reason: it is lossless (a 96k Opus cymbal swishes), has no
// encoder delay to eat the transient, and decodeAudioData handles it in Chrome, Firefox and
// Safari. Measured on the GM Standard kit: 11MB PCM -> 5.6MB FLAC, 2.2MB AAC 128k, 1.6MB Opus
// 96k. Pass --codec opus if the download ever matters more than the transients.
//
// Usage (from the repo root, after `npm --prefix packages/core run build`):
//   node packages/core/tools/extract-drumkit.mjs
//   node packages/core/tools/extract-drumkit.mjs --programs 0,8,16 --codec opus --name gm-kits
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

const sf2Path  = path.resolve(repoRoot, opt('sf2', 'assets/soundfont/FluidR3_GM.sf2'));
const outDir   = path.resolve(repoRoot, opt('out', 'assets/drumkits'));
const name     = opt('name', 'gm-standard');
const codec    = opt('codec', 'flac');
const programs = opt('programs', '0').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

const CODECS = {
  flac: { ext: 'flac', mime: 'audio/flac', ffmpeg: ['-c:a', 'flac', '-compression_level', '8'] },
  opus: { ext: 'opus', mime: 'audio/ogg',  ffmpeg: ['-c:a', 'libopus', '-b:a', '96k'] },
  aac:  { ext: 'm4a',  mime: 'audio/mp4',  ffmpeg: ['-c:a', 'aac', '-b:a', '128k'] }
};

function die(msg) { console.error('extract-drumkit: ' + msg); process.exit(1); }

if (!CODECS[codec]) die('unknown --codec ' + codec + ' (want ' + Object.keys(CODECS).join('/') + ')');
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

const kits = [];
const sampleIds = [];                       // kit-local index -> bank sample index
const localOf = new Map();                  // bank sample index -> kit-local index

for (const program of programs) {
  const preset = bank.presets.find(p => p.bank === 128 && p.program === program);
  if (!preset) die('no bank-128 preset for program ' + program + ' in ' + path.basename(sf2Path));
  const zones = preset.zones.map(z => {
    if (!localOf.has(z.sampleIndex)) { localOf.set(z.sampleIndex, sampleIds.length); sampleIds.push(z.sampleIndex); }
    // Deliberately the same field set core/sf2.ts emits, so the runtime reuses zonesFor/rateFor
    // unchanged — the kit is a bank, not a second format with a second interpreter.
    return {
      keyLo: z.keyLo, keyHi: z.keyHi, velLo: z.velLo, velHi: z.velHi,
      sampleIndex: localOf.get(z.sampleIndex),
      rootKey: z.rootKey, tuneCents: z.tuneCents,
      attenuationDb: round(z.attenuationDb, 3), pan: round(z.pan, 4),
      loopMode: z.loopMode, exclusiveClass: z.exclusiveClass,
      attack: round(z.attack, 5), hold: round(z.hold, 5), decay: round(z.decay, 5),
      sustain: round(z.sustain, 5), release: round(z.release, 5)
    };
  });
  kits.push({ program, name: preset.name.trim(), zones });
}

function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round((v || 0) * f) / f;
}

// ── encode each sample on its own ─────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gomidas-kit-'));
const chunks = [];
const samples = [];
let offset = 0;

for (let i = 0; i < sampleIds.length; i++) {
  const s = bank.samples[sampleIds[i]];
  const frames = s.end - s.start;
  if (frames <= 0) die('sample ' + s.name + ' is empty');

  const pcm = Buffer.alloc(frames * 2);
  for (let k = 0; k < frames; k++) pcm.writeInt16LE(bank.pcm[s.start + k], k * 2);

  const wav = path.join(tmp, i + '.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(frames, s.sampleRate), pcm]));
  const enc = path.join(tmp, i + '.' + CODECS[codec].ext);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, ...CODECS[codec].ffmpeg, enc]);
  const bytes = fs.readFileSync(enc);
  chunks.push(bytes);

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
fs.rmSync(tmp, { recursive: true, force: true });

function wavHeader(frames, rate) {
  const h = Buffer.alloc(44);
  const dataBytes = frames * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

// ── write ─────────────────────────────────────────────────────────────────────
const blob = Buffer.concat(chunks);
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

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, name + '.bin'), blob);
fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(header, null, 1) + '\n');

const seconds = samples.reduce((a, s) => a + (s.end - s.start) / s.sampleRate, 0);
console.log('extract-drumkit: ' + kits.map(k => k.program + ':' + k.name).join(', '));
console.log('  ' + samples.length + ' samples, ' + seconds.toFixed(1) + 's, ' +
            (blob.length / 1048576).toFixed(2) + 'MB ' + codec +
            ' -> ' + path.relative(repoRoot, outDir) + '/' + name + '.{json,bin}');
