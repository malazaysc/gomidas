# SFZ instruments — manual test checklist

What to verify by hand for the per-track SFZ "realistic sound" feature (everything I couldn't
confirm without ears / GUI). Build + the SFZ→audio path are already verified
(`tests/sfz_smoketest`); this covers the in-app behaviour and regressions.

> Launch: `open build/Gomidas_artefacts/Debug/Gomidas.app`

## Before you start — known NOT-implemented (don't test these, they're expected to be absent)
- ❌ **Slides / bends are not audible yet** — only the event plumbing landed; no pitch-bend is emitted.
- ❌ **No drum SFZ** — drums still use the GM SoundFont (good CC0 kits are too big to bundle yet).
- ❌ **Custom (Load file…) SFZ does NOT persist** across save/reload — only the built-in presets do.

---

## A. Core — does it sound? (the headline)
- [ ] Load/open a **guitar** track. Inspector → **TRACK → Sounds → Preset → "Classical Guitar (CC0)"**;
      status line shows *"SFZ instrument loaded: …"*.
- [ ] Press **Space** → that track sounds like a **sampled classical guitar**, not the SoundFont.
- [ ] On a **bass** track, Preset → **"Electric Bass (CC0)"** → plays as a sampled bass.
- [ ] The **RSE** pill lights when an SFZ is loaded; **MIDI** lights when it isn't.
- [ ] Preset → **"GM SoundFont"** → reverts that track to the SoundFont.
- [ ] Pick a GM **Sound** (program dropdown) while an SFZ is loaded → track switches back to MIDI
      (SFZ auto-cleared, GM sound is audible).
- [ ] Preset → **"Load file…"** → pick any `.sfz` on disk → it loads and plays.
- [ ] Sound menu → **Load / Clear SFZ Instrument for Track** does the same as the dropdown.

## B. Mixer / multi-track (SFZ honours the mix)
- [ ] **Volume** slider on an SFZ track changes its loudness.
- [ ] **Pan** on an SFZ track moves it L/R.
- [ ] **Mute** and **Solo** on an SFZ track work (and during playback).
- [ ] **Per-track EQ** affects the SFZ track's tone.
- [ ] Multi-track playback: an SFZ track + SoundFont tracks play **together, in sync**.

## C. Persistence (.gomidas)
- [ ] Load an SFZ preset on a track → **Save** `.gomidas` → close & **reopen** → the instrument is
      reloaded automatically.
- [ ] Preset on **two+ tracks** → save → reopen → all reload correctly.
- [ ] Open an **old `.gomidas`** (saved before this feature) → still loads fine, no error.

## D. Regression (make sure nothing broke)
- [ ] Tracks with **no SFZ** play exactly as before (SoundFont).
- [ ] **Drums** still play.
- [ ] Transport: **play / stop / seek-from-cursor / A-B loop / metronome / count-in** all still work.
- [ ] **Editing** (note entry, durations, undo/redo) still works.
- [ ] **Save / Open / Export `.gp`** still work.

## E. Robustness / edge cases
- [ ] Switch between tracks → inspector shows the **correct per-track** instrument each time.
- [ ] Load preset A, then a **different** preset on the same track → swaps cleanly, **no stuck notes**.
- [ ] **A/B loop** over an SFZ track → loops cleanly, no stuck or detuned notes at the wrap.
- [ ] **Panic** (Sound → Panic) silences ringing SFZ notes.
- [ ] Load SFZ on **several tracks** and play → no crashes, no audio dropouts.
- [ ] Load an SFZ, start playback, **change preset mid-play** → no crash (brief gap is OK).

## F. Build (only if testing a fresh clone)
- [ ] `cmake -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build` succeeds (sfizz patches apply).
- [ ] `cmake -B build -DGOMIDAS_BUILD_TESTS=ON --` then `--target sfz_smoketest`;
      `./.../sfz_smoketest assets/instruments/classical-guitar/classical-guitar.sfz` → **PASS**.

---
**If anything fails**, note which item + what happened (and any stderr from launching the binary
directly: `build/Gomidas_artefacts/Debug/Gomidas.app/Contents/MacOS/Gomidas`) and I'll fix it.
