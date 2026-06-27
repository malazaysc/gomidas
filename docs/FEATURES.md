# Gomidas — Implemented Features

Status of the tab editor + playback engine. Keyboard column shows the **Gomidas** key and,
where it differs, the **GP8** equivalent (see `references/gp8-keyboard-shortcuts.md`).
Not-yet-built features and the full GP parity gap live in [`BACKLOG.md`](./BACKLOG.md).

Legend: ✅ done · 🟡 partial · key in `mono` is the live binding.

## File / project
| Feature | Key | Notes |
| --- | --- | --- |
| New score (setup dialog) | toolbar `New…` / menu File→New | ✅ GP8-style modal: title, tempo, time signature, add/remove tracks (Guitar/Bass/Drums) + tuning preset per track |
| Add track (Guitar / Bass / Drums) | toolbar `+ Track…` | ✅ matches existing master bars; drums via importer+JSON merge |
| Open `.gp` / `.gomidas` / MusicXML | toolbar `Open` / menu File→Open | ✅ native file chooser (real path); `.gomidas` = score JSON, others via alphaTab (`gomidasLoadBinary`, base64) |
| Open Recent | menu File→Open Recent | ✅ last 10 files, persisted to `~/Library/Application Support/Gomidas/recent.txt`; honours the unsaved-changes guard; `Clear Recent` |
| Save `.gomidas` project | toolbar `Save` | ✅ clears the unsaved-changes flag |
| Unsaved-changes guard | — | ✅ New / Open / Sample prompt to discard if there are unsaved edits |
| Load sample | toolbar `Sample` | ✅ |
| Set tempo | toolbar tempo field / inspector SONG tab | ✅ 40–240 BPM, drives native clock |
| Honour loaded file's tempo | automatic | ✅ `scoreLoaded` pushes `score.tempo` to the engine + tempo field (no longer stuck at 120) |

## Navigation (cursor)
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Next / previous beat | `→` / `←` | same | ✅ wraps across bars |
| String up / down | `↑` / `↓` | same | ✅ (on tab, GP `↑`/`↓` line = string) |
| Previous / next track | `⌘↑` / `⌘↓` | same | ✅ (`PageUp`/`PageDown` also work) |
| Click any beat in score (incl. empty bars) | mouse | — | ✅ `getBeatAtPos`; picks string from tab-staff Y |
| Click a note | mouse | — | ✅ selects its string |
| Click a track in multiview → switch controls | mouse | — | ✅ re-picks track by click Y (drum row → drum palette) |

## Note entry
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Type fret on current string | `0`–`9` | same | ✅ instant; 2nd digit within 600 ms amends (1→2 = 12) |
| Place fret via fretboard | click fret cell | — | ✅ auto-sized to tuning, inlay dots, auditions note |
| Delete note on current string | `⌫` / `Delete` | `⌫` | ✅ |
| Audition current beat (chord) | automatic on entry | — | ✅ native `preview` |

## Duration & rhythm
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Set duration (whole … 32nd) | toolbar `1 ½ ¼ ⅛ 16 32` | — | ✅ |
| Decrease note duration | `+` / `=` | same | ✅ |
| Increase note duration | `-` / `_` | same | ✅ |
| Dotted | `.` / toolbar `.` | same | ✅ single dot toggle |
| Double dotted | `⌘.` / toolbar `‥` | same | ✅ |
| Triplet (3 in space of 2) | `/` / toolbar `3` | same (Triolet) | 🟡 per-beat; other tuplets (5/6/7/9) → backlog |
| Rest | `R` / toolbar `R` | same | ✅ clears beat to a timed rest |
| Insert beat after cursor | `⌃+`, toolbar `＋beat`, or `→` at end | `⌃+` | ✅ |
| Delete the beats | `⌘-` / toolbar `－beat` | `⌘-` | ✅ |
| Insert bar (to all tracks) | `⌘+` / toolbar `＋bar` | `⌘+` / `Ins` | ✅ whole-rest bar, master bars kept aligned |
| Delete bar (from all tracks) | `⌃-` / toolbar `－bar` | `⌃-` | ✅ JSON round-trip rebuild; keeps ≥1 bar |

