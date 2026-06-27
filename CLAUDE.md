# CLAUDE.md — Gomidas

A **Guitar-Pro-like app** for guitar / bass / drums, macOS-first, built on **JUCE 8 / C++20**.
Read `~/dev/audio/juce-docs` for JUCE API reference before writing engine code.

> Commercial, closed-source product. © 2026 Alexis Giovoglanian. Sibling apps:
> **Conduit** (VST host + routing + stems), **Pitchyn** (pitch), **Saturation Engine**.

## What it is

Load any Guitar Pro tab (GP3–GP8), see it as tab + notation, **edit it**, and **play it back**
via MIDI/SoundFont — then (later) play on top with your own instrument through a VST chain.

## The product priorities (from the user)

1. Play on top of the tracks with a loaded VST chain + mix (live input).
2. Each track can load a VST instrument.
3. Load any Guitar Pro tab incl. GP8.
4. First versions target Guitar, Bass, Drums.
5. Tracks play MIDI instruments by default (like Guitar Pro).
6. Post-MVP: sync real recordings to tabs via stem separation, syncing to the drum track
   (reuse Conduit's `build-stems` / `StemSeparationService`).

**First deliverable the user asked for: a tab editor with MIDI playback.**

## Architecture (decided)

```
JUCE Standalone macOS app
├─ WebView (alphaTab, MPL-2.0)  = SOURCE OF TRUTH for the score
│   ├─ parse GP3–GP8 / render tab+notation / editing UI (we build the editing layer)
│   └─ walks model → flat MIDI event list → native (on every edit)
└─ Native C++
    ├─ AudioEngine: AudioDeviceManager + transport clock (960 PPQ) + scheduler
    ├─ SoundFontSynth: TinySoundFont (MIT) + bundled GM SoundFont (sonivox.sf2)
    ├─ (later) live input → VST/AU host chain (Conduit-inspired) + mixer
    └─ pushes transport position → alphaTab cursor (external-media sync)
```

**Key rule: native owns the clock; alphaTab only renders + moves its cursor.**
alphaTab's built-in player runs soundfont-less (silent) — we only use its cursor.
All audio is native so MIDI tracks, the synth, the (future) live VST chain and the cursor
stay in sync off one master transport.

### Why these choices
- **alphaTab** already encodes every GP notation/MIDI semantic and parses GP3–GP8 — rebuilding
  that natively would be months. It is a renderer, not an editor, so the **editing layer is ours**.
- **TinySoundFont** (single-header, MIT) is trivially commercial-safe and audio-thread friendly.
  fluidsynth (LGPL) is the upgrade path if we want better GM sound.
- **No `.gp` write-back** initially: we import `.gp`, save to our own `.gomidas` project format.

## Layout

```
CMakeLists.txt              juce_add_gui_app + juce_add_binary_data(GomidasAssets)
src/Main.cpp                JUCEApplication + DocumentWindow
src/ui/MainComponent.*      WebBrowserComponent + JS↔C++ bridge + native macOS menu bar (MenuBarModel)
src/engine/AudioEngine.*    device, transport, scheduler, Sequence hand-off
src/synth/SoundFontSynth.*  TinySoundFont wrapper
src/synth/tsf/tsf.h         vendored TinySoundFont (MIT)
web/index.html              GP8-style dark 4-panel layout (transport / palette / center / inspector / tracks)
web/app.js                  alphaTab host, model→MIDI (self-computed ticks), bridge
web/editor.js               tab editor: cursor/nav/entry, mouse select, edit+play cursors
web/juce_native_interop.js  JUCE WebView bridge (vendored from JUCE; sets window.__JUCE__.backend)
web/alphaTab.min.js          alphaTab classic bundle (embedded)
web/Bravura.woff2/.woff      music notation font (embedded)
assets/soundfont/sonivox.sf2 GM SoundFont (embedded; native synth)
```

## Build

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug   # first run fetches JUCE 8.0.13
cmake --build build
open "build/Gomidas_artefacts/Debug/Gomidas.app"
```

## Cross-thread model (real-time safety)
- Edits build a new `Sequence` on the message thread; handed to the audio thread via a
  `SpinLock` + `tryEnter` swap (audio thread never blocks). See `AudioEngine`.
- Transport position is audio-thread owned, published via `std::atomic<double> reportedTicks`.
- Native→JS cursor uses `evaluateJavascript` on a 30 Hz UI timer.
- **Known milestone-1 caveats** (revisit before shipping): TSF voice alloc + the shared_ptr-ish
  swap can free/allocate on the audio thread; fine for a dev build, harden later.

## Editor — what works (mouse-first; keyboard secondary)
> Feature status + GP8 key mapping live in **`docs/FEATURES.md`** and **`docs/BACKLOG.md`**
> (GP reference: `docs/references/gp8-keyboard-shortcuts.md`). Update those when features land.

**UI: GP8-style dark layout** (`web/index.html`): top **transport** (home/zoom/undo·redo · ◀◀ ▶ ▶▶ +
track chip with tempo · New/Open/Save/Import/track-select), left **palette** (`#editbar`, built by
`fretboard.js buildEditBar` — nav/duration/fx/articulation/bar-ops), center **score** (`#at`) + **fretboard
/ drum palette**, right **SONG/TRACK inspector** (`buildInspector` — **live**: TRACK tab = editable name,
Score/Tab toggles, tuning-preset picker, GM sound picker → `setTrackName`/`toggleNotation`/`setTuningPreset`/
`setTrackProgram`; SONG tab = title + tempo → `setSongTitle`/`setSongTempo`. Interpretation sliders are still
visual placeholders. The panel skips rebuild while a text field is focused so typing isn't clobbered),
bottom **track list** (`buildTrackList` — row click → `selectTrack`→`gomidasShowTrack` focuses that track
**alone**; **mute/solo are live via per-channel gain** (`applyMixer`→native `setChannelMix`, solo overrides
mute, instant during playback); **volume slider** per row = linear gain; **eye** toggles the track in the
multi-track view, hide ≠ mute). `getState()` also returns `allTracks` (each with `volume`), `title`,
`artist`, `songTempo`, `curTrackIndex`, `trackProgram`, `showStandard/showTab`.
**New-score dialog + unsaved-changes guard:** `New…`/menu→`window.gomidasOpenNew` opens a GP8-style modal
(title/tempo/time-sig/add-remove tracks + tuning presets) → `createNewFromConfig` builds alphaTex. A dirty
flag (`GomidasEditor.isDirty`, set on every commit, cleared on fresh load + Save) drives `confirmDiscard`
before New/Open/Sample.
**View model:** `app.js` has `viewMode` = `single` (one focused track, set by a track-row click /
`track-select`) or `multi` (all non-hidden, set by the eye control); `renderView()` reconciles them.
**Native menu bar:** `MainComponent` is a `juce::MenuBarModel` (`setMacMainMenu`) with GP8 menus
(File/Edit/Track/Bar/Note/Effects/Section/Tools/Sound/View/Window/Help). Items carry an action string →
`menuItemSelected` → `evaluateJavascript("window.gomidasMenu('action')")` → dispatched in `app.js`.
Keep menu labels **ASCII** (non-ASCII `const char*` literals trip a JUCE String UTF-8 assertion).
**Playback rule:** a bar always spans its full time-signature length (`masterBarTicks`); underfilled bars
are silence-padded so the next bar starts on the downbeat. **Mixer:** mute/solo/volume are applied **live**
as per-channel gain — `app.js applyMixer()` computes each track's gain (vol × mute/solo) + pan and pushes
`setChannelMix` to the engine, which calls `tsf_channel_set_volume/pan` on the audio thread (affects ringing
voices, no rebuild). `rebuildSequence` no longer drops muted events. `window.gomidasTrackFlags[i] =
{muted,soloed,hidden,vol}`. Loaded files honour their own tempo (`scoreLoaded`→`applyScoreTempo`).

**Toolbar:** `New…` (opens setup dialog) · `+Track…` · `Open` (.gp/.gomidas/MusicXML) / `Save` (.gomidas) ·
track selector · tempo field.
**Open + Recent files:** Open routes through a **native** `juce::FileChooser` (`MainComponent::openFileDialog`
→ `loadFileFromPath`) so we get a real path; `.gomidas` → `gomidasLoadProject`, others → base64 →
`gomidasLoadBinary` → `api.load`. Opened paths persist to `~/Library/Application Support/Gomidas/recent.txt`
(note: JUCE `userApplicationDataDirectory` is `~/Library` on macOS, so we append `Application Support`).
File→**Open Recent** submenu (built in `getMenuForIndex`, ids `kRecentIdBase+i`) routes through
`window.gomidasConfirmOpenRecent` so the unsaved-changes guard runs first.
**Key delivery:** `onKey` (JS window-capture) and the native `keyPressed`→`gomidasNativeKey` path both reach
`handleKey`; **`onKey` bails when a text field/SELECT/modal is focused** so Space types instead of toggling
play (a focused plain button still plays — it's not a typing target). Auto-scroll keeps the play cursor in
view during playback (`autoScrollToPlayCursor`, GP-style edge-triggered; `setAutoScroll(bool)`).
**Edit bar:** `◀▶` beat · `▲▼` string · durations `1 ½ ¼ ⅛ 16 32` · `.` dot · `‥` double-dot ·
`3` triplet · `P.M.` palm-mute · `R` rest · `＋beat`/`－beat`/`＋bar` · `↶`/`↷` undo/redo · `▶ Play`.
**Keymap is GP8-faithful** (no Gomidas-specific muscle memory to preserve — user asked for GP parity):
digits = fret (instant, 2-digit within 600 ms) · `R` rest · `.`/`⌘.` dot/double-dot · `/` triplet ·
`P`/`⇧P` palm-mute note/beat · `X` dead note · `I` let ring · `+`/`-` shorter/longer duration ·
`⌃+` insert beat · `⌘+` insert bar · `⌘-` delete beat · `⌘↑`/`⌘↓` prev/next track · `→` at last beat
appends · `⌘Z`/`⌘⇧Z` undo/redo · `Space` play. Command (⌘) vs Control (⌃) are distinct — the native
bridge (`MainComponent::keyPressed` → `gomidasNativeKey(key,cmd,ctrl,shift)`) forwards them separately.
Effects mutate the alphaTab model then `applyEdit(true)`; dead/palm-mute/let-ring also reshape the MIDI note.
Also implemented (GP keys): ties `L`/`⇧L` (sustains in MIDI), hammer/pull `H`, legato slide `S`,
ghost `O`, staccato `!`, accent `;`/`:`, natural harmonic `Y`, vibrato `V`, transpose `⌥⇧↑/↓` (semitone)
/ `⌥↑/↓` (octave). `⌥` (Option) is now forwarded too (`gomidasNativeKey(key,cmd,ctrl,shift,alt)`).
Multiview: **clicking a track's row switches the editor to that track** — `selectBeatAt` re-picks the
track whose staff bounds contain the click Y (`getBeatAtPos` alone returns the wrong track in multiview).
**Fretboard** (auto-sized to the track tuning): click a fret to place/toggle a note on the
current beat; inlay dots; note badges show the current beat. **Click any beat in the score**
(incl. empty bars) to move the cursor — uses `boundsLookup.getBeatAtPos`.
**Drums:** on a percussion track (`staff.isPercussion`) the fretboard is replaced by a **drum pad
palette** (`fretboard.js renderDrumPalette`); click a pad to toggle a hit. `New… → Drums/Full Band`
and `+Track… → Drums` create drum tracks. Gotcha: alphaTab builds `percussionArticulations`
**lazily from drum notes**, not from `\instrument percussion` alone — so templates/`addDrumTrack`
play a registration chord of every palette piece (GM keys 49,51,46,42,48,47,43,38,36 = the tex drum
numbers) then clear it. Palette pieces resolve to the articulation index by `outputMidiNumber`.
**Feedback:** clicking a fret auditions the note/chord (native `preview`). Edit + play cursors
span notation+tab and follow the native transport.

Key facts learned (don't relearn):
- alphaTab renders into a `.at-surface` div at the `#at` padding offset (24,24) — cursor/click
  coords must add/subtract `surfaceOffset()`.
- `note.string` is **1-based from the lowest pitch** (string 1 = bottom). Fretboard rows are
  top=highest → `stringNo = stringCount - row`.
- alphaTex `\tuning` must be **parenthesized**: `\tuning(E4 B3 …)` or it eats following tokens.
- Percussion: `note.percussionArticulation` indexes `track.percussionArticulations`; that
  articulation's `outputMidiNumber` is the GM drum key (channel 9). `realValue` is NOT it.
- Score serialization: `alphaTab.model.JsonConverter.scoreToJson` / `jsonToScore` (used for
  `.gomidas` save/load and undo snapshots). `Gp7Exporter` exists → real `.gp` export is possible.
- Keyboard goes to the WebView; it must hold focus (native `grabKeyboardFocus` on load +
  focus-on-click). Real-key delivery unverified in the sandbox (synthetic keys blocked).

## Performance (measured — don't re-investigate from scratch)
Instrumented the real edit→renderFinished→paint timeline (drove `setFret` programmatically, ran the
**binary directly** `…/MacOS/Gomidas` with stderr captured, used isolated single edits 2.5s apart to
avoid alphaTab coalescing). Definitive findings on the **2-bar sample**:
- Synchronous JS per edit ≈ **13–26ms** (`finish()` ~1ms, `renderTracks()` enqueue ~12ms).
- Native message-thread work is **trivial** — `previewNotes`/`setSequence` only stash state under a
  SpinLock; all synth work is on the audio thread. NOT the freeze.
- Idle **rAF = 60/s** (window composites fine). An **isolated** edit renders in **~26ms**.
- ⚠️ Measurement trap: alphaTab **coalesces rapid `renderTracks` calls**, so a naive harness
  misattributes the *gap between edits* as render time (saw bogus "700ms/1400ms" that tracked the test's
  timer spacing exactly). `enableLazyLoading=true` was a red herring (deferred renders) — set to **false**.
**Conclusion:** the small-score edit path is fast (~26ms), not a freeze. The user's "~1s freeze per note"
must come from a path the direct-`setFret` harness bypassed:
1. **650ms keyboard fret-commit debounce** → FIXED: `placeFret` now renders each digit instantly; a 2nd
   digit within 600ms amends it (1→2 = fret 12). Buffer just resets on a timer, no pre-display wait.
2. **Big imported `.gp`**: alphaTab re-lays-out the **whole score** on every edit (no native partial
   render). Invisible on 2 bars (~26ms), seconds on a large multi-track song.
Diagnostics left in place: `editor.js onRenderFinished` logs `slow render: edit→display Nms (B bars,
T tracks shown)` only when an edit takes >150ms — quiet normally, and the next laggy note tells us if it
scales with bar/track count. Also added a `MessageChannel` **loop-pump** (`pumpLoop`/`stopPump`) as cheap
insurance against the WebView deferring a render when the loop goes idle right after an input event.
**If lag persists on a big file** → render only the active track during edits (`renderTracks([active])`)
and/or a bar-window render (`settings.display.startBar`/`barCount`) around the cursor; full render on idle.

## Roadmap
- **Phase 1 — editor: DONE.** load/render GP3–8, render tab+notation, edit notes/durations/
  beats/bars, multi-track + add-track, New/Open/Save (.gomidas), undo/redo, native MIDI playback
  + transport + good SoundFont (FluidR3), per-note audition, fixed cursor. Drum tracks play.
  - Drum-entry palette DONE (#8). **Deferred:** keyboard drum entry; bend editor.
- **Phase 2:** per-track mixer **(vol/mute/solo DONE** via `AudioEngine::setChannelMix` → TSF channel
  gain; **pan: engine-ready, no UI yet)**, A/B loop + count-in/metronome, tempo slow-down,
  live input through a VST chain, record/loop. (Re-enable `MICROPHONE_PERMISSION_ENABLED` in CMake.)
- **Phase 3:** `.gp` export (Gp7Exporter) + stem-sync (reuse Conduit `build-stems`).
