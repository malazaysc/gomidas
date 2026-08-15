// Gomidas — browser build: DEV SERVER ONLY (GMD-32, docs/WEB_PORT.md §10 Phase 1).
//
// ⚠️ `vite build` IS NOT THE PRODUCTION BUILD — use `apps/web/build.mjs` (`npm run build`).
// Vite cannot build this app: index.html loads every script as a CLASSIC <script src=…>, and
// Vite refuses to process non-module scripts *and does not copy them*. It emitted an index.html
// referencing fourteen files that were not in the output — and still exited 0. That is GMD-56.
// There is also no module graph to bundle by design (§11), so it had nothing to contribute.
// This config now exists purely for `vite dev`, where its file serving does earn its place.
//
// Deliberately NOT a copy of the editor. Vite's root IS `packages/core/`, the same directory the
// desktop app embeds, so both products serve the SAME index.html and the SAME compiled
// JavaScript. There is nothing to keep in sync because there is only one of everything.
//
// That works because index.html loads plain <script src="dist/…"> tags: the WebView resolves
// those through MainComponent's kAssets table, and the browser reads them off disk. Keep those
// two in step — a path added here needs a row there, AND a row in build.mjs's copy list.
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const webRoot = fileURLToPath(new URL('../../packages/core', import.meta.url));

export default defineConfig({
  root: webRoot,
  // Bundled CC0 SFZ instruments live in assets/, outside the web root. Serving that directory
  // as the public dir puts them at /instruments/... — the same relative path the desktop app
  // resolves inside Gomidas.app/Contents/Resources.
  //
  // In DEV this serving the whole tree is harmless: nothing fetches the 151MB FluidR3 bank, so
  // it costs nothing to leave visible. It was fatal only because `vite build` COPIED publicDir
  // verbatim into the output (GMD-52). build.mjs ships an explicit allowlist instead, which
  // cannot regress the same way — a new file under assets/ is invisible until someone adds it.
  publicDir: fileURLToPath(new URL('../../assets', import.meta.url)),
  // Everything is same-origin and relative, so the app works from a subpath too.
  base: './',
  server: {
    port: 5173,
    open: true,
    fs: {
      // Vite must be allowed above its root to reach node_modules for HMR plumbing.
      allow: [fileURLToPath(new URL('../..', import.meta.url))]
    }
  },
  // Not used to build (see the header) — this is what `vite preview` reads to find build.mjs's
  // output, so `npm run preview` serves the real production tree.
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true
  },
  // The editor is vanilla DOM with global <script> tags — there is no module graph for Vite to
  // optimise, and it must stay that way (§11: keep any framework strictly outside the editor).
  optimizeDeps: { include: [] }
});
