# Gomidas — Realistic Sound (RSE-equivalent)

Design + implementation plan for giving Gomidas a realistic, sample-based sound engine —
the equivalent of Guitar Pro's **RSE** ("Realistic Sound Engine"), built legally from scratch.

> Status (2026-06-29): **Phase 0 + Phase-A engine landed** — sfizz is integrated, per-track SFZ
> instruments build/link/run; not yet runtime-verified to make sound (see §7). Remaining phases are
> tracked in [`BACKLOG.md`](./BACKLOG.md) under *Realistic Sound*. Bundled-content licensing lives in
> [`SOUND_LIBRARIES.md`](./SOUND_LIBRARIES.md).

---

## 1. What we're building (and the legal framing)

"RSE" is three separate things, and only some of them are Arobas Music's (Guitar Pro's) to own:

| Layer | Owned by Arobas? | Our position |
| --- | --- | --- |
| The **name "RSE"** | Yes (trademark) | Don't use it. Ship our own name (e.g. *Studio Sound*). |
| The **soundbanks / samples** | Yes (licensed content) | Can't reuse. We bundle our own CC0/permissive samples. |
| The **engine concept** (multisample + articulation mapping + amp sim) | No — universal | Free to rebuild. This is the work. |

So the goal is **not** "clone RSE." It's: a sample-based per-track instrument engine with an
articulation-mapping layer, sounding good out of the box, with an upgrade path to pro libraries.

### The two-pronged approach (decided with the user, A-first)

- **A — Bundled SFZ default (build first).** Ship a CC0 sample set (guitar/bass/drums) played by the
  **sfizz** engine (BSD/ISC, embeddable). Sounds good with zero setup, no VST required. We control the
  SFZ layout, so articulations map to real alternate samples / keyswitches.
- **B — Per-track VST3/AU instruments (after A).** Each track can load Ample Guitar, Shreddage,
  MODO Bass, EZdrummer, etc. This is roadmap **priority #2**. Realism lives in the user's library; we
  build the hosting + the articulation→keyswitch/pitch-bend mapping.

Both ride on the **same foundation** (Phase 0): a per-track instrument abstraction + an extended
event format. Build it once, A and B branch off it.

---

## 2. Current architecture (verified, with file:line)

