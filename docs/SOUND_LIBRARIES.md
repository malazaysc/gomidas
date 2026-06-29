# Gomidas — Sound Libraries (bundled-content licensing)

License-verified reference for sample content we **bundle inside the closed-source commercial app**
and play with sfizz. Companion to [`REALISTIC_SOUND.md`](./REALISTIC_SOUND.md).

> Verified 2026-06-29 against the actual license pages (URLs below). **Re-verify before shipping** —
> licenses and mirrors change. See the pre-ship checklist at the bottom.

---

## The licensing bar

We are **redistributing the raw samples** inside a **paid, closed-source** product. That is a higher
bar than "use the resulting music commercially." The license must permit redistributing the sample
files themselves, bundled in proprietary software.

| Verdict | Meaning |
| --- | --- |
| **SAFE** | CC0 / public domain — bundle freely, no attribution, no conditions. |
| **ATTRIBUTION** | CC-BY — bundle commercially, must credit in an About/credits screen. |
| **COPYLEFT-FLAG** | CC-BY-SA — allowed but ShareAlike + attribution attach to the audio; can't wrap in a restrictive EULA. Avoid for closed-source. |
| **DEALBREAKER** | Forbids commercial bundling / sample redistribution. Do not use. |

---

## Bundled now (in `assets/instruments/`, copied to app Resources at build)
| Instrument | Source | License | Size |
| --- | --- | --- | --- |
| `classical-guitar` | FreePats Spanish Classical Guitar | CC0 | 5.2 MB (SFZ+FLAC) |
| `electric-bass` | FreePats PickedBass YR (Yamaha RBX, pick) | CC0 | 2.8 MB (SFZ+FLAC) |

These ship inside the app and load instantly as inspector presets (no download). **Drums are
deliberately not bundled** — the good CC0 kits (Karoryfer) are ~1.6–2.3 GB, so they'll be
download-on-first-run. CC0 confirmed in each bundled `cc0.txt`.

## Recommended default set — all CC0, SFZ-native, zero attribution

This is a complete guitar + bass + drums default with **no legal conditions at all** (no credit
screen required for the strictly-CC0 picks).

| Slot | Pick | License | Source |
| --- | --- | --- | --- |
| Acoustic guitar | **FreePats Nylon / Spanish Classical** | CC0 | freepats.zenvoid.org/Guitar/acoustic-guitar.html |
| Clean electric guitar | **FreePats Clean Electric Guitar** (incl. **DI variant** → optional NAM amp sim) | CC0 | freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html |
| Distorted electric (optional) | FreePats Distorted Electric Guitar | CC0 | freepats.zenvoid.org/ElectricGuitar/distorted-electric-guitar.html |
| Electric bass | **Karoryfer Growlybass / Fashionbass** (rich) or **FreePats Clean Electric Bass** (light) | CC0 | github.com/sfzinstruments · freepats.zenvoid.org/ElectricGuitar/clean-electric-bass.html |
| Acoustic drum kit | **Karoryfer Big Rusty Drums** (~2.3 GB full kit) | CC0 | github.com/sfzinstruments/karoryfer.big-rusty-drums |
| Aux/orchestral perc (optional) | **VCSL** | CC0 | github.com/sgossner/VCSL |

**Upgrade (one credit line):** Naked Drums (Wilkinson Audio, CC-BY 4.0) or FreePats MuldjordKit
(CC-BY 4.0) sound more polished — add e.g. "Drums: MuldjordKit, CC-BY 4.0" to a credits screen.

---

## Per-library findings

### FreePats — the backbone (per-library license; the good ones are CC0)
SFZ-native (ships SFZ + FLAC/WAV + SF2). License index: https://freepats.zenvoid.org/licenses.html
CC0 pages read verbatim: *"Published under the terms of the Creative Commons CC0 1.0 public domain
dedication."*

| Library | License | Verdict |
| --- | --- | --- |
| Nylon-String / Spanish Classical Guitar | CC0 1.0 | **SAFE** |
| Clean Electric Guitar (incl. DI/direct) | CC0 1.0 | **SAFE** |
| Distorted Electric Guitar | CC0 1.0 | **SAFE** |
| Clean Electric Bass (Yamaha RBX, pick+finger) | CC0 1.0 | **SAFE** |
| Acoustic Drum Kit (MuldjordKit) | CC-BY 4.0 | **ATTRIBUTION** |
| **Steel-String Acoustic Guitar** | GPLv3 + exception | **DEALBREAKER** |

