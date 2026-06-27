# Gomidas — Backlog

Not-yet-implemented features, prioritised. Implemented items live in [`FEATURES.md`](./FEATURES.md).
Keyboard targets follow GP8 (`references/gp8-keyboard-shortcuts.md`) unless a divergence is noted.
Check an item off and move it to `FEATURES.md` when it ships.

Priority: **P1** core editing parity · **P2** expressive effects · **P3** app/UX polish · **Phase 2/3** product roadmap.

---

## Reported issues (user, 2026-06-26) — FIXED 2026-06-26
All seven shipped; see [`FEATURES.md`](./FEATURES.md). Summary of what landed:
- [x] **Loaded file tempo** — `scoreLoaded` reads `score.tempo` → `setTempo` + tempo field.
- [x] **Mixer** — per-channel linear gain in `AudioEngine` (`setChannelMix` → `tsf_channel_set_volume/pan`),
  applied on the audio thread; track-list volume slider wired (`applyMixer`).
- [x] **Solo / Mute** — now live via channel gain (mute = gain 0; solo silences non-soloed); instant during playback.
- [x] **Eye (show/hide)** — toggles the track in the multi-track view; reconciled with single-track focus
  via an explicit `viewMode` (`single` = focused row, `multi` = all non-hidden). Hide ≠ mute.
- [x] **New discards file silently** — dirty flag (`isDirty`) + discard-confirm modal before New / Open / Sample.
- [x] **New setup dialog** — GP8-style modal (title, tempo, time signature, add/remove tracks + tuning presets).
- [x] **Inspector wired** — editable track name, notation toggles, tuning picker, GM sound picker, SONG title/tempo.

Remaining inspector polish (small):
- [ ] **Interpretation controls** — Playing style / Palm-mute / Accentuation / Auto let-ring / Auto brush are
  still visual placeholders (no clean alphaTab track-level hook). Wire when the playback model supports it.
- [ ] **Per-track pan control** — engine supports pan (`setChannelMix` pan arg); add a UI control (slider/knob).

---

## P1 — Core editing parity
Note effects (per current string / note):
- [ ] Legato / slur — GP `⇧H`; shift slide — GP `⌥S`; pick slides
- [ ] Bend — GP `B` (needs a bend editor UI)
- [ ] Legato MIDI for hammer/pull + pitch-bend MIDI for slides + harmonic/vibrato MIDI (notation already renders)

Rhythm:
- [ ] Other tuplets (5, 6, 7, 9) — generalise `toggleTriplet`
- [ ] Triplet feel — GP `⌘/`
- [ ] Spanning tuplet groups (apply across a selection, GP-style) — current triplet is per-beat

Bars / structure:
- [ ] Delete track — GP `⌥⌘R`
- [ ] Time signature — GP `⌘T`
- [ ] Key signature — GP `⌘K`

Voices & selection:
- [ ] Voices 1–4 — GP `⌘1`–`⌘4`; multivoice edition — GP `⌘M`
- [ ] Select all — GP `⌘A`; select beat / range — GP `⇧↑↓` / `⇧→←`
- [ ] Copy / cut / paste — GP `⌘C` / `⌘X` / `⌘V`; copy last beat — GP `C`
- [ ] Cursor: beginning/end of bar — GP `Home`/`End`; first/last bar — GP `⌘Home`/`⌘End`
- [ ] Move cursor to next/previous staff — GP `Tab` / `⇧Tab`

Drums:
- [ ] Keyboard drum entry (palette + playback done) — e.g. number/letter hotkeys per piece
- [ ] Expand palette to the full GM kit (splash, china, cowbell, etc.; currently 9 common pieces)

## P2 — Expressive effects
- [ ] Wide vibrato — GP `⌥W`; artificial harmonic — GP `⌥Y`
- [ ] Tremolo bar — GP `⌥V`; tremolo picking — GP `"`
- [ ] Trill — GP `N`
- [ ] Brush up/down — GP `⌘U`/`⌘D`; arpeggio up/down — GP `⇧⌘U`/`⇧⌘D`
- [ ] Grace notes (before / on beat) — GP `G` / `⌥G`
- [ ] Chord diagram — GP `A`; slap — GP `$`; pick stroke up/down — GP `⇧U`/`⇧D`
- [ ] Fade in / out — GP `<` / `>`; volume swell — GP `⌥<`/`⌥>`
- [ ] Wah open/close, rasgueado, left-hand tapping, tapping — GP `⌥O`/`⌥C`, `⇧R`, `(`, `)`
- [ ] Text — GP `T`; directions — GP `D`; fermata — GP `F`

## GP8 UI shell — wiring (layout shipped)
- [x] Track list mute / solo / show-hide; native menu bar (File/Edit/…)
- [x] Track list **volume** per row (per-channel gain in the engine: `AudioEngine::setChannelMix`)
- [x] Inspector: editable track name, tuning picker, sound/program selector; SONG tab (title + tempo)
- [ ] Inspector Interpretation: real Palm-mute / Accentuation / Auto-let-ring / Auto-brush controls (still placeholders)
- [ ] Transport: rewind/forward seek, count-in, metronome, loop, view-layout toggles
- [ ] Fill out the left palette toward GP's full icon set (clefs, key/time sig, more effects)

## P3 — App / UX polish
- [ ] Multitrack view toggle — GP `F3`
- [ ] Zoom in / out — GP `⌘>` / `⌘<`
- [ ] Go To (bar) — GP `⌘G`
- [ ] Repeats: open / close / multirest — GP `[` / `]` / `⌘R`
- [ ] Full screen, palettes, inspectors — GP `F11`, `F2`, `F5`/`F6`
- [ ] Print — GP `⌘P`
- [ ] Let ring: ring until the next note on the same string (currently a fixed ~4× sustain)

## Phase 2 — Play-on-top (the product's #1 priority)
- [ ] Per-track mixer: volume / pan / mute / solo
- [ ] A/B loop + count-in + metronome
- [ ] Tempo slow-down (independent of pitch)
- [ ] **Live input through a per-track VST/AU chain** + mix (re-enable `MICROPHONE_PERMISSION_ENABLED`)
- [ ] Record / loop the live input

## Phase 3 — Export & sync
- [ ] `.gp` export (alphaTab `Gp7Exporter`)
- [ ] Stem separation → sync real recordings to tabs (reuse Conduit `build-stems` / `StemSeparationService`), sync to the drum track

---

## Engineering / tech debt
- [ ] Confirm edit lag is gone on **large imported `.gp`**; if not, render only the active track during edits and/or a bar-window around the cursor (full render on idle). Diagnostic `slow render: …` log is wired in `editor.js onRenderFinished`.
- [ ] Harden real-time safety: TSF voice alloc + sequence swap can free/allocate on the audio thread (milestone-1 caveat in `CLAUDE.md`).
- [ ] Verify physical-keyboard delivery in the packaged app (synthetic keys are blocked in the sandbox).
