// GMD-68 — the two real globals the plain-JS editor files rely on.
//
// `app.js` / `editor.js` / `fretboard.js` / `grooves.js` / `core/gomidas-core.js` load as plain
// <script> globals, so `alphaTab` and `GomidasCore` come from other <script> tags rather than an
// import. Declaring them here is what turns the dangling-reference sweep into a real gate: with
// these two known, ANY remaining TS2304 in those files is a reference to something that does not
// exist. See tools/checkjs-sweep.mjs.
//
// Deliberately in types/ rather than core/: the main tsconfig.json includes `core/**/*`, so a
// .d.ts there would leak these `any` globals into the main build, where they could mask a real
// error in a .ts file. types/ is outside that include — only tsconfig.sweep.json reads it.

/** alphaTab classic bundle, loaded from `alphaTab.min.js` (see index.html). */
declare const alphaTab: any;

/** Shared editor core, loaded from `core/gomidas-core.js` (see index.html). */
declare const GomidasCore: any;
