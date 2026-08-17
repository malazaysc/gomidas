// GMD-68 — the sweep's classifier and its coverage assertions ARE the gate.
//
// The failure mode being pinned down is specific: anything that lets the script print
// "[sweep] clean" and exit 0 without having checked the files. That is indistinguishable from a
// healthy run, and two review rounds found four separate routes to it — a stale `files` entry, an
// empty `files` list, a syntax error, and a killed tsc. Each has a test here.

import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  classifySweepOutput,
  parseResolvedConfig,
  missingFiles,
  unprocessedFiles,
} from '../tools/checkjs-sweep.mjs'

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
    // The high-count codes measured on this codebase: 510 + 472 + 221 + 88 + 72 + 24.
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

describe('parseResolvedConfig', () => {
  it('reads the files list out of tsc --showConfig output', () => {
    const shown = '{ "compilerOptions": { "checkJs": true }, "files": ["./app.js", "./x.js"] }'
    expect(parseResolvedConfig(shown)).toEqual(['./app.js', './x.js'])
  })

  it('rejects an empty files list rather than sweeping nothing', () => {
    // tsc answers `"files": []` with TS18002 — a 5-digit code no FATAL pattern matches — so
    // without this guard the sweep checked zero files and reported clean.
    expect(() => parseResolvedConfig('{ "files": [] }')).toThrow(/missing or empty/)
  })

  it('rejects a config with no files key at all', () => {
    expect(() => parseResolvedConfig('{ "include": ["**/*"] }')).toThrow(/missing or empty/)
  })

  it('rejects non-JSON — i.e. tsc reported an error instead of a config', () => {
    expect(() => parseResolvedConfig("error TS5083: Cannot read file 'nope.json'.")).toThrow(
      /did not return JSON/,
    )
  })
})

describe('missingFiles', () => {
  it('catches a stale entry left behind by a .js -> .ts migration', () => {
    expect(missingFiles(['app.js', 'fretboard-renamed-away.js'], pkgRoot)).toEqual([
      'fretboard-renamed-away.js',
    ])
  })
})

describe('unprocessedFiles', () => {
  const listed = [resolve(pkgRoot, 'app.js'), resolve(pkgRoot, 'editor.js')].join('\n')

  it('is satisfied when tsc listed every file it was given', () => {
    expect(unprocessedFiles(['app.js', 'editor.js'], listed, pkgRoot)).toEqual([])
  })

  it('catches a file tsc never processed — the sweep did not cover what it claims', () => {
    expect(unprocessedFiles(['app.js', 'grooves.js'], listed, pkgRoot)).toEqual(['grooves.js'])
  })

  it('does not count a diagnostic line as a processed file', () => {
    const withError = `${listed}\napp.js(1,1): error TS2304: Cannot find name 'x'.`
    expect(unprocessedFiles(['app.js', 'editor.js'], withError, pkgRoot)).toEqual([])
    expect(unprocessedFiles(['grooves.js'], withError, pkgRoot)).toEqual(['grooves.js'])
  })

  it('treats truncated output (a killed tsc) as coverage loss, not success', () => {
    expect(unprocessedFiles(['app.js', 'editor.js'], '', pkgRoot)).toEqual(['app.js', 'editor.js'])
  })
})
