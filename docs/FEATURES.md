# Gomidas — Implemented Features

> Bird's-eye map (roadmap phases + verification debt): [`STATUS.md`](./STATUS.md).

Status of the tab editor + playback engine. Keyboard column shows the **Gomidas** key and,
where it differs, the **GP8** equivalent (see `references/gp8-keyboard-shortcuts.md`).
Not-yet-built features and the full GP parity gap live in [`BACKLOG.md`](./BACKLOG.md).
Buttons that render but aren't wired yet are inventoried in [`DEAD_BUTTONS.md`](./DEAD_BUTTONS.md).

Legend: ✅ done · 🟡 partial · key in `mono` is the live binding.

## File / project
| Feature | Key | Notes |
| --- | --- | --- |
| New score (setup dialog) | toolbar `New…` / menu File→New | ✅ GP8-style modal: title, tempo, time signature, add/remove tracks (Guitar/Bass/Drums) + tuning preset per track |
| Add track (Guitar / Bass / Drums) | toolbar `+ Track…` | ✅ matches existing master bars; drums via importer+JSON merge |
| Delete track | `⌥⌘R` / menu Track→Delete Track | ✅ JSON round-trip rebuild; keeps ≥1 track; cursor moves to previous track |
| Open `.gp` / `.gomidas` / MusicXML | toolbar `Open` / menu File→Open | ✅ native file chooser (real path); `.gomidas` = score JSON, others via alphaTab (`gomidasLoadBinary`, base64) |
| Open Recent | menu File→Open Recent | ✅ last 10 files, persisted to `~/Library/Application Support/Gomidas/recent.txt`; honours the unsaved-changes guard; `Clear Recent` |
| Save `.gomidas` project | toolbar `Save` | ✅ clears the unsaved-changes flag; **folds per-track volume/pan into `playbackInfo`** so the mix persists (mute/solo/hidden stay session-only) |
| Export Guitar Pro `.gp` | menu File→Export Guitar Pro | ✅ alphaTab `Gp7Exporter` → native save dialog (`saveBinary`, base64). Round-trip pending runtime verification |
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
| Beginning / end of bar | `Home` / `End` | same | ✅ jumps to first / last beat of the current bar |
| First / last bar | `⌘Home` / `⌘End` | same | ✅ cursor lands on the bar's first beat |
| Next / previous staff | `Tab` / `⇧Tab` | same | ✅ moves to next/prev track (one staff per track) |
| Select voice 1–4 | `⌘1`–`⌘4` / menu Note→Voice | same | ✅ switches the editing voice (lazily created as a whole-bar rest); status line shows voice when > 1 |
| Go to bar | `⌘G` | same | ✅ modal prompt → `goToBar`; also View→Go To Bar |
| Click any beat in score (incl. empty bars) | mouse | — | ✅ `getBeatAtPos`; picks string from tab-staff Y |
| Click a note | mouse | — | ✅ selects its string |
| Click a track in multiview → switch controls | mouse | — | ✅ re-picks track by click Y (drum row → drum palette) |
| Click a **bar square** in the track list | mouse | — | ✅ selects that track and jumps the edit cursor to that bar (`goToBar`) |

## Selection & clipboard
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Extend selection by a beat | `⇧→` / `⇧←` | same | ✅ beat range on voice 0 of the current track, across bars; amber highlight |
| Select all | `⌘A` | same | ✅ every beat in the current track |
| **Mouse click-drag select** | drag in the score | — | ✅ drag across beats/bars selects a range; a plain click clears it. Crossing into another track's staff makes it a **cross-track block** |
| **Cross-track block selection** | drag across staves | GP block | ✅ bar range × track range (whole bars); highlights span every covered staff in multi-track view |
| **Select whole bars** | shift-click track-list bar squares | — | ✅ shift-click a second bar square selects that bar range on the track (`selectBars`) |
| Copy | `⌘C` / menu Edit→Copy | same | ✅ within-track → beat list; cross-track → **whole-bar block** (`{kind:'beats'|'block'}` clipboard) |
| Cut | `⌘X` / menu Edit→Cut | same | ✅ within-track removes beats (≥1/bar); block clears the covered bars |
| **Paste (incl. multi-track)** | `⌘V` / menu Edit→Paste | same | ✅ beat list inserts after the cursor; **block** writes each captured track/bar from the cursor down, clamped to range (one undo step) |
| Copy last beat | `C` | same | ✅ duplicates the previous beat at the cursor |

