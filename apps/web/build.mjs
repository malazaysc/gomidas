#!/usr/bin/env node
// Gomidas — production build for the browser app (GMD-56, GMD-52).
//
// WHY THIS EXISTS INSTEAD OF `vite build`:
//
// `packages/core/index.html` loads every script as a CLASSIC `<script src=…>`, because the same
// file is served by the JUCE WebView, which resolves those paths through MainComponent's kAssets
// table. Vite refuses to process non-module scripts — and, crucially, does not copy them either.
// It said so once per tag and still exited 0:
//
//   <script src="dist/core/webaudio.js"> in "/index.html" can't be bundled without type="module"
//
// So `vite build` emitted an index.html referencing fourteen files that were not in the output,
// plus 151MB of FluidR3 that nothing fetches (publicDir was the whole assets/ tree). The site
// could not run, and the build reported success. See GMD-56 / GMD-52.
//
// There is no module graph here by design (WEB_PORT.md §11: keep frameworks out of the editor),
// so a bundler has nothing to bundle — Vite reported "2 modules transformed" for the whole app.
// The honest production build is: tsc (already run by the npm script), copy an explicit list,
// content-hash the JavaScript, and then VERIFY the result. Vite stays for `npm run dev`, where
// its file serving genuinely earns its place.
//
// Two rules this file exists to enforce:
//
//   1. COPY LISTS ARE ALLOWLISTS, never "the whole directory minus exclusions". GMD-52 shipped
//      151MB because publicDir was a directory. An allowlist cannot regress that way: a new file
//      under assets/ is invisible here until someone adds it deliberately.
//   2. NOTHING SHIPS UNVERIFIED. The build fails if any reference in the output — a script tag or
//      a path fetched at runtime — does not resolve to a file that exists. That check is the
//      whole reason GMD-56 was possible, and it runs on every build now.
//
// Usage:  node apps/web/build.mjs           (or: npm --prefix apps/web run build)

import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const coreDir  = path.join(repoRoot, 'packages/core');
const assetDir = path.join(repoRoot, 'assets');
const outDir   = path.join(repoRoot, 'apps/web/dist');

const rel = (p) => path.relative(repoRoot, p);
function die(msg) { console.error('build: ' + msg); process.exit(1); }

// ── what ships ────────────────────────────────────────────────────────────────
//
// HASHED: files we rewrite the reference to, so a CDN can hold them forever. Safe for every
// script here because `app.js makeSettings()` sets core.useWorkers = false — alphaTab never
// fetches itself by name — and these are plain globals with no path-based imports between them.
//
// NOT hashed, and the reasons are load-bearing:
//   Bravura.woff2/.woff  alphaTab fetches these BY NAME from settings.core.fontDirectory
//                        (app.js:51), so the filenames are part of a contract we don't control.
//   drumkit.webp         fetched by name from fretboard.js:359.
//   assets/*             fetched by name from webaudio.ts (sonivox :885, drum pack :910,
//                        instruments :1178). Versioning these is GMD-58's job, via the pack
//                        manifest rather than the filename.
//
// juce_native_interop.js is DELIBERATELY ABSENT. It is JUCE-licensed code and publishing it at a
// public URL is a distribution we don't need to make: backend.ts hasJuceBridge() discriminates on
// a NON-EMPTY __JUCE__.initialisationData.__juce__platform, which is false when the file simply
// never ran. The desktop build still loads it through kAssets. (Raised in GMD-60.)
const HASHED_SCRIPTS = [
  'alphaTab.min.js',
  'dist/core/gomidas-core.js',
  'dist/core/timebase.js',
  'dist/core/sfz.js',
  'dist/core/fx.js',
  'dist/core/sf2.js',
  'dist/core/webfiles.js',
  'dist/core/menus.js',
  'dist/core/webaudio.js',
  'dist/core/backend.js',
  'dist/grooves.js',
  'dist/editor.js',
  'dist/fretboard.js',
  'dist/app.js',
  'dist/core/webshell.js'
];

const VERBATIM_CORE = [
  'Bravura.woff2',
  'Bravura.woff',
  'drumkit.webp'
];

// From assets/. NOTE what is not here: assets/soundfont/FluidR3_GM.sf2, 151MB, gitignored, and
// never fetched by the browser — it is the desktop synth's bank. That omission is GMD-52.
const VERBATIM_ASSETS = [
  'soundfont/sonivox.sf2',
  'drumkits/gm-standard.json',
  'drumkits/gm-standard.bin'
];


