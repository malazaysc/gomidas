# Gomidas — Web Port Spec

Working document for the browser build of Gomidas. Written 2026-08-13; open questions decided the
same day (§11), which added Phase 0.5 and repointed the build.

**Read `CLAUDE.md` first.** This document assumes it and does not repeat it.
Work is tracked in Samu as `GMD-30`…`GMD-39` (project `GMD`, workspace `gomidas`).

---

## 0. The decision, in one paragraph

Gomidas is already ~74% a web app: ~6,400 lines of JS/HTML in `web/` versus ~2,330 lines of
C++ in `src/`. alphaTab owns parsing and rendering; the entire editing layer — cursor, keymap,
effects, drum kit view, groove library, beat grid, inspector, track list — is JavaScript that
runs unmodified in a browser today. The C++ is four things: the audio engine, two synths, and
the WebView host.

We are building a **second product**, not replacing the first. The desktop app keeps the things
the web cannot have (VST/AU hosting, low-latency live input — the "play on top" feature). The
web app gets distribution: shareable links, no install, any platform. Both are built from **one
shared core**, split at a formal backend interface.

**Target for the web build: full editor parity with desktop, minus VST and live input.**

---

## 1. Repo strategy

Work happens **in this repository**, on a branch. Do not create a separate repo.

```
git checkout -b feat/web-app
```

The shared code is not "similar" between the two apps — it is *the same files*. A separate repo
means copying 4,200 lines of editor JS and drifting within a week. A branch gives the same
isolation with none of the divergence.

**Do not restructure up front.** Add `apps/web/` alongside the existing `web/` and import
directly from `../../web/`. Let the seam emerge from real work. The eventual
`web/` → `packages/core/` rename is **the last step**, not the first — it is cosmetic and
should only happen once the boundary is proven.

### Hard rule

> Every commit must leave `cmake --build build` green and the macOS app behaving identically.

This is the entire reason for working in one repo. When a refactor moves something behind the
backend interface, the desktop build proves in thirty seconds that nothing broke. Verify it.

### 1.1 TypeScript, and why it is cheap here (measured 2026-08-13)

The decision in §11 is **TypeScript**, against this document's original recommendation. The
premise that recommendation rested on — *shared files stay byte-identical* — does die. What
replaces it is nearly as good, and the reason is a property of how the app already loads:

`web/index.html:701-707` loads every script as a plain `<script src>` tag exporting **globals**.
No ES modules, no bundler, no build step anywhere in the repo (`web/package.json` has only
Vitest + alphaTab). `gomidas-core.js` is deliberately dual-mode — `window.GomidasCore` in the
browser, `module.exports` under Node.

Therefore **`tsc` alone suffices — no bundler.** With `module: none` and per-file emit, one `.js`
comes out per `.ts`, the script order is unchanged, and `juce_add_binary_data` simply points at
`web/dist/` instead of `web/`. The desktop app never learns that TypeScript exists.

What it genuinely costs:

- `cmake --build` gains a **Node dependency** — the codegen must run before the C++ build, so the
  §1 hard rule now means *generate, then build, then verify*.
- The CI `native-tests` job needs `setup-node`.
- "Shared files are byte-identical" becomes "shared **generated** files are identical."

Migration is a **ratchet, never a big-bang port**: `allowJs: true` from day one, convert a file per
phase, raise strictness as you go. Start with `backend.ts` and `gomidas-core.ts` — the core is only
472 lines and has 62 Vitest tests as a safety net. `editor.js` (2,612 lines) converts late.
`juce_native_interop.js` is vendored from JUCE and stays JavaScript, untouched.

### Coupling that will need touching (it is small)

| What | Where |
|---|---|
| Embedded web assets | `CMakeLists.txt:72-83` — twelve file-path strings in `juce_add_binary_data` (repoint to `web/dist/` in Phase 0.5) |
| CI web job | `.github/workflows/ci.yml` — `working-directory: web`, `cache-dependency-path` |
| Test imports | `web/tests/*.js` — relative `../core/gomidas-core.js` |