> Selection is voice-0. Single-track = beat range; cross-track = whole-bar block. Clears on any
> edit or plain navigation. Vertical `⇧↑↓` range and bar-reflow on overfull paste are still backlog.

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
| Set duration (whole … 32nd) | toolbar `1 ½ ¼ ⅛ 16 32` | — | ✅ applies across the beat selection if one is active, else the current beat |
| Decrease note duration | `+` / `=` | same | ✅ |
| Increase note duration | `-` / `_` | same | ✅ |
| Dotted | `.` / toolbar `.` | same | ✅ single dot toggle |
| Double dotted | `⌘.` / toolbar `‥` | same | ✅ |
| Triplet (3 in space of 2) | `/` / toolbar `3` | same (Triolet) | 🟡 per-beat (spanning groups → backlog) |
| Tuplets 5 / 6 / 7 / 9 | Note menu | same | ✅ `setTuplet(n)`; denom = nearest lower power of two; applies across the beat selection (spanning groups), toggles off when all selected already have it |
| Rest | `R` / toolbar `R` | same | ✅ clears beat to a timed rest |
| Insert beat after cursor | `⌃+`, toolbar `＋beat`, or `→` at end | `⌃+` | ✅ **capacity-aware**: appends within the bar, or **flows into a new bar** (created if at the end) once the bar is full per its time signature. `→` at the last beat of the last bar always extends — including after a silence |
| Delete the beats | `⌘-` / toolbar `－beat` | `⌘-` | ✅ |
| Insert bar (to all tracks) | `⌘+` / toolbar `＋bar` | `⌘+` / `Ins` | ✅ whole-rest bar, master bars kept aligned |
| Delete bar (from all tracks) | `⌃-` / toolbar `－bar` | `⌃-` | ✅ JSON round-trip rebuild; keeps ≥1 bar |
| Time signature | `⌘T` / **click the time sig in the transport chip** / palette `4/4` / menu Bar→Time Signature | same | ✅ modal (beats / note value, incl. custom e.g. 3/4, 6/8); applies from the current bar to the end. The transport chip shows the current bar's time signature live |
| Key signature | `⌘K` / menu Bar→Key Signature | same | ✅ modal (−7..+7 accidentals + major/minor); applies from the current bar to the end |
| Open / close repeat | `[` / `]` / menu Bar | same | ✅ notation barline + **playback loops** (repeats unrolled into the event list; play cursor jumps back). Alternate endings → backlog |
| Beat text | `T` / menu Note→Text | same | ✅ free-text annotation on the current beat (modal; blank clears) |
| Directions (Segno/Coda/Fine, D.C./D.S. jumps) | menu Section | `D` | ✅ notation + **playback**: D.C. / D.C. al Fine / D.S. / D.S. al Fine drive the play order (once, stop at Fine). Coda variants → backlog |
| Fermata | `F` / menu Section | same | 🟡 per-beat hold (notation); playback timing unchanged |
| Chord | `A` / menu Note→Chord | same | ✅ names a chord on the beat (+ optional fret diagram); modal, blank clears |
| Triplet feel (swing) | `⌘/` / menu Note | same | ✅ notation from the current bar onward; **MIDI swings** (2:1 8th-grid warp in `rebuildSequence`). ⚠ confirm feel by ear |

