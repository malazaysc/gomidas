// GOM-87 — keyboard shortcuts per platform. GP8 publishes a macOS keymap and a Windows one
// (docs/references/gp8-keyboard-shortcuts.md), and they are not a modifier swap; these pin both
// tables and the one deliberate deviation (plain Del deletes the note on PC, not the track).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import K from '../core/keymap.ts';

const { resolve, label, platformOf, BINDINGS } = K;

const mac = (key, mods = {}) => resolve(key, mods, 'mac');
const pc = (key, mods = {}) => resolve(key, mods, 'pc');

describe('macOS keymap (the pre-GOM-87 bindings; cmd/ctrl/alt now match exactly)', () => {
  it('keeps ⌘ and ⌃ distinct: ⌘+ inserts a bar, ⌃+ a beat; ⌘- deletes beats, ⌃- the bar', () => {
    expect(mac('+', { meta: true, shift: true })).toBe('insertBar');
    expect(mac('=', { meta: true })).toBe('insertBar');
    expect(mac('=', { ctrl: true })).toBe('insertBeat');
    expect(mac('-', { meta: true })).toBe('deleteBeats');
    expect(mac('-', { ctrl: true })).toBe('deleteBar');
  });

  it('maps the ⌘ editing set, with shift variants winning over their plain form', () => {
    expect(mac('z', { meta: true })).toBe('undo');
    expect(mac('Z', { meta: true, shift: true })).toBe('redo');
    expect(mac('c', { meta: true })).toBe('copy');
    expect(mac('G', { meta: true, shift: true })).toBe('toggleBeatGrid');
    expect(mac('g', { meta: true })).toBe('goTo');
    expect(mac('U', { meta: true, shift: true })).toBe('arpeggioUp');
    expect(mac('3', { meta: true })).toBe('voice3');
    expect(mac('r', { meta: true, alt: true })).toBe('deleteTrack');
  });

  it('ignores shift on macOS named keys, as before (⇧⌘↑ still moves track)', () => {
    expect(mac('ArrowUp', { meta: true, shift: true })).toBe('prevTrack');
    expect(mac('End', { meta: true, shift: true })).toBe('lastBar');
  });

  it('matches cmd/ctrl/alt exactly: ⌥⌘C is not Copy, ⌃Z is not Undo', () => {
    expect(mac('c', { meta: true, alt: true })).toBe(null);
    expect(mac('z', { ctrl: true })).toBe(null);
    expect(mac('ArrowUp', { alt: true })).toBe('octaveUp');
    expect(mac('ArrowUp', { alt: true, shift: true })).toBe('semitoneUp');
  });

  it('keeps Insert as the Let Ring alias on macOS only; other plain keys go to the editor', () => {
    expect(mac('Insert')).toBe('letRing');
    expect(pc('Insert')).toBe('insertBar');
    expect(mac('Delete')).toBe(null);
    expect(mac('p')).toBe(null);
  });
});

