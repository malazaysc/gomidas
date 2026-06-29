# Bundled SFZ instruments

Small, **CC0** SFZ sample instruments shipped inside the app. A CMake `POST_BUILD` step copies this
whole directory to `Gomidas.app/Contents/Resources/instruments/`, and sfizz loads them by absolute
path. They appear in the inspector **SOUNDS → Preset** dropdown.

> Only bundle **small, redistributable** content here (CC0 ideal — see `docs/SOUND_LIBRARIES.md` for
> the licensing bar and the hard-avoid list). Big sets (good CC0 drum kits are 1.6–2.3 GB) must NOT go
> here — they're for the future download-on-first-run path.

## Current contents
| Folder | Instrument | License | Source |
| --- | --- | --- | --- |
| `classical-guitar/` | FreePats Spanish Classical Guitar | CC0 (`cc0.txt`) | freepats.zenvoid.org |
| `electric-bass/` | FreePats PickedBass YR (Yamaha RBX) | CC0 (`cc0.txt`) | freepats.zenvoid.org |

Each `.sfz` was given `bend_up=1200 / bend_down=-1200` in its `<global>` so sfizz allows ±12-semitone
bends, matching the TSF engine (see the "Gomidas:" comment in each file). Otherwise the files are the
upstream CC0 content.

## Adding a preset
1. Drop the instrument folder here (`<id>/<id>.sfz` + its `samples/` + a license file). Keep sample
   paths **relative** (`sample=samples/...`) — sfizz resolves them next to the `.sfz`.
2. Add an entry to `window.gomidasSfzPresets` in `web/app.js`:
   ```js
   { id: '<id>', name: '<Display Name> (CC0)', file: '<id>/<id>.sfz', kind: 'guitar'|'bass'|'drums' }
   ```
3. Rebuild — the POST_BUILD copy picks it up; it shows in the inspector Preset dropdown.
4. **Verify it sounds:** `cmake -B build -DGOMIDAS_BUILD_TESTS=ON && cmake --build build --target sfz_smoketest`
   then `./<build>/sfz_smoketest assets/instruments/<id>/<id>.sfz <midiNote>` → expect `PASS`.

## Pre-ship licensing check
Confirm CC0/permissive in the **actual files bundled** (not just the web page). See the checklist in
`docs/SOUND_LIBRARIES.md`.
