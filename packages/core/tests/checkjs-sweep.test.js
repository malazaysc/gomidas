// GMD-68 — the sweep's classifier is what the gate actually IS.
//
// The failure mode this pins down is specific: a diagnostic that should fail but isn't matched
// prints "[sweep] clean" and exits 0, which is indistinguishable from a healthy run. The first
// version of this script shipped exactly that — it keyed off `error TS2304` alone, so a stale
// entry in the sweep config (TS6053) or a syntax error (TS1xxx) reported clean while checking
// less than it claimed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classifySweepOutput, missingSweepFiles } from '../tools/checkjs-sweep.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('classifySweepOutput', () => {
  it('fails on TS2304 — the plain undefined reference (GMD-67)', () => {
    const out = classifySweepOutput("editor.js(933,21): error TS2304: Cannot find name 'pb'.")
    expect(out).toHaveLength(1)
    expect(out[0].why).toBe('undefined reference')
  })

  it('fails on TS2552 — a typo of a name that IS in scope', () => {
    // tsc emits this INSTEAD of TS2304 when a similar name exists, so a filter that only knows
    // TS2304 misses the likeliest dangling reference of all.
    const out = classifySweepOutput(
      "grooves.js(12,5): error TS2552: Cannot find name 'EIGHTH'. Did you mean 'EIGHTHS'?",
    )
    expect(out).toHaveLength(1)
  })

  it('fails on a config/host error, which means the sweep did not check what it claims', () => {
    const out = classifySweepOutput("error TS6053: File 'fretboard.js' not found.")
    expect(out).toHaveLength(1)
    expect(out[0].why).toMatch(/did not check/)
  })

  it('fails on a syntax error', () => {
    const out = classifySweepOutput("app.js(10,3): error TS1005: ')' expected.")
    expect(out).toHaveLength(1)
  })

  it('ignores the inference noise that made checkJs unusable in the main build', () => {
    // These are the high-count codes measured on this codebase: 510 + 472 + 221 + 88 + 72 + 24.
    const noise = [
      "app.js(1,1): error TS7006: Parameter 'e' implicitly has an 'any' type.",
      "app.js(2,1): error TS2339: Property 'gomidasFoo' does not exist on type 'Window'.",
      "app.js(3,1): error TS7005: Variable 'x' implicitly has an 'any[]' type.",
      "app.js(4,1): error TS18047: 'el' is possibly 'null'.",
      "app.js(5,1): error TS2531: Object is possibly 'null'.",
      "app.js(6,1): error TS2551: Property 'lenght' does not exist. Did you mean 'length'?",
    ].join('\n')
    expect(classifySweepOutput(noise)).toEqual([])
  })

  it('does not mistake 5-digit codes for the 4-digit families it gates on', () => {
    // TS18047 starts with "1" but must not match the TS1xxx syntax-error family.
    expect(classifySweepOutput("a.js(1,1): error TS18047: 'x' is possibly 'null'.")).toEqual([])
  })

  it('reports every fatal line, not just the first', () => {
    const out = classifySweepOutput(
      [
        "editor.js(1,1): error TS2304: Cannot find name 'pb'.",
        "app.js(2,2): error TS2304: Cannot find name 'nope'.",
      ].join('\n'),
    )
    expect(out).toHaveLength(2)
  })

  it('is clean on empty output', () => {
    expect(classifySweepOutput('')).toEqual([])
  })
})

describe('missingSweepFiles', () => {
  it('accepts the real sweep config — every file it names exists', () => {
    const cfg = readFileSync(join(pkgRoot, 'tsconfig.sweep.json'), 'utf8')
    expect(missingSweepFiles(cfg, pkgRoot)).toEqual([])
  })

  it('catches a stale entry left behind by a .js -> .ts migration', () => {
    const cfg = '{\n // leading comment\n "files": ["app.js", "fretboard-renamed-away.js"] }'
    expect(missingSweepFiles(cfg, pkgRoot)).toEqual(['fretboard-renamed-away.js'])
  })

  it('tolerates a TRAILING comment — tsconfig allows them, JSON.parse does not', () => {
    const cfg = '{ // trailing on an open brace\n "files": ["app.js"] // and here\n }'
    expect(missingSweepFiles(cfg, pkgRoot)).toEqual([])
  })

  it('does not treat a // inside a string value as a comment', () => {
    const cfg = '{ "files": ["nested//path.js"] }'
    expect(missingSweepFiles(cfg, pkgRoot)).toEqual(['nested//path.js'])
  })
})
