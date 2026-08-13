# Dead / placeholder buttons

Tracks controls that render but aren't (fully) wired. Most of the original 30 were
implemented on 2026-06-28 (see git history + [`BACKLOG.md`](./BACKLOG.md)); what remains
is **intentionally deferred** and shown greyed-out in the UI via the `.gd-soon` style.

Verify against source before relying on a line number — they drift.

## Deferred — greyed out (`.gd-soon`)

These are dimmed + non-interactive on purpose; wire them when the engine/model supports them.

| Control | File:line | Why deferred |
|---------|-----------|--------------|
| RSE engine segment (RSE/MIDI pill) | `packages/core/fretboard.js:400` | Realistic Sound Engine — own modelling effort; only MIDI is active |
| Interpretation section (Playing style, Palm-mute, Accentuation, Auto-let-ring, Auto-brush, Stringed) | `packages/core/fretboard.js:411-414` | Guitar-playing simulation — coupled to RSE |
| Tuner | `packages/core/index.html:395` | Needs real-time pitch detection (YIN/autocorrelation) on the live input — its own pass |

## Partially implemented

| Control | File:line | State |
|---------|-----------|-------|
| Crescendo `<` / Diminuendo `>` | `packages/core/fretboard.js:122-123` | Sets the notation hairpin marking; a velocity ramp across the hairpin span in `rebuildSequence` is still TODO |
| Track / Master EQ | `packages/core/fretboard.js` EQ buttons + Master row | Fully live (per-channel buses + 3-band biquad in `AudioEngine`), but the EQ values are **session-only** — not yet saved into `.gomidas` (no alphaTab model field; would need a project-format change). Vol/pan still persist via `playbackInfo`. |

## Implemented in this pass (no longer dead)

Palette: dynamics ppp–fff, octave/clef 8va/8vb/15ma/15mb, lyrics. Track list: per-track EQ,
track-options ⋮ menu, Master row volume/pan/EQ. Transport: Print. Native menus: Tools
(Transpose + practice tools), Window→Minimize, Help→About.
