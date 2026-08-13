# Effects Chain & Feature Roadmap

> Drafted 2026-07-09. Companion to `docs/FEATURES.md` / `docs/BACKLOG.md` (feature status)
> and `docs/REALISTIC_SOUND.md` (SFZ/RSE plan). This doc covers two things the user asked
> for: (1) the **missing score-writing / playability features** vs. Guitar Pro & peers, and
> (2) a concrete design for **per-track audio effects (a simple amp/pedalboard chain)**.

---

## Part 1 — Where the audio engine is today

Signal path per audio block (`AudioEngine::audioDeviceIOCallbackWithContext`,
`src/engine/AudioEngine.cpp`):

```
for each MIDI channel c (0..15):
    render voices  ──►  TinySoundFont  (default)   OR   sfizz SFZ  (if loaded on c)
    [SFZ only] apply per-channel mixer gain + balance pan (post-render)
    3-band EQ  (low-shelf 120Hz / mid-peak 1kHz / high-shelf 6kHz, transposed DF-II biquad)
    sum into master bus
master 3-band EQ  ──►  master gain + balance pan  ──►  output

live input (separate): capture ─► ONE global VST3/AU insert ─► gain ─► mix to output
```

**What exists:** per-channel EQ, per-channel mixer (gain/pan/mute/solo), master EQ + gain,
one global VST/AU insert **on the live input only**, WAV capture of the output.

**What is missing (the whole ask):** there are **no nonlinear or time-based effects at all** —
no distortion/overdrive/fuzz, no compressor, no noise gate, no cab simulation, no chorus /
phaser / flanger / tremolo / wah, no delay, no reverb. The MIDI/SFZ tracks cannot be sent
through any effect. GP8's whole "realistic guitar tone" story is exactly this chain, and we
have the perfect insertion point already: the per-channel render loop at
`AudioEngine.cpp:496`, right where each channel's stereo bus exists in isolation before it is
summed.

---

## Part 2 — Per-track effects chain (design)

### 2.1 The good news: JUCE `dsp` gives us almost everything, allocation-free

We already depend on `juce_dsp`. It ships production-quality, RT-safe building blocks that map
one-to-one onto the pedals we want:

| Pedal / block            | JUCE dsp class                              | Notes |
|--------------------------|---------------------------------------------|-------|
| Noise gate               | `juce::dsp::NoiseGate`                       | threshold/ratio/attack/release |
| Compressor / sustain     | `juce::dsp::Compressor`                      | threshold/ratio/attack/release + makeup gain |
| Overdrive / distortion / fuzz | `juce::dsp::WaveShaper` + pre/post `Gain` | transfer fn = the pedal's character (see 2.3) |
| Tone stack / amp EQ      | `juce::dsp::IIR` (we already build biquads) | bass/mid/treble/presence voicing |
| Cabinet simulation       | `juce::dsp::Convolution` (IR)               | **the piece that makes drive sound like an amp** |
| Chorus                   | `juce::dsp::Chorus`                          | rate/depth/centre-delay/feedback/mix |
| Phaser                   | `juce::dsp::Phaser`                          | rate/depth/centre-freq/feedback/mix |
| Flanger                  | `juce::dsp::DelayLine` + LFO                 | short modulated delay + feedback |
| Tremolo                  | `juce::dsp::Oscillator` (LFO) × gain         | amplitude LFO |
| Wah / auto-wah           | `juce::dsp::StateVariableTPTFilter` (bandpass) | LFO- or envelope-driven centre freq |
| Delay / echo             | `juce::dsp::DelayLine` + feedback + wet mix  | optional filtered/"tape" feedback |
| Reverb                   | `juce::dsp::Reverb` (Freeverb)               | room/hall/plate/spring voicings via params |
| Graphic / param EQ       | `juce::dsp::IIR` chain                        | extends the 3-band we already ship |

**Consequence:** we do **not** need a heavy amp-modelling library or new third-party deps to
ship a credible v1. It's mostly wiring + UI + presets. (A neural amp-sim / NAM-style path is a
possible *future* upgrade, not a v1 requirement.)

### 2.2 Architecture — one reusable `TrackFx` chain

