// GOM-93 — no UI text may need a font the app doesn't ship. macOS has every symbol font; a bare
// Linux install has one sans (Liberation Sans here), so a glyph outside it renders as a box. Icons go
// to the SVG sprite, music symbols to Bravura via SMuFL code points (written as numbers, e.g.
// 0xE4C0, so they never appear as literal characters), and literal text stays inside this allowlist.
// A manual one-font run is how the rule was proved once; this keeps it proved.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8');

// Latin-1 plus the few typographic symbols the UI uses, each checked present in Liberation Sans
// (fc-list ':charset=<hex>').
const SAFE = new Set([...'…—–−’•←↑→↓⅛'].map((c) => c.codePointAt(0)));
// The Private Use Area is where SMuFL lives; in this app only Bravura (.smf) draws it.
const isPua = (cp) => cp >= 0xE000 && cp <= 0xF8FF;
const isSafe = (cp) => cp <= 0xFF || SAFE.has(cp) || isPua(cp);

// The macOS-only shortcut glyphs: only keymap.ts may produce them, and only for platform 'mac'.
const MAC_ONLY = new Set([...'⌘⌥⇧⌃'].map((c) => c.codePointAt(0)));

/** Source text with comments removed, so a glyph in a comment doesn't count. Rough on purpose: a
 *  `//` inside a string can hide the rest of that line (a miss, never a false alarm). */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

/** Escapes decoded to the characters they produce — '\u25B6' and '&#x25B6;' render a box too. */
function decodeEscapes(src) {
  const ch = (hex) => String.fromCodePoint(parseInt(hex, 16));
  return src
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => ch(h))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => ch(h))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => ch(h))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function offenders(rel, extraAllowed = new Set()) {
  const text = decodeEscapes(stripComments(read(rel)));
  const found = new Map();
  text.split('\n').forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (!isSafe(cp) && !extraAllowed.has(cp)) {
        const key = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') + ' ' + ch;
        if (!found.has(key)) found.set(key, rel + ':' + (i + 1));
      }
    }
  });
  return [...found.entries()].map(([k, where]) => k + ' at ' + where);
}

describe('UI text needs no font the app does not ship', () => {
  // grooves.js: groove names on the Pattern Library cards; core/menus.ts: the HTML menu bar's labels.
  for (const rel of ['index.html', 'app.js', 'editor.js', 'fretboard.js', 'grooves.js',
                     'core/webshell.ts', 'core/menus.ts']) {
    it(rel, () => expect(offenders(rel)).toEqual([]));
  }

  it('core/keymap.ts (macOS shortcut glyphs allowed — macOS fonts have them)', () => {
    expect(offenders('core/keymap.ts', MAC_ONLY)).toEqual([]);
  });

  it('catches a glyph outside the allowlist (the check is not vacuous)', () => {
    expect(isSafe('◧'.codePointAt(0))).toBe(false);
    expect(isSafe('♭'.codePointAt(0))).toBe(false);
    expect(isSafe('½'.codePointAt(0))).toBe(true);
    expect(stripComments('a // ◧ comment\nb')).not.toContain('◧');
    expect(decodeEscapes("'\\u25B6' &#x2715; &#9837;")).toBe("'▶' ✕ ♭");
  });
});
