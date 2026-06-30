# Gomidas — Backlog

Not-yet-implemented features, prioritised. Implemented items live in [`FEATURES.md`](./FEATURES.md).
Keyboard targets follow GP8 (`references/gp8-keyboard-shortcuts.md`) unless a divergence is noted.
Check an item off and move it to `FEATURES.md` when it ships.

Priority: **P1** core editing parity · **P2** expressive effects · **P3** app/UX polish · **Phase 2/3** product roadmap.

---

## GP8 UI replication pass (user, 2026-06-27)
- [x] **SVG icon set** — inline `<symbol>` sprite + `Icons.use(name)` helper in `index.html` (~50 icons,
  `currentColor`). Replaced all emoji/unicode glyphs in transport, palette, track list, inspector.
- [x] **Track section + bar squares** — GP8 track panel: bar-number ruler + per-track row of small **fixed-width
  per-bar blocks** (filled in the track color, current bar outlined, **click to jump to that bar**), pan knob,
  EQ button, Master row. `getState()` now returns `barCount` + per-track `color`/`shortName`/`bars[]`.
- [x] **Left palette buildout** — voice tabs, Lyrics/Chords, signatures, octave/clef, tuplets, dynamics,
  articulation grid (~30 effects wired through `gomidasMenu`). Engine-less items (dynamics/octave/clef/lyrics) are
  dimmed placeholders.
- [x] **Transport + inspector polish** — icon-ified transport, multi-line info chip with **live, clickable time
  signature**, loop/speed/tuner cluster, view/instrument clusters; inspector color swatch + short label +
  notation icon toggles + RSE/MIDI + sound-chain + Stringed.
- [x] **Beat add after a silence** — `→` at the last beat of the last bar always extends (removed an
  over-aggressive anti-runaway guard that blocked extending past a rest).
- [x] **Beats overfilling one bar** — beat insertion is now **capacity-aware** (`barCapacityTicks` vs
  `barFilledTicks`): a full bar flows into the next bar (created if at the end).
- [x] **Auto-scroll to the edit cursor** — `refreshCursor` now keeps the edit cursor in view (generalised the
  play-cursor edge-scroll into `autoScrollToCursor`; instant, stands down during playback).
- [x] **Timeline horizontal scroll** — bar squares scroll horizontally (ruler + all rows scroll-synced; controls
  column frozen); the timeline follows the current bar (2026-06-28).
- [x] **Placeholder controls** — wired the dead buttons (2026-06-28): dynamics / octave-clef / lyrics palette,
  crescendo·diminuendo, track-options ⋮ menu, **per-track + master EQ** (synth re-architected into per-channel
  buses so each track has a real 3-band EQ), master volume/pan, Print, Tools (Transpose + practice tools),
  Window→Minimize, Help→About. **Deferred (greyed out via `.gd-soon`):** RSE engine, Interpretation
  (guitar-playing sim), Tuner. See [`DEAD_BUTTONS.md`](./DEAD_BUTTONS.md).
- [x] **EQ persistence** — track + master EQ now persist in the `.gomidas` envelope (`mix` sibling of
  `instruments`: per-track `eq` keyed by track index + master `{vol,pan,eq}`); restored + re-applied on load
  (`saveProject`/`gomidasLoadProject` in `app.js`). Legacy/instrument-only files still load.
- [x] **Crescendo/diminuendo playback** — `rebuildSequence` now ramps note velocity across a hairpin span
  (consecutive beats with the same `crescendo` type): 0.6→1.0 cresc, 1.0→0.6 dim (`crescendoFactors`, `app.js`).
- [ ] **Tuner** — chromatic tuner from the live input (pitch detection + needle UI). _(real-instrument scope)_

