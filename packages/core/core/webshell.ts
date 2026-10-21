// Gomidas — browser shell (GMD-38, docs/WEB_PORT.md §10 Phase 7).
//
// Supplies the two things the desktop host provides natively and the browser does not:
//   1. A MENU BAR. macOS gets a real juce::MenuBarModel; caps.nativeMenus is false on web AND on
//      the Linux/Windows desktop (no global menu there, GOM-86), so without this every menu-only
//      feature (Export .gp, the whole Effects menu, Open Recent) is unreachable. Built from
//      core/menus.ts, which is GENERATED from the same C++ table the desktop menu uses.
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

/** Actions keyed by the capability they need (the browser lacks liveInput/pluginHost; every
 *  host without a native menu bar — browser and Linux/Windows desktop — lacks nativeMenus). */
const CAP_ACTIONS: Record<string, string[]> = {
  liveInput: ['liveinput'],   // the tuner is a transport button, not a menu action
  pluginHost: ['loadplugin', 'showplugineditor', 'clearplugin'],
  // Window > Minimize stays off where there is no native menu bar: Hyprland and other tiling
  // compositors ignore the iconify request, so an enabled item would silently do nothing.
  nativeMenus: ['minimize']
};

/** Actions keyed by the host method they call — present on the desktop (any OS), absent on web.
 *  (Minimize is gated by CAP_ACTIONS.nativeMenus alone, which already excludes the browser.) */
const HOST_ACTIONS: Record<string, string> = { about: 'showAbout' };

/** Desktop-only UI is gated on the host method it calls — present on the desktop (any OS). */
function hostHas(host: any, method: string): boolean {
  return !!host && typeof host[method] === 'function';
}

/** Labels that name a macOS-only technology, reworded wherever the HTML bar draws on a PC host.
 *  The C++ table (and so the macOS native menu) keeps the original. Labels stay ASCII. */
const PC_LABELS: Record<string, string> = { loadplugin: 'Load Input Plugin (VST3)...' };

function itemLabel(item: { label: string; action: string }): string {
  const K = (window as any).GomidasKeymap;
  const pc = K ? K.platform() === 'pc' : true;
  return (pc && PC_LABELS[item.action]) || item.label;
}

function actionBlocked(action: string, caps: any, host?: any): boolean {
  for (const cap of Object.keys(CAP_ACTIONS)) {
    if (!caps[cap] && CAP_ACTIONS[cap].indexOf(action) >= 0) return true;
  }
  const method = HOST_ACTIONS[action];
  return !!method && !hostHas(host, method);
}

// ---- Open Recent (desktop hosts without a global menu: Linux/Windows, GOM-86) ---------------
// Native owns the list (MainComponent recentFiles) and pushes {name, path} pairs to
// window.gomidasRecentFiles whenever it changes; opening routes through gomidasConfirmOpenRecent
// so the unsaved-changes guard runs, exactly like the macOS native submenu. It passes the PATH,
// not the position, so a list that changed since the last push can't open the wrong file.
interface RecentEntry { name: string; path: string; }
let recentHost: HTMLElement | null = null;
let recentBackend: any = null;      // the host that gated the section in — Clear goes to the same one
let closeMenus: () => void = () => {};
let recentFiles: RecentEntry[] = [];

function renderRecent(): void {
  if (!recentHost) return;
  recentHost.textContent = '';
  const label = el('div', 'wm-group', 'Open Recent');
  label.addEventListener('click', (ev) => ev.stopPropagation());   // a heading, not an item
  recentHost.appendChild(label);
  if (recentFiles.length === 0) {
    const none = el('button', 'wm-item wm-sub wm-disabled', '(no recent files)');
    (none as HTMLButtonElement).disabled = true;
    recentHost.appendChild(none);
    return;
  }
  for (const f of recentFiles) {
    const b = el('button', 'wm-item wm-sub', f.name);
    b.title = f.path;
    b.addEventListener('click', () => {
      closeMenus();
      try { (window as any).gomidasConfirmOpenRecent && (window as any).gomidasConfirmOpenRecent(f.path); } catch (e) { /* keep the menu alive */ }
    });
    recentHost.appendChild(b);
  }
  if (!hostHas(recentBackend, 'clearRecent')) return;
  recentHost.appendChild(el('div', 'wm-sep'));    // as on the macOS submenu: Clear is not a file
  const clear = el('button', 'wm-item wm-sub', 'Clear Recent');
  clear.addEventListener('click', () => {
    closeMenus();
    recentBackend.clearRecent();
  });
  recentHost.appendChild(clear);
}

/** Native -> page: the current recent-files list, most recent first. */
function setRecentFiles(list: unknown): void {
  recentFiles = Array.isArray(list)
    ? list.filter((f) => f && typeof f.path === 'string')
          .map((f) => ({ path: f.path, name: typeof f.name === 'string' ? f.name : f.path }))
    : [];
  renderRecent();
}

function buildMenuBar(caps: any, host?: any): void {
  const menus = (window as any).GomidasMenus && (window as any).GomidasMenus.GOMIDAS_MENUS;
  if (!menus || document.getElementById('webmenubar')) return;
  recentHost = null;
  recentBackend = host;

  const bar = el('div', 'wm-bar');
  bar.id = 'webmenubar';
  let openMenu: HTMLElement | null = null;

  const closeAll = () => {
    if (openMenu) { openMenu.classList.remove('wm-open'); openMenu = null; }
  };
  closeMenus = closeAll;

  for (const menu of menus) {
    const wrap = el('div', 'wm-menu');
    const title = el('button', 'wm-title', menu.name);
    const list = el('div', 'wm-list');

    for (const item of menu.items) {
      if (item.label === '-') { list.appendChild(el('div', 'wm-sep')); continue; }
      const blocked = actionBlocked(item.action, caps, host);
      const b = el('button', 'wm-item' + (blocked ? ' wm-disabled' : ''), itemLabel(item));
      if (blocked) {
        // Kept visible but inert, with the reason — silently omitting items makes the web build
        // look broken rather than different.
        b.title = caps.fileSystem === 'native' ? 'Not available on this system'
                                               : 'Not available in the browser (desktop app only)';
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
      // Desktop host: Open Recent right after File > Open, where macOS puts its native submenu.
      if (item.action === 'open' && hostHas(host, 'requestRecentFiles')) {
        recentHost = el('div', 'wm-recent');
        list.appendChild(recentHost);
        renderRecent();
      }
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
  .wm-group { color: #8a8a96; padding: 5px 14px 2px; font-size: 11px; }
  .wm-item.wm-sub { padding-left: 26px; }
  `;
}

function initWebShell(): void {
  const caps = (window as any).GomidasAudio && (window as any).GomidasAudio.caps;
  if (!caps || caps.nativeMenus) return;    // desktop already has a real menu bar
  const style = document.createElement('style');
  style.textContent = styles();
  document.head.appendChild(style);
  const host = (window as any).GomidasHost;
  buildMenuBar(caps, host);
  gateTransport(caps);
  if (hostHas(host, 'requestRecentFiles')) host.requestRecentFiles();
}

  const api = { initWebShell, buildMenuBar, gateTransport, actionBlocked, setRecentFiles, CAP_ACTIONS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    (window as any).GomidasWebShell = api;
    (window as any).gomidasRecentFiles = setRecentFiles;   // called by MainComponent by literal name
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWebShell);
    else initWebShell();
  }
}());
