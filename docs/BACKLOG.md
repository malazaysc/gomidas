# Gomidas — Backlog

Not-yet-implemented features, prioritised. Implemented items live in [`FEATURES.md`](./FEATURES.md).
Keyboard targets follow GP8 (`references/gp8-keyboard-shortcuts.md`) unless a divergence is noted.
Check an item off and move it to `FEATURES.md` when it ships.

Priority: **P1** core editing parity · **P2** expressive effects · **P3** app/UX polish · **Phase 2/3** product roadmap.

---

## Reported issues (user, 2026-06-27)
- [x] **Play started from bar 1, not the cursor** — `AudioEngine::stop()` rewinds `seekRequest` to 0 and
  nothing exposed `seekTicks` to JS. Added a native `seek` function; `togglePlay` now computes the cursor's
  tick (`gomidasSeekToCursor` → `tickForCursor`, mirroring `rebuildSequence`'s bar layout) and seeks there
  before play. Single-track view is exact; multi-track aligns to the bar.

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
- [x] **Per-track pan control** — inspector TRACK→Mixer pan slider (L/C/R label) → `gomidasTrackFlags[i].pan` → `applyMixer` → `setChannelMix`.

---

## P1 — Core editing parity
Note effects (per current string / note):
- [x] Shift slide — GP `⌥S` (Effects→Shift Slide); pick slides down/up (Effects menu). Legato/slur `⇧H` ≈ hammer/pull (`H`).
- [ ] Bend — GP `B` (needs a bend editor UI)
- [~] Legato MIDI for hammer/pull (done: hammered/pulled note plays softer, no re-pick) + **pitch-bend MIDI
  for slides + harmonic/vibrato MIDI still pending** (need native pitch-bend in `SoundFontSynth` + event format)

Rhythm:
- [x] Other tuplets (5, 6, 7, 9) — `setTuplet(n)` generalises `toggleTriplet` (Note menu + `gomidasMenu tuplet:N`)
- [~] Triplet feel — GP `⌘/` (notation: swing 8ths on the current bar onward; **MIDI doesn't swing yet**)
- [x] Spanning tuplet groups — `setTuplet`/`setDuration` now apply across the beat selection (`selectedBeats`);
  tuplet toggles off when every selected beat already has it. (Also: set duration across a selection.)

Bars / structure:
- [x] Delete track — GP `⌥⌘R` (Track→Delete Track; JSON round-trip, keeps ≥1 track)
- [x] Time signature — GP `⌘T` (modal; sets current bar onward; Bar→Time Signature)
- [x] Key signature — GP `⌘K` (modal, −7..+7 + major/minor; sets current bar onward; Bar→Key Signature)

Voices & selection:
- [x] Voices 1–4 — GP `⌘1`–`⌘4` (switches editing voice; lazily creates the voice as a whole-bar rest in
  every bar; Note menu Voice 1–4). All voices already render + play. Multivoice display toggle `⌘M` → backlog.
  Note: the play cursor + seek follow voice 0's tick map, so they're approximate when editing voice ≥ 2.
- [x] Select all — GP `⌘A`; select range — GP `⇧→←` (per-track, voice 0). Vertical `⇧↑↓` → backlog
- [x] Copy / cut / paste — GP `⌘C` / `⌘X` / `⌘V`; copy last beat — GP `C` (beat-range clipboard; paste inserts after cursor)
- [x] Cursor: beginning/end of bar — GP `Home`/`End`; first/last bar — GP `⌘Home`/`⌘End`
- [x] Move cursor to next/previous staff — GP `Tab` / `⇧Tab` (next/prev track)

Drums:
- [x] Keyboard drum entry — digits `1`–`9` toggle the matching kit piece on the current beat (pad labels show the hotkey); `0` rests
- [x] Expand palette toward the full GM kit (17 pieces: + splash, china, ride bell, HH pedal, side stick, hand clap, tambourine, cowbell). First 9 keep digit hotkeys.

## P2 — Expressive effects
> Shipped this pass are **notation-only** (MIDI playback unchanged) unless noted — same status as
> harmonic/vibrato/slide. Audible realism (tremolo repick, strum spread, fade envelopes) → MIDI backlog.
- [x] Wide vibrato — GP `⌥W` (menu: Effects→Wide Vibrato; ⌥-letter keys unreliable so menu-only)
- [x] Artificial harmonic — GP `⌥Y` (Effects→Artificial Harmonic) + pinch harmonic (Effects menu)
- [ ] Tremolo bar — GP `⌥V`
- [x] Tremolo picking — GP `"` (beat-level, 16th)
- [x] Trill — GP `N` (trills to fret+2)
- [x] Brush up/down — GP `⌘U`/`⌘D`; arpeggio up/down — GP `⇧⌘U`/`⇧⌘D`
- [x] Grace notes (before / on beat) — GP `G` / `⌥G` (on-beat is menu-only)
- [x] Chord diagram — GP `A` (name + optional fret shape via modal → `Staff.addChord` / `beat.chordId`;
  name always shows, diagram when frets given). Chord library picker / barre UI → future polish.
- [x] Slap — GP `$`; pop (Effects menu); pick stroke up/down — GP `⇧U`/`⇧D`
- [x] Fade in / out — GP `<` / `>`; volume swell — GP `⌥<`/`⌥>` (swell is menu-only)
- [ ] Wah open/close, rasgueado, left-hand tapping, tapping — GP `⌥O`/`⌥C`, `⇧R`, `(`, `)`
- [x] Text — GP `T`; directions — GP `D` (Section menu: Segno/Coda/Fine + Da Capo/Dal Segno jumps →
  `masterBar.directions`); fermata — GP `F`. **Jumps now drive playback**: `computePlaybackOrder` honours
  D.C. / D.C. al Fine / D.S. / D.S. al Fine (once, stopping at Fine). Coda variants + alternate endings still TODO.

## Transport extras (shipped)
- [x] Input-gain slider + output VU meter (peak via `AudioEngine::getOutputPeak`, pushed ~30 Hz while playing/monitoring)
- [x] Panic / all notes off (Sound menu → `AudioEngine::panic`)
- [x] Persist per-track volume/pan in `.gomidas` + `.gp` (folded into `playbackInfo` on save/export)

## GP8 UI shell — wiring (layout shipped)
- [x] Track list mute / solo / show-hide; native menu bar (File/Edit/…)
- [x] Track list **volume** per row (per-channel gain in the engine: `AudioEngine::setChannelMix`)
- [x] Inspector: editable track name, tuning picker, sound/program selector; SONG tab (title + tempo); **per-track pan** (Mixer section)
- [ ] Inspector Interpretation: real Palm-mute / Accentuation / Auto-let-ring / Auto-brush controls (still placeholders)
- [~] Transport: rewind/forward seek, **loop** (A/B `⌘L`) + **metronome** (`♩`) + **count-in** (`⏱`) + **practice speed** done; view-layout toggles pending
- [ ] Fill out the left palette toward GP's full icon set (clefs, key/time sig, more effects)

## P3 — App / UX polish
- [x] Multitrack view toggle — GP `F3` (flips focused single track ↔ full multi-track view; View menu too)
- [x] Zoom in / out — GP `⌘>` / `⌘<` (keyboard; transport buttons already existed)
- [x] Go To (bar) — GP `⌘G` (modal → `GomidasEditor.goToBar`; View→Go To Bar)
- [x] Repeats: open / close — GP `[` / `]` (notation + **playback loops**: `computePlaybackOrder` unrolls
  repeats into the flat event list in `rebuildSequence`; the play cursor jumps back per GP. Alternate
  endings not handled). Multirest (`⌘R`) still pending.
- [ ] Full screen, palettes, inspectors — GP `F11`, `F2`, `F5`/`F6`
- [ ] Print — GP `⌘P`
- [x] Let ring: ring until the next note on the same string (replaces the fixed ~4× sustain; per-string in `rebuildSequence`)

## Phase 2 — Play-on-top (the product's #1 priority)
- [x] Per-track mixer: volume / pan / mute / solo
- [x] A/B loop (`⌘L`) + **metronome** (`♩` toggle) + **count-in** (`⏱` toggle — one bar of clicks at the
  playback tempo via the preview path before the transport starts; pressing play again aborts it)
- [x] Tempo slow-down (independent of pitch) — transport **practice-speed** select (25–150%) →
  `AudioEngine::setPlaybackRate` scales playback tempo; pitch is inherently unchanged (re-sequenced MIDI)
- [~] **Live input through a VST/AU chain** + mix — _shipped_: mic monitoring (`setLiveInput`, transport `🎤`) **+
  a VST3/AU plugin insert** on the input. `JUCE_PLUGINHOST_AU/VST3` enabled, full `juce_audio_processors` linked
  (JUCE 8 `addDefaultFormatsToManager`); `AudioEngine::loadInputPlugin(file)` creates the instance, prepares it,
  and swaps it onto the audio thread under a SpinLock; the callback runs the captured input through it before the
  mix. Sound menu → Load/Clear Input Plugin. **+ plugin editor window** (Show Plugin Editor; auto-opens on load).
  Ownership is now message-thread (`ownedPlugin`) with a `tryEnter`-guarded `processBlock`, so the editor + the
  swap/free are race-safe. **TODO:** per-track chains (multiple inserts), plugin state save. _Needs runtime
  verification with a real plugin._
- [x] Record the output mix (backing tracks + live input) to WAV — transport `⏺` / Sound menu;
  `AudioEngine::startRecording`/`stopRecording` via a background `ThreadedWriter` (RT-safe). _Loop/overdub recording still pending._

## Phase 3 — Export & sync
- [x] `.gp` export (alphaTab `Gp7Exporter`) — File→Export Guitar Pro; `exportGp` → `saveBinary` native
  save dialog (base64 → bytes). _Verify the round-trip: export, then reopen the `.gp` in Gomidas / GP._
- [ ] Stem separation → sync real recordings to tabs (reuse Conduit `build-stems` / `StemSeparationService`), sync to the drum track

---

## Engineering / tech debt
- [ ] Confirm edit lag is gone on **large imported `.gp`**; if not, render only the active track during edits and/or a bar-window around the cursor (full render on idle). Diagnostic `slow render: …` log is wired in `editor.js onRenderFinished`.
- [ ] Harden real-time safety: TSF voice alloc + sequence swap can free/allocate on the audio thread (milestone-1 caveat in `CLAUDE.md`).
- [ ] Verify physical-keyboard delivery in the packaged app (synthetic keys are blocked in the sandbox).