## Reported issues (user, 2026-06-29) — triaged, not yet fixed
> Root-caused via code investigation 2026-06-29 (see file:line refs). Bend (#1) **deferred by user**
> — emission is risky and can't be ear-verified in this environment; tracked under Phase 0/C below.

**Core bugs (P3 / high-value, low-risk):**
- [x] **RSE pill opens the file finder** — the RSE/MIDI pill is now a status indicator: the **MIDI**
  segment switches the track back to GM (`clearsfz`); the **RSE** segment no longer opens a dialog (you
  enter RSE by picking a preset). Custom SFZ load lives only in Preset → *Load file…* (`web/fretboard.js`).
- [x] **Playback resumes from the blue edit cursor, not the green play cursor** — on stop the green play
  beat is captured (`captureResume`); the next Play resumes from it unless the edit cursor moved since
  (`resumeBeat`/`resumeAtCursor`, `seekForPlay`/`seekToBeat` in `editor.js`). Falls back to `cur` on a
  reposition; cleared on score load.
- [x] **Pattern Library shows in all three drum tabs** — `buildPatternLib()` now lives inside the `kit`
  `.dp-pane`, so tab show/hide hides it for the Groove/Mixer tabs (`web/fretboard.js`).
- [x] **New drum-only track is silent even after inserting a pattern** — `clearDrumRegistration` now
  captures each percussion track's populated `percussionArticulations`, strips the registration notes,
  finishes, then **restores** the kit (instead of letting `finish()` re-derive an empty one). Groove/kit
  entry resolves articulation indices again (`web/editor.js`).

**Instrument SOUNDS panel (P3 / UX consistency):**
- [x] **RSE highlighted but MIDI controls shown** — the SOUNDS controls now follow the engine mode: when
  an SFZ is loaded (RSE) the GM Sound/Kit picker is hidden (it's overridden by sfizz); the Preset dropdown
  groups sample instruments under an `<optgroup>` ("Sample instruments (RSE)") separate from "GM SoundFont
  (MIDI)". Pill, dropdown, and visible controls stay consistent (`web/fretboard.js`).

**Drum KIT VIEW visual (P3):**
- [ ] **Kit hotspot circles misaligned** — `.kit-frame` uses `height:100%` + `max-width:100%`, so when
  the stage is narrower than `--drum-h × 1.5` the frame loses the 1536/1024 ratio and `object-fit:contain`
  letterboxes the image, while `.kit-hot` stays anchored to the *frame* not the rendered image
  (`index.html:186-191`; coords `fretboard.js:288-298`, positioning `:362-367`). Also a center-vs-corner
  ambiguity: `.kit-hot` uses `translate(-50%,-50%)` (coords = center) but the table reads like rectangle
  corners. **Fix:** lock the frame to the image aspect ratio (size by width so contain never letterboxes,
  or position hotspots against the rendered image box), and reconcile the coordinate convention; re-measure
  hotspots against `drumkit.png` if needed. _Needs visual iteration in-app._

**Bar-fill indicator (P1 / editing parity):**
- [x] **GP-style bar-fill indicator** — `trackBarFillClass` classifies each bar (`under`|`exact`|`over`)
  across **all** voices (max filled ticks vs `barCapacityTicks`); exposed in `getState()` (per-track
  `barsFill[]` + `curBarFill`). Timeline squares show an amber dot (incomplete) / red outline+dot
  (overfilled) (`fretboard.js`, CSS `.bf-under`/`.bf-over` in `index.html`); the status line shows
  "⚠ bar incomplete/overfilled" for the current bar.

**Tuning (P3 → small + feature):**
- [x] **Re-tuning an existing track** — `INSP_TUNINGS` expanded (6-string: Drop C, DADGAD, Open G/D/E…;
  7/8-string; 4/5/6-string bass), the select is labelled a re-tune control (tooltip + "Custom (…)" readout),
  and saved user tunings are merged in (★). (`web/fretboard.js`)
- [x] **Custom tunings: author + save/load** — per-string tuning editor modal (`gomidasOpenTuningEditor`,
  `app.js`) reached via the inspector tuning dropdown's "Custom / Edit…" option; **Save & apply** persists
  to `localStorage` (`gomidasUserTunings`) and the saved tuning appears in the preset list for matching
  string counts. Applies via the existing `setTuningPreset`.

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
- [x] Bend — GP `B` (Effects→Bend… / `B` → preset shapes: full / half / bend&release / pre-bend /
  pre-bend&release). **MIDI pitch-bend now emitted** (`emitBendEvents` in `app.js`): traces the bend
  curve over the note then resets the wheel to centre just before the note ends (fractional reset tick
  sorts before the next note-on). Imported GP bends are now audible too. ⚠ per-channel (a bent note bends
  the whole channel in a chord); confirm pitch by ear.
- [~] Legato MIDI for hammer/pull (done: hammered/pulled note plays softer, no re-pick) + **pitch-bend MIDI
  for slides + harmonic/vibrato MIDI still pending** (need native pitch-bend in `SoundFontSynth` + event format)

Rhythm:
- [x] Other tuplets (5, 6, 7, 9) — `setTuplet(n)` generalises `toggleTriplet` (Note menu + `gomidasMenu tuplet:N`)
- [x] Triplet feel — GP `⌘/` (notation swing 8ths on the current bar onward; **MIDI now swings**:
  `rebuildSequence` warps the within-bar 8th grid onto a 2:1 triplet feel for `Triplet8th` bars
  via `swungTickInBar`/`sw()` in `app.js`. ⚠ timing feel — confirm by ear.)
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
- [x] Tremolo bar — GP `⌥V` (Effects→Tremolo Bar; beat-level `whammyBarType` Dip + bend points; toggles off)
- [x] Tremolo picking — GP `"` (beat-level, 16th)
- [x] Trill — GP `N` (trills to fret+2)
- [x] Brush up/down — GP `⌘U`/`⌘D`; arpeggio up/down — GP `⇧⌘U`/`⇧⌘D`
- [x] Grace notes (before / on beat) — GP `G` / `⌥G` (on-beat is menu-only)
- [x] Chord diagram — GP `A` (name + optional fret shape via modal → `Staff.addChord` / `beat.chordId`;
  name always shows, diagram when frets given). Chord library picker / barre UI → future polish.
- [x] Slap — GP `$`; pop (Effects menu); pick stroke up/down — GP `⇧U`/`⇧D`
- [x] Fade in / out — GP `<` / `>`; volume swell — GP `⌥<`/`⌥>` (swell is menu-only)
- [x] Wah open/close, rasgueado, left-hand tapping, tapping — GP `⌥O`/`⌥C`, `⇧R`, `(`, `)`
  (Effects menu + keys; `beat.wahPedal`/`beat.rasgueado`/`beat.tap`/`note.isLeftHandTapped`; notation-only)
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
- [x] Track list **bar-square timeline** (per-bar content blocks, click to jump) + pan knob; Master row (visual)
- [x] Inspector: editable track name, tuning picker, sound/program selector; SONG tab (title + tempo); **per-track pan** (Mixer section); GP8 visual chrome (swatch, short label, notation icon toggles, RSE/MIDI, sound-chain)
- [ ] Inspector Interpretation: real Palm-mute / Accentuation / Auto-let-ring / Auto-brush / Stringed controls (still placeholders)
- [x] **SVG icon set** across the whole UI (inline sprite + `Icons.use`)
- [x] Transport: rewind/forward seek, **loop** (A/B `⌘L`) + **metronome** (`♩`) + **count-in** (`⏱`) + **practice speed**; icon-ified, live time-signature chip. View-layout / instrument clusters are **visual** single-select toggles (no layout backing yet)
- [x] Left palette filled toward GP's icon set (voices, signatures, octave, dynamics, tuplets, articulation grid); dynamics/octave/clef/lyrics are placeholders pending engine support

## P3 — App / UX polish
- [x] **Time-grid tab view** (piano-roll-for-tabs, `renderBeatLane`) — consistent time grid below the
  score; adaptive columns, beat/counting rows, fret-on-string by start time, center-locked playhead.
  **v2 TODO:** fretboard-dot strip (colored dots per string, mapped from the same time columns);
  left-margin rhythm thumbnails; right-margin "= N grid spaces" annotations; multi-voice rendering;
  repeats-aware playhead (currently linear song-tick, jumps on repeat replay).
- [x] **Collapsible per-panel drawers** (`initDrawers`) — chevron handle → labelled rail; persists.
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

## Realistic Sound (RSE-equivalent) — sfizz default + per-track VST
> Full design + architecture: [`REALISTIC_SOUND.md`](./REALISTIC_SOUND.md). Bundled-content licensing:
> [`SOUND_LIBRARIES.md`](./SOUND_LIBRARIES.md). Decided with the user 2026-06-29: **A-first** (bundled
> CC0 SFZ default), then **B** (per-track VST instruments — roadmap priority #2). Status: **planning**.

**Phase 0 — shared foundation (prereq for A and B):**
- [x] Add **sfizz** (BSD/ISC) to `CMakeLists.txt` via FetchContent (static lib; built as C++17 — see
  `REALISTIC_SOUND.md` §7 for the four arm64/modern-clang build fixes in `cmake/patch_sfizz.py`)
- [x] Per-channel SFZ override in `AudioEngine` via `SfzSynth` (lock-free `activeMask()` + per-block
  `tryLock()`, mirroring `pluginLock`; null channel → existing TSF path). _Generalised `TrackInstrument`
  abstraction deferred — `SfzSynth` is the concrete first backend; refactor when VST instruments land._
- [x] Sequencer routing fork: SFZ channels routed in `applyEvent` + the render loop (mixer gain/pan applied
  post-render since sfizz bypasses TSF volume/pan)
- [x] Prove end-to-end: builds/links/launches; **`tests/sfz_smoketest` confirms sfizz loads the bundled
  SFZ + decodes FLAC + renders non-silent audio** (guitar+bass PASS). In-app GUI routing → speakers still
  needs an ear-check (inspector Preset → play).
- [x] **Event-format plumbing**: `NoteEvent` gains `kind`+`value` (0=note, 1=pitch-bend, 2=CC); native parses
  the optional 8th/9th array elements; `applyEvent` dispatches to TSF (`tsf_channel_set_pitchwheel`/`_midi_control`,
  bend range widened to ±12) and sfizz (`pitchWheel`/`cc`; bundled SFZs given `bend_up/down=1200`). Additive —
  no behavior change until JS emits pitch-bend/CC events.
- [ ] **Emit** pitch-bend for slides/bends in `rebuildSequence` (~`app.js:251`). _Deliberately deferred:_ a
  mis-ordered bend-reset detunes the whole channel for following notes, so this needs **ear verification** before
  shipping. Design: ramp center→Δsemitones over the slide note (Δ scaled to ±12), reset to centre at the target
  onset (use a fractional tick so the reset sorts before the next note-on). Watch legato (no re-pick) vs shift.

**Phase A — bundled SFZ default (build first):**
- [x] `SfzSynth` per-channel sfizz backend (load/note/bend/cc/render/clear) — see Phase 0
- [x] Native `loadTrackSfz`/`clearTrackSfz`; **inspector SOUNDS UI**: live RSE/MIDI pill + Instrument row +
  Load SFZ…/Clear buttons (reused the "RSE pill" stub). Also a Sound-menu fallback.
- [x] CC0 content bundled: **FreePats Classical Guitar (5.2 MB) + Electric Bass (2.8 MB)**, both CC0,
  in `assets/instruments/` → copied to app Resources at build. **Drums deferred to download-on-first-run**
  (good CC0 kits are 1.6–2.3 GB — too big to bundle).
- [x] **Built-in preset picker**: inspector SOUNDS dropdown (GM SoundFont | presets | loaded custom file |
  Load file…); native `loadTrackSfzPreset` resolves the bundled path. _Drum-kit SFZ preset still TODO
  (needs the download mechanism)._
- [ ] Author our own `.sfz` layout incl. the articulation/keyswitch map (Phase C)
- [x] **Persist the instrument assignment in `.gomidas`** via a backward-compatible envelope
  (`{ gomidasVersion, instruments, score }`; legacy raw-score files still load). Built-in **presets** persist
  (matched by name) + reload on open; custom file loads stay session-only (paths are fragile). This is the
  project-format envelope EQ-persistence can also use. _Verified with standalone round-trip tests; needs a GUI
  save/reload pass to confirm in-app._

**Phase B — per-track VST instruments (priority #2):**
- [ ] ⚠️ First **verify the existing live-input VST host actually works at runtime** (it's unverified) before scaling to 16
- [ ] `VstInstrument : TrackInstrument` (per-channel MidiBuffer feed; reuse `pluginFormatManager` + the
  `loadInputPlugin` swap pattern)
- [ ] Generalize `PluginEditorWindow` → N windows; native `showTrackPluginEditor(channel)`
- [ ] Plugin state save/restore in `.gomidas` (`getStateInformation` → base64) — closes the existing "plugin state-save" TODO
- [ ] UI sound-source picker → "Plugin…" → file chooser → `setTrackInstrument(channel,'vst',path)`

**Phase C — articulation mapping (realism; overlaps A/B):**
- [ ] Pitch-bend ramps for slides/bends in `rebuildSequence` (~`app.js:251`) — universal across backends
- [ ] Keyswitch emission for palm-mute/harmonic/dead matching the bundled-SFZ layout
- [ ] (Later) tremolo repick, strum spread, fade envelopes, vibrato-as-pitch-bend; per-VST articulation presets

**Later / open:** amp sim (bundle Neural Amp Modeler MIT, fed the CC0 clean-DI guitar); per-track plugin
*chains*; sample-accurate (vs block-quantized) note timing.

## Phase 3 — Export & sync
- [x] `.gp` export (alphaTab `Gp7Exporter`) — File→Export Guitar Pro; `exportGp` → `saveBinary` native
  save dialog (base64 → bytes). _Verify the round-trip: export, then reopen the `.gp` in Gomidas / GP._
- [ ] Stem separation → sync real recordings to tabs (reuse Conduit `build-stems` / `StemSeparationService`), sync to the drum track

---

## Engineering / tech debt
- [ ] Confirm edit lag is gone on **large imported `.gp`**; if not, render only the active track during edits and/or a bar-window around the cursor (full render on idle). Diagnostic `slow render: …` log is wired in `editor.js onRenderFinished`.
- [ ] Harden real-time safety: TSF voice alloc + sequence swap can free/allocate on the audio thread (milestone-1 caveat in `CLAUDE.md`).
- [ ] Verify physical-keyboard delivery in the packaged app (synthetic keys are blocked in the sandbox).
