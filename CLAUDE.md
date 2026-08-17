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

## Project tracking — use Samu (not GitHub Issues)

All open work is tracked in **Samu**, a local issue tracker (workspace `gomidas`, project
`GMD`). **Samu now supersedes GitHub Issues** — do not file or update GitHub issues.
`docs/BACKLOG.md`, `STATUS.md`, and `FEATURES.md` remain as **design/spec docs**, not the work list.

⚠️ **The board was rebuilt 2026-08-13.** The `GMD` project had vanished from the Samu server, so
the original `GMD-1…GMD-23` (migrated from GitHub Issues) are **lost and the keys were reused**.
It was reseeded from `BACKLOG.md`/`STATUS.md` as `GMD-1…GMD-29`, plus `GMD-30…GMD-39` for the web
port. **Any `GMD-<n>` reference in a commit before 2026-08-13 now points at an unrelated ticket** —
don't trust it.

Follow the **`samu` skill** (`.claude/skills/samu/`): before starting, `samu ticket ls` and
claim a ticket (`samu ticket move <KEY> "In Progress"`); file anything you discover
(`samu ticket create …`); on finishing a verified chunk, move it to `Done` and
`samu status log …`. You're pre-authenticated as the coding-agent (via `SAMU_CONFIG`). Never
mark a ticket Done until the change is actually built and exercised. Reference the ticket key
in commits (e.g. `GMD-8: …`). The board is at http://127.0.0.1:8080 (workspace `gomidas`).

## How work lands — the `spec` → `ship` pipeline (2026-08-17)

**Idea/bug in → `spec` → Samu ticket → `ship` → merged.** Two project skills, both in
`.claude/skills/`, both tracked in git.

**`/spec <idea or bug>`** is the front door: research the code **before** asking anything
(CLAUDE.md, the board for duplicates, parallel `Explore` agents for anything non-trivial),
discuss until no open question would change the implementation, then file Samu tickets **sized
to one `/ship` run each**. A ticket is done when an agent can pick it up cold without
re-deriving what was already decided — title states the *mechanism* not the symptom, body
carries Why / Mechanism / Where (`file:line`) / Acceptance / How to verify / **Traps** (every
parallel code path that must change together — the reason GMD-44 and GMD-62 got reopened).

**`/ship GMD-<n>`** is the exit. One ticket, one branch, one PR — no more batched local merges
straight into `main`.

```
CLAIM → PLAN → BRANCH → IMPLEMENT → VERIFY → PR → REVIEW → MERGE → CLOSE
```

**Two hard stops where you wait for the user: the plan, and the merge.** Everything else you
drive. Failures go *backwards* — never a PR on a red gate, never a merge on a red review, never
`Done` on an unverified merge.

