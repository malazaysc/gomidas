# Gomidas — Testing Strategy

_Status doc. Written 2026-07-01. Companion to [`STATUS.md`](./STATUS.md) (verification debt)
and [`SFZ_TEST_CHECKLIST.md`](./SFZ_TEST_CHECKLIST.md) (manual SFZ pass)._

## Running the tests

```bash
# Web layer — pure logic (fast, no native build). 62 tests.
cd web && npm ci && npm test          # or: npm run test:watch

# Native audio-path smoke tests (sfizz SFZ load + render) via ctest.
cmake -B build -DGOMIDAS_BUILD_TESTS=ON
cmake --build build --target gomidas_tests    # builds all test executables
ctest --test-dir build --output-on-failure
```

Both run in CI on every push / PR (`.github/workflows/ci.yml`): a fast `web-tests` job
(Vitest, Ubuntu) and a `native-tests` job (ctest, macOS).

## Progress (2026-07-01)

- ✅ **P1 — pure JS unit tests (Vitest).** Pure logic extracted to `web/core/gomidas-core.js`;
  `app.js` / `editor.js` now **delegate** to it (one implementation, no drift). **105 tests**.
  Extracted: tick & bar math, dynamics/octave/swing, pitch-bend emission, beat-lane grid, mixer
  gain/pan, the `.gomidas` envelope, **articulation note-shaping** (`shapeNote`), **repeat/D.C./D.S.
  unrolling** (`computePlaybackOrder`), crescendo hairpins, the free-channel picker, and the whole
  **model→MIDI walk** (`buildSequence`).
- ✅ **P2 — import→MIDI golden tests.** `buildSequence` (the full playback walk) is extracted and
  covered two ways: 12 integration tests over hand-built plain-object scores (notes, rests,
  dead-note shaping, ties, swing, repeats, percussion + drum-gains, metronome), **plus** golden
  snapshots that parse **real alphaTex with the real alphaTab engine in Node** (`@coderline/alphatab`
  dev-dep, pinned to the embedded 1.8.3) → `buildSequence` → committed snapshot
  (`web/tests/__snapshots__`). The latter also catches drift between our assumed model shape and
  alphaTab's. _Optional extension:_ add binary `.gp` fixtures (alphaTex already exercises the walk;
  `.gp` would additionally cover the GP binary parser).
- 🟡 **P3 — C++ `ctest` + CI.** Three native smoke tests in `ctest`, all green in CI: `sfz_smoketest`
  (SFZ path — classical guitar, electric bass) and `sf_smoketest` (**TinySoundFont / SoundFontSynth**
  — the default GM MIDI path every track uses; loads the bundled `sonivox.sf2`, renders a note,
  asserts non-silent). _Caught a real gap: the bass renders silent at middle C (samples top out
  ~key 46) — the test now plays E2._ Still TODO: per-channel **EQ**-finite and **TSF↔SFZ routing**
  cases (need a test framework linked against `AudioEngine`, deferred with P4).
- ⬜ **P4 / P5** — not started (see below).

## Where we are

| Layer | What exists | Gap |
| --- | --- | --- |
| C++ audio | `tests/sfz_smoketest.cpp` — hand-run `main()`, asserts SFZ render RMS > 1e-4 (`-DGOMIDAS_BUILD_TESTS=ON`) | Not under a framework/`ctest`; no CI; only covers SFZ, not TSF/EQ/routing/`Sequence` |
| C++ engine/threading | — | `Sequence` swap, per-channel EQ, TSF↔SFZ `activeMask` routing, SpinLock hand-offs all untested |
| JS logic (~270 KB) | — | `app.js` (model→MIDI, mixer, bend emission, save/load envelope), `editor.js` (cursor/nav/bar-capacity/beat-lane), `fretboard.js` (drums/grooves) — **zero tests, no `package.json`** |
| Import / round-trip | — | GP3–GP8 → MIDI, `.gp` export round-trip: manual/ear only |
| Runtime verification | `SFZ_TEST_CHECKLIST.md` (manual) | Live input, VST insert, recording, in-app SFZ→speakers: never runtime-verified |