// Directories copied whole, because their contents are DATA the build must not have to track:
// the .sfz files name their own samples, and the melodic pack's program list changes whenever
// the extractor is re-run with a different --programs. Still enumerated from fixed roots, so
// nothing else under assets/ can drift in.
//
//   instruments/*     bundled CC0 SFZ presets (docs/SOUND_LIBRARIES.md). README/licence files
//                     ship too: CC0 asks for nothing, but the licence text travelling with the
//                     samples is the cheapest possible answer to "where did this audio come from".
//   instruments-gm    per-program FluidR3 melodic packs (GMD-57), fetched lazily per program.
const ASSET_TREES = [
  'instruments/classical-guitar',
  'instruments/electric-bass',
  'instruments-gm'
];

// Paths the running app fetches that appear in NO script tag, so nothing else would catch their
// absence. Each is a real string in the source, cited so this list can be re-checked by hand.
const RUNTIME_FETCHED = [
  ['Bravura.woff2',              'alphaTab via settings.core.fontDirectory — app.js:51'],
  ['drumkit.webp',               'fretboard.js:359'],
  ['soundfont/sonivox.sf2',      'webaudio.ts:885 — GM fallback bank'],
  ['drumkits/gm-standard.json',  'webaudio.ts:910 — FluidR3 drum pack'],
  ['drumkits/gm-standard.bin',   'webaudio.ts:910 — FluidR3 drum pack'],
  ['instruments/classical-guitar/classical-guitar.sfz', 'webaudio.ts:1178 — SFZ preset'],
  ['instruments/electric-bass/electric-bass.sfz',       'webaudio.ts:1178 — SFZ preset'],
  ['instruments-gm/gm-melodic.json',                    'webaudio.ts — melodic pack manifest'],
  ['instruments-gm/gm-melodic-024.bin',                 'webaudio.ts — melodic pack, per program']
];

// ── helpers ───────────────────────────────────────────────────────────────────
const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

function copyInto(srcAbs, relPath) {
  const dest = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcAbs, dest);
  return fs.statSync(dest).size;
}

function walk(dirAbs, base, acc = []) {
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) walk(abs, base, acc);
    else acc.push(path.relative(base, abs));
  }
  return acc;
}

