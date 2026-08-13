// Gomidas — browser shell (GMD-38, docs/WEB_PORT.md §10 Phase 7).
//
// Supplies the two things the desktop host provides natively and the browser does not:
//   1. A MENU BAR. macOS gets a real juce::MenuBarModel; caps.nativeMenus is false on web, so
//      without this every menu-only feature (wide vibrato, artificial harmonic, tremolo bar,
//      the whole Effects menu) is unreachable in a browser. Built from core/menus.ts, which is
//      GENERATED from the same C++ table the desktop menu uses.
//   2. CAPABILITY GATING. §2.3: "The UI must hide what a backend cannot do rather than calling
//      it and failing." Live input and plugin hosting do not exist in a browser and never will.
//
// Stays vanilla DOM. §11: keep any framework strictly outside the editor.

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Actions that cannot work in a browser, keyed by the capability they need. */
const CAP_ACTIONS: Record<string, string[]> = {
  liveInput: ['liveinput'],   // the tuner is a transport button, not a menu action
  pluginHost: ['loadplugin', 'showplugineditor', 'clearplugin'],
  nativeMenus: ['minimize']
};

function actionBlocked(action: string, caps: any): boolean {
  for (const cap of Object.keys(CAP_ACTIONS)) {
    if (!caps[cap] && CAP_ACTIONS[cap].indexOf(action) >= 0) return true;
  }
  return false;
}

function buildMenuBar(caps: any): void {
  const menus = (window as any).GomidasMenus && (window as any).GomidasMenus.GOMIDAS_MENUS;
  if (!menus || document.getElementById('webmenubar')) return;

  const bar = el('div', 'wm-bar');
  bar.id = 'webmenubar';
  let openMenu: HTMLElement | null = null;

  const closeAll = () => {
    if (openMenu) { openMenu.classList.remove('wm-open'); openMenu = null; }
  };

  for (const menu of menus) {
    const wrap = el('div', 'wm-menu');
    const title = el('button', 'wm-title', menu.name);
    const list = el('div', 'wm-list');

    for (const item of menu.items) {
      if (item.label === '-') { list.appendChild(el('div', 'wm-sep')); continue; }
      const blocked = actionBlocked(item.action, caps);
      const b = el('button', 'wm-item' + (blocked ? ' wm-disabled' : ''), item.label);
      if (blocked) {
        // Kept visible but inert, with the reason — silently omitting items makes the web build
        // look broken rather than different.
        b.title = 'Not available in the browser (desktop app only)';
        (b as HTMLButtonElement).disabled = true;
      } else {
        b.addEventListener('click', () => {
          closeAll();
          try {
            if ((window as any).gomidasMenu) (window as any).gomidasMenu(item.action);
          } catch (e) { /* an editor action must not kill the menu */ }
        });
      }
      list.appendChild(b);
    }

    title.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasOpen = wrap.classList.contains('wm-open');
      closeAll();
      if (!wasOpen) { wrap.classList.add('wm-open'); openMenu = wrap; }
    });
    // Hovering moves between menus once one is open, like a real menu bar.
    title.addEventListener('mouseenter', () => {
      if (openMenu && openMenu !== wrap) { closeAll(); wrap.classList.add('wm-open'); openMenu = wrap; }
    });

    wrap.appendChild(title);
    wrap.appendChild(list);
    bar.appendChild(wrap);
  }

  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  document.body.insertBefore(bar, document.body.firstChild);
}

/** Hide transport controls whose backend method does not exist on this host. */
function gateTransport(caps: any): void {
  const hide = (id: string) => {
    const n = document.getElementById(id);
    if (n) n.style.display = 'none';
  };
  // The mic button is the clearest case: getUserMedia exists, but ~20-40ms round trip makes
  // "play on top" a desktop feature (§8), and the web AudioBackend has no setLiveInput at all.
  if (!caps.liveInput) { hide('liveinput-btn'); hide('input-gain'); hide('tuner-btn'); }
  // Record STAYS: on web it is an offline bounce (§7.3), which works.
}

function styles(): string {
  return `
  .wm-bar { display: flex; align-items: stretch; gap: 0; background: #16161b;
            border-bottom: 1px solid #0e0e12; font-size: 12px; user-select: none; flex: 0 0 auto; }
  .wm-menu { position: relative; }
  .wm-title { background: none; border: 0; color: #cfcfd6; padding: 4px 10px; height: 24px;
              cursor: default; font-size: 12px; }
  .wm-menu:hover .wm-title, .wm-menu.wm-open .wm-title { background: #2d2d37; color: #fff; }
  .wm-list { display: none; position: absolute; top: 100%; left: 0; min-width: 220px; z-index: 10000;
             background: #22222a; border: 1px solid #0e0e12; border-radius: 0 0 6px 6px;
             box-shadow: 0 8px 24px rgba(0,0,0,.5); padding: 4px 0; max-height: 70vh; overflow-y: auto; }
  .wm-menu.wm-open .wm-list { display: block; }
  .wm-item { display: block; width: 100%; text-align: left; background: none; border: 0;
             color: #e4e4ea; padding: 5px 14px; font-size: 12px; cursor: default; }
  .wm-item:hover { background: #7b5cff; color: #fff; }
  .wm-item.wm-disabled { color: #6a6a74; }
  .wm-item.wm-disabled:hover { background: none; color: #6a6a74; }
  .wm-sep { height: 1px; background: #33333d; margin: 4px 8px; }
  `;
}

function initWebShell(): void {
  const caps = (window as any).GomidasAudio && (window as any).GomidasAudio.caps;
  if (!caps || caps.nativeMenus) return;    // desktop already has a real menu bar
  const style = document.createElement('style');
  style.textContent = styles();
  document.head.appendChild(style);
  buildMenuBar(caps);
  gateTransport(caps);
}

  const api = { initWebShell, buildMenuBar, gateTransport, actionBlocked, CAP_ACTIONS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    (window as any).GomidasWebShell = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWebShell);
    else initWebShell();
  }
}());