The steel-string's GPL "special exception" only covers a rendered *composition*, not the raw samples
(*"...these sounds do not by themselves cause the entire composition...to be covered by the GNU
GPL."*). The sample files stay plain GPLv3 → incompatible with closed-source bundling. **Use the CC0
nylon guitar instead.**

### Karoryfer Samples — best content depth, CC0 (free catalog)
The old custom "Lizard/Lecold" license is **defunct** — Karoryfer relicensed the entire free catalog
to **CC0 in Nov 2022** (announcement: kvraudio.com/forum/viewtopic.php?t=588927). Stated at
shop.karoryfer.com/pages/free-samples: *"All our free sample libraries are under a Creative Commons
Zero license."* CC0 legal code ships in each GitHub repo. **SFZ-native.**

- **Guitar (CC0, SAFE):** Shinyguitar (~352 MB), Emilyguitar (~98 MB), Black And Green Guitars (~500 MB)
- **Bass (CC0, SAFE):** Growlybass, Swagbass, Fashionbass, Pastabass, Black And Blue Basses, Meatbass
- **Drums (CC0, SAFE):** Big Rusty Drums (~2.3 GB), Swirly Drums (~1.6 GB)
- **DEALBREAKER nearby:** the **Rickenbacker 4001** on sfzinstruments is **CC-BY-NC-SA** (NonCommercial),
  *not* a Karoryfer CC0 title — avoid.

### Versilian — pristine CC0, but wrong content for us
- **VCSL** (github.com/sgossner/VCSL): genuine CC0 1.0 (README: *"...even make commercial software, no
  royalties, no credit."*). **SAFE.** But no acoustic/electric guitar, no electric bass; only orchestral
  drum/cymbal singles (no assembled kit). SFZ on a non-default `sfz` branch. Keep as a CC0 aux-percussion
  source.
- **VSCO 2 Community Edition**: CC0 (*"...a Creative Commons 0 (i.e. public domain) license."*). **SAFE**,
  ships SFZ+WAV. Chamber orchestra only — no guitar/bass/kit. Off-target.

### Other sources evaluated — mostly dealbreakers
| Source | Finding | Verdict |
| --- | --- | --- |
| Sonatina Symphonic Orchestra | CC Sampling Plus 1.0 — bars commercial whole-copy redistribution | **DEALBREAKER** |
| Virtual Playing Orchestra | FAQ: no profiting from repackaging source material | **DEALBREAKER** |
| No Budget Orchestra | *"may not use it for commercial sample libraries"* | **DEALBREAKER** |
| Pianobook | Terms §5 forbid redistributing as sampler content / competitive products | **DEALBREAKER** |
| Unreal Instruments (Standard Bass/Guitar) | "Custom" license, no text anywhere (404s) | **DEALBREAKER** (no grant) |
| Salamander Drumkit / AVL (Black Pearl, Red Zeppelin) | CC-BY-SA 3.0 | **COPYLEFT-FLAG** — avoid |
| Naked Drums (Wilkinson Audio) | CC-BY 4.0 — best-sounding realistic kit | **ATTRIBUTION** |
| SM Drums | Listed Public Domain (~2.2 GB) | SAFE *if* PD wording confirmed in its manual |
| Greg Sullivan | CC-BY 3.0 — electric pianos only | N/A (no guitar/bass/drums) |

---

## Pre-ship checklist
1. **Open the LICENSE file inside each actual download we bundle.** Older Karoryfer mirrors carried the
   pre-2022 license; current GitHub repos are CC0. Confirm CC0 in the bytes we ship, not just the web page.
2. **FreePats steel-string = GPL** — make sure we shipped the **nylon** acoustic, not the steel-string.
3. If we use **SM Drums**, confirm the PD/CC0 statement in its bundled manual.
4. For any **CC-BY** pick (MuldjordKit / Naked Drums), add the required credit line to the About screen.
5. Avoid every **DEALBREAKER** and **COPYLEFT-FLAG** above.

## Hard-avoid list (quick reference)
Sonatina · Virtual Playing Orchestra · No Budget Orchestra · Pianobook · Unreal Instruments ·
FreePats steel-string (GPL) · any CC-BY-NC (Rickenbacker 4001) · CC-BY-SA kits (Salamander/AVL).