## Effects
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Palm mute (current note) | `P` | same | ✅ shorter+softer in MIDI playback |
| Palm mute (whole beat) | `⇧P` / toolbar `P.M.` | same | ✅ |
| Dead note | `X` / toolbar `✕` | same | ✅ short percussive thunk in MIDI |
| Let ring | `I` / toolbar `L.R.` | same | 🟡 rings ~4× duration (true "ring until next" → backlog) |
| Tie note / tie beat | `L` / `⇧L`, toolbar `⌣` | same | ✅ copies pitch; sustains the ringing note in MIDI |
| Hammer-on / pull-off | `H` / toolbar `H` | same | 🟡 notation done; MIDI still re-articulates (legato MIDI → backlog) |
| Legato slide | `S` / toolbar `sl` | same | 🟡 notation done; MIDI plain (pitch-bend slide → backlog) |
| Ghost note | `O` / toolbar `gh` | same | ✅ softer in MIDI |
| Staccato | `!` / toolbar `·` | same | ✅ shortened in MIDI |
| Accent / heavy accent | `;` / `:`, toolbar `>` | same | ✅ louder / much louder in MIDI |
| Natural harmonic | `Y` / toolbar `◇` | same | 🟡 notation done; MIDI plain |
| Vibrato | `V` / toolbar `∿` | same | 🟡 notation done; MIDI plain |
| Transpose note: semitone / octave | `⌥⇧↑`·`⌥⇧↓` / `⌥↑`·`⌥↓` | semitone same; octave is a Gomidas mapping | ✅ shifts the fret |

## Drums
| Feature | How | Notes |
| --- | --- | --- |
| Create drum track | `New… → Drums` / `New… → Full Band` / `+ Track… → Drums` | ✅ full GM kit (channel 9) |
| Drum palette (replaces fretboard on a percussion track) | click a pad | ✅ Kick, Snare, Hi-Hat (closed/open), Toms (hi/mid/floor), Crash, Ride |
| Place / remove a hit on the current beat | click pad (toggles; pads stack) | ✅ auditions the hit |
| Drum playback | automatic | ✅ articulation → `outputMidiNumber` on GM channel 9 |

> Pieces resolve to the track's `percussionArticulation` index by GM MIDI key, so the palette
> works on imported GP drum tracks too. Keyboard drum entry → backlog.

## Playback / transport
| Feature | Key | Notes |
| --- | --- | --- |
| Play / stop | `Space` / toolbar `▶ Play` | ✅ native transport owns the clock (960 PPQ). Space is ignored while typing in a field / modal (so it types a space there instead) |
| Edit + play cursors over tab & notation | automatic | ✅ follow native transport |
| Auto-scroll during playback | automatic | ✅ keeps the play cursor in view (GP-style page turn); only scrolls near an edge. Toggle: `GomidasEditor.setAutoScroll(bool)` |
| MIDI instruments per track (GM program) | automatic | ✅ TinySoundFont + FluidR3_GM SoundFont |
| Drum tracks (GM channel 9) | automatic | ✅ articulation → `outputMidiNumber` |

## UI / app
| Feature | How | Notes |
| --- | --- | --- |
| GP8-style dark layout | — | transport · left palette · score · right SONG/TRACK inspector · bottom track list |
| Native macOS menu bar | menu bar | File / Edit / Track / Bar / Note / Effects / Section / Tools / Sound / View / Window / Help |
| Track mute / solo | track-list M / S | ✅ live via per-channel gain in `AudioEngine` (`setChannelMix`); solo overrides mute; takes effect instantly during playback |
| Track volume (mixer) | track-list slider | ✅ per-track linear gain (0–100%), live; defaults from `playbackInfo.volume` |
| Track show / hide | track-list 👁 | ✅ toggles the track in the score (multi-track view); does not mute it |
| Single-track focus | click a track row / `track-select` | ✅ shows that track alone (GP-style); eye control returns to multi-track view |
| Inspector — TRACK (live) | right panel | ✅ editable name · Score/Tab notation toggles · tuning preset picker · GM sound picker. Interpretation sliders still visual placeholders |
| Inspector — SONG (live) | right panel `SONG` tab | ✅ editable title + tempo |
| Zoom | transport `−` / `＋` | ✅ rescales the score |

## Edit history
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Undo | `⌘Z` | same | ✅ score-JSON snapshots, debounced |
| Redo | `⌘⇧Z` / `⌘Y` | same | ✅ |

---
### Notes / minor divergences from GP8
- Keymap follows GP8. Extras on top of GP: `PageUp`/`PageDown` alias `⌘↑`/`⌘↓` (track nav), and
  `→` at the **last beat of the last bar** appends a new beat (convenience; GP uses `⌃+`).
- Triplets apply **per beat**, not yet as a GP-style spanning tuplet group.
- Let ring is approximate in MIDI (fixed ~4× sustain) until "ring until next note on string" lands.