// ── clean ─────────────────────────────────────────────────────────────────────
// Guard the rm: this path is a constant, but a constant one edit away from being $HOME.
if (path.basename(outDir) !== 'dist' || !outDir.startsWith(path.join(repoRoot, 'apps/web'))) {
  die('refusing to clean an unexpected output directory: ' + outDir);
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── copy + hash the scripts, and rewrite index.html to match ──────────────────
const indexSrc = path.join(coreDir, 'index.html');
if (!fs.existsSync(indexSrc)) die('missing ' + rel(indexSrc));
let html = fs.readFileSync(indexSrc, 'utf8');

let bytes = 0;
for (const script of HASHED_SCRIPTS) {
  const srcAbs = path.join(coreDir, script);
  if (!fs.existsSync(srcAbs)) {
    die('missing ' + rel(srcAbs) + '\n' +
        '  dist/* comes from tsc — run `npm --prefix packages/core run build` first.');
  }
  const buf = fs.readFileSync(srcAbs);
  const ext = path.extname(script);
  const hashed = script.slice(0, -ext.length) + '.' + hashOf(buf) + ext;

  bytes += copyInto(srcAbs, hashed);

  // Exact-match the tag we know is there. A miss means index.html changed shape, and shipping a
  // stale reference is precisely the GMD-56 failure — so it is fatal, not a warning.
  const tag = `<script src="${script}"></script>`;
  if (!html.includes(tag)) die('no <script src="' + script + '"> in index.html — copy list is stale');
  html = html.replace(tag, `<script src="${hashed}"></script>`);
}

// Drop the JUCE bridge tag from the web output (see HASHED_SCRIPTS note above).
const juceTag = '<script src="juce_native_interop.js"></script>';
if (html.includes(juceTag)) {
  html = html.replace(juceTag,
    '<!-- juce_native_interop.js is desktop-only; see apps/web/build.mjs -->');
} else {
  console.warn('build: warning — no juce_native_interop.js tag found; did index.html change?');
}

fs.writeFileSync(path.join(outDir, 'index.html'), html);
bytes += Buffer.byteLength(html);

// ── copy everything that keeps its name ───────────────────────────────────────
for (const f of VERBATIM_CORE) {
  const srcAbs = path.join(coreDir, f);
  if (!fs.existsSync(srcAbs)) die('missing ' + rel(srcAbs));
  bytes += copyInto(srcAbs, f);
}
for (const f of VERBATIM_ASSETS) {
  const srcAbs = path.join(assetDir, f);
  if (!fs.existsSync(srcAbs)) die('missing ' + rel(srcAbs));
  bytes += copyInto(srcAbs, f);
}
for (const tree of ASSET_TREES) {
  const rootAbs = path.join(assetDir, tree);
  if (!fs.existsSync(rootAbs)) die('missing ' + rel(rootAbs));
  for (const f of walk(rootAbs, assetDir)) bytes += copyInto(path.join(assetDir, f), f);
}

// ── cache headers (Cloudflare Pages `_headers`) ───────────────────────────────
//
// Emitted BY the build rather than committed as a static file, so it can never describe a layout
// the build no longer produces.
//
// The split is exactly the hashed/unhashed split above, and it matters: a long TTL on an unhashed
// file is unclearable at the edge. That is the failure CLAUDE.md already records — "a tab left
// open across a tsc build runs the OLD player" — except at the CDN, where nobody can reload it.
//
//   hashed JS   immutable, one year. A new build changes the NAME, so there is nothing to bust.
//   index.html  must-revalidate. It is the file that names the hashes, so it is the whole
//               cache-invalidation mechanism; caching it caches the old app wholesale.
//   everything  30 days. Long enough to be worth it, short enough to recover from by waiting.
//   else        GMD-58 puts a version key in the pack manifest; those can go immutable after.
const headers = `# Generated by apps/web/build.mjs — do not edit by hand.
# Hashed filenames: safe to keep forever, because a rebuild changes the name.
/dist/*
  Cache-Control: public, max-age=31536000, immutable

/alphaTab.min.*.js
  Cache-Control: public, max-age=31536000, immutable

# The file that names every hash. Caching this caches the whole old app.
/index.html
  Cache-Control: public, max-age=0, must-revalidate

/
  Cache-Control: public, max-age=0, must-revalidate

# Unhashed and fetched by name at runtime, so NOT immutable — see GMD-58.
/Bravura.woff2
  Cache-Control: public, max-age=2592000
/Bravura.woff
  Cache-Control: public, max-age=2592000
/drumkit.webp
  Cache-Control: public, max-age=2592000
/drumkits/*
  Cache-Control: public, max-age=2592000
/instruments-gm/*
  Cache-Control: public, max-age=2592000
/instruments/*
  Cache-Control: public, max-age=2592000
/soundfont/*
  Cache-Control: public, max-age=2592000

# The app is same-origin and self-contained; it loads nothing from anywhere else.
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;
fs.writeFileSync(path.join(outDir, '_headers'), headers);

// ── verify: nothing ships unverified ──────────────────────────────────────────
// This is the check whose absence made GMD-56 possible. Two halves: every local reference the
// HTML makes, and every path the running code fetches without one.
const problems = [];

for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (ref.startsWith('#') || ref.startsWith('data:') || /^[a-z]+:\/\//i.test(ref)) continue;
  if (!fs.existsSync(path.join(outDir, ref))) problems.push('index.html references missing ' + ref);
}
for (const [p, why] of RUNTIME_FETCHED) {
  if (!fs.existsSync(path.join(outDir, p))) problems.push('missing ' + p + '  (fetched by ' + why + ')');
}
// A build that emits no JavaScript is exactly what shipped before; assert against it directly.
const jsCount = walk(outDir, outDir).filter(f => f.endsWith('.js')).length;
if (jsCount !== HASHED_SCRIPTS.length) {
  problems.push('expected ' + HASHED_SCRIPTS.length + ' .js files in the output, found ' + jsCount);
}

if (problems.length) {
  console.error('build: FAILED verification —');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

// ── report ────────────────────────────────────────────────────────────────────
const files = walk(outDir, outDir);
const sizeOf = (pred) => files.filter(pred)
  .reduce((a, f) => a + fs.statSync(path.join(outDir, f)).size, 0);
const mb = (b) => (b / 1048576).toFixed(2) + 'MB';

const shell = sizeOf(f => f.endsWith('.js') || f.endsWith('.html') || f.startsWith('Bravura'));
console.log('build: ' + files.length + ' files, ' + mb(bytes) + ' total');
console.log('  shell (js/html/fonts, pre-compression) ' + mb(shell));
console.log('  drumkit.webp                           ' + mb(sizeOf(f => f === 'drumkit.webp')));
console.log('  soundfont/ (sonivox fallback)          ' + mb(sizeOf(f => f.startsWith('soundfont/'))));
console.log('  drumkits/  (FluidR3 drum pack)         ' + mb(sizeOf(f => f.startsWith('drumkits/'))));
console.log('  instruments-gm/ (FluidR3 melodic)      ' + mb(sizeOf(f => f.startsWith('instruments-gm/'))));
console.log('  instruments/ (CC0 SFZ presets)         ' + mb(sizeOf(f => f.startsWith('instruments/'))));
console.log('  -> ' + rel(outDir));