**The problem in one line:** coverage maps almost inversely to risk. The densest, most
bug-prone logic (JS tick/model math, C++ audio graph) has the least coverage, and the
[`STATUS.md`](./STATUS.md) "verification debt" cluster has none.

Guiding principle: **prioritize by leverage, not coverage %.** Target the classes of bug that
are (a) likely and (b) miserable to catch by ear — off-by-one tick math, wrong-channel routing,
silent event drops.

---

## Priority 1 — Extract + unit-test the pure JS logic (Vitest) ✅ DONE

Highest ROI. The tick/capacity/model→MIDI functions are already pure — they just wear browser
clothing (`window`, `alphaTab`, JUCE bridge globals). Appetite for refactoring is confirmed, so:

**Shipped:** `web/core/gomidas-core.js` (dual-mode: `window.GomidasCore` in the browser,
`module.exports` under Node) holds the pure functions below; `web/index.html` loads it first and
`app.js` / `editor.js` delegate to it. Tests: `web/tests/*.test.js` (62 tests). The list below is
what actually got extracted:
- ticks: `beatTicks`/`beatTicksRaw`, `masterBarTicks`, `barCapacityTicks`, `barFilledTicks`, `barIsFull`
- dynamics/octave/swing: `dynamicsToVelocity`, `ottavaSemitones`, `swungTickInBar`
- bend: `bendValueToSemitones`, `semitonesToWheel`, `emitBendEvents` (reset-to-centre ordering)
- beat-lane: `laneBeatK`
- mixer: `anyTrackSoloed`, `computeChannelMix` (solo-overrides-mute + vol/pan precedence)
- envelope: `buildEnvelope`, `parseEnvelope` (versioned + legacy raw-score fallback, never throws)

_Original plan (for reference):_

**Refactor shape.** For each target, split the pure core from the DOM/bridge shell:
- New `web/core/` (or `web/lib/`) ES modules exporting pure functions: `(data) => data`, no
  `window`/`document`/`alphaTab` singletons touched.
- Existing files import from `web/core/` and keep the glue (event wiring, bridge calls, rendering).
- Modules must be importable in Node with no browser globals.