Introduce a `TrackFx` object per MIDI channel (and one for the live input, so "play on top"
and the tone engine share the exact same code — priority #1 + realistic-tone in one stroke).

```
src/engine/fx/
  Effect.h          // abstract: prepare(spec) / process(AudioBlock) / reset() / setParams(...)
  FxChain.h/.cpp    // ordered vector<unique_ptr<Effect>>; process runs them in order
  effects/NoiseGate, Compressor, Drive, CabIR, Chorus, Phaser, Flanger,
          Tremolo, Wah, Delay, Reverb, ParamEq   // thin wrappers over juce::dsp
```

- Each `Effect` owns its DSP state (delay lines, reverb tanks, convolution) — **audio-thread
  owned**, never touched by the message thread while processing.
- The `FxChain` slots into the per-channel loop between render and the existing EQ (order is a
  design choice — see 2.4). For live input, it replaces the single `activePluginPtr` insert.

### 2.3 The drive pedals (the heart of "distortion / overdrive / fuzz")

All three are the same structure — **pre-gain → waveshaper → tone → post-gain** — differing
only in the transfer curve and gain staging:

- **Overdrive**: soft clip, e.g. `tanh(k·x)` (smooth, touch-sensitive, tube-like).
- **Distortion**: harder clip (`x/(1+|x|)` pushed, or cubic soft-then-hard), more gain.
- **Fuzz**: asymmetric / near-square clipping, high pre-gain, a little DC-bias asymmetry for
  the characteristic buzz, then a low-pass to tame fizz.

**Cabinet IR after the drive is non-negotiable for realism** — raw waveshaping without a cab
sounds like a fizzy buzzer; a speaker impulse response is what turns it into "an amp." This is
the single highest-leverage effect in the chain.

### 2.4 Recommended signal chain order (guitar-oriented, GP/real-rig faithful)

```
Noise Gate → Compressor → Drive (OD/Dist/Fuzz) → Amp Tone/EQ → Cab IR
    → Modulation (Chorus/Phaser/Flanger/Tremolo/Wah) → Delay → Reverb
```

Reverb/delay last (time effects on the fully-formed tone); modulation typically pre-delay;
drive early. Users can reorder, but this is the sane default. Where this sits relative to the
existing per-channel 3-band EQ: fold the EQ into the chain as the "Amp Tone/EQ" block (or keep
it as a post-chain channel EQ). Keep the master EQ where it is.

### 2.5 Real-time safety (follows the patterns already in the codebase)

The repo already has three RT-safe swap idioms — reuse them verbatim:

- **Param changes** (knob turns): atomics or a small double-buffered param struct, picked up on
  the audio thread on a `dirty` flag — exactly like the `mixDirty` / `eqDirty` handoff.
- **Chain edits** (add/remove/reorder a pedal, load a new IR): build the new `FxChain` on the
  message thread, swap the pointer under a `SpinLock` + `tryEnter`, free the old chain on the
  message thread — exactly like the `pluginLock` / `Sequence` swap. **Convolution IR loading is
  not RT-safe**, so load off-thread and swap.
- **Skip when bypassed/flat**: mirror `EqUnit::flat` — a bypassed chain costs ~nothing, so CPU
  scales with *active* pedals on *audible* tracks (same principle as the voice-count skip).

Add these to the existing "harden before shipping" list in `docs/REALISTIC_SOUND.md`.

### 2.6 Cabinet IRs & presets (content sourcing — verify licensing, like the SFZ sets)

- **IRs**: bundle a handful of CC0 / permissively-licensed guitar & bass cab impulse responses
  (`assets/ir/`, copied to `Resources/ir` by the existing CMake POST_BUILD step, same as the
  SFZs). ⚠️ **Licensing must be verified per file** — treat exactly like `docs/SOUND_LIBRARIES.md`.
  Fallback: record our own, or ship without and let users load their own `.wav` IR.
- **Amp/pedalboard presets** as JSON: *Clean, Crunch, Lead, High-Gain/Metal, Bass DI, Bass
  Grind, Acoustic/DI, Ambient (chorus+delay+reverb)*. Persist per track in the `.gomidas`
  envelope (the `instruments` block already exists — add an `fx` block next to it).

### 2.7 UI — a GP8-style pedalboard/rack per track

The track-list already has an **EQ button** and `gomidasOpenEq` popup. Grow that into an **FX
rack**: a row of stompbox cards (bypass toggle + a few knobs each), drag-to-reorder, an
amp/preset picker at the head, master + per-pedal wet/dry. Reuse the drawer/panel system. A
"realistic tone" pill already exists in the inspector (RSE/MIDI) — the FX rack lives alongside it.

### 2.8 Suggested build phases

- **FX-1 (foundation):** `Effect`/`FxChain` abstraction + RT-safe swap + wire into the
  per-channel loop and the live-input insert. Ship with **Reverb + Delay** first (pure
  `juce::dsp`, universally useful, no IR/licensing needed). Verify audibly.
- **FX-2 (drive + cab):** Overdrive/Distortion/Fuzz waveshapers + Cab IR convolution + bundled
  CC0 IRs + amp tone EQ. This is the "realistic guitar" payoff.
- **FX-3 (modulation):** Chorus, Phaser, Flanger, Tremolo, Wah + Compressor + Noise Gate.
- **FX-4 (UX):** pedalboard UI, drag-reorder, preset library, `.gomidas` persistence.
- **FX-5 (later):** per-track VST3/AU **instrument + effect** inserts (generalise the existing
  single live-input host to every track), then optional neural amp-sim path.

---

## Part 3 — Score-writing & playability gaps (audited against the editor source)

The editor is **already GP-deep**. Confirmed IMPLEMENTED (don't rebuild): grace notes,
tremolo picking, chord diagrams + naming, slap/pop, two-hand + left-hand tapping, rasgueado,
lyrics, trill, fade-in/out + volume swell, brush/arpeggio direction, pre-bend + bend-release,
artificial/pinch harmonics, wide/slight vibrato, time- & key-signature changes, voices 1–4,
copy/cut/paste + repeat-bar, transpose, swing/shuffle feel, repeat barlines + D.C./D.S./al-Fine
playback, `.gp` export.

**PARTIAL (works but shallow):**
- Whammy/tremolo bar — only a fixed "Dip" preset (`whammyBarPoints=[0,-4,0]`); no dive-bomb /
  other shapes, no graphical editor (`editor.js tremoloBar()`).
- Bends — preset shapes only; no draggable curve editor (`editor.js setBend`).
- Coda / D.S. al Coda playback order — markers toggle, but al-Coda + alternate endings are
  explicitly not unrolled (`core/gomidas-core.js:210`).
- Let-ring / palm-mute — per-note booleans only; no span/region tool.

**MISSING (no implementation):** golpe; fingering annotations (LH 0–4 / RH p i m a);
mordent/turn/ornaments; multirest; alternate endings (1st/2nd); unison bend; tapped/feedback
harmonics; **tempo automation (accel/rit / gradual)**; capo; pickup/anacrusis bars + cut/common
time symbols; beaming control; **MusicXML export**; **MIDI export**; slash/rhythm notation.

**Playability:** no **master limiter/brickwall** on output (can clip); no **offline WAV bounce**
of the whole song (only live output capture); no MIDI/MusicXML export. (Metronome, count-in,
A/B loop, pitch-preserving speed trainer, mixer, live input all already done.)

## Part 4 — Priority call

The user's explicit ask (effects) is also the biggest strategic differentiator and the lowest
notation risk, so **effects lead**. No competitor combines GP-depth tab editing + sampled/SFZ
sound + a built-in amp/FX chain + per-track VST instruments + play-on-top; that combination is
the product. Sequence: **P0** FX-1 (reverb+delay foundation) + master limiter + verify the
unverified live-input stack; **P1** FX-2 (drive + cab IR = realistic guitar) + per-track VST
instruments (CLAUDE priority #2) + FX-3 modulation; **P2** notation gaps (tempo automation,
alternate endings/Coda, whammy shapes + graphical bend editor, MIDI/MusicXML export) + pedalboard
UI + optional neural amp (NAM MIT + RTNeural BSD).
