// Gomidas — keyboard shortcuts per platform (GOM-87).
//
// The editor is GP8-faithful, and GP8 publishes TWO keymaps (docs/references/gp8-keyboard-shortcuts.md,
// column "macOS / Windows"). They are not a modifier swap: on Windows the bar/beat insert/delete
// group moves to Ins/Del and Ctrl+/- become zoom. So each platform gets its own table, and this
// module answers one question — which action does this key press mean here — as a pure function.
//
// Both key entry points normalise to the same event before asking: the browser's keydown (onKey)
// and native forwarding (MainComponent::keyPressed -> gomidasNativeKey). `meta` is the Command key
// on macOS and the Windows/Super key elsewhere (no PC binding uses it), `ctrl` is Control.
//
// Unmodified keys (frets, effects letters, arrows) stay in editor.js handleKey. Deliberate
// deviation, decided by the user 2026-10-21: plain Del deletes the NOTE on PC, as Backspace does;
// GP8's Windows "Del = Delete Track" would make one stray keypress remove a whole track.

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

type Platform = 'mac' | 'pc';
interface KeyMods { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; }
interface Binding { action: string; combo: string; label?: string; }

// A combo is "mod+mod+key". Modifiers: cmd (meta), ctrl, alt, shift. The key is the KeyboardEvent
// `key` (letters lower-case). cmd/ctrl/alt must match EXACTLY; shift must match when written and
// is ignored when not — so list a shift variant before its plain form. `label` is what tooltips
// show when it differs from the combo's own rendering.
const BINDINGS: Record<Platform, Binding[]> = {
  mac: [
    { action: 'deleteTrack',     combo: 'cmd+alt+r' },
    { action: 'redo',            combo: 'cmd+shift+z' },
    { action: 'undo',            combo: 'cmd+z' },
    { action: 'redo',            combo: 'cmd+y' },
    { action: 'selectAll',       combo: 'cmd+a' },
    { action: 'copy',            combo: 'cmd+c' },
    { action: 'cut',             combo: 'cmd+x' },
    { action: 'paste',           combo: 'cmd+v' },
    { action: 'doubleDot',       combo: 'cmd+.' },
    { action: 'insertBar',       combo: 'cmd++', label: '⌘+' },
    { action: 'insertBar',       combo: 'cmd+=' },
    { action: 'deleteBeats',     combo: 'cmd+-', label: '⌘-' },
    { action: 'deleteBeats',     combo: 'cmd+_' },
    { action: 'prevTrack',       combo: 'cmd+ArrowUp' },
    { action: 'nextTrack',       combo: 'cmd+ArrowDown' },
    { action: 'firstBar',        combo: 'cmd+Home' },
    { action: 'lastBar',         combo: 'cmd+End' },
    { action: 'toggleBeatGrid',  combo: 'cmd+shift+g' },
    { action: 'goTo',            combo: 'cmd+g' },
    { action: 'timeSignature',   combo: 'cmd+t' },
    { action: 'keySignature',    combo: 'cmd+k' },
    { action: 'arpeggioUp',      combo: 'cmd+shift+u' },
    { action: 'brushUp',         combo: 'cmd+u' },
    { action: 'arpeggioDown',    combo: 'cmd+shift+d' },
    { action: 'brushDown',       combo: 'cmd+d' },
    { action: 'zoomIn',          combo: 'cmd+>' },
    { action: 'zoomOut',         combo: 'cmd+<' },
    { action: 'tripletFeel',     combo: 'cmd+/' },
    { action: 'voice1',          combo: 'cmd+1' },
    { action: 'voice2',          combo: 'cmd+2' },
    { action: 'voice3',          combo: 'cmd+3' },
    { action: 'voice4',          combo: 'cmd+4' },
    { action: 'toggleLoop',      combo: 'cmd+l' },
    { action: 'insertBeat',      combo: 'ctrl++', label: '⌃+' },
    { action: 'insertBeat',      combo: 'ctrl+=' },
    { action: 'deleteBar',       combo: 'ctrl+-', label: '⌃-' },
    { action: 'deleteBar',       combo: 'ctrl+_' },
    { action: 'semitoneUp',      combo: 'alt+shift+ArrowUp' },
    { action: 'octaveUp',        combo: 'alt+ArrowUp' },
    { action: 'semitoneDown',    combo: 'alt+shift+ArrowDown' },
    { action: 'octaveDown',      combo: 'alt+ArrowDown' },
    { action: 'tremoloBar',      combo: 'alt+v' },
    { action: 'wahOpen',         combo: 'alt+o' },
    { action: 'wahClose',        combo: 'alt+c' }
  ],
  // GP8's Windows column. Ctrl+Alt+letter is GP's own choice for the ⌥ effects (AltGr on some
  // layouts produces a character instead — the Effects menu is the dependable path there).
  pc: [
    { action: 'redo',            combo: 'ctrl+shift+z' },
    { action: 'undo',            combo: 'ctrl+z' },
    { action: 'redo',            combo: 'ctrl+y' },
    { action: 'selectAll',       combo: 'ctrl+a' },
    { action: 'tremoloBar',      combo: 'ctrl+alt+v' },
    { action: 'wahOpen',         combo: 'ctrl+alt+o' },
    { action: 'wahClose',        combo: 'ctrl+alt+c' },
    { action: 'copy',            combo: 'ctrl+c' },
    { action: 'cut',             combo: 'ctrl+x' },
    { action: 'paste',           combo: 'ctrl+v' },
    { action: 'doubleDot',       combo: 'ctrl+.' },
    { action: 'insertBeat',      combo: 'ctrl+Insert' },
    { action: 'insertBar',       combo: 'Insert', label: 'Ins' },
    { action: 'deleteBar',       combo: 'ctrl+Delete' },
    { action: 'deleteBeats',     combo: 'shift+Delete' },
    { action: 'prevTrack',       combo: 'ctrl+ArrowUp' },
    { action: 'nextTrack',       combo: 'ctrl+ArrowDown' },
    { action: 'firstBar',        combo: 'ctrl+Home' },
    { action: 'lastBar',         combo: 'ctrl+End' },
    { action: 'toggleBeatGrid',  combo: 'ctrl+shift+g' },
    { action: 'goTo',            combo: 'ctrl+g' },
    { action: 'timeSignature',   combo: 'ctrl+t' },
    { action: 'keySignature',    combo: 'ctrl+k' },
    { action: 'arpeggioUp',      combo: 'ctrl+shift+u' },
    { action: 'brushUp',         combo: 'ctrl+u' },
    { action: 'arpeggioDown',    combo: 'ctrl+shift+d' },
    { action: 'brushDown',       combo: 'ctrl+d' },
    { action: 'zoomIn',          combo: 'ctrl++', label: 'Ctrl++' },
    { action: 'zoomIn',          combo: 'ctrl+=' },
    { action: 'zoomOut',         combo: 'ctrl+-', label: 'Ctrl+-' },
    { action: 'zoomOut',         combo: 'ctrl+_' },
    { action: 'tripletFeel',     combo: 'ctrl+/' },
    { action: 'voice1',          combo: 'ctrl+1' },
    { action: 'voice2',          combo: 'ctrl+2' },
    { action: 'voice3',          combo: 'ctrl+3' },
    { action: 'voice4',          combo: 'ctrl+4' },
    { action: 'toggleLoop',      combo: 'ctrl+l' },
    { action: 'semitoneUp',      combo: 'alt+shift+ArrowUp' },
    { action: 'octaveUp',        combo: 'alt+ArrowUp' },
    { action: 'semitoneDown',    combo: 'alt+shift+ArrowDown' },
    { action: 'octaveDown',      combo: 'alt+ArrowDown' }
  ]
};