**One exception (user's standing call, 2026-08-17):** meta-work on the tooling itself — skills,
`CLAUDE.md`, `.gitignore`, harness config — **goes straight to `main` on request**, no branch/PR/
review, since there's no code for the gates to check. Still `samu status log` it. Anything
touching `src/`, `packages/` or `apps/` takes the full loop.

**The four verification gates, all before the PR exists:**
- **A — automated:** `pnpm typecheck` · `pnpm test` · `cmake --build build` · `ctest`.
- **B — the checkJs sweep:** `pnpm sweep`. Exit 1 means **you referenced something that doesn't
  exist**. Also runs in CI, first in `web-tests` (GMD-68).
- **C — runtime verification.** Build green ≠ works. Exercise it; measure anything measurable;
  evidence goes in the PR body. If it truly can't be verified here, **say so in the PR** — this
  is exactly how the live-input/plugin/recording stack got to "builds but UNVERIFIED".
- **D — both products.** `packages/core` is shared; GMD-44/57/62 were all one product fixed and
  the other left broken. Check for the parallel code path.

Review is **`/code-review high <PR#>`**, looped until clean — always pass the level, or the skill
silently reuses whatever was typed last and the gate stops being reproducible. **`ultra` is on
the user's demand ONLY: never run it, never propose it.** CI already runs on `pull_request`.

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

Monorepo since 2026-08-13 (GMD-39). **`packages/core/` is the shared editor** — the same files
the desktop app embeds and the browser build serves; there is only one copy of everything.

```
packages/core/              shared editor (TypeScript -> dist/, see tsconfig.json)
apps/web/                   browser build: Vite shell whose root IS packages/core
CMakeLists.txt, src/        macOS app (kept at the repo root; assets/ is shared with the web build)
```

```
CMakeLists.txt              juce_add_gui_app + juce_add_binary_data(GomidasAssets)
src/Main.cpp                JUCEApplication + DocumentWindow
src/ui/MainComponent.*      WebBrowserComponent + JS↔C++ bridge + native macOS menu bar (MenuBarModel)
src/engine/AudioEngine.*    device, transport, scheduler, Sequence hand-off
src/synth/SoundFontSynth.*  TinySoundFont wrapper
src/synth/tsf/tsf.h         vendored TinySoundFont (MIT)
packages/core/index.html              GP8-style dark 4-panel layout (transport / palette / center / inspector / tracks)
                            + inline SVG icon sprite (`<symbol>` defs) and `Icons.use(name,cls)` helper — all UI icons live here
packages/core/app.js                  alphaTab host, model→MIDI (self-computed ticks), bridge
packages/core/editor.js               tab editor: cursor/nav/entry, mouse select, edit+play cursors
packages/core/juce_native_interop.js  JUCE WebView bridge (vendored from JUCE; sets window.__JUCE__.backend)
packages/core/alphaTab.min.js          alphaTab classic bundle (embedded)
packages/core/Bravura.woff2/.woff      music notation font (embedded)
assets/soundfont/sonivox.sf2 GM SoundFont (embedded; native synth) — fallback bank on web too
assets/drumkits/gm-standard.{json,bin}  web drum pack, extracted from FluidR3 (GMD-50)
assets/instruments-gm/gm-melodic.json + gm-melodic-<prog>.bin  per-program melodic packs (GMD-57)
packages/core/tools/extract-sf2-pack.mjs the tool that generates both (needs FluidR3 + ffmpeg)
```

## Build

**pnpm, not npm** (GMD-63) — one workspace (`pnpm-workspace.yaml`), one lockfile, one install for
both packages. CMake shells out to `pnpm exec tsc`, so **`pnpm install` is a prerequisite of
`cmake --build`**; it hard-fails if pnpm is missing rather than embedding stale JavaScript.
(`npx tsc` used to *download* a compiler when none was installed — an unpinned tsc silently
compiling what gets embedded.)

```bash
pnpm install                              # workspace root; required before configuring
cmake -B build -DCMAKE_BUILD_TYPE=Debug   # first run fetches JUCE 8.0.13
cmake --build build
open "build/Gomidas_artefacts/Debug/Gomidas.app"
```

Root scripts: `pnpm build` / `test` / `typecheck` (packages/core) and `pnpm web:dev` /
`web:build` / `web:preview` (apps/web). Per-package: `pnpm -C <dir> run <script>` — filter by
**directory**, since the package names are confusing (packages/core is `gomidas-web`, apps/web is
`gomidas-app-web`).

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

**UI: GP8-style dark layout** (`packages/core/index.html`): top **transport** (home/zoom/undo·redo · ◀◀ ▶ ▶▶ +
track chip with tempo · New/Open/Save/Import/track-select), left **palette** (`#editbar`, built by
`fretboard.js buildEditBar` — nav/duration/fx/articulation/bar-ops), center **score** (`#at`) + **time-grid
tab** (`#beatlane-panel`, see below) + **fretboard
/ drum palette**, right **SONG/TRACK inspector** (`buildInspector` — **live**: TRACK tab = editable name,
Score/Tab toggles, tuning-preset picker, GM sound picker → `setTrackName`/`toggleNotation`/`setTuningPreset`/
`setTrackProgram`; SONG tab = title + tempo → `setSongTitle`/`setSongTempo`. Interpretation sliders are still
visual placeholders. The panel skips rebuild while a text field is focused so typing isn't clobbered),
bottom **track list** (`buildTrackList` — row click → `selectTrack`→`gomidasShowTrack` focuses that track
**alone**; **mute/solo are live via per-channel gain** (`applyMixer`→native `setChannelMix`, solo overrides
mute, instant during playback); **volume slider** per row = linear gain; **eye** toggles the track in the
multi-track view, hide ≠ mute). Each row also has a **per-bar square timeline** (small fixed-width blocks,
filled in the track color where the bar has notes, current bar outlined; **click a square → `selectTrack` +
`goToBar`**), a **pan knob** (drag/dbl-click-center), an EQ button (placeholder), and a **Master row**
(placeholder controls). `getState()` also returns `allTracks` (each with `volume`, `color`, `shortName`,
`bars[]` content map), `barCount`, `title`, `artist`, `songTempo`, `curTrackIndex`, `trackProgram`,
`showStandard/showTab`. **Bar capacity:** beat insertion is capacity-aware (`barCapacityTicks` vs
`barFilledTicks` in `editor.js`) — a full bar flows into the next; `→` at the score end always extends.
**Auto-scroll:** `autoScrollToCursor` keeps both the play and **edit** cursors in view (edge-triggered).
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
**Drums — KIT VIEW** (reference redesign 2026-06-28; `fretboard.js renderDrumPalette` builds it,
shown when `staff.isPercussion`): a 3-tab panel **KIT VIEW / GROOVE EDITOR / MIXER** in `#fretboard`
(`.kit` class makes it taller). KIT VIEW = `packages/core/drumkit.webp` (bundled; served
`/drumkit.webp` — was a 2.1MB `.png` until GMD-59; a tab left open across that build 404s and now says
so, GMD-71) with
percent-positioned **hotspots** (`KIT_PIECES`) → click toggles `toggleDrum(midi)` on the current beat
per the **Quick Tools** mode (draw/erase/paint/select) + Accent/Ghost/Repeat/Tie actions; an
**Articulation** panel picks each piece's GM key + a velocity→dynamic slider. A **Pattern Library**
(grooves in `packages/core/grooves.js`, keyed by category, 16-step lanes; favourites + user grooves in
localStorage) inserts via `E.insertGroove` (writes sixteen 16th-step beats; Replace-Bar/Append per
`gomidasInsertMode`, target `cur.voice`). **GROOVE EDITOR** = step grid over `E.readBarGrid`/
`toggleGridCell`. **Generate Variation** (`E.generateVariation`, seeded) humanizes the current bar.
**MIXER** = per-piece level → `window.gomidasDrumGains[midi]` scales hit velocity in `rebuildSequence`.
Kit picker (inspector) = drum **program** (Standard/Room/Rock/…). `New… → Drums/Full Band` and
`+Track… → Drums` create drum tracks. Gotcha: alphaTab builds `percussionArticulations`
**lazily from drum notes**, not from `\instrument percussion` alone — so templates/`addDrumTrack`
play a registration chord of every palette piece (GM keys 49,51,46,42,48,47,43,38,36 = the tex drum
numbers) then clear it. Kit pieces resolve to the articulation index by `outputMidiNumber`
(`drumArtIndex`). **Theme:** the app uses a purple accent (`--accent #7b5cff`); track colors are
kind-based (drums purple / bass blue / guitar orange) and the bottom timeline is a continuous
colored band per track.
**Feedback:** clicking a fret auditions the note/chord (native `preview`). **One unified cursor**
spans notation+tab: it follows the native transport during playback and stays where playback stopped
(written back into `cur`), so Play always resumes from the cursor (`commitPlayPositionToCursor`).

**Time-grid tab view ("piano roll for tabs")** — a beat-reading helper for non-notation-readers,
in `#beatlane-panel` below the score (toggle `⇧⌘G` / View→Toggle Beat Grid). alphaTab is an **optical
engraver** (no proportional/equal-width-bar mode — only `stretchForce`/`justifyLastSystem`/`layoutMode`/
`barCountPerPartial`), so any overlay on its surface is irregular. The grid is therefore drawn **by us
on a canvas** (`editor.js renderBeatLane`) on its own even **time** scale: every 4/4 bar the same width,
each bar's columns **adapt to its smallest value** (`laneBeatK`: 8ths→8, 16ths→16, triplets→3/beat),
fret numbers on string rows at their **start time** + duration bars, BEAT + counting rows, center-locked
green playhead, click-to-seek. The engraved tab/notation stays source of truth. _Don't re-attempt an
overlay on the alphaTab score — it can't be both even and note-aligned._ v2 (backlog): fretboard-dot
strip, margin annotations, multi-voice, repeats-aware playhead.
**Collapsible drawers:** every dockable panel (Tools/Inspector/Beat Grid/Fretboard/Tracks) has a corner
chevron → collapses to a thin labelled rail (`app.js initDrawers`; a `MutationObserver` re-appends the
handle after `innerHTML` rebuilds; state persists per panel).

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
- ⚠️ **The `AlphaTabApi` constructor defers its own bootstrap behind a `requestAnimationFrame`**
  (`beginInvoke` *is* rAF), and that bootstrap — `initialRender()` — is what registers the handler
  resetting alphaTab's render-result counter on each `preRender`. **Any render that happens before
  it appends partials to `.at-surface` with no counter to trim against**, so the surface grows by 4
  nodes per render forever and the score title comes out overprinted (GMD-41). Never drive
  `tex`/`render`/`renderTracks` in the same task that constructs the API — `app.js` boot waits one
  frame. Corollary: **`reflowScore()` is debounced**; five overlapping renders (one per panel in
  `initDrawers`) interleave their rAF-deferred appends and defeat the counter even after bootstrap.
  Still reachable from a **second** trigger: `addTrack` followed by `selectTrack` with no wait
  overlaps two renders and the title doubles again (GMD-70, open).
- ⚠️ **`editor.js`/`app.js`/`fretboard.js`/`grooves.js`/`core/gomidas-core.js` are plain `<script>`
  globals with NO typecheck** (the main tsconfig sets `checkJs: false` deliberately — on, it buries
  the build in ~1400 inference diagnostics from 5,700 un-migrated lines), so a dangling reference is
  invisible until that line happens to run. **`pnpm sweep` is the gate** (GMD-68): the
  already-installed compiler, no new dependency, ~0.3s, and it **runs in CI** first in `web-tests`.
  `tools/checkjs-sweep.mjs` keeps only `TS2304` and sets its own exit code — tsc's is useless
  because the inference noise makes it non-zero always. The two real globals are declared in
  `types/globals.d.ts`, so **any** surviving TS2304 is a name that exists nowhere. A legitimate new
  global goes in `globals.d.ts`; **never** delete the check. TS2552 doesn't occur in this codebase
  (measured: zero), so TS2304 is the only clean signal there is. That is how GMD-67 was found:
  GMD-54 removed a `const pb = t.playbackInfo` and left `pb.program` two lines below, so **every
  note audition threw and clicking a fret was silent on both products for a day** — invisible
  because `previewBeat()` runs LAST in `setFret`, so the edit still committed and the app looked
  fine.
- **Everything the inspector renders must branch on `s.isPercussion`** (GMD-69). A tuning row, palm
  mute, auto let ring, auto brush, "Stringed" and the bundled melodic CC0 SFZ presets are all
  properties of a *fretted* instrument, and showing them on a drum track is what makes the panel read
  as "the guitar controls". `gomidasSfzPresets[].kind` exists for exactly that filtering — it was
  defined with a "for future per-track-kind filtering" comment and left unwired.
- **A drum MIXER fader owns a GM key GROUP (`PIECE_KEYS`), never `artics[0]`** (GMD-72). `artics` is
  the deliberately-short list of articulations you can *place*; a fader is a *channel*, so Hi-Hat has
  to move closed + open + pedal together. Keyed off `artics[0]` a fader moved exactly one key, and on
  a real imported `.gp` — GMD-54's Pantera `.gp5`, playing 35, 40, 46, 53 — **every fader moved
  nothing at all**, which is what "drum mix does not change anything" looks like from the outside.

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
> Authoritative feature status lives in **`docs/FEATURES.md`** / **`docs/BACKLOG.md`** — keep them current.

### ⭐ Current top priority (user, 2026-08-13): the **web app**
The browser build now **outranks every other line of work**, including the desktop verification debt
and per-track VST instruments. Spec + decisions: **`docs/WEB_PORT.md`**. Tracked as `GMD-30…GMD-39`
under the **Web port v1** milestone (label `web-port`); start at **`GMD-30`** (Phase 0) and go in order.

It is a **second product built from one shared core**, not a replacement — desktop keeps VST/AU
hosting and low-latency live input, which cannot exist in a browser. Work happens **in this repo on a
branch** (`feat/web-app`); the hard rule is that **every commit leaves `cmake --build build` green and
the macOS app behaving identically**. Decided 2026-08-13: full editor parity for v1 · pure
client-side, no server · effects web-only but with a backend-agnostic schema · **TypeScript**
(cheap here — `index.html` loads plain `<script>` globals, so `tsc` per-file emit needs no bundler;
`juce_add_binary_data` just repoints at `packages/core/dist/`).
- **Phase 1 — editor: DONE.** load/render GP3–8, tab+notation, edit notes/durations/beats/bars,
  multi-track + add/delete-track, New/Open/Save (.gomidas), undo/redo, native MIDI playback + transport
  (starts from the edit cursor) + FluidR3 SoundFont, per-note audition. Selection + copy/cut/paste, voices
  1–4, time/key sig, repeats, tuplets (incl. spanning), keyboard drum entry (17-pc kit), full GP8 effect set,
  text/directions/fermata/chords, D.C./D.S. + repeat playback, bends (preset shapes + pitch-bend MIDI).
  **Deferred:** graphical bend-curve editor; multirest; alternate-endings/Coda playback order.
- **Phase 2 — play on top: DONE except the depth items.** per-track mixer (vol/pan/mute/solo, persisted),
  A/B loop, metronome, count-in, tempo slow-down (pitch-independent), **live input + AU/VST3 plugin insert +
  plugin editor window**, input gain, output VU meter, WAV recording, panic. `MICROPHONE_PERMISSION_ENABLED`
  re-enabled. ⚠️ **The live-input/plugin/recording stack builds + links but is UNVERIFIED at runtime — verify
  before extending.** **TODO:** per-track VST *instruments* (priority #2), per-track plugin chains, plugin
  state-save, loop/overdub recording.
- **Phase 3:** `.gp` export (Gp7Exporter) **DONE**; **TODO:** stem-sync (reuse Conduit `build-stems`).

### Per-track audio buses + EQ (2026-06-28)
To give each track its own EQ, `SoundFontSynth` now keeps **one TSF instance per MIDI channel**
(`chan[16]`, created with `tsf_copy` from a shared template — refcounts the soundfont samples, so the
copies are cheap). `renderChannel(ch, …)` renders one channel's bus and **skips channels with no active
voices** (`tsf_active_voice_count`), so CPU scales with *audible* tracks, not a fixed 16. `AudioEngine`
loops the channels: render → per-channel **3-band EQ** (low-shelf/mid-peak/high-shelf, manual transposed
DF-II biquad, allocation-free) → sum → **master EQ** → master gain/balance-pan → output. EQ coeffs are
computed on the message thread (`juce::dsp::IIR::Coefficients`, 5 normalized floats) and handed to the
audio thread under `eqLock` + `eqDirty` (mirrors the `Sequence`/`mixDirty` swap). Native bridge:
`setTrackEq`/`setMasterEq`/`setMasterMix`. JS: track-list EQ buttons + Master row → `gomidasOpenEq` popup
(Low/Mid/High −12..+12 dB); values live in `gomidasTrackFlags[i].eq` / `gomidasMaster` (**session-only —
not yet saved to `.gomidas`**; vol/pan still persist via `playbackInfo`).

### Per-track SFZ instruments (sfizz) — "realistic sound" / RSE-equivalent (2026-06-29)
First step of the realistic-sound plan (full design: **`docs/REALISTIC_SOUND.md`**; CC0 content +
licensing: **`docs/SOUND_LIBRARIES.md`**). A track can load an **SFZ sample instrument** played by
**sfizz** (BSD/ISC); that channel renders via sfizz instead of TinySoundFont, through the **same
per-channel EQ → mix → master bus**. `src/synth/SfzSynth.{h,cpp}` keeps **one `sfz::Sfizz` per MIDI
channel**, mirroring `SoundFontSynth`. Threading mirrors the `pluginLock` idiom: a lock-free
`activeMask()` lets the audio thread choose TSF-vs-SFZ routing per channel **without** touching
instances; instances are only read between `tryLock()/unlock()`; loads swap+free on the message thread
under the lock. `AudioEngine` forks in `applyEvent` + the per-channel render loop (SFZ-channel mixer
gain/pan applied **post-render**, since sfizz bypasses TSF's internal volume/pan). The per-block lock is
taken **after** the only early-return so it can't leak.
- **Content/presets:** small CC0 SFZ sets are bundled in `assets/instruments/` (FreePats classical
  guitar 5.2 MB, electric bass 2.8 MB) → copied to `Gomidas.app/Contents/Resources/instruments` by a
  CMake POST_BUILD step. Inspector **SOUNDS** has a live RSE/MIDI pill + a **Preset** dropdown
  (GM SoundFont | bundled presets | loaded custom file | Load file…). Native `loadTrackSfzPreset`
  resolves the bundled path; `loadTrackSfz`/`clearTrackSfz` handle custom files + clearing. Picking a GM
  Sound/Kit clears the SFZ (switches the track back to MIDI). Drums are **not** bundled (good CC0 kits
  are 1.6–2.3 GB → future download-on-first-run).
- **Persistence:** `.gomidas` now wraps the score in an envelope `{ gomidasVersion, instruments, score }`
  (`saveProject`/`gomidasLoadProject` in `app.js`); legacy raw-score files still load. Built-in presets
  persist (matched by name) + reload; custom file loads are session-only.
- **Event format extended** (`NoteEvent.kind`/`value`): kind 0=note, 1=pitch-bend, 2=CC. Native parses
  optional 8th/9th array elements; `applyEvent` dispatches to TSF (`tsf_channel_set_pitchwheel`/
  `_midi_control`, bend range ±12) or sfizz (`pitchWheel`/`cc`; bundled SFZs given `bend_up/down=1200`).
  **Bend emission is live** (`emitBendEvents` in `app.js`): a bent note's `bendPoints` are traced as
  kind-1 pitch-bend events over the note, then the wheel is **reset to centre at a fractional tick just
  before the note end** so it sorts before the next note-on and never leaves the channel detuned. Bend is
  per-channel (a bent note bends the whole channel in a chord — fine for lead bends). Imported GP bends
  play too. _Still deferred:_ pitch-bend *slides* (legato vs shift nuance) + CC emission.
- ⚠️ **`buildSequence` must return the event list TICK-SORTED (stable)** — every consumer assumes it:
  the web scheduler walks it with a running cursor (`selectWindow`) and seeks with a **binary search**
  (`indexAtOrAfter`), and `applyEvent` runs in array order. Emission order is per note (`[on, off,
  bend…]`) and per track, so the raw list is not ascending — a chord alone breaks it. Only the desktop
  build used to sort (`MainComponent::rebuildSequence`), which is exactly why **bends were audible
  natively and silent on web** (GMD-43): the scheduler applied a note's note-off — which drops the voice
  from the instrument's voice map — *before* that note's own bend events, so `pitchBend` had no voice to
  ramp. Fixed by sorting in `buildSequence` itself; native now `stable_sort`s to preserve equal-tick
  order (note-on before its bend points; note-off at T before the next note-on at T).
- ⚠️ **On web, never read `AudioParam.value` for a scheduled note** — the lookahead scheduler runs
  100ms–2s ahead, so the automation usually has not run and `.value` returns the node default (1.0
  for a GainNode), not the note's level. This has now caused two shipped bugs: bends (GMD-43) and
  **palm mutes releasing from FULL GAIN** (GMD-44/GMD-48 — every note ended with a re-attack louder
  than its own peak; measured 16 amplitude attacks for an 8-note palm-muted riff). The rule: a voice
  **records the envelope it scheduled** and asks `envelopeLevelAt(points, t)` for the level at the
  release time (`webaudio.ts`; unit-tested in `tests/envelope-level.test.js`). `cancelAndHoldAtTime`
  would do it natively but Firefox lacks it, and one path keeps the offline bounce deterministic.
  ⚠️ There are **three near-identical instrument factories** (SF2 / SFZ / tone placeholder) — GMD-44
  was closed after fixing only one of them, so the default instrument kept the bug. Change all three.

- **Build:** sfizz 1.2.3 via FetchContent (static; built as **C++17** — app stays C++20).
  `cmake/patch_sfizz.py` (idempotent FetchContent `PATCH_COMMAND`) fixes the arm64 `-mfpu`/`-mfloat-abi`
  flags + an `atomic_queue` template-keyword conformance error. See `docs/REALISTIC_SOUND.md` §7.
- **Audio path verified (non-GUI):** `tests/sfz_smoketest.cpp` (`-DGOMIDAS_BUILD_TESTS=ON`) loads a bundled
  SFZ, plays a note, asserts non-silent output — guitar+bass PASS (FLAC decode + render confirmed). The
  in-app inspector→engine→speakers routing is still GUI-only; ear-check via inspector Preset → play.

### Web drums — the pack, and the two SF2 curves (GMD-50 / GMD-51, 2026-08-14)
The browser fetched sonivox while the desktop loaded FluidR3, so web drums were the Android EAS
bank: **kick = 402 frames @ 20 kHz = 20 ms, one velocity layer**; snare 176 ms @ 16 kHz; nothing
above ~8 kHz. That — not our envelope code — is "dull". FluidR3's kick is 283 ms @ 44.1 kHz
stereo and its snare has **seven** velocity layers.
- **The pack:** `packages/core/tools/extract-sf2-pack.mjs` extracts FluidR3 bank 128 to
  `assets/drumkits/gm-standard.{json,bin}` (105 samples, 5.4 MB FLAC), **committed** because
  FluidR3 is gitignored. Each sample is **its own complete audio file** inside the blob — a single
  re-encoded sprite smears hits together and lossy priming shifts every later offset. Verified in
  Chrome: 105/105 decode, frame-exact (12462 declared = 12462 decoded), 213 ms to fetch+decode.
  Fetched lazily on the first percussion note; **sonivox stays the fallback** (verified by
  blocking the fetch). FLAC over Opus (1.6 MB) on purpose: no priming eating the transient.
- ⚠️ **initialAttenuation is NOT literal centibels.** Read as spec (`10^(-cB/200)`), FluidR3 plays
  its kick 10 dB and its closed hat 21 dB below its snare — a snare with faint company, and the
  "drums are very low" report. fluidsynth divides by **531.509** ("by the standard this should be
  -200.0") because the EMU hardware banks were authored against did not follow the spec. Same
  zones then read kick −3.8 dB, hat −7.9 dB, crash −6.0 dB. Match the player, not the document
  (`SF2.attenuationGain`). Note TSF uses the literal −200, so **desktop under-plays FluidR3 too**.
- **Velocity is squared, not linear** (`SF2.velocityGain`): SF2's default velocity→attenuation
  modulator works out to amp = (vel/127)², to within a rounding error of fluidsynth's table. TSF is
  linear, so this is a deliberate web/desktop divergence.
- **Percussion rules:** a non-looping percussion zone is a **one-shot** — note-off must not touch
  it (a crash written on a 16th is not a 16th long); a **looping** drum zone still honours note-off
  or it rings forever (sonivox's hats are loopMode 1). **Exclusive class (gen 57) is parsed and
  enforced** — 42/44/46 share a class in both banks, so before this the closed hat never cut the
  open one. Measured: open-hat tail RMS 0.01405 → 0.00062 after the choke, untouched before it.
  `allNotesOff` fades over 80 ms rather than the zone release, or Stop leaves a 9 s crash ringing.
- **Kit selection:** use `bank.findDrumPreset(program)`, never `findPreset(128, program)` — the
  latter falls back to "same program in bank 0", so sonivox answers program 16 with **Organ 1**.
- ⚠️ **Never write `percussion = (channel === 9)`** (GMD-54). Four call sites did, so a file whose
  drum track sits on any other channel took the melodic branch, where a drum note's key becomes
  `note.realValue` on a melodic program — soft wooden thuds at arbitrary pitches. Ask
  **`GomidasCore.trackChannelInfo(track)`**: percussion comes from `staff.isPercussion` (or the
  articulations, or channel 9) and percussion tracks are forced onto channel 9, which is what
  selects bank 128 in both engines. Shared core → both products.
- ⚠️ **An imported GP3–5 drum track has an EMPTY `percussionArticulations`.** `buildSequence`'s
  `note.realValue` fallback is what carries it, and that is correct for those files: alphaTab's
  GP5 importer puts real GM numbers in `percussionArticulation`/`realValue` (measured on a Pantera
  .gp5: 35 ac-kick, 40 e-snare, 46 open hat, 53 ride bell). Don't "fix" the fallback away.
- The loader logs `[Gomidas] drum kit: Standard (105 samples) — FluidR3 pack`, and warns with the
  reason on fallback. Check that line before debating whether the good kit is playing — the editor
  serves compiled `dist/core/*.js`, so a tab left open across a `tsc` build runs the OLD player.
- **How to measure any of this** (the tab is always `document.hidden`, so rAF and the meter are
  dead): stub `GomidasFiles.saveData` to capture instead of download, call
  `GomidasAudio.startRecording()` — the offline bounce — and analyse the WAV. Deterministic, and
  it exercises the real instrument path.

### Web melodic instruments — per-program FluidR3 packs (GMD-57, 2026-08-14)
GMD-50 fixed percussion and left guitars and basses on sonivox. Same extractor, same pack format,
new mode: `extract-sf2-pack.mjs --bank 0 --split` writes `assets/instruments-gm/gm-melodic.json`
(every program's zone table) plus **one `.bin` per program**.
- **Per-program, not per-family, because melodic presets share almost no samples.** Measured on
  FluidR3: guitars 24–31 are 83 samples summed per-program and **82 unique**; basses 32–39, 65 and
  65. The split therefore costs nothing in total size and a score using one guitar fetches ~1MB
  instead of the 5.89MB family. (Drums are the opposite — a kit is one unit — so they stay
  single-blob.) Guitars+basses total **9.09MB FLAC** from 19.99MB PCM; biggest single program is
  Overdrive Guitar at 1.81MB, most are under 1MB.
- **The manifest is 482KB raw but 7.5KB brotli**, so it is one cheap fetch that also says *which*
  programs are packed — that's how we avoid firing a 404 per note for the ~100 unpacked programs.
  `melodicPacks` stores **null** for a known-unpacked program; `|| gmBank` is then the intended
  path, not a fallback.
- **Don't downsample guitar/bass.** Capping at 22.05kHz saves only 9.06→8.07MB because most of
  those zones are already ≤22kHz in FluidR3. It *is* worth it for the 32k/44.1k families (piano
  7.72→6.35, strings 14.58→9.79) if those ever ship.
- **FLAC, never Opus — and the melodic reason is stronger than the drum one.** These zones *loop*,
  the runtime derives loop points as `(startLoop - start) / rate` in frames, and Opus adds priming
  delay and forces 48kHz, so every sustained note would click at each loop boundary.
- ⚠️ **`bankFor(program, perc)` is THE ONE PLACE a bank is chosen.** `renderOffline` used to carry
  its own copy of that expression, commented "Same bank choice as live playback", which silently
  stopped being true the moment packs existed — the bounce measured *byte-identical* with packs
  present and packs 404ing. Same failure shape as GMD-44's three instrument factories. If you add
  an instrument source, extend `bankFor`; do not add a branch. (SFZ still diverges here: GMD-62.)
- Logs `[Gomidas] instrument 27: Clean Guitar (10 samples) — FluidR3 pack` per program, and warns
  with the reason on fallback. Verified A/B on the sample score: brightness (first-difference
  energy ratio) **0.0367 sonivox → 0.1604 packs**, RMS 0.128 → 0.178.
- ⚠️ FluidR3 is ~1.2dB hotter than sonivox, which **exposes GMD-42**: the bounce now pins at full
  scale (410/529200 samples, 52 runs, longest 0.41ms). Gain staging needs headroom before master.

### Web pack cache — IndexedDB, so a repeat visit is shell-only (GMD-58, 2026-08-15)
`core/packcache.ts` (`GomidasPackCache`) caches every lazily-fetched **binary** payload — sonivox,
the drum `.bin`, the per-program melodic `.bin`s, SFZ definitions + samples. One helper,
`packFetch(url, expectedBytes)` in `webaudio.ts`, is the only fetch path for all of them.
Measured: cold visit 3 misses / 2.2MB; **warm visit 3 hits / 0 bytes**, with only the manifest on
the wire. The 5.4MB drum blob round-trips exactly, 8ms warm.
- **The JSON heads are deliberately NOT cached.** The manifest is 482KB raw but 7.5KB brotli, and
  it is what declares each blob's `blobBytes` — so reading every blob back against a
  freshly-fetched head gives invalidation for free. A re-extract invalidates automatically; there
  is no version to forget to bump. `CACHE_VERSION` covers only headless payloads (sonivox, SFZ).
- ⚠️ **`indexedDB.open()` can hang with NO event** — not success, not error, not blocked — when a
  `deleteDatabase` from another tab is pending. It froze the renderer because every `fetchBuffer`
  awaited forever. Hence the 3s open / 4s read timeouts. **Nothing on this path may stall a pack
  load**: every failure falls through to the network, and the network to sonivox.
- ⚠️ **A host with an SPA fallback answers a missing pack with 200 `index.html`** — cached, that
  would keep "succeeding" with HTML forever for the payloads with no `blobBytes` to check. Rejected
  on content-type. Remember this when configuring the host in GMD-60.
- Stores a **copy** of the buffer: callers hand these to `decodeAudioData`, which *detaches* its
  input, and the spec does not pin down whether IndexedDB has finished serialising by then.
- Tested without `fake-indexeddb`: the store is an injectable seam, so policy is unit-tested
  (`tests/packcache.test.js`) and the IDB plumbing is verified in Chrome.

### Web mix gain staging — headroom + a soft ceiling (GMD-42, 2026-08-15)
Measured through the offline bounce: **one full-velocity note peaks at +2.88 dBFS**, a three-note
chord +7.52, six-note +9.38, the two-track sample score +5.77 with **410 hard-clipped samples**. A
SINGLE note already exceeds full scale, so this was never a mixing-discipline or too-many-tracks
problem — a voice's peak gain is velocity² × zone attenuation, both capping at 1.0, over a sample
normalised near full scale. Nothing in the chain budgeted for a second voice.
- The master output stage is **−6 dB headroom → 1/`CEILING_RANGE` pre-scale → WaveShaper ceiling**,
  built by `makeOutputStage` and used by **both** the live graph and the bounce. Sample score now
  −1.07 dBFS, 0 clipped. **Don't "restore the levels" by deleting the trim** — that is the bug.
- Deliberately a WaveShaper and **not** a `DynamicsCompressorNode`: zero latency, no attack/release
  to pump or smear a transient, and bit-identical live vs offline. Below the knee the curve is
  exactly `y = x` so ordinary material is untouched, and `oversample = 'none'` keeps that literally
  true (any oversampling runs it through resampling filters first).
- ⚠️ Two traps the unit tests caught and an ear would not. tanh saturates fast enough that
  `knee + (1-knee)*tanh(…)` **rounds to exactly 1.0 in float32** well inside the curve's range,
  which the int16 encode turns straight back into the clipped sample the stage exists to prevent —
  hence `CEILING_MAX = 0.998`. And a WaveShaper **clamps out-of-range input to its end entries**, so
  feeding it a +9 dB peak *without* the pre-scale is hard clipping wearing a different hat. Curve
  shape is pure and unit-tested (`tests/ceiling.test.js`).

### The offline bounce is built from ONE description of the mixer (GMD-62 / GMD-66, 2026-08-15)
`renderOffline` used to hand-rebuild the graph, and kept falling behind — the **third** time this
file shipped that same failure (GMD-57 `bankFor` was the first, GMD-44's three instrument factories
the second). It mirrored each channel's gain/pan/EQ and silently dropped the **entire master
section**: bouncing with the master fader at 0.25 produced a **byte-identical file** to 1.0. Master
pan, master EQ, master inserts, track inserts and sends were all dropped too — and there was no SFZ
branch at all, so a track with an SFZ preset **recorded as GM**.
- **`snapshotMix()` is the single enumeration of what the mixer consists of**, and
  **`makeInstrument(ctx, ch, program, perc, buffers)` the single instrument choice** — the same role
  `bankFor` plays for banks. Add a mixer control → add it to `snapshotMix`. Add an instrument source
  → extend `makeInstrument`. **Never add a branch inside `renderOffline`.**
- `sfzChannels` maps channel → the **parsed preset**, not just membership, because the bounce builds
  its own sampler in its own context: AudioNodes cannot cross contexts, regions and decoded buffers
  can.
- The snapshot's field list is pinned by `tests/mixsnapshot.test.js`, so a new control cannot
  quietly skip the recording.
- ⚠️ **SF2 note-off is FIFO by note INSTANCE, not by key** (GMD-49). One note-on spawns several
  voices for a layered preset and those must release together, but a key retriggered while an
  earlier instance still rings (ties, let ring, repeated notes on one string) must **not** be killed
  by the older note's note-off. Voices from one note-on share a `noteId`; `voicesToRelease` picks the
  oldest surviving instance and skips one-shots. The SFZ and tone instruments already did this — only
  the default instrument for every track had it wrong.

### Real-time-safety caveats (milestone-1; harden before shipping)
TSF voice alloc + the `Sequence` swap, **the input-plugin swap/free + `processBlock`**, **the EQ
coeff swap (`eqLock`)**, and **the per-channel SFZ instance swap (`SfzSynth`'s lock)**, all happen on the
audio thread under a `SpinLock` (tryEnter). Fine for a dev build; revisit for production.