**First extraction targets (pure, high-value):**
- `editor.js`: `barCapacityTicks`, `barFilledTicks`, capacity-aware beat-insertion decision
  (full bar → flows to next), `laneBeatK` / beat-lane column math (`renderBeatLane`'s time model).
- `app.js`: the self-computed tick walk (model → flat MIDI event list), `emitBendEvents`
  (bendPoints → kind-1 pitch-bend events + centre-reset tick ordering), the `.gomidas` envelope
  wrap/unwrap (`saveProject` / `gomidasLoadProject`, incl. legacy raw-score fallback),
  `applyMixer` gain/pan computation (vol × mute/solo → per-channel gain).

**Harness:** [Vitest](https://vitest.dev) — runs ESM directly, no bundler/build step. Add a
minimal `web/package.json` (`"type": "module"`, `vitest` devDep) + `npm test`.

**What to assert:** exact tick boundaries, that a full bar overflows correctly, bend centre-reset
sorts *before* the next note-on, envelope round-trips (save→load identity), mixer solo overrides
mute. These are the silent-corruption bugs.

Est: a few days. No C++ build needed — decouples JS testing from the slow native build entirely.

---

## Priority 2 — Import → MIDI golden-file tests

Locks down the single most important behavior: *does this tab produce the right notes?* Directly
attacks the `.gp` round-trip verification debt.

- alphaTab runs in Node → load a handful of `.gp3`–`.gp8` fixtures headlessly, run the same
  model→flat-MIDI-event walk extracted in Priority 1, snapshot the event list
  (tick, channel, note, velocity, kind) as golden files.
- Every future parser/emitter change becomes a visible diff instead of a silent playback shift.
- Extend to `.gp` **export round-trip**: import → `Gp7Exporter` → re-import → assert event-list
  equality (or a documented, intentional diff).

Keep fixtures small (2–4 bars, one per format + one multi-track + one drum track). Store expected
outputs in-repo. Run under the same Vitest command.

---

## Priority 3 — Promote the C++ smoke test to a real suite + CI 🟡 PARTIAL

**Shipped:** `sfz_smoketest` is wired into `ctest` (two cases: classical guitar @ middle C,
electric bass @ E2) and `.github/workflows/ci.yml` runs it on macOS alongside the web tests.
Still TODO: the `SoundFontSynth` / EQ-finite / TSF↔SFZ-routing / `Sequence`-ordering cases below
(they need a test framework linked against the app's own sources — deferred to keep the
pre-release build stable). _Original plan:_

- Move `sfz_smoketest` under **`ctest`**. Framework: JUCE bundles `UnitTestRunner`, or add
  **Catch2** via `FetchContent` (already used for sfizz/JUCE — no new tooling burden).
- New cases:
  - `SoundFontSynth` renders non-silent for a GM note (TSF path, mirror of the SFZ smoke test).
  - Per-channel EQ output stays **finite** and bounded for extreme ±12 dB settings (guards the
    hand-rolled DF-II biquads).
  - TSF↔SFZ routing: given an `activeMask`, the render loop selects the right synth per channel.
  - `Sequence` build/swap produces the expected event ordering (feed known edits, inspect result).
- **CI:** GitHub Actions macOS runner → configure with `-DGOMIDAS_BUILD_TESTS=ON`, build,
  `ctest`. Right now nothing stops a broken build landing on `main`. Even build-only CI is a win;
  add `ctest` once cases exist. (First run fetches JUCE 8 — cache the `build/_deps` dir.)

Note: functional tests here won't catch the **real-time-safety** bugs (audio-thread alloc/free
under SpinLock — the milestone-1 caveat). Those need TSan/manual audit, tracked separately as
tech debt, not unit tests.

---

## Priority 4 — Offline-render engine harness (converts manual checklist → repeatable)

The live-input/VST/recording paths "build but were never run." Replace as much of the manual
checklist as possible with a deterministic offline render:

- Small tool: feed a known `Sequence` through `AudioEngine`, render N blocks to a WAV buffer,
  assert RMS/peak + expected note-onset positions (energy appears at the right ticks).
- Covers the engine graph (transport → scheduler → synth → EQ → mix → master) deterministically.
- Does **not** cover: physical mic capture, VST plugin-editor window, keyboard delivery in the
  packaged app. Those stay manual (`SFZ_TEST_CHECKLIST.md` style) — document the boundary so a
  green suite isn't mistaken for full coverage.

---

## Priority 5 (later) — One end-to-end app smoke test

Launch the JUCE standalone, load a sample, hit play, confirm audio out. High maintenance; defer
until the cheaper layers exist and prove their worth.

---

## Recommended order

1. **Vitest on extracted pure JS** (Priority 1) — days, no native build, biggest silent-bug payoff.
2. **Import→MIDI golden files** (Priority 2) — reuses P1's extracted walk; locks the core behavior.
3. **C++ `ctest` + macOS CI** (Priority 3) — makes 1 & 2 actually gate merges.
4. **Offline-render harness** (Priority 4) — pays down the runtime-verification debt.
5. **E2E smoke** (Priority 5) — last.

## Explicit non-goals / boundaries

- Not chasing coverage %. Targeting bug *classes*, not lines.
- RT-safety hardening is **audit/TSan work, not unit tests** — don't expect the suite to catch it.
- Physical mic / plugin-editor-window / packaged-app keyboard delivery stay manual; keep that
  boundary written down so green ≠ "everything verified."
