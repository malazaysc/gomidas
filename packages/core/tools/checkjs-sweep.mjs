#!/usr/bin/env node
// Gomidas — dangling-reference sweep (GMD-68).
//
// WHY THIS EXISTS: app.js, editor.js, fretboard.js, grooves.js and core/gomidas-core.js load as
// plain <script> globals, and the main tsconfig sets `checkJs: false` on purpose — turning it on
// would bury the build in ~1400 inference diagnostics from 5,700 lines of un-migrated JavaScript.
// The cost of that ratchet is that a reference to something which does not exist is invisible
// until the line happens to run.
//
// It has already shipped once. GMD-54 removed `const pb = t.playbackInfo` and left `pb.program`
// two lines below; `previewBeat()` runs LAST in `setFret`, so the edit still committed and the
// app looked fine while every note audition threw. Clicking a fret was silent on BOTH products
// for a day.
//
// tsc finds it — but its exit code cannot be the gate, because the inference noise above makes
// it non-zero always. So: run the sweep config, keep ONLY `TS2304` ("Cannot find name"), and
// decide the exit code from that. With the two real globals declared in types/globals.d.ts, any
// surviving TS2304 is a reference to a name that exists nowhere.
//
// Deliberately narrow. TS2339 ("property does not exist") and the TS7xxx implicit-any family are
// inference noise on untyped JavaScript, not bugs. TS2552 ("did you mean…") does not occur in
// this codebase — measured, currently zero — so TS2304 is the only clean signal available.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The local tsc — the same compiler the build uses. Never `npx tsc`, which downloads an unpinned
// compiler when none is installed (GMD-63).
const tsc = join(pkgRoot, 'node_modules', '.bin', 'tsc')

const run = spawnSync(tsc, ['-p', 'tsconfig.sweep.json'], {
  cwd: pkgRoot,
  encoding: 'utf8',
})

if (run.error) {
  console.error(`[sweep] could not run tsc at ${tsc}: ${run.error.message}`)
  console.error('[sweep] run `pnpm install` at the workspace root first.')
  process.exit(2)
}

// tsc reports diagnostics on stdout; keep stderr in view in case it dies for another reason.
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
const dangling = output.split('\n').filter((line) => line.includes('error TS2304'))

if (dangling.length === 0) {
  console.log('[sweep] clean — no undefined references in the plain-JS editor files.')
  process.exit(0)
}

console.error(`[sweep] ${dangling.length} undefined reference(s):\n`)
for (const line of dangling) console.error(`  ${line.trim()}`)
console.error(`
[sweep] Each line above names something that exists nowhere — a typo, or a variable that was
        removed while a use of it was left behind (that is exactly GMD-67, which made every note
        audition throw for a day). These files have no other typecheck, so this is the only thing
        standing between that class of bug and a release.

        If the name IS a legitimate global declared by another <script> tag, declare it in
        packages/core/types/globals.d.ts — do not delete the check.`)
process.exit(1)
