# Gomidas — Status Snapshot (Feature Map vs. Roadmap)

Bird's-eye view of where the product stands. Granular detail lives in
[`FEATURES.md`](./FEATURES.md) (what's implemented) and [`BACKLOG.md`](./BACKLOG.md)
(what's not). This file is the "one screen" summary — keep it current with those two.

_Last reviewed: 2026-06-30._

---

## Roadmap phases

| Phase | Goal | Status |
| --- | --- | --- |
| **Phase 1** | Tab editor + MIDI playback | ✅ **DONE** |
| **Phase 2** | Play on top (mixer, live input, VST insert, recording) | ✅ **DONE** except depth items; ⚠️ live-input / plugin / recording stack **builds + links but is UNVERIFIED at runtime** |
| **Realistic Sound** | RSE-equivalent: bundled SFZ default (A) → per-track VST (B) | 🟡 **Phase A mostly done**; Phase B (per-track VST instruments) **not started** |
| **Phase 3** | `.gp` export ✅ · stem-sync ❌ | 🟡 export done (round-trip unverified); stem-sync pending |

---

## ✅ Done — by area

**Editor core (Phase 1 — complete)**
- Load/render GP3–GP8 + MusicXML; tab + notation
- New (setup dialog) / Open / Save (`.gomidas`) / Open Recent / unsaved-changes guard
- Note / duration / beat / bar editing; capacity-aware beat insertion; bar-fill indicator
- Multi-track + add/delete track; voices 1–4
- Selection (incl. mouse-drag + cross-track block), copy/cut/paste
- Time/key sig, repeats (with playback loops), tuplets (incl. spanning), triplet-feel swing
- Undo/redo
- Full GP8 effect set (most notation; many with real MIDI shaping)
- Bends → **MIDI pitch-bend emitted**; D.C./D.S. jumps drive playback
- Drums: 17-piece kit, KIT VIEW / GROOVE EDITOR / MIXER, pattern library, keyboard entry

**Playback / transport (Phase 2)**
- Native clock (960 PPQ), starts from edit cursor, resumes from play position
- Per-track mixer: vol/pan/mute/solo (live), persisted
- Per-track + master 3-band EQ (per-channel buses), persisted
- A/B loop, metronome, count-in, practice slow-down (pitch-independent), panic
- Live input monitor + VST3/AU insert + plugin editor window ⚠️ unverified
- Input gain, output VU meter, WAV recording

**Realistic sound (Phase A — mostly done)**
- Per-track **SFZ via sfizz** through the EQ→mix bus
- Bundled CC0 presets (Classical Guitar, Electric Bass); custom `.sfz` load
- Persisted in `.gomidas` envelope
- Audio path verified by `tests/sfz_smoketest` (guitar+bass PASS)

**UI / app**
- GP8-style dark layout, SVG icon set, native macOS menu bar
- Track timeline (bar squares), inspector (TRACK/SONG live)
- Time-grid tab view (piano-roll-for-tabs) + collapsible per-panel drawers
- Full view, zoom, custom-tunings editor

**Export**
- `.gp` export via `Gp7Exporter` (round-trip needs verification)

---

## ⚠️ Verification debt (highest-risk — blocks building further)

These paths are **written and compile, but were never confirmed at runtime**. They gate
downstream work (especially Realistic Sound Phase B, which reuses the live-input host).

- Live-input / VST-plugin-insert / recording stack — never runtime-verified
- In-app SFZ routing → speakers — ear-check only (`sfz_smoketest` passes; the GUI
  inspector→engine→speakers path is not)
- `.gp` export round-trip — export, then reopen in Gomidas / Guitar Pro
- Physical-keyboard delivery in the packaged app (synthetic keys are blocked in the sandbox)

See [`SFZ_TEST_CHECKLIST.md`](./SFZ_TEST_CHECKLIST.md) for the SFZ manual pass, and
[`TESTING.md`](./TESTING.md) for the automated-test strategy. **Now in place:** 62 Vitest unit
tests over the extracted pure editor/model logic (`web/core/gomidas-core.js`) + `ctest` SFZ
audio-path smoke tests (guitar + bass), both run in CI (`.github/workflows/ci.yml`).

---

## ❌ / 🟡 Not done — the real backlog

**Realistic Sound — Phase B (per-track VST instruments; roadmap priority #2) — not started**
- `VstInstrument : TrackInstrument`, N plugin-editor windows, plugin state save, sound-source picker
- Gated on verifying the live-input host first

**Realistic Sound — Phase C (articulation realism)**
- Pitch-bend ramps for **slides** (bends already done), keyswitch emission for palm-mute/harmonic/dead
- Drum-kit SFZ preset (needs download-on-first-run mechanism)

**Effects with notation-only MIDI (🟡 — look right, play plain)**
- Slides, harmonics, vibrato, brush/arpeggio, tremolo, trill, grace, slap, fades, wah, tap, etc.

**Editing-parity gaps**
- Spanning triplet groups (per-beat only); vertical `⇧↑↓` selection; bar-reflow on overfull paste
- Alternate endings / Coda playback order; multirest
- Interpretation controls (palm-mute / accentuation / auto-let-ring — still placeholders)

**Known bugs / UX**
- Drum KIT VIEW hotspot circles misaligned (aspect-ratio letterboxing)
- Tuner (deferred; real-instrument scope)

**Phase 3**
- Stem separation → sync real recordings to tabs (reuse Conduit `build-stems`)

**Tech debt**
- Real-time-safety hardening (audio-thread alloc/free under SpinLock — milestone-1 caveat)
- Confirm edit lag gone on large imported `.gp` (partial-render fallback ready if not)

---

**The honest read:** breadth is essentially complete through Phase 2 — the gating risk isn't
*missing* features, it's a **cluster of unverified runtime paths** (live input, VST insert,
recording, in-app SFZ, `.gp` round-trip). Phase B (per-track VST instruments) is the next
net-new roadmap item, but it explicitly depends on verifying the live-input host first.