What exists today (the playback path we're extending):

- **Channel = track = instrument.** `SoundFontSynth` keeps one TinySoundFont instance per MIDI
  channel — `tsf* chan[16]` (`src/synth/SoundFontSynth.h:50`), each a `tsf_copy` of a shared template
  (`SoundFontSynth.cpp:43-47`, refcounts the soundfont samples so copies are cheap). GM channel 9 =
  percussion.
- **Per-channel render loop.** The audio callback
  `AudioEngine::audioDeviceIOCallbackWithContext()` (`src/engine/AudioEngine.cpp:283-537`):
  1. sequences events → `noteOn`/`noteOff`/`programChange` (lines 363-408),
  2. **per-channel render → per-channel 3-band EQ → sum** (lines 427-455) — *this is the insertion
     point for a different instrument backend*,
  3. master EQ (457-470), master gain/pan (472-480),
  4. live-input insert + optional plugin (488-520),
  5. output + WAV recording (482-533).
  `renderChannel(c)` skips channels with no active voices (fast path), so CPU scales with audible
  tracks.
- **Event format (the main gap).** `struct NoteEvent` (`src/engine/AudioEngine.h:14-30`):
  `{ double tick; int channel; int key; float velocity; bool on; int program; bool percussion; }`.
  **No pitch-bend, no CC, no keyswitch concept.** Per-event channel exists. Transport is 960 PPQ
  (`AudioEngine.h:59`).
- **JS builds the events.** `web/app.js rebuildSequence` walks the alphaTab model into a flat array
  `[tick, channel, key, vel, on, program, percussion]` (`app.js:263-265`) and ships it via
  `nativeInvoke('setSequence', …)` (`app.js:315`). Articulation reshaping (velocity/duration only)
  is at `app.js:241-255` — dead/palm-mute/staccato/ghost/accent/hammer-pull-dest. Everything else
  (harmonics, slides, vibrato, trills, bends, brush, slap, fade…) is **notation-only**, ignored by
  the MIDI builder.
- **A working VST host already exists** (the pattern B copies). Live-input insert:
  `juce::AudioPluginFormatManager pluginFormatManager` + `addDefaultFormatsToManager` (AU+VST3,
  `AudioEngine.cpp:52`); load via `loadInputPlugin()` (65-102) creating an `AudioPluginInstance`;
  message-thread `ownedPlugin` swapped onto the audio thread under a `juce::SpinLock pluginLock`
  with a `tryEnter`-guarded `processBlock` (504-511); `PluginEditorWindow` (8-23) hosts the editor.
- **Native bridge** (`src/ui/MainComponent.cpp`): `WebBrowserComponent::Options::withNativeFunction`
  registers ~26 functions (`setSequence`, `preview`, `setChannelMix`, `setTrackEq`, `loadInputPlugin`,
  `showPluginEditor`, …). Adding one = one more `.withNativeFunction(...)` lambda.

---

## 3. Target architecture

### 3.1 `TrackInstrument` abstraction (Phase 0)

A pluggable per-channel instrument. Backends: TSF (default, today's behavior), sfizz (A), VST (B).

```cpp
class TrackInstrument {
public:
    virtual ~TrackInstrument() = default;
    virtual void prepare (double sampleRate, int blockSize) = 0;
    // Sequencer-driven, block-quantized like today (sample offsets optional for v1):
    virtual void noteOn  (int key, float vel, int sampleOffset) = 0;
    virtual void noteOff (int key, int sampleOffset) = 0;
    virtual void pitchBend (int value14, int sampleOffset) = 0;   // slides / bends
    virtual void controlChange (int cc, int val, int sampleOffset) = 0;
    virtual void programChange (int program) = 0;
    virtual void render (juce::AudioBuffer<float>& stereoOut, int numSamples) = 0;
    virtual void reset() = 0;                                      // panic / all notes off
};
```

`AudioEngine` holds `std::array<std::unique_ptr<TrackInstrument>, 16> trackInstr` — an **override
slot** per channel. **Null → fall back to the existing TSF path.** Swapped on the message thread under
a new `juce::SpinLock instrLock` (mirrors `pluginLock`), owned/freed on the message thread. This makes
Phase 0 *additive and low-risk*: with no overrides set, playback is byte-for-byte today's behavior.

Backends:
- `TsfInstrument` — optional wrapper of the current per-channel TSF (or just keep the fallback path).
- `SfizzInstrument` — wraps `sfz::Sfizz`; native delay offsets, `pitchWheel`, `cc`, `renderBlock`.
- `VstInstrument` — wraps `juce::AudioPluginInstance`; fed a per-channel `MidiBuffer`, then
  `processBlock` → audio.

### 3.2 Extended event format (Phase 0)

Add a discriminant so events can carry pitch-bend / CC. Keyswitches need nothing new — they're just
note-on/off on a low key.

- **Native:** extend `NoteEvent` with `int kind = 0; int value = 0;`
  (`kind` 0=note, 1=pitchBend [value 0..16383], 2=cc [key=cc#, value=ccVal]).
- **JS:** append to the array → `[tick, ch, key, vel, on, prog, perc, kind, value]` (backward-compatible;
  missing → kind 0). Parsed in `MainComponent` `handleSetSequence`.
- **Dispatch:** the sequencer loop routes pitch-bend/CC to the channel's instrument — and to TSF on the
  default path via `tsf_channel_set_pitchwheel` / `tsf_channel_midi_control` (both already in `tsf.h`).

Bonus: this alone makes **slides and bends audible** (today notation-only) on every backend.

### 3.3 Sequencer routing fork (Phase 0)

In the event loop (`AudioEngine.cpp:363-408`):
- If `trackInstr[ch]` is a **VST** → accumulate the event into a per-channel `MidiBuffer` (with sample
  offset) for that block.
- If it's **sfizz / TSF** → call `noteOn/noteOff/pitchBend/controlChange` directly.

Then in the render loop (427-455): if `trackInstr[ch]` is set, `render()` from it (VST: `processBlock`
the accumulated MidiBuffer); else fall through to today's `synth.renderChannel(c)`. EQ/sum/master
chain downstream is unchanged.

### 3.4 Articulation-mapping layer (Phase C — the genuinely-ours part)

In `web/app.js rebuildSequence`, insertion point ~`app.js:251` (after the existing velocity/duration
reshaping, before the note-on is pushed). Emit, per note/beat:
- **Pitch-bend ramps** for slides (`slideOutType`) and bends — *universal*, work on any backend.
- **Keyswitches** for palm-mute / harmonic / dead / etc. — only where we control the mapping
  (our bundled SFZ; per-VST presets later). Each VST library uses different keys, so keyswitching
  arbitrary VSTs is a later, preset-driven feature.
- Keep the existing velocity/duration shaping.

The mapping table (articulation → {keyswitch key | pitch-bend curve | CC}) is **per-instrument**.
For the bundled SFZ we define it ourselves in the `.sfz`.

---

## 4. Phased plan

### Phase 0 — Shared foundation *(prereq for A and B)*
- [ ] Add **sfizz** to `CMakeLists.txt` (FetchContent).
- [ ] `TrackInstrument` interface + per-channel override slot in `AudioEngine` (`instrLock`, null→TSF).
- [ ] Extend event format (`kind`+`value`) on JS + native; dispatch pitch-bend/CC (incl. TSF path).
- [ ] Sequencer routing fork (VST→MidiBuffer, sfizz/TSF→direct calls); render from override if set.
- [ ] Prove end-to-end: one `SfizzInstrument` + a hard-coded test `.sfz` on one track, audible.
- **Bonus delivered:** slides/bends become audible on the default TSF engine.

### Phase A — Bundled SFZ default *(build first after Phase 0)*
- [ ] `SfizzInstrument : TrackInstrument` (full: prepare/note/bend/cc/render/reset).
- [ ] Acquire + verify the CC0 content (see [`SOUND_LIBRARIES.md`](./SOUND_LIBRARIES.md)).
- [ ] Author our `.sfz` layout for guitar/bass/drums incl. the articulation/keyswitch map.
- [ ] Bundle samples (size-aware: Karoryfer Big Rusty Drums is ~2.3 GB — decide bundled vs
      download-on-first-run; see Open Questions).
- [ ] Native: `setTrackInstrument(channel, 'sfz', presetId)` / `clearTrackInstrument(channel)`.
- [ ] UI: inspector SOUNDS **sound-source picker** ("Studio (SFZ)" presets) — reuse the deferred
      "RSE pill" stub. Per-track engine choice.
- [ ] Persist the assignment in `.gomidas`.

### Phase B — Per-track VST instruments *(roadmap priority #2)*
- [ ] `VstInstrument : TrackInstrument` (per-channel MidiBuffer feed; reuse `pluginFormatManager`).
- [ ] Generalize `PluginEditorWindow` to N windows; native `showTrackPluginEditor(channel)`.
- [ ] **Plugin state save/restore** in `.gomidas` (`getStateInformation` → base64) — closes the
      existing "plugin state-save" backlog item.
- [ ] UI: sound-source picker → "Plugin…" → file chooser → `setTrackInstrument(channel,'vst',path)`.
- [ ] (Later) per-track plugin *chains* (multiple inserts), per-VST articulation presets.

### Phase C — Articulation mapping *(realism; can overlap A/B)*
- [ ] Pitch-bend ramps for slides/bends in `rebuildSequence` (universal).
- [ ] Keyswitch emission for palm-mute/harmonic/dead matching the bundled-SFZ layout.
- [ ] (Later) tremolo repick, strum spread, fade envelopes, vibrato as pitch-bend LFO.

---

## 5. Cross-cutting concerns

- **Real-time safety.** All instrument swaps go through `instrLock.tryEnter` on the audio thread;
  instances are created/destroyed on the message thread (same discipline as `ownedPlugin`). This adds
  to the existing milestone-1 RT caveats (TSF voice alloc, Sequence swap, plugin swap, EQ swap) —
  harden together before shipping.
- **CPU.** Override channels render unconditionally (samplers/VSTs have tails) — gate them on active
  voices + a tail timer, extending the existing silent-channel fast path. 16 VSTs is heavy; that's a
  user-driven cost (they chose the plugins).
- **Persistence / project format.** A track's instrument assignment (engine kind + preset/path +
  plugin state blob) must be saved to `.gomidas`. This needs a project-format **envelope** around the
  alphaTab score JSON — the *same* envelope EQ-persistence wants. Build it once, use for both.
- **Memory / install size.** Sample content is large. Decide bundle-vs-download (Open Questions).
- **The VST host B reuses is itself runtime-unverified** (see `BACKLOG.md` / memory). Verify the
  existing live-input plugin path actually works at runtime *before* building 16 of them.

---

## 6. Open questions / decisions to make

1. **Bundle vs download-on-first-run** for the large CC0 sample sets (Karoryfer drums ~2.3 GB).
   Likely: ship a small starter set, fetch the big ones on demand to a support dir.
2. **Default engine per track kind** — does a new guitar track default to SFZ or stay GM/TSF until the
   user opts in? (Proposal: SFZ default once content ships; GM as a lightweight fallback.)
3. **Amp sim** for electric guitar — bundle Neural Amp Modeler (MIT) fed by the CC0 clean-DI guitar?
   Strong differentiator, but a later phase (after A's clean/acoustic path works).
4. **Sample-accurate vs block-quantized** note timing — today it's block-quantized (~callback size).
   sfizz/VST support sample offsets; do we upgrade timing now or keep parity for v1? (Proposal: parity
   for v1.)
5. **How far does the per-VST articulation mapping go** — generic pitch-bend only, or shipped presets
   for popular libraries (Shreddage/Ample/EZdrummer)?

---

## 7. Build integration notes — sfizz (implemented 2026-06-29)

sfizz 1.2.3 via FetchContent, **static lib only**, linked as `sfizz::sfizz`. Options:
`SFIZZ_SHARED/RENDER/JACK/LV2/VST/AU/TESTS/DEMOS/DEVTOOLS/BENCHMARKS=OFF`, `SFIZZ_USE_SNDFILE=OFF`
(vendored dr_libs loader — no external libsndfile), `ENABLE_LTO=OFF` (dev builds).

sfizz 1.2.3 is a C++17-era codebase and does NOT build cleanly on arm64 + modern clang. Four fixes,
all committed so clean checkouts build (`cmake/patch_sfizz.py` is an idempotent FetchContent
`PATCH_COMMAND`):
1. **arm64 flags** — sfizz's `(arm.*)` processor regex matches `arm64`, injecting 32-bit-only
   `-mfpu=neon` / `-mfloat-abi=hard`, which clang rejects. Guard *only* `cmake/SfizzConfig.cmake`
   (NEON is baseline on AArch64). **Leave the identical regex in `external/st_audiofile` alone** — it
   needs `arm64` to match so it disables WavPack ASM (which also fails on Apple Silicon).
2. **atomic_queue** — `Base::template do_pop_any(`/`do_push_any(` without a template arg list is a
   hard error on modern clang (`-Wmissing-template-arg-list-after-template-kw`); drop the `template`.
3. **C++20 incompatibilities** (`std::result_of` removed; pre-`char8_t` `u8"..."` literals; abseil
   hash-map) — root-fixed by **building sfizz as C++17**: wrap its `FetchContent_MakeAvailable` with
   `set(CMAKE_CXX_STANDARD 17)` then restore `20`. The app stays C++20; sfizz's public `sfizz.hpp`
   (plain std types) compiles fine under either.

What's wired: `src/synth/SfzSynth.{h,cpp}` (one `sfz::Sfizz` per channel, mirroring `SoundFontSynth`),
`AudioEngine` routing (`applyEvent` + render loop fork, lock-free `activeMask()` + per-block
`tryLock()`), native `loadTrackSfz`/`clearTrackSfz`, Sound-menu items, JS `currentTrackChannel()` /
`gomidasSfzLoaded`.

**To verify audio:** run the app → select a track → Sound → *Load SFZ Instrument for Track…* →
`~/Music/GomidasTest/test.sfz` (a generated test tone) → play. Real CC0 instruments per
[`SOUND_LIBRARIES.md`](./SOUND_LIBRARIES.md) come next.

## 8. Related docs / memory
- [`SOUND_LIBRARIES.md`](./SOUND_LIBRARIES.md) — license-verified CC0/permissive content reference.
- [`BACKLOG.md`](./BACKLOG.md) — phased task tracking (*Realistic Sound* section).
- [`FEATURES.md`](./FEATURES.md) — move items here as they ship.
- CLAUDE.md "Per-track audio buses + EQ" — the per-channel synth re-architecture this builds on.