Also add a `paths-ignore` filter to the `native-tests` CI job so web-only pushes don't spin up a
macOS runner to build JUCE and sfizz.

---

## 2. The seam — two interfaces, not one

Today there is exactly one door between the editor and the host: `nativeInvoke(name, payload)`
at `web/app.js:17`, with **29 distinct call names**. That door becomes two typed interfaces.

The calls split cleanly, and the split matters — the file/shell group is the one that differs
most between platforms and it has nothing to do with audio.

### 2.1 `AudioBackend`

```js
/**
 * @typedef {Object} AudioBackend
 *
 * // ---- transport ----
 * @property {(seq: Sequence) => void}            setSequence
 * @property {() => void}                          play
 * @property {() => void}                          stop
 * @property {(tick: number) => void}              seek
 * @property {() => void}                          panic
 * @property {(on: boolean, startTick?: number, endTick?: number) => void} setLoop
 * @property {(bpm: number) => void}               setTempo
 * @property {(rate: number) => void}              setPlaybackRate
 *
 * // ---- mixer ----
 * @property {(ch: number, gain: number, pan: number) => void}  setChannelMix
 * @property {(gain: number, pan: number) => void}              setMasterMix
 * @property {(ch: number, low: number, mid: number, high: number) => void} setTrackEq
 * @property {(low: number, mid: number, high: number) => void}             setMasterEq
 *
 * // ---- instruments ----
 * @property {(ch: number, presetId: string) => Promise<InstrumentInfo>} loadTrackPreset
 * @property {(ch: number) => void}                                       clearTrackInstrument
 * @property {(ch, program, percussion, keys: number[]) => void}          preview
 *
 * // ---- effects (new; see §5) ----
 * @property {(ch: number, chain: FxChain) => void}  setTrackFx
 * @property {(chain: FxChain) => void}              setMasterFx
 * @property {(ch: number, sends: SendLevels) => void} setTrackSends
 *
 * // ---- recording ----
 * @property {() => Promise<void>}  startRecording
 * @property {() => Promise<Blob|void>} stopRecording
 *
 * // ---- desktop-only; absent on web (guard with caps) ----
 * @property {(on: boolean, gain: number) => boolean} [setLiveInput]
 * @property {() => Promise<string>}                  [loadInputPlugin]
 * @property {() => void}                             [clearInputPlugin]
 * @property {() => void}                             [showPluginEditor]
 *
 * @property {BackendCaps} caps
 * @property {(event: string, handler: Function) => void} on
 */
```

`loadTrackSfz` / `loadTrackSfzPreset` / `clearTrackSfz` are deliberately generalised to
`loadTrackPreset` / `clearTrackInstrument`. The editor should not know whether a preset is SFZ,
SoundFont, or something else — that is the backend's business.

### 2.2 `HostBackend`

```js
/**
 * @typedef {Object} HostBackend
 * @property {() => Promise<{name: string, bytes: Uint8Array}|null>} openFile
 * @property {(json: string, suggestedName: string) => Promise<boolean>} saveProject
 * @property {(bytes: Uint8Array, suggestedName: string) => Promise<boolean>} saveBinary
 * @property {() => Promise<string[]>}  recentFiles
 * @property {(msg: string) => void}    log
 * @property {() => void}               [minimizeWindow]   // desktop only
 * @property {() => void}               [showAbout]        // desktop only
 */
```

### 2.3 Capabilities

The UI must hide what a backend cannot do rather than calling it and failing.

```js
const caps = {
  liveInput:    false,  // desktop: true
  pluginHost:   false,  // desktop: true — VST/AU. Never true on web.
  nativeMenus:  false,  // desktop: true
  fileSystem:   'picker' | 'download',   // web: File System Access API vs. download fallback
  offlineRender: true,  // web: true — see §7
};
```