## Effects
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Bend | `B` / menu Effects→Bend… | `B` | ✅ preset shapes (full / half / bend&release / pre-bend / pre-bend&release); **MIDI pitch-bend emitted** (per-channel; resets to centre at note end). Imported GP bends play too. ⚠ confirm pitch by ear |
| Palm mute (current note) | `P` | same | ✅ shorter+softer in MIDI playback |
| Palm mute (whole beat) | `⇧P` / toolbar `P.M.` | same | ✅ |
| Dead note | `X` / toolbar `✕` | same | ✅ short percussive thunk in MIDI |
| Let ring | `I` / toolbar `L.R.` | same | ✅ rings until the next note on the same string (per-string in `rebuildSequence`), or the track end |
| Tie note / tie beat | `L` / `⇧L`, toolbar `⌣` | same | ✅ copies pitch; sustains the ringing note in MIDI |
| Hammer-on / pull-off | `H` / toolbar `H` | same | 🟡 notation; MIDI legato approximation (hammered/pulled note plays softer, not re-picked); true mono-legato → backlog |
| Legato slide | `S` / toolbar `sl` | same | 🟡 notation done; MIDI plain (pitch-bend slide → backlog) |
| Ghost note | `O` / toolbar `gh` | same | ✅ softer in MIDI |
| Staccato | `!` / toolbar `·` | same | ✅ shortened in MIDI |
| Accent / heavy accent | `;` / `:`, toolbar `>` | same | ✅ louder / much louder in MIDI |
| Natural harmonic | `Y` / toolbar `◇` | same | 🟡 notation done; MIDI plain |
| Artificial / pinch harmonic | menu Effects | `⌥Y` / — | 🟡 notation; MIDI plain |
| Shift slide / pick slide up·down | menu Effects | `⌥S` / — | 🟡 notation; MIDI plain (legato slide `S` already keyed) |
| Vibrato | `V` / toolbar `∿` | same | 🟡 notation done; MIDI plain |
| Wide vibrato | menu Effects→Wide Vibrato | `⌥W` | 🟡 notation; MIDI plain (⌥-letter keys unreliable → menu) |
| Transpose note: semitone / octave | `⌥⇧↑`·`⌥⇧↓` / `⌥↑`·`⌥↓` | semitone same; octave is a Gomidas mapping | ✅ shifts the fret |
| Brush up / down | `⌘U` / `⌘D` | same | 🟡 beat strum; notation; MIDI plain |
| Arpeggio up / down | `⇧⌘U` / `⇧⌘D` | same | 🟡 notation; MIDI plain |
| Pick stroke up / down | `⇧U` / `⇧D` | same | 🟡 notation; MIDI plain |
| Tremolo picking | `"` | same | 🟡 beat-level (16th); notation; MIDI plain |
| Trill | `N` | same | 🟡 trills to fret+2; notation; MIDI plain |
| Grace note (before / on beat) | `G` / menu (on beat) | `G` / `⌥G` | 🟡 notation; MIDI plain |
| Slap / pop | `$` / menu (pop) | same | 🟡 bass; notation; MIDI plain |
| Fade in / out / volume swell | `<` / `>` / menu (swell) | `<` / `>` / `⌥<` | 🟡 notation; MIDI plain |
| Tremolo / whammy bar | menu Effects→Tremolo Bar | `⌥V` | 🟡 beat-level dip-and-return (`whammyBarType` Dip + bend points); notation; MIDI plain |
| Wah open / closed | menu Effects→Wah Open/Closed | `⌥O` / `⌥C` | 🟡 beat-level `wahPedal`; notation; MIDI plain |
| Rasgueado | `⇧R` / menu Effects | `⇧R` | 🟡 beat-level flamenco strum (`rasgueado`); notation; MIDI plain |
| Left-hand tapping | `(` / menu Effects | `(` | 🟡 note-level `isLeftHandTapped`; notation; MIDI plain |
| Tapping | `)` / menu Effects | `)` | 🟡 beat-level `tap`; notation; MIDI plain |

