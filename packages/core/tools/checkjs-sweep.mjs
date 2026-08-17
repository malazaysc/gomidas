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
// tsc finds it — but its exit code cannot be the gate on its own, because the inference noise
// makes it non-zero always. So this script classifies the diagnostics itself.
//
// ⚠️ WHAT THIS GATE DOES *NOT* CATCH. It sees **bare identifiers** only. Cross-file calls in
// these files mostly go through `window.<name>`, and a missing property on `window` is TS2339 —
// 472 of those exist today as pure noise, so they cannot gate. Renaming a `window.gomidas*`
// entry point therefore passes a green sweep. GMD-67 was a bare identifier (`pb`), which is why
// this catches it. Do not read "sweep clean" as "every reference resolves".

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SWEEP_CONFIG = 'tsconfig.sweep.json'

// Diagnostics that FAIL the sweep. Everything not listed here is inference noise on untyped
// JavaScript (TS7006 ×510, TS2339 ×472, TS7005 ×221, TS18047 ×88 …) and must not gate.
//
// TS2552 matters as much as TS2304 and is easy to miss: tsc emits it *instead of* TS2304 when a
// similarly-spelled name is in scope — i.e. for a typo of a real identifier, the single likeliest
// dangling reference there is. It is zero in this codebase today, so including it costs no noise.
const FATAL = [
  [/error TS2304:/, 'undefined reference'],
  [/error TS2552:/, 'undefined reference (typo of a name that is in scope)'],
  [/error TS1\d{3}:/, 'syntax error'],
  [/error TS[56]\d{3}:/, 'sweep config/host error — the sweep did not check what it claims to'],
]

/**
 * Split tsc's output into the lines that must fail the sweep and everything else.
 *
 * Exported and unit-tested (tests/checkjs-sweep.test.js) because the whole value of this gate is
 * in which codes it treats as fatal — a silent misclassification here reads exactly like "clean".
 */
export function classifySweepOutput(output) {
  const fatal = []
  for (const line of String(output).split('\n')) {
    const hit = FATAL.find(([re]) => re.test(line))
    if (hit) fatal.push({ line: line.trim(), why: hit[1] })
  }
  return fatal
}

/**
 * Strip `//` line comments from a tsconfig, ignoring ones inside string literals.
 *
 * tsconfig allows comments and JSON.parse does not. Quote-aware rather than a regex because the
 * naive line-anchored version silently mishandles a TRAILING comment — and the failure lands in
 * the one helper whose entire job is noticing that the sweep is checking less than it claims.
 * (Writing that regex out here is what broke this file once: it contains a comment terminator.)
 */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += c
  }
  return out
}

/** The `files` entries of the sweep config that are missing from disk. */
export function missingSweepFiles(configText, root) {
  const files = JSON.parse(stripJsonComments(String(configText))).files ?? []
  return files.filter((f) => !existsSync(resolve(root, f)))
}

function main() {
  // A file renamed .js -> .ts (the migration ratchet tsconfig.json describes) leaves a stale
  // entry here. tsc reports TS6053 and checks the REST of the list happily — so without this,
  // the sweep would go on reporting "clean" while quietly covering one file fewer.
  let missing
  try {
    missing = missingSweepFiles(readFileSync(join(pkgRoot, SWEEP_CONFIG), 'utf8'), pkgRoot)
  } catch (err) {
    // Never fall through to "clean" here: if the config cannot be read, nothing was checked.
    console.error(`[sweep] could not read ${SWEEP_CONFIG}: ${err.message}`)
    process.exit(2)
  }
  if (missing.length) {
    console.error(`[sweep] ${SWEEP_CONFIG} names ${missing.length} file(s) that do not exist:\n`)
    for (const f of missing) console.error(`  ${f}`)
    console.error(`
[sweep] The sweep cannot check a file that is not there. If it was renamed (.js -> .ts, say),
        update the "files" list — a .ts file is already covered by the main build's typecheck.
        If it was deleted, drop the entry. Do not leave it: a stale name is silent coverage loss.`)
    process.exit(2)
  }

  // The local tsc — the same compiler the build uses. Never `npx tsc`, which downloads an
  // unpinned compiler when none is installed (GMD-63).
  const tsc = join(pkgRoot, 'node_modules', '.bin', 'tsc')
  const run = spawnSync(tsc, ['-p', SWEEP_CONFIG], { cwd: pkgRoot, encoding: 'utf8' })

  if (run.error) {
    console.error(`[sweep] could not run tsc at ${tsc}: ${run.error.message}`)
    console.error('[sweep] run `pnpm install` at the workspace root first.')
    process.exit(2)
  }

  // tsc reports diagnostics on stdout; keep stderr in view in case it dies for another reason.
  const fatal = classifySweepOutput(`${run.stdout ?? ''}${run.stderr ?? ''}`)

  if (fatal.length === 0) {
    console.log('[sweep] clean — no undefined references in the plain-JS editor files.')
    process.exit(0)
  }

  console.error(`[sweep] ${fatal.length} problem(s):\n`)
  for (const { line, why } of fatal) console.error(`  ${line}\n      ^ ${why}`)
  console.error(`
[sweep] An undefined reference names something that exists nowhere — a typo, or a variable that
        was removed while a use of it was left behind (that is exactly GMD-67, which made every
        note audition throw for a day). These files have no other typecheck, so this is the only
        thing standing between that class of bug and a release.

        If the name IS a legitimate global declared by another <script> tag, declare it in
        packages/core/types/globals.d.ts — do not delete the check.`)
  process.exit(1)
}

// Run only when invoked directly, so the classifier above can be imported by the tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
