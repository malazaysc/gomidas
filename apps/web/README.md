# Gomidas — browser build

Vite shell over the shared editor. **Not a copy**: Vite's root is `../../packages/core`, the same
directory the desktop app embeds, so both products serve one `index.html` and one set of
compiled JavaScript. There is nothing to keep in sync because there is only one of everything.

```bash
npm install
npm run dev      # compiles ../../packages/core with tsc, then serves it at http://localhost:5173
npm run build    # tsc, then apps/web/build.mjs -> apps/web/dist (~19MB)
npm run preview  # serve the production output
```

Both scripts run the TypeScript build first (`npm --prefix ../../packages/core run build`),
because `index.html` loads `dist/*.js` — the same paths the JUCE WebView resolves through
`MainComponent`'s `kAssets` table.

⚠️ **Adding a script tag means adding a row in `kAssets` AND a row in `build.mjs`'s copy list.**
The build now fails loudly if you forget the second one, rather than shipping a dead reference.

## The production build is `build.mjs`, not `vite build`

`vite build` cannot build this app, and used to fail *silently*: `index.html` loads classic
(non-module) scripts, which Vite refuses to process **and does not copy**, so the output was an
`index.html` pointing at fourteen files that were not there — plus 151MB of FluidR3 that nothing
fetches, because `publicDir` was the whole `assets/` tree. It exited 0. That was GMD-56/GMD-52.

`build.mjs` copies an explicit **allowlist**, content-hashes the JavaScript (so a CDN can cache
it forever), and then **verifies** the result: every reference in the emitted HTML, plus every
path the running code fetches without one, must resolve to a file that exists. Vite stays for
`dev`, where its file serving genuinely earns its place.

## What works today

The whole editor renders and is interactive — notation + tab, beat grid, fretboard, track list,
inspector, palette — and **plays audio** through the Web Audio scheduler and channel strip
(GMD-33). Authoritative feature status is `docs/FEATURES.md`.

`caps.liveInput` and `caps.pluginHost` are `false` and always will be — VST/AU hosting and
low-latency live input are why the desktop app exists. The desktop-only methods are *absent*
from the web backend rather than no-ops, so UI that forgets to check `caps` fails loudly.

See `docs/WEB_PORT.md` for the full plan and `GMD-30`…`GMD-39` for the phases.
