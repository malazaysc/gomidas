// Gomidas — browser build (GMD-32, docs/WEB_PORT.md §10 Phase 1).
//
// Deliberately NOT a copy of the editor. Vite's root IS `web/`, the same directory the desktop
// app embeds, so both products serve the SAME index.html and the SAME compiled JavaScript. There
// is nothing to keep in sync because there is only one of everything.
//
// That works because index.html loads plain <script src="dist/…"> tags: the WebView resolves
// those through MainComponent's kAssets table, and the browser reads them off disk. Keep the two
// in step — a path added here needs a row there.
//
// The monorepo tidy (web/ -> packages/core/, this -> apps/desktop's sibling) is Phase 8 on
// purpose. Do not restructure yet; let the seam prove itself first.
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const webRoot = fileURLToPath(new URL('../../web', import.meta.url));

export default defineConfig({
  root: webRoot,
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
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true
  },
  // The editor is vanilla DOM with global <script> tags — there is no module graph for Vite to
  // optimise, and it must stay that way (§11: keep any framework strictly outside the editor).
  optimizeDeps: { include: [] }
});