## Drum view (KIT VIEW / GROOVE EDITOR / MIXER) — reference redesign (2026-06-28)
| Feature | How | Notes |
| --- | --- | --- |
| Purple theme + colored timeline | app-wide | ✅ reference palette; track-kind colors (drums purple / bass blue / guitar orange); continuous per-track timeline bands |
| **KIT VIEW** | drum track, bottom panel | ✅ photoreal kit (`web/drumkit.png`) with clickable hotspots per piece → toggle hit on the current beat + select; hit pieces ring purple |
| Quick Tools | KIT VIEW rail | ✅ Select/Draw/Erase/Paint entry modes + Accent/Ghost/Repeat/Tie actions |
| Articulation panel | KIT VIEW right | ✅ per-piece GM articulation (Hi-Hat Closed/Open/Pedal, Snare Center/Side-stick, Ride/Bell…) + Velocity→dynamic |
| **Pattern Library** | row under the kit | ✅ categories + search, groove cards with dot-grid preview, ▶ audition, ＋ insert, ♡ favourite (localStorage); **Add Pattern** captures the current bar as a User Groove |
| **Groove insert** | card ＋ / dbl-click / Insert Pattern | ✅ writes the groove as sixteen 16th-steps; honours accents/ghosts; Replace-Bar or Append-Bars (Insert Options) + target Voice |
| **GROOVE EDITOR** | drum tab | ✅ step-sequencer grid (lanes × 16); click toggles, Shift=accent, Alt=ghost; edits rewrite the bar live |
| **Generate Variation** | inspector button / `E.generateVariation()` | ✅ seeded musical variation (ghost hats/snares, off-beat kicks, accented backbeat) |
| Kit picker | inspector SOUNDS | ✅ Standard/Room/Rock/Electronic/808/Jazz/Brush/Orchestra → drum program (kit) |
| **MIXER tab** | drum tab | ✅ per-piece level sliders → scale hit velocity in `rebuildSequence` (`gomidasDrumGains`) |
| Insert Options | inspector | ✅ Insert mode (Replace/Append) + Voices 1–4 |

## Drums
| Feature | How | Notes |
| --- | --- | --- |
| Create drum track | `New… → Drums` / `New… → Full Band` / `+ Track… → Drums` | ✅ full GM kit (channel 9) |
| Drum palette (replaces fretboard on a percussion track) | click a pad | ✅ 17-piece GM kit: crash/splash/china/ride/ride-bell, HH open/closed/pedal, toms hi/mid/floor, snare, side-stick, hand-clap, tambourine, cowbell, kick |
| Place / remove a hit on the current beat | click pad (toggles; pads stack) | ✅ auditions the hit |
| Keyboard drum entry | digits `1`–`9` (pad labels show the hotkey); `0` rests | ✅ toggles the matching kit piece on the current beat |
| Drum playback | automatic | ✅ articulation → `outputMidiNumber` on GM channel 9 |

> Pieces resolve to the track's `percussionArticulation` index by GM MIDI key, so the palette
> works on imported GP drum tracks too. Keyboard drum entry → backlog.

