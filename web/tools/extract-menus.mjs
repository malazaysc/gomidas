// Generates web/core/menus.ts from the menu table in src/ui/MainComponent.cpp.
//
// The C++ table is the SINGLE SOURCE OF TRUTH: the desktop app builds a real macOS menu bar from
// it, and the browser has no native menus (caps.nativeMenus === false) so it renders its own from
// this generated copy. Hand-maintaining two copies of 157 items would drift within a week.
//
// Run: node tools/extract-menus.mjs      (checked by tests/menus.test.js, so CI catches drift)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const cppPath = fileURLToPath(new URL('../../src/ui/MainComponent.cpp', import.meta.url));
const outPath = fileURLToPath(new URL('../core/menus.ts', import.meta.url));

export function parseMenus(source) {
  const start = source.indexOf('menus = {');
  if (start < 0) throw new Error('menu table not found in MainComponent.cpp');
  // Walk braces to find the end of the initialiser.
  let depth = 0, end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = source.slice(start, end + 1);

  // Brace-aware, NOT a regex over the whole block: a non-greedy regex silently drops the last
  // menus (it lost Window and Help), and a missing menu is a missing feature on web.
  const menus = [];
  const nameRe = /\{\s*"([^"]+)"\s*,\s*\{/g;
  let m;
  while ((m = nameRe.exec(body)) !== null) {
    const name = m[1];
    // Walk from the inner '{' to its matching '}' so nested item braces are handled.
    let depth = 0, i = m.index + m[0].length - 1, close = -1;
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;
    const inner = body.slice(m.index + m[0].length, close);
    const items = [];
    const itemRe = /\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*"([^"]*)"\s*\}/g;
    let it;
    while ((it = itemRe.exec(inner)) !== null) {
      items.push({ label: it[1].replace(/\\"/g, '"'), action: it[2] });
    }
    if (items.length) menus.push({ name, items });
    nameRe.lastIndex = close;      // resume AFTER this menu, not inside it
  }
  return menus;
}

const menus = parseMenus(readFileSync(cppPath, 'utf8'));
const banner = `// GENERATED FILE — do not edit by hand.
//
// Source of truth: src/ui/MainComponent.cpp (the \`menus\` table). Regenerate with:
//   cd web && node tools/extract-menus.mjs
// tests/menus.test.js re-parses the C++ and fails if this drifts.
//
// The desktop app builds a real macOS menu bar from the C++ table; the browser has no native
// menus (caps.nativeMenus === false) and renders its own from this copy. Both dispatch the same
// action strings through window.gomidasMenu.

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

const GOMIDAS_MENUS = ${JSON.stringify(menus, null, 2)};

  const api = { GOMIDAS_MENUS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasMenus = api;
}());
`;
writeFileSync(outPath, banner);
console.log(`generated core/menus.ts: ${menus.length} menus, ${menus.reduce((n, m) => n + m.items.length, 0)} items`);