describe('PC keymap (GP8 Windows column) — Linux and Windows', () => {
  it('Ctrl is the ⌘ of the editing set; the Super key is not', () => {
    expect(pc('z', { ctrl: true })).toBe('undo');
    expect(pc('y', { ctrl: true })).toBe('redo');
    expect(pc('Z', { ctrl: true, shift: true })).toBe('redo');
    expect(pc('a', { ctrl: true })).toBe('selectAll');
    expect(pc('v', { ctrl: true })).toBe('paste');
    expect(pc('2', { ctrl: true })).toBe('voice2');
    expect(pc('z', { meta: true })).toBe(null);
  });

  it('moves the bar/beat group to Ins/Del, as GP8 does on Windows', () => {
    expect(pc('Insert')).toBe('insertBar');
    expect(pc('Insert', { ctrl: true })).toBe('insertBeat');
    expect(pc('Delete', { ctrl: true })).toBe('deleteBar');
    expect(pc('Delete', { shift: true })).toBe('deleteBeats');
  });

  it('matches shift exactly on named keys: Shift+Ins (paste) and Ctrl+Shift+Del are not bar edits', () => {
    expect(pc('Insert', { shift: true })).toBe(null);
    expect(pc('Delete', { ctrl: true, shift: true })).toBe(null);
    expect(pc('Delete', { shift: true })).toBe('deleteBeats');
    expect(pc('ArrowUp', { ctrl: true, shift: true })).toBe(null);
  });

  it('on PC Ctrl+Shift+letter is not the plain Ctrl action (Ctrl+Shift+X must not cut)', () => {
    expect(pc('X', { ctrl: true, shift: true })).toBe(null);
    expect(pc('V', { ctrl: true, shift: true })).toBe(null);
    expect(pc('Z', { ctrl: true, shift: true })).toBe('redo');     // named in the table
    expect(pc('+', { ctrl: true, shift: true })).toBe('zoomIn');   // a symbol: shift types it
    expect(pc('1', { ctrl: true, shift: true })).toBe('voice1');   // AZERTY types digits with shift
  });

  it('has GP8\'s shifted variants: Ctrl+* double dot, Ctrl+? (Ctrl+Shift+/) triplet feel', () => {
    expect(pc('*', { ctrl: true, shift: true })).toBe('doubleDot');
    expect(pc('?', { ctrl: true, shift: true })).toBe('tripletFeel');
    expect(mac('*', { meta: true, shift: true })).toBe('doubleDot');
    expect(mac('?', { meta: true, shift: true })).toBe('tripletFeel');
  });

  it('deviates on plain Del (user decision): it stays Delete Note, never Delete Track', () => {
    expect(pc('Delete')).toBe(null);          // falls through to the editor's deleteNote
    expect(pc('Backspace')).toBe(null);
    expect(BINDINGS.pc.some((b) => b.action === 'deleteTrack')).toBe(false);
  });

  it('makes Ctrl++ / Ctrl+- zoom, not bar edits', () => {
    expect(pc('=', { ctrl: true })).toBe('zoomIn');
    expect(pc('+', { ctrl: true, shift: true })).toBe('zoomIn');
    expect(pc('-', { ctrl: true })).toBe('zoomOut');
  });

  it('puts the ⌥ effects on Ctrl+Alt+letter, distinct from Ctrl+letter', () => {
    expect(pc('v', { ctrl: true, alt: true })).toBe('tremoloBar');
    expect(pc('c', { ctrl: true, alt: true })).toBe('wahClose');
    expect(pc('o', { ctrl: true, alt: true })).toBe('wahOpen');
    expect(pc('c', { ctrl: true })).toBe('copy');
    expect(pc('v', { alt: true })).toBe(null);
  });

  it('keeps Alt+arrows as transpose', () => {
    expect(pc('ArrowDown', { alt: true })).toBe('octaveDown');
    expect(pc('ArrowDown', { alt: true, shift: true })).toBe('semitoneDown');
  });
});

describe('labels', () => {
  it('renders ⌘ glyphs on macOS and Ctrl+… elsewhere', () => {
    expect(label('undo', 'mac')).toBe('⌘Z');
    expect(label('redo', 'mac')).toBe('⇧⌘Z');
    expect(label('undo', 'pc')).toBe('Ctrl+Z');
    expect(label('redo', 'pc')).toBe('Ctrl+Shift+Z');
    expect(label('insertBeat', 'mac')).toBe('⌃+');
    expect(label('insertBeat', 'pc')).toBe('Ctrl+Ins');
    expect(label('insertBar', 'pc')).toBe('Ins');
    expect(label('deleteBeats', 'pc')).toBe('Shift+Del');
    expect(label('voice1', 'pc')).toBe('Ctrl+1');
    expect(label('deleteTrack', 'pc')).toBe('');
  });
});

describe('platform detection', () => {
  const juce = (p) => ({ __JUCE__: { initialisationData: { __juce__platform: [p] } } });
  it('trusts JUCE on the desktop', () => {
    expect(platformOf(juce('macos'))).toBe('mac');
    expect(platformOf(juce('linux'))).toBe('pc');
    expect(platformOf(juce('windows'))).toBe('pc');
  });
  it('falls back to navigator in the browser', () => {
    expect(platformOf({ navigator: { platform: 'MacIntel' } })).toBe('mac');
    expect(platformOf({ navigator: { userAgentData: { platform: 'Linux' } } })).toBe('pc');
    expect(platformOf({ navigator: { platform: 'Win32' } })).toBe('pc');
  });
});

describe('the editor implements every bound action', () => {
  it('SHORTCUT_ACTIONS in editor.js has an entry for each table action', () => {
    const src = readFileSync(fileURLToPath(new URL('../editor.js', import.meta.url)), 'utf8');
    const block = src.slice(src.indexOf('const SHORTCUT_ACTIONS = {'), src.indexOf('function keyPlatform()'));
    const defined = new Set([...block.matchAll(/^\s{4}(\w+)(?::|,|$)/gm)].map((m) => m[1]));
    expect(defined.size).toBeGreaterThan(30);    // the slice found the table, not nothing
    for (const p of ['mac', 'pc']) {
      for (const b of BINDINGS[p]) expect(defined.has(b.action), `${p}: ${b.action}`).toBe(true);
    }
  });

});