### 2.4 Events (backend → editor)

Replaces the current `window.gomidas*` global callbacks. Same payloads, delivered through
`backend.on(...)`.

| Event | Payload | Replaces |
|---|---|---|
| `tick` | `{ tick }` | `window.gomidas.onTick` (native pushed at 30 Hz) |
| `meter` | `{ peak }` | `window.gomidasMeter` |
| `instrumentLoaded` | `{ channel, ok, name }` | `window.gomidasSfzLoaded` |
| `recordingState` | `{ recording }` | `window.gomidasRecording` |
| `pluginLoaded` | `{ name }` | `window.gomidasInputPluginLoaded` (desktop only) |

`window.gomidasMenu` and `window.gomidasNativeKey` are **host** concerns, not audio — they stay
on the desktop side and the web shell supplies its own equivalents.

---

## 3. Phase 0 — extract the seam (do this first, no behaviour change)

The first commit series touches **only the existing desktop app**:

1. Define the interfaces above in `web/core/backend.js`.
2. Implement `JuceAudioBackend` / `JuceHostBackend` that wrap the existing `nativeInvoke` calls
   verbatim.
3. Replace every direct `nativeInvoke(...)` call site in `app.js`, `editor.js`, `fretboard.js`
   with a backend method call.
4. Convert the `window.gomidas*` audio callbacks to backend events.
5. Build the Mac app. It must behave **identically**. Exercise transport, mixer, EQ, SFZ load,
   and preview.

**Phase 0 stays in JavaScript.** The TypeScript migration is Phase 0.5. Do not refactor the call
graph and change language in the same commit — when the Mac app misbehaves you want one variable.

⚠️ **Acceptance caveat on recording, live input and the plugin insert.** The list above
deliberately omits them. Those paths were never runtime-verified (`GMD-1`; `docs/STATUS.md`
verification debt), so there is no known-good behaviour to regress against — "it still does what
it did" is unfalsifiable there. For those calls, acceptance is *the same call fires with the same
payload* (assert at the bridge), **not** *the audio is correct*. Verifying them for real is
`GMD-1`, a separate piece of work, and it does not block Phase 0.

Nothing web-specific exists yet. This is the foundation both products hang off, and it is worth
doing where you can prove it is non-breaking.

---

## 4. The audio graph

### 4.1 Channel strip

Match the native signal order so mixes translate between the two products. Native today is:
instrument → gain/pan → EQ → sum → master EQ → master gain/pan → out.

```
instrument (§6)
  → FX inserts (pre-fader, §5)
  → channelGain    GainNode
  → channelPan     StereoPannerNode
  → channelEQ      3× BiquadFilterNode  [lowshelf, peaking, highshelf]
  → ├─────────────────────────────────→ masterBus
    └─ sendGain (post-fader) ─→ shared FX buses ─→ masterBus

masterBus → masterEQ (3× Biquad) → masterGain → masterPan
          → analyser (VU) → destination
```

Two notes on this shape:

- **Inserts are pre-fader** so moving the volume slider doesn't change how hard you're driving
  the distortion.
- **Sends are post-fader** so muting a track also mutes its reverb tail. Standard console
  behaviour; do not deviate.
- The hand-written transposed direct-form-II biquads in `AudioEngine.h` become three
  `BiquadFilterNode`s. `lowshelf`, `peaking`, and `highshelf` are literally the three band types
  already in use. Do not port the DSP.

### 4.2 CPU note

`ConvolverNode` is the expensive node here. Sixteen per-channel reverbs will hurt; **one shared
reverb bus with per-channel sends will not**. This is why sends exist in the design.

---

## 5. Effects

Web Audio provides most of this as stock nodes. This is a capability the desktop app does *not*
have today — its plan for real tone was VST inserts, which is the one thing that cannot port.