## Playback / transport
| Feature | Key | Notes |
| --- | --- | --- |
| Play / stop | `Space` / toolbar `▶ Play` | ✅ native transport owns the clock (960 PPQ). **Starts from the edit cursor** (seeks the transport to the cursor's tick before playing), not bar 1. **Resumes from the green play position** after a stop unless the edit cursor was repositioned since. Space is ignored while typing in a field / modal |
| Single cursor over tab & notation | automatic | ✅ one cursor; follows the transport while playing and stays where playback stopped (Play resumes from it) |
| Auto-scroll during playback | automatic | ✅ keeps the play cursor in view (GP-style page turn); only scrolls near an edge. Toggle: `GomidasEditor.setAutoScroll(bool)` |
| Auto-scroll to the **edit** cursor | automatic | ✅ as you navigate/edit, the score scrolls to keep the edit cursor in view (edge-triggered, instant; stands down during playback). Same `setAutoScroll` toggle |
| A/B loop | `⌘L` / menu Sound→Loop Selection | — | ✅ loops the beat selection (or current bar) via `AudioEngine::setLoopRange`; `⌘L` again or Clear Loop turns it off; cleared on score load |
| Metronome | transport `♩` toggle / menu Sound→Metronome | — | ✅ wood-block click on the time-signature grid (downbeat accented), on a free melodic channel; injected into the sequence so it loops/repeats with the music |
| Practice speed (tempo slow-down) | transport speed select (25–150%) | — | ✅ `AudioEngine::setPlaybackRate` scales playback tempo without changing pitch or the notated tempo |
| Count-in | transport `⏱` toggle + 1/2-bar selector / menu Sound→Count-in | — | ✅ **1 or 2 bars** of wood-block clicks at the playback tempo before the transport starts, with a **big on-screen countdown** number over the score; press play again to abort |
| Live input monitor | transport `🎤` toggle / menu Sound→Live Input | — | 🟡 reopens the device with a mic bus and mixes input→output (first toggle triggers the macOS mic prompt) |
| Input plugin insert (AU/VST3) | menu Sound→Load/Clear Input Plugin | — | 🟡 hosts one VST3/AU effect/instrument on the live input; **plugin editor window** (Show Plugin Editor, auto-opens on load). No per-track chains / state-save yet; needs runtime verification |
| Input gain | transport slider (next to `🎤`) | — | ✅ live monitoring gain (0–200%) → `setLiveInput` gain |
| Output level meter | transport VU bar | — | ✅ peak meter (green/amber/red); native pushes `getOutputPeak` ~30 Hz while playing or monitoring |
| Record to WAV | transport `⏺` / menu Sound→Record | — | ✅ records the output mix (tracks + live input) to a 24-bit WAV via a background `ThreadedWriter` (RT-safe); save dialog → `~/Music` default |
| Panic (all notes off) | menu Sound→Panic | — | ✅ stops the transport and force-releases every voice (clears stuck/ringing notes) |
| MIDI instruments per track (GM program) | automatic | ✅ TinySoundFont + FluidR3_GM SoundFont |
| Drum tracks (GM channel 9) | automatic | ✅ articulation → `outputMidiNumber` |

## Realistic sound — per-track SFZ instruments (sfizz)
> Design + build notes: [`REALISTIC_SOUND.md`](./REALISTIC_SOUND.md); CC0 content: [`SOUND_LIBRARIES.md`](./SOUND_LIBRARIES.md).
> ⚠️ In-app audio (inspector preset → speakers) still needs an ear-check; the SFZ→audio path is verified by `tests/sfz_smoketest`.

| Feature | How | Notes |
| --- | --- | --- |
| Per-track SFZ instrument | inspector **SOUNDS → Preset** / Sound menu | ✅ a track plays an SFZ sample instrument via **sfizz** (one `sfz::Sfizz` per channel) through the same per-channel EQ→mix bus; engine = `src/synth/SfzSynth` |
| Built-in CC0 presets | inspector Preset dropdown | ✅ Classical Guitar + Electric Bass bundled (`assets/instruments/`, copied to app Resources); load instantly, no download |
| Load custom `.sfz` | Preset → *Load file…* / Sound menu | ✅ native file chooser; loads any SFZ onto the current track (session-only) |
| RSE / MIDI engine pill | inspector SOUNDS | ✅ shows which engine a track uses; RSE = SFZ loaded, MIDI = SoundFont. Picking a GM Sound/Kit clears the SFZ |
| Persist instrument in `.gomidas` | Save / Open | ✅ built-in presets reload on open (envelope `{gomidasVersion,instruments,score}`; legacy files still load) |
| Pitch-bend / CC events | event format | 🟡 plumbing only (`NoteEvent.kind/value` → TSF/sfizz, ±12 bend) — no slide/bend emission yet (deferred, needs ear) |
| SFZ audio smoke test | `cmake -DGOMIDAS_BUILD_TESTS=ON` → `sfz_smoketest` | ✅ loads an SFZ, plays a note, asserts non-silent output (guitar+bass PASS) |

## UI / app
| Feature | How | Notes |
| --- | --- | --- |
| GP8-style dark layout | — | transport · left palette · score · right SONG/TRACK inspector · bottom track list |
| **SVG icon set** (GP8-style) | — | ✅ inline `<symbol>` sprite + `Icons.use(name)` helper in `index.html` (~50 monochrome `currentColor` icons). Replaced all emoji/unicode glyphs across transport, palette, track list, inspector |
| **Track timeline (bar squares)** | bottom track list | ✅ per-track row of small fixed-width per-bar blocks, filled in the track color where the bar has notes, current bar outlined; **click a square to jump to that bar**, **shift-click to select a bar range**. Bar-number ruler in the header. **Horizontal scroll**: ruler + all rows scroll-synced (controls frozen-left); the timeline follows the current bar |
| **Time-grid tab ("piano roll for tabs")** | panel below the score · `⇧⌘G` / View→Toggle Beat Grid | — | ✅ a **consistent rhythm view** rendered by us on a canvas (`editor.js renderBeatLane`), since alphaTab's engraved tab is optically spaced and can never be even. **The grid represents TIME, not note count**: every 4/4 bar is the same width; each bar's columns **adapt to its smallest value** (8ths→8, 16ths→16, triplets→3/beat — `laneBeatK`). BEAT row (1·2·3·4) + counting row (`e + a` etc.); fret numbers sit on string rows (e B G D A E gutter) at their **start time** with a duration bar (ties=long bars, rests=gaps). Center-locked green **playhead** during playback (music flows in from the right), purple edit cursor, click-to-seek. Engraved tab/notation above stays source of truth. _v2 deferred:_ fretboard-dot strip, left rhythm thumbnails, right annotations |
| **Collapsible drawers (per panel)** | chevron handle on each panel | — | ✅ every dockable panel (Tools / Inspector / Beat Grid / Fretboard / Tracks) has a corner chevron that collapses it in place to a thin **labelled rail** (vertical title for side panels, horizontal for bottom); click the rail to expand. State persists per panel (`gomidasDrawer_*`); score reflows. Panels that rebuild via `innerHTML` keep the handle via a `MutationObserver` re-append (`app.js initDrawers`) |
| **Collapse / expand panels** | transport ◧ ◨ ▤ buttons / View menu | — | ✅ toggle the left palette / right inspector / track list individually; score reflows |
| **Full view** | transport ⛶ / `F11` / `Esc` / View→Full View | — | ✅ hides all chrome (palette, inspector, tracks, fretboard) leaving transport + score; `Esc` or toggle exits |
| Track row controls | bottom track list | ✅ color swatch · instrument icon · name · show/hide · mute · solo · volume fader + value · **pan knob** (drag; double-click = center) · **EQ button** (3-band per-track EQ popup) · **⋮ track-options menu** (rename / mute / solo / hide / add / delete) |
| **Per-track + master EQ** | track-list EQ buttons / Master row | ✅ 3-band EQ (low/mid/high, −12..+12 dB) per track and on the master, live. Synth re-architected into **per-channel audio buses** (`tsf_copy`) so each track EQs independently. **Persisted** in the `.gomidas` envelope (`mix`: per-track `eq` + master `{vol,pan,eq}`) |
| **Master row** | bottom track list | ✅ live master volume + balance pan + EQ |
| **Expanded left palette** | left palette | ✅ GP8 sections: voice tabs 1–4, Lyrics/Chords, bar & signatures, octave/clef (8va/8vb/15ma/15mb → `beat.ottava`, shifts playback octave), durations, tuplets, **dynamics ppp–fff** (→ velocity), **crescendo/diminuendo** (notation marking **+ playback velocity ramp** across the hairpin span), articulation grid (~30 effects), bars & beats |
| Native macOS menu bar | menu bar | File / Edit / Track / Bar / Note / Effects / Section / Tools / Sound / View / Window / Help |
| Track mute / solo | track-list M / S | ✅ live via per-channel gain in `AudioEngine` (`setChannelMix`); solo overrides mute; takes effect instantly during playback |
| Track volume (mixer) | track-list slider | ✅ per-track linear gain (0–100%), live; defaults from `playbackInfo.volume` |
| Track pan (mixer) | inspector TRACK→Mixer slider | ✅ per-track pan (L/C/R), live via `setChannelMix`; defaults from `playbackInfo.balance` |
| Track show / hide | track-list 👁 | ✅ toggles the track in the score (multi-track view); does not mute it |
| Single-track focus | click a track row / `track-select` | ✅ shows that track alone (GP-style); eye control returns to multi-track view |
| Inspector — TRACK (live) | right panel | ✅ color swatch + instrument icon + short-name badge · editable name · **notation icon toggles** (staff/tab) · **re-tune picker** (expanded presets + saved user tunings + **Custom / Edit…** per-string editor) · GM sound picker · pan. SOUNDS controls follow the engine mode (RSE hides the GM picker). **Deferred (greyed `.gd-soon`):** Interpretation section (playing-style sim) |
| Custom tuning editor | inspector tuning → Custom / Edit… | — | ✅ per-string pitch picker modal; **Save & apply** persists to `localStorage` (`gomidasUserTunings`), saved tunings (★) merge into the preset list for matching string counts |
| **GP-style bar-fill indicator** | timeline + status line | — | ✅ per-bar `under`/`exact`/`over` classifier across all voices; amber dot = incomplete, red = overfilled on the track-list squares; status line warns for the current bar |
| Transport view clusters | transport | 🟡 page-view toggles (page/vert/wide) + right instrument cluster (audio/guitar/keys/drums) are single-select **visual** toggles. **Print** works (`window.print()`); **Tuner** is deferred (greyed) |
| Print | transport `🖨` / menu File→Print | ✅ prints the rendered score via the WebView |
| Transpose | menu Tools→Transpose | ✅ shift current beat or whole track by ±24 semitones (tab: shifts frets) |
| Lyrics | palette `Lyrics` | ✅ per-beat lyric syllable (`beat.lyrics`) |
| Window / Help | menu Window→Minimize, Help→About | ✅ native minimise + About box |
| Inspector — SONG (live) | right panel `SONG` tab | ✅ editable title + tempo |
| Zoom | transport `−` / `＋` or `⌘<` / `⌘>` | ✅ rescales the score |
| Multitrack view toggle | `F3` / menu View→Toggle Multitrack View | ✅ flips focused single track ↔ all non-hidden tracks |

## Edit history
| Feature | Gomidas key | GP8 | Notes |
| --- | --- | --- | --- |
| Undo | `⌘Z` | same | ✅ score-JSON snapshots, debounced |
| Redo | `⌘⇧Z` / `⌘Y` | same | ✅ |

---
### Notes / minor divergences from GP8
- Keymap follows GP8. Extras on top of GP: `PageUp`/`PageDown` alias `⌘↑`/`⌘↓` (track nav), and
  `→` at the **last beat of the last bar** always appends/extends a beat (convenience; GP uses `⌃+`).
  Beat insertion is capacity-aware — a full bar **flows into the next bar** instead of overfilling.
  (Holding `→` keeps spawning beats, one per repeat; undo / `−beat` reverse an overshoot.)
- Triplets apply **per beat**, not yet as a GP-style spanning tuplet group.
- Let ring now sustains until the next note on the same string (or the track end), per GP.
