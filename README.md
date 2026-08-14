# Gomidas

A **Guitar-Pro-like** tab editor and player for guitar, bass and drums — macOS-first,
built on **JUCE 8 / C++20** with [alphaTab](https://alphatab.net) for notation rendering and
[TinySoundFont](https://github.com/schellingb/TinySoundFont) for MIDI playback.

Load any Guitar Pro tab (GP3–GP8), see it as **tab + standard notation**, **edit it**, and
**play it back** through a bundled General-MIDI SoundFont — then (later) play on top with your own
instrument through a VST chain.

> Commercial, closed-source product. © 2026 Alexis Giovoglanian.
> Sibling apps: **Conduit** (VST host + routing + stems), **Pitchyn** (pitch), **Saturation Engine**.

---

## Status

**Phase 1 (editor + MIDI playback): shipping.** Load/render GP3–8 + MusicXML, edit
notes/durations/beats/bars, multi-track editing, New/Open/Save, undo/redo, native MIDI playback with
transport + good SoundFont, per-track mixer (volume/mute/solo), auto-scroll, drum tracks, a GP8-style
dark UI, native macOS menu bar, and recent-files.

See **[`docs/FEATURES.md`](docs/FEATURES.md)** for the full implemented-feature list and
**[`docs/BACKLOG.md`](docs/BACKLOG.md)** for what's planned.

---

## Build

Requires CMake ≥ 3.22 and a C++20 toolchain (Xcode on macOS). The first configure fetches JUCE 8.0.13.

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug   # first run fetches JUCE 8.0.13
cmake --build build
open "build/Gomidas_artefacts/Debug/Gomidas.app"
```

The web front-end (`packages/core/`) and the GM SoundFont (`assets/`) are embedded into the binary via
`juce_add_binary_data`, so there are no runtime asset paths to manage — editing a file under `packages/core/`
and rebuilding re-embeds it.

### SoundFonts

Playback uses a General-MIDI SoundFont embedded at build time. Two banks live under
`assets/soundfont/`:

| File | Size | Tracked in git? | Used when |
|------|------|-----------------|-----------|
| `sonivox.sf2` | ~1.3 MB | ✅ yes | fallback — always available |
| `FluidR3_GM.sf2` | ~144 MB | ❌ no (too large for GitHub's 100 MB limit) | bundled if present at configure time |

The repo ships only the small **sonivox** bank, so the project builds and plays out of the box.
For higher-quality playback, drop the optional **FluidR3_GM** bank in place before configuring:

```bash
# Download FluidR3_GM.sf2 (MIT-licensed, ~144 MB) and place it here:
#   assets/soundfont/FluidR3_GM.sf2
# Canonical source: https://member.keymusician.com/Member/FluidR3_GM/index.html
#   (also bundled with MuseScore as FluidR3Mono_GM.sf3 — the .sf2 form is what we want)
curl -L -o assets/soundfont/FluidR3_GM.sf2 <url-to-FluidR3_GM.sf2>
```

CMake auto-detects it: `assets/soundfont/FluidR3_GM.sf2` present → bundles FluidR3; absent →
falls back to the embedded sonivox bank (see `CMakeLists.txt`). Reconfigure after adding it.

#### Drums on the web build

144 MB cannot go over the wire, and sonivox's kit is a 20 ms kick sampled at 20 kHz — which is
exactly what "the drums sound like cardboard" is. So the browser build loads a **drum-only pack**
extracted from FluidR3 once and committed:

| File | Size | Tracked in git? |
|------|------|-----------------|
| `assets/drumkits/gm-standard.json` | ~75 KB | ✅ yes |
| `assets/drumkits/gm-standard.bin` | ~5.4 MB (FLAC) | ✅ yes |

It is fetched lazily on the first percussion note, so a guitar tab never pays for it, and it falls
back to sonivox if it is missing. Regenerate it only if the kit selection changes — you need
FluidR3 in place plus `ffmpeg`:

```bash
npm --prefix packages/core run build          # the tool reads dist/core/sf2.js
node packages/core/tools/extract-drumkit.mjs  # --programs 0,8,16  --codec flac|opus|aac
```

---

## Architecture

```
JUCE Standalone macOS app
├─ WebView (alphaTab, MPL-2.0)  = SOURCE OF TRUTH for the score
│   ├─ parse GP3–GP8 / MusicXML, render tab + notation, editing UI (our editing layer)
│   └─ walks the model → flat MIDI event list → native (on every edit)
└─ Native C++
    ├─ AudioEngine: AudioDeviceManager + transport clock (960 PPQ) + scheduler + per-track mixer
    ├─ SoundFontSynth: TinySoundFont (MIT) + bundled GM SoundFont
    └─ (later) live input → VST/AU host chain + mixer
```

**Key rule: native owns the clock; alphaTab only renders and moves its cursor.** All audio is native,
so MIDI tracks, the synth, the (future) live VST chain and the playback cursor stay in sync off one
master transport. The editing layer is ours — alphaTab is a renderer, not an editor.

### Why these choices
- **alphaTab** already encodes every GP notation/MIDI semantic and parses GP3–GP8; rebuilding that
  natively would take months.
- **TinySoundFont** (single-header, MIT) is commercial-safe and audio-thread friendly.
- We import `.gp` and save to our own `.gomidas` project format (alphaTab score JSON); no `.gp`
  write-back initially.

---

## Project layout

```
CMakeLists.txt               juce_add_gui_app + juce_add_binary_data(GomidasAssets)
src/Main.cpp                 JUCEApplication + DocumentWindow
src/ui/MainComponent.*       WebView host + JS↔C++ bridge + native menu bar + Open/Recent files
src/engine/AudioEngine.*     device, transport, scheduler, per-channel mixer, Sequence hand-off
src/synth/SoundFontSynth.*   TinySoundFont wrapper
src/synth/tsf/tsf.h          vendored TinySoundFont (MIT)
packages/core/index.html               GP8-style dark 4-panel layout
packages/core/app.js                   alphaTab host, model→MIDI, native bridge, mixer/view, New dialog
packages/core/editor.js                tab editor: cursor/nav/entry, effects, drums, cursors, auto-scroll
packages/core/fretboard.js             left edit bar, fretboard / drum palette, inspector, track list
packages/core/alphaTab.min.js          alphaTab bundle (embedded)
assets/soundfont/            GM SoundFont (embedded; native synth)
docs/FEATURES.md             implemented features (+ GP8 key mapping)
docs/BACKLOG.md              roadmap / not-yet-built
docs/references/             GP8 keyboard-shortcut reference
CLAUDE.md                    deep engineering notes (read before touching engine code)
```

---

## Editing (mouse-first, keyboard secondary)

The keymap is **GP8-faithful** (Gomidas has no legacy muscle memory to preserve). A few highlights:

- **Notes:** type a fret on the current string (`0`–`9`, instant; a 2nd digit within 600 ms amends,
  e.g. `1` then `2` = fret 12), or click the auto-sized **fretboard**. `⌫` deletes.
- **Duration & rhythm:** `+`/`-` shorter/longer · `.`/`⌘.` dot/double-dot · `/` triplet · `R` rest.
- **Beats & bars:** `⌃+` insert beat · `⌘-` delete beat · `⌘+` insert bar · `⌃-` delete bar.
- **Effects:** palm-mute `P`/`⇧P` · dead `X` · let-ring `I` · tie `L`/`⇧L` · hammer/pull `H` ·
  slide `S` · ghost `O` · staccato `!` · accent `;`/`:` · natural harmonic `Y` · vibrato `V` ·
  transpose `⌥⇧↑/↓` (semitone) / `⌥↑/↓` (octave).
- **Transport:** `Space` = play/stop (auto-scroll follows the cursor); `⌘Z`/`⌘⇧Z` undo/redo.
- **Drums:** percussion tracks swap the fretboard for a **drum-pad palette**; click a pad to toggle a hit.

Full mapping and feature status live in [`docs/FEATURES.md`](docs/FEATURES.md).

---

## Roadmap

- **Phase 1 — editor + MIDI playback:** shipping (see Status).
- **Phase 2 — play-on-top (the product's #1 priority):** live input through a per-track VST/AU chain
  + mix, record/loop, A/B loop, count-in/metronome, tempo slow-down. (Mixer vol/mute/solo done.)
- **Phase 3 — export & sync:** `.gp` export (alphaTab `Gp7Exporter`), and stem-separation to sync
  real recordings to tabs against the drum track (reuse Conduit's `build-stems`).

---

## License

Proprietary / closed-source. © 2026 Alexis Giovoglanian. All rights reserved.

Third-party components: alphaTab (MPL-2.0), TinySoundFont (MIT), JUCE 8 (commercial/AGPL),
Bravura music font (SIL OFL), bundled General-MIDI SoundFont.