| Effect | Implementation |
|---|---|
| Overdrive / distortion / fuzz | `WaveShaperNode` + transfer curve, `oversample: '4x'` |
| Cabinet sim | `ConvolverNode` + cab IR (~20–100 KB) |
| Chorus | `DelayNode` ~15–30 ms, LFO → `delayTime`, mixed with dry |
| Flanger | as chorus, ~1–10 ms + feedback, deeper/faster LFO |
| Phaser | cascaded `BiquadFilterNode` allpass, LFO on frequency |
| Delay | `DelayNode` + feedback `GainNode` + filter in the loop |
| Reverb | `ConvolverNode` (IR) — shared send bus |
| Compressor | `DynamicsCompressorNode` |
| Tremolo | LFO → `GainNode` |
| Wah | `BiquadFilterNode` bandpass, modulated frequency |

**Priority note:** the cab IR matters more than the distortion algorithm. A dry DI sample through
a waveshaper sounds like a bee in a jar; the same signal through a 4×12 impulse response sounds
like an amp. Implement `cab` early.

### 5.1 Chain schema — serialisable, backend-agnostic

**This is the most important part of this section.** If the web app implements effects as a Web
Audio graph and the desktop app later implements them as VST inserts, the `.gomidas` format
forks and the two products drift apart. Effects must be stored as **data that either backend can
render its own way**.

```json
{
  "version": 1,
  "chain": [
    { "type": "compressor", "bypass": false,
      "params": { "threshold": -18, "ratio": 4, "attack": 0.003, "release": 0.25, "knee": 6 } },
    { "type": "drive",
      "params": { "mode": "overdrive", "drive": 0.6, "tone": 0.5, "level": 0.8 } },
    { "type": "chorus",
      "params": { "rate": 0.8, "depth": 0.4, "mix": 0.3, "delayMs": 22 } },
    { "type": "cab",
      "params": { "ir": "4x12-v30", "mix": 1.0 } }
  ],
  "sends": { "delay": 0.2, "reverb": 0.15 }
}
```

Rules:

- **No Web-Audio-specific concepts in the schema.** No node names, no `AudioParam` references.
  If JUCE cannot express it with `juce::dsp`, it does not belong here.
- Real units where meaningful (`dB`, `Hz`, `seconds`, `ratio`); `0..1` for abstract amount
  controls (`drive`, `depth`, `mix`, sends). Document the range of every param.
- `ir` is an **identifier**, not a path or a blob — each backend resolves it to its own asset.
- Unknown `type` values must be preserved on load/save and skipped at render time, so a file
  written by a newer build still round-trips.

### 5.2 Persistence

The `.gomidas` envelope is currently `{ gomidasVersion, instruments, score }`. Add:

```js
{ gomidasVersion, instruments, score, fx: { tracks: { [ch]: FxChain }, master: FxChain } }
```

Absent `fx` means no effects. Legacy files must continue to load — the loader already handles a
raw score with no envelope; keep that path working.

**The desktop app must preserve `fx` even though it does not render it** (per the §11 decision).
`saveProject`/`gomidasLoadProject` in `app.js` must round-trip the block untouched — read it on
load, hold it, write it back on save. Without this, opening a web-authored project on macOS and
saving silently destroys the effects. This is a small task and it belongs in the same phase as
the web FX work, not after it.

### 5.3 What this unlocks

`docs/STATUS.md` lists effects that "look right, play plain" — slides, vibrato, tremolo, wah,
fades. Several of those are DSP problems, not notation problems, and become nearly free here:

- **vibrato** → LFO on `playbackRate` (easier in a sample player than in TSF)
- **tremolo** → LFO on a `GainNode`
- **wah** → the modulated bandpass above
- **fades / volume swells** → `GainNode` automation
- **slides** → `playbackRate` ramp — this is the deferred Phase C item

The web build can close realism gaps still open on desktop. Wire these to the existing notation
flags rather than inventing new UI.

---

## 6. Synthesis

