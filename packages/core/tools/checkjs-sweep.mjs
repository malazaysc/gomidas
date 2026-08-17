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
// ── THE FAILURE MODE THIS FILE MUST NOT HAVE ────────────────────────────────────────────────
// A gate that reports "clean" because it checked NOTHING is worse than no gate: CI is green and
// the coverage is gone. Two review rounds found four separate ways to reach that state (a stale
// `files` entry, an empty `files` list, a syntax error, a killed tsc), all of which printed
// "clean" and exited 0. So this script never infers success from the absence of a bad diagnostic.
// It asserts the positive: tsc must report having PROCESSED every file the config names.
// `--listFiles` is what makes that checkable. Keep it that way.
//
// tsc's own exit code still cannot be the verdict: the inference noise makes it non-zero always.
//
// ⚠️ WHAT THIS GATE DOES *NOT* CATCH. It sees **bare identifiers** only. Cross-file calls in
// these files mostly go through `window.<name>`, and a missing property on `window` is TS2339 —
// 472 of those exist today as pure noise, so they cannot gate. Renaming a `window.gomidas*`
// entry point therefore passes a green sweep. GMD-67 was a bare identifier (`pb`), which is why
// this catches it. Do not read "sweep clean" as "every reference resolves".

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

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
 * Pull the `files` list out of `tsc --showConfig` output.
 *
 * The config is JSONC — block comments and trailing commas are legal and `JSON.parse` rejects
 * both — so asking tsc to resolve it is better than parsing it here. It also removes the gap
 * between "what this script validated" and "what tsc will actually compile": the list checked
 * below is tsc's own. (A hand-rolled stripper was tried first. It mishandled trailing comments,
 * and the regex documenting it contained a comment terminator, which broke the whole file.
 * TypeScript 7's package exposes no compiler API to fall back on — only `version`.)
 */
export function parseResolvedConfig(showConfigOutput) {
  let config
  try {
    config = JSON.parse(showConfigOutput)
  } catch {
    throw new Error(`tsc --showConfig did not return JSON:\n${String(showConfigOutput).trim()}`)
  }
  const files = config?.files
  // An empty or absent list is not "nothing to check" — it is a broken gate. tsc answers an empty
  // list with TS18002, a 5-digit code that matches none of the FATAL patterns, so before this
  // guard `"files": []` swept zero files and reported clean.
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('"files" is missing or empty — the sweep would check nothing')
  }
  return files
}

/** The `files` entries that are missing from disk. */
export function missingFiles(files, root) {
  return files.filter((f) => !existsSync(resolve(root, f)))
}

/**
 * The `files` entries tsc did NOT report processing.
 *
 * This is the positive assertion the header describes: `--listFiles` makes tsc name every file it
 * actually pulled in, so "did the sweep check what it claims" stops being an inference from which
 * error codes happened to appear.
 */
export function unprocessedFiles(files, listOutput, root) {
  const listed = new Set(
    String(listOutput)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.includes('error TS'))
      .map((l) => resolve(l)),
  )
  return files.filter((f) => !listed.has(resolve(root, f)))
}

function die(message, detail) {
  console.error(`[sweep] ${message}`)
  if (detail) console.error(detail)
  process.exit(2)
}

function main() {
  // The local tsc — the same compiler the build uses. Never `npx tsc`, which downloads an
  // unpinned compiler when none is installed (GMD-63).
  const tsc = join(pkgRoot, 'node_modules', '.bin', 'tsc')
  const spawnTsc = (args) => spawnSync(tsc, args, { cwd: pkgRoot, encoding: 'utf8' })

  const shown = spawnTsc(['-p', SWEEP_CONFIG, '--showConfig'])
  if (shown.error) {
    die(
      `could not run tsc at ${tsc}: ${shown.error.message}`,
      '        run `pnpm install` at the workspace root first.',
    )
  }
  let files
  try {
    files = parseResolvedConfig(shown.stdout ?? '')
  } catch (err) {
    die(`could not resolve ${SWEEP_CONFIG}: ${err.message}`)
  }

  // A file renamed .js -> .ts (the migration ratchet tsconfig.json describes) leaves a stale
  // entry here. Caught before tsc runs so the message names the actual problem.
  const missing = missingFiles(files, pkgRoot)
  if (missing.length) {
    die(
      `${SWEEP_CONFIG} names ${missing.length} file(s) that do not exist:\n\n` +
        missing.map((f) => `  ${f}`).join('\n'),
      `
        The sweep cannot check a file that is not there. If it was renamed (.js -> .ts, say),
        update the "files" list — a .ts file is already covered by the main build's typecheck.
        If it was deleted, drop the entry. Do not leave it: a stale name is silent coverage loss.`,
    )
  }

  // --listFiles: what makes the coverage assertion below possible.
  // --pretty false: this parses tsc's text, so ANSI colour codes and the boxed layout must stay
  //   off. It is off by default when stdout is a pipe, but not if someone sets "pretty": true.
  const run = spawnTsc(['-p', SWEEP_CONFIG, '--listFiles', '--pretty', 'false'])

  if (run.error) {
    die(`could not run tsc at ${tsc}: ${run.error.message}`)
  }
  // A SIGKILLed child (an OOM on a CI runner, say) returns error undefined, status null and
  // truncated output — which sailed straight past the guard above into the "clean" branch.
  if (run.signal) {
    die(`tsc was killed by ${run.signal} — nothing was verified.`)
  }

  // Joined with a newline, not concatenated: if stdout does not end in one, its last line and
  // stderr's first would fuse and the pair would be classified as a single diagnostic.
  const output = [run.stdout ?? '', run.stderr ?? ''].join('\n')

  const unswept = unprocessedFiles(files, output, pkgRoot)
  if (unswept.length) {
    die(
      `tsc did not process ${unswept.length} of the ${files.length} file(s) it was given:\n\n` +
        unswept.map((f) => `  ${f}`).join('\n'),
      `
        The sweep only means something if it read every file. Something is wrong with
        ${SWEEP_CONFIG} or with the tsc invocation — do not treat this as a pass.`,
    )
  }

  const fatal = classifySweepOutput(output)

  if (fatal.length === 0) {
    console.log(`[sweep] clean — ${files.length} files checked, no undefined references.`)
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

// Run only when invoked directly, so the helpers above can be imported by the tests. realpath on
// both sides: resolve() does not follow symlinks, so via a bin link the comparison would fail,
// main() would never run, and node would exit 0 — a silently green gate.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
