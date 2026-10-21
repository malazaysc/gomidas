// GOM-86 — the HTML menu bar on desktop hosts without a global menu (Linux/Windows): which items
// are gated, and the Open Recent section fed by native. Runs against a minimal fake DOM — the
// shell only uses createElement/appendChild/addEventListener/getElementById.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import S from '../core/webshell.ts';

const { buildMenuBar, setRecentFiles, actionBlocked } = S;

function fakeNode(tag) {
  const listeners = {};
  const classes = new Set();
  const n = {
    tagName: tag, id: '', title: '', disabled: false, style: {}, children: [], _text: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); v.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get textContent() { return n._text + n.children.map((c) => c.textContent).join(''); },
    set textContent(v) { n._text = v; n.children = []; },
    appendChild(c) { n.children.push(c); c.parentNode = n; return c; },
    insertBefore(c) { n.children.unshift(c); return c; },
    get firstChild() { return n.children[0] || null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    click() {
      let stopped = false;
      (listeners.click || []).forEach((fn) => fn({ stopPropagation() { stopped = true; } }));
      if (!n.disabled && !stopped) fakeDoc.fire('click');
    }
  };
  return n;
}

let fakeDoc;
function makeDoc() {
  const listeners = {};
  const body = fakeNode('body');
  const all = (node) => [node, ...node.children.flatMap(all)];
  return {
    body,
    createElement: fakeNode,
    getElementById: (id) => all(body).find((x) => x.id === id) || null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ key: '' })); },
    fired: (type) => (listeners[type] || []).length,
    all: () => all(body)
  };
}

const MENUS = [{ name: 'File', items: [
  { label: 'Open...', action: 'open' },
  { label: '-', action: '' },
  { label: 'Minimize', action: 'minimize' },
  { label: 'About Gomidas', action: 'about' },
  { label: 'Load Input Plugin (AU/VST3)...', action: 'loadplugin' }
] }];

const items = () => fakeDoc.all().filter((x) => x.className.includes('wm-item'));
const byText = (t) => items().find((x) => x.textContent === t);

const recent = (...paths) => paths.map((path) => ({ name: path.split('/').pop(), path }));

describe('web shell menu bar', () => {
  let opened, cleared, menuCalls;
  const saved = { document: globalThis.document, window: globalThis.window };
  afterEach(() => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  });
  beforeEach(() => {
    fakeDoc = makeDoc();
    opened = []; cleared = 0; menuCalls = [];
    globalThis.document = fakeDoc;
    globalThis.window = {
      GomidasMenus: { GOMIDAS_MENUS: MENUS },
      gomidasConfirmOpenRecent: (i) => opened.push(i),
      gomidasMenu: (a) => menuCalls.push(a),
      GomidasHost: { clearRecent: () => cleared++, requestRecentFiles() {} }
    };
  });

  const desktop = { liveInput: true, pluginHost: true, nativeMenus: false, fileSystem: 'native' };
  const web = { liveInput: false, pluginHost: false, nativeMenus: false, fileSystem: 'browser' };

  it('gates About on the host method; Minimize also needs a native menu bar (tiling WMs ignore it)', () => {
    expect(actionBlocked('minimize', desktop, { minimizeWindow() {} })).toBe(true);
    expect(actionBlocked('minimize', { ...desktop, nativeMenus: true }, { minimizeWindow() {} })).toBe(false);
    expect(actionBlocked('minimize', web, {})).toBe(true);
    expect(actionBlocked('about', desktop, { showAbout() {} })).toBe(false);
    expect(actionBlocked('about', web, {})).toBe(true);
    expect(actionBlocked('loadplugin', web, {})).toBe(true);
    expect(actionBlocked('loadplugin', desktop, {})).toBe(false);
  });

  it('desktop: Open Recent sits after Open, shows native\'s names, opens by PATH via the guard', () => {
    buildMenuBar(desktop, { minimizeWindow() {}, showAbout() {}, requestRecentFiles() {}, clearRecent: () => cleared++ });
    expect(byText('(no recent files)').disabled).toBe(true);

    setRecentFiles(recent('/home/u/songs/a.gp', '/home/u/b.gomidas'));
    const labels = items().map((x) => x.textContent);
    expect(labels.slice(0, 4)).toEqual(['Open...', 'a.gp', 'b.gomidas', 'Clear Recent']);
    expect(byText('b.gomidas').title).toBe('/home/u/b.gomidas');
    expect(byText('Minimize').disabled).toBe(true);
    expect(byText('Minimize').title).toBe('Not available on this system');
    expect(byText('About Gomidas').disabled).toBe(false);

    byText('b.gomidas').click();
    expect(opened).toEqual(['/home/u/b.gomidas']);
    byText('Clear Recent').click();
    expect(cleared).toBe(1);
  });

  it('web: no Open Recent section, desktop-only items disabled with the browser reason', () => {
    window.GomidasKeymap = { platform: () => 'pc' };
    buildMenuBar(desktop, { requestRecentFiles() {} });   // a previous bar's recent section must not leak
    fakeDoc = makeDoc(); globalThis.document = fakeDoc;
    buildMenuBar(web, {});
    setRecentFiles(recent('/x/a.gp'));
    expect(byText('a.gp')).toBeUndefined();
    expect(byText('Minimize').disabled).toBe(true);
    expect(byText('About Gomidas').disabled).toBe(true);
    expect(byText('Load Input Plugin (VST3)...').title).toMatch(/browser/);
    expect(fakeDoc.all().some((x) => x.className === 'wm-group')).toBe(false);
    byText('Open...').click();
    expect(menuCalls).toEqual(['open']);
  });

  it('a malformed push empties the list rather than throwing; the name is native\'s, verbatim', () => {
    buildMenuBar(desktop, { requestRecentFiles() {}, clearRecent() {} });
    setRecentFiles([{ name: 'riff\\v2.gp', path: '/home/u/riff\\v2.gp' }, 'junk', null]);
    expect(items().filter((x) => x.className.includes('wm-sub')).map((x) => x.textContent))
      .toEqual(['riff\\v2.gp', 'Clear Recent']);
    setRecentFiles(null);
    expect(byText('(no recent files)')).toBeDefined();
  });

  it('offers Clear Recent only when the host can clear', () => {
    buildMenuBar(desktop, { requestRecentFiles() {} });
    setRecentFiles(recent('/x/a.gp'));
    expect(byText('a.gp')).toBeDefined();
    expect(byText('Clear Recent')).toBeUndefined();
  });

  it('rewords the AU/VST3 plugin label on a PC host only (GOM-88)', () => {
    window.GomidasKeymap = { platform: () => 'pc' };
    buildMenuBar(desktop, {});
    expect(byText('Load Input Plugin (VST3)...')).toBeDefined();
    fakeDoc = makeDoc(); globalThis.document = fakeDoc;
    window.GomidasKeymap = { platform: () => 'mac' };
    buildMenuBar(desktop, {});
    expect(byText('Load Input Plugin (AU/VST3)...')).toBeDefined();   // the table's own label
  });

  it('clicking the Open Recent heading does not close the menu', () => {
    buildMenuBar(desktop, { requestRecentFiles() {} });
    const file = fakeDoc.all().find((x) => x.className.includes('wm-menu'));
    file.children[0].click();                       // open File
    expect(file.classList.contains('wm-open')).toBe(true);
    fakeDoc.all().find((x) => x.className === 'wm-group').click();
    expect(file.classList.contains('wm-open')).toBe(true);
  });
});