### 6.1 `Instrument` interface

Mirrors the existing native fork between `SoundFontSynth` and `SfzSynth`.

```js
/**
 * @typedef {Object} Instrument
 * @property {(key, velocity, when) => void} noteOn
 * @property {(key, when) => void}           noteOff
 * @property {(value, when) => void}         pitchBend   // 0..16383, 8192 = centre
 * @property {(num, value, when) => void}    cc
 * @property {() => void}                    allNotesOff
 * @property {AudioNode}                     output
 */
```

### 6.2 Order of implementation

**Step 1 — SFZ-lite sample player. Start here.**

The bundled instruments use **nine opcodes**:

```
lokey  hikey  key  pitch_keycenter  sample
ampeg_decay  ampeg_release  loop_mode  bend_up  bend_down
```

No velocity layers, no round-robins, no filters, no LFOs — one FLAC per key with a few stretched
ranges. See `assets/instruments/electric-bass/electric-bass.sfz` (54 lines, complete).

Implementation: parse the `.sfz`, `fetch` + `decodeAudioData` each FLAC (browsers decode FLAC
natively), then per note an `AudioBufferSourceNode` with
`playbackRate = 2 ** ((key - pitch_keycenter) / 12)`, a `GainNode` for the `ampeg` envelope, and
`start(when)`. Pitch bend is `playbackRate` automation — the existing kind-1 events map straight
onto it.

No WASM, no worklet, no build step. Estimate 3–4 days. Also parse `lovel`/`hivel` even if unused
today — velocity layers are the most likely next requirement.

**Step 2 — GM fallback for breadth.**

Step 1 covers guitar and bass — the stated v1 scope. An arbitrary imported `.gp` has piano,
strings, organ. Options, in preference order:

1. **TinySoundFont → WASM in an AudioWorklet.** `src/synth/tsf/tsf.h` is a single MIT header
   already vendored. The native code already renders per-channel with `tsf_copy` +
   `tsf_active_voice_count` skipping — that design ports 1:1 to a worklet with
   `numberOfOutputs: 16`. Identical sound to the desktop app. Wrinkle: worklets cannot `fetch`,
   so compile the `WebAssembly.Module` on the main thread and pass it via `processorOptions`.
2. A JS SoundFont player, if the TSF build proves painful.

Channels route to whichever instrument is loaded, exactly as `AudioEngine::applyEvent` forks on
`SfzSynth::activeMask()` today.

**Step 3 — sfizz-WASM. Deferred, behind the same interface.**

