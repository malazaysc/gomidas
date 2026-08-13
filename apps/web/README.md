# Gomidas — browser build

Vite shell over the shared editor. **Not a copy**: Vite's root is `../../packages/core`, the same
directory the desktop app embeds, so both products serve one `index.html` and one set of
compiled JavaScript. There is nothing to keep in sync because there is only one of everything.

```bash
npm install
npm run dev      # compiles ../../packages/core with tsc, then serves it at http://localhost:5173
```

`npm run dev` and `npm run build` both run the TypeScript build first (`npm --prefix ../../packages/core
run build`), because `index.html` loads `dist/*.js` — the same paths the JUCE WebView resolves
through `MainComponent`'s `kAssets` table. **Adding a script tag means adding a row there too.**

## What works today (GMD-32)

The whole editor UI renders and is interactive: notation + tab, beat grid, fretboard, track
list, inspector, palette. Scores open through a file picker.

**There is no audio.** `createWebBackends()` supplies a real `HostBackend` and a *silent*
`AudioBackend`; GMD-33 replaces it with the Web Audio scheduler and channel strip. Everything
above the seam is already written against the interface, so that is a swap, not a rewrite.

`caps.liveInput` and `caps.pluginHost` are `false` and always will be — VST/AU hosting and
low-latency live input are why the desktop app exists. The desktop-only methods are *absent*
from the web backend rather than no-ops, so UI that forgets to check `caps` fails loudly.

See `docs/WEB_PORT.md` for the full plan and `GMD-30`…`GMD-39` for the phases.