interface Combo { key: string; cmd: boolean; ctrl: boolean; alt: boolean; shift: boolean; }

function parseCombo(combo: string): Combo {
  // The key is the LAST token, and may itself be '+' ("cmd++").
  const plus = combo.endsWith('++');
  const parts = (plus ? combo.slice(0, -2) : combo).split('+').filter(Boolean);
  const key = plus ? '+' : parts.pop()!;
  return { key, cmd: parts.includes('cmd'), ctrl: parts.includes('ctrl'),
           alt: parts.includes('alt'), shift: parts.includes('shift') };
}

const PARSED: Record<Platform, Array<Binding & { c: Combo }>> = {
  mac: BINDINGS.mac.map((b) => ({ ...b, c: parseCombo(b.combo) })),
  pc: BINDINGS.pc.map((b) => ({ ...b, c: parseCombo(b.combo) }))
};

/** Letters compare case-insensitively (Shift and Caps Lock change `key`); named keys exactly. */
function normKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** The action a key press means on this platform, or null. */
function resolve(key: string, mods: KeyMods, platform: Platform): string | null {
  const k = normKey(key || '');
  const m = { cmd: !!mods.meta, ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift };
  for (const b of PARSED[platform] || PARSED.pc) {
    const c = b.c;
    if (c.key !== k || c.cmd !== m.cmd || c.ctrl !== m.ctrl || c.alt !== m.alt) continue;
    if (c.shift && !m.shift) continue;
    return b.action;
  }
  return null;
}

const MAC_GLYPH: Record<string, string> = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End'
};

function renderCombo(c: Combo, platform: Platform): string {
  const key = KEY_NAMES[c.key] || c.key.toUpperCase();
  if (platform === 'mac') {
    // Apple order: ⌃⌥⇧⌘.
    return (c.ctrl ? MAC_GLYPH.ctrl : '') + (c.alt ? MAC_GLYPH.alt : '') +
           (c.shift ? MAC_GLYPH.shift : '') + (c.cmd ? MAC_GLYPH.cmd : '') + key;
  }
  const mods = [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift'].filter(Boolean);
  return mods.concat([key]).join('+');
}

/** The shortcut to show for an action on this platform ('⌘Z' / 'Ctrl+Z'), or '' if unbound. */
function label(action: string, platform: Platform): string {
  const b = (PARSED[platform] || PARSED.pc).find((x) => x.action === action);
  if (!b) return '';
  return b.label || renderCombo(b.c, platform);
}

/** Which keymap this host gets. The desktop asks JUCE (initialisationData.__juce__platform, set
 *  by native — "macos" | "linux" | "windows" | …); the browser falls back to navigator. */
function platformOf(win?: any): Platform {
  const w = win || (typeof window !== 'undefined' ? window : {});
  try {
    const p = w.__JUCE__ && w.__JUCE__.initialisationData && w.__JUCE__.initialisationData.__juce__platform;
    if (Array.isArray(p) && typeof p[0] === 'string' && p[0] !== '') return p[0] === 'macos' ? 'mac' : 'pc';
  } catch (e) { /* fall through */ }
  const nav = w.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  const hint = nav ? String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '') : '';
  return /mac|iphone|ipad/i.test(hint) ? 'mac' : 'pc';
}

  const api = { resolve, label, platformOf, BINDINGS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasKeymap = api;
}());