[`sfztools/sfizz-webaudio`](https://github.com/sfztools/sfizz-webaudio) exists and proves
feasibility, but: it builds against *a personal fork's* `emscripten` branch, has 36 commits,
supports "only generators and embedded sample files", is Chromium-only, and **its live demo does
not currently work**. It is a prototype, not a library.

It buys nothing audible for the nine opcodes above. It becomes worth revisiting when content
demands the real spec — specifically the Phase C keyswitch work (`sw_lokey`/`sw_hikey`/`sw_last`)
or third-party libraries with velocity layers and round-robins. Because it sits behind
`Instrument`, that is a swap, not a rewrite.

**Cheap decisive experiment:** after Step 1, A/B the web sample player against the Mac app
playing the same `classical-guitar.sfz`. If the difference is audible, that justifies porting
sfizz. If not, two weeks and a fork dependency are saved.

[`sfzlab/sfz-web-player`](https://github.com/sfzlab/sfz-web-player) is **CC0** (public domain —
no attribution, no copyleft, safe to vendor and modify inside a closed-source product). Small
project; do not depend on it, but it may beat starting from a blank file.

---

## 7. Transport and scheduling

**The architecture rule holds: our engine owns the clock. alphaTab only renders and moves its
cursor.** `settings.player.enablePlayer` stays `false`.

Do **not** use alphaTab's built-in player. It is a single stereo pipeline with nowhere to attach
per-channel EQ or the mixer, and it takes ownership of the clock — which would fork the two
products architecturally.

### 7.1 Lookahead scheduler

The standard Web Audio pattern, replacing the audio-callback scheduler:

- A timer ticks every **~25 ms**.
- Each tick, scan the sequence for all events falling in the next **~100 ms** window and schedule
  them against `audioContext.currentTime`.
- Timer jitter never reaches the audio, because `start(when)` is sample-accurate.

`buildSequence` output is consumed **unchanged** — a flat tick-sorted event list with
`kind` 0/1/2 (note / pitch-bend / CC). That is the payoff of the existing extraction and golden
tests. Do not modify it.

Estimate ~150 lines.

### 7.2 Details

- `PPQ = 960`, matching alphaTab and the native engine.
- **Cursor position derives from `audioContext.currentTime`**, mapped back through the tempo
  map. Do not count scheduled events. This replaces the `reportedTicks` atomic and the 30 Hz
  `evaluateJavascript` push; emit the `tick` event from a `requestAnimationFrame` loop.
- Seek, A/B loop, and mid-flight tempo changes all require discarding and rebuilding the
  scheduled window. Keep a handle on every scheduled node so it can be cancelled.
- Pitch-independent slow-down is free — playback is re-sequenced MIDI, not time-stretched audio.
  Same as native.
- **Autoplay policy:** `AudioContext` must be created or resumed inside a user gesture. Wire this
  to the first transport interaction and handle the suspended state gracefully.
- Use `latencyHint: 'interactive'` for the preview/audition path (fretboard clicks).

### 7.3 Recording — better than native

Instead of realtime capture, render the whole song through an `OfflineAudioContext` faster than
realtime and encode the result to WAV (~30 lines). Cleaner than the desktop `ThreadedWriter`
path, and it produces a deterministic mix.

---

## 8. Non-goals and constraints

- **No VST/AU hosting. Ever.** It does not exist in a browser. Do not attempt WAM as a
  substitute; do not add plugin UI to the web build. Guard with `caps.pluginHost`.
- **No live input in v1.** `getUserMedia` works, but round-trip latency (~20–40 ms vs ~5–10 ms
  through CoreAudio) makes "play on top" a desktop feature. Guard with `caps.liveInput`.
- **Safari has no File System Access API.** No save-in-place. Implement the download/upload +
  IndexedDB fallback and select on `caps.fileSystem`. Do not ship a Chromium-only app.
- **`WaveShaperNode` aliases.** `oversample: '4x'` mitigates, does not eliminate. This is why a
  lot of browser guitar tone sounds buzzy at high gain. We are building a credible amp sim, not a
  boutique modeler — set UI expectations accordingly.
- **Asset payload is a product constraint.** `FluidR3_GM.sf2` is 144 MB and is not going over the
  wire. `sonivox.sf3` is 977 KB (Ogg-compressed, vs 1.35 MB as `.sf2`) — prefer `.sf3`. Bundled
  SFZ instruments are 5.2 MB (guitar) and 2.8 MB (bass); lazy-load per track, cache in IndexedDB.
- **Source is readable.** Minification is not protection. The editing layer is the moat — alphaTab
  is only a renderer. Factor this into what ships in the web build.

### Licensing

- alphaTab is **MPL-2.0**: fine as a library, your code stays proprietary, but modifications *to
  alphaTab files* must be shared. Do not fork it.
- TinySoundFont **MIT**, sfizz **BSD/ISC**, bundled instruments **CC0** — all safe.

---

## 9. Testing

`web/core/gomidas-core.js` already has 62 Vitest tests running in CI on plain Node. **Extend that
convention** — every new piece of pure logic goes in a testable module with no DOM and no
`AudioContext`:

- SFZ parser → region list (golden-test against the two bundled instruments)
- tick ↔ time mapping under tempo changes and playback rate
- scheduler window selection (which events fall in `[t, t+lookahead)`, including across a loop
  boundary)
- FX chain schema validation and round-trip through `.gomidas`
- waveshaper curve generation (pure function, snapshot it)

Audio graph construction itself needs a browser; keep that layer thin and push logic down into
tested modules.

---

## 10. Order of work

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0** | Extract `AudioBackend` / `HostBackend`; `Juce*` implementations. **Stays JS.** | Mac app behaves identically; `cmake --build build` green. Recording/live-input/plugin judged at the bridge only — see §3 |
| **0.5** | TypeScript infrastructure: `tsconfig` (`allowJs`, `module: none`, per-file emit → `web/dist/`), CMake repointed, Node in CI `native-tests`. Migrate `backend.ts` + `gomidas-core.ts` | `cmake --build build` green from generated output; Mac app identical; 62 Vitest tests still pass |
| **1** | `apps/web/` — Vite + alphaTab rendering, no audio | A `.gp` loads and renders in a browser |
| **2** | `WebAudioBackend` — scheduler, channel strip, mixer, EQ | A score plays with correct timing; mute/solo/vol/pan/EQ live |
| **3** | SFZ-lite sample player | Guitar and bass tracks sound like the Mac app; A/B it |
| **4** | Effects — chain schema, inserts, sends **+ desktop preserves the `fx` block** (§5.2) | Drive + cab + delay on a guitar track; round-trips through `.gomidas`; a web-authored file saved on macOS keeps its effects |
| **5** | GM fallback (TSF → WASM) | An imported multi-instrument `.gp` plays in full |
| **6** | File handling — picker + download/IndexedDB fallback. **No server** (§11) | Works in Safari and Chrome |
| **7** | Editor parity pass — the largest phase | Full keymap, drums (kit view + grooves), inspector, beat grid |
| **8** | Monorepo tidy — `web/` → `packages/core/`, `apps/desktop/` | Both apps build from the shared core |

Phase 8 is deliberately last. Do not start there.

TypeScript conversion **continues across every phase** as a ratchet (§1.1) — one file per phase,
strictness rising. Phase 0.5 only builds the machinery; it does not finish the migration.

---

## 11. Decisions (2026-08-13) and what is still open

The four questions this document originally left open are now answered.

| Question | Decision | Consequence |
|---|---|---|
| **Target user for v1** | **Full editor parity** | Phase 7 is the largest phase, as §0 assumed. No viewer-first shortcut. |
| **Does it need a server?** | **No — pure client-side v1** | No auth, storage, sharing or quotas. `HostBackend` stays a thin local-file interface and `saveProject` keeps its `Promise<boolean>` shape. Shareable links become a separately-scoped surface later. |
| **Effects: which product?** | **Web renders them; schema stays portable** | Desktop must still **preserve** the `fx` block through load/save (§5.2). See the two accepted consequences below. |
| **Plain JS vs TypeScript** | **TypeScript** | Overrides the original recommendation. Cheaper than expected here — see §1.1. Adds Phase 0.5. |

**Two consequences of web-only FX, accepted explicitly:**

1. A mix authored on the web will **sound different on macOS** until the desktop implements the
   same chain via `juce::dsp`. Files round-trip; audio does not match.
2. The schema gets **no second-backend validation** until that happens. "No Web-Audio-specific
   concepts in the schema" is therefore self-enforced discipline, not something the build checks.
   Review §5.1 rules on every new effect type.

**Still open:**

- **Framework for the web shell.** The editor is vanilla DOM (`innerHTML` rebuilds, a
  `MutationObserver` for drawer handles) and should stay that way. If the shell needs routing or a
  component library, keep any framework strictly outside the editor.
- **When desktop implements the FX chain.** Not scheduled. Until it does, consequence 1 stands.
- **Shareable links** as a product surface (storage, accounts, quotas) — deliberately out of scope
  for v1, not cancelled.
