// Gomidas visual editor UI: a clickable guitar fretboard + an edit toolbar that
// reflect/drive the current beat via window.GomidasEditor. Mouse-first entry.
'use strict';

(function () {
  const NFRETS = 24;
  const MARKERS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
  const SINGLE_INLAY = new Set([3, 5, 7, 9, 15, 17, 19, 21]);
  const DOUBLE_INLAY = new Set([12, 24]);
  const DURS = [
    { v: 1, label: '𝅝', name: 'whole' },
    { v: 2, label: '𝅗𝅥', name: 'half' },
    { v: 4, label: '♩', name: 'quarter' },
    { v: 8, label: '♪', name: 'eighth' },
    { v: 16, label: '𝅘𝅥𝅯', name: '16th' },
    { v: 32, label: '𝅘𝅥𝅰', name: '32nd' }
  ].map(d => ({ v: d.v, name: d.name, label: ({ 1: '1', 2: '½', 4: '¼', 8: '⅛', 16: '16', 32: '32' })[d.v] }));
  const E = window.GomidasEditor;
  function nlog(m) { try { window.__JUCE__.backend.emitEvent('__juce__invoke',
      { name: 'log', params: ['[fretboard] ' + m], resultId: 0 }); } catch (e) {} }

  let gridStrings = -1;          // # strings currently laid out
  let cellEls = [];              // cellEls[row][fret] -> div
  let durBtns = {};              // duration value -> button
  let dotBtn = null, dot2Btn = null, tripletBtn = null, pmBtn = null, deadBtn = null, lrBtn = null;
  let tieBtn = null, hpBtn = null, slideBtn = null;
  let ghostBtn = null, stacBtn = null, accentBtn = null, harmBtn = null, vibBtn = null;
  let playBtn = null, posLabel = null, trackLabel = null;
  let voiceBtns = [];            // voice index -> button (highlight current)

  function el(tag, cls, txt) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (txt != null) d.textContent = txt;
    return d;
  }

  // ---- edit toolbar ----------------------------------------------------------
  function buildEditBar() {
    const bar = document.getElementById('editbar');
    bar.innerHTML = '';

    // ---- voices + lyrics/chords (GP8 palette top) ----
    const voices = el('div', 'eb-group eb-voices');
    voices.appendChild(el('span', 'eb-label', 'voices'));
    voiceBtns = [];
    for (let i = 0; i < 4; i++) {
      const b = mkBtn(String(i + 1), 'voice ' + (i + 1) + ' (⌘' + (i + 1) + ')', () => E.selectVoice(i));
      b.classList.add('eb-sq', 'eb-voice');
      voiceBtns[i] = b;
      voices.appendChild(b);
    }
    bar.appendChild(voices);

    const lc = el('div', 'eb-group');
    lc.append(
      mkMenu('Lyrics', 'lyrics', 'lyrics'),
      mkMenu('Chords', 'chord diagram', 'chord')
    );
    lc.querySelectorAll('.eb-btn').forEach(b => b.classList.add('eb-wide'));
    bar.appendChild(lc);

    // ---- bar / signatures ----
    const sig = el('div', 'eb-group');
    sig.appendChild(el('span', 'eb-label', 'bar & signatures'));
    sig.append(
      mkMenu('♯♭', 'key signature', 'keysig'),
      mkMenu('4/4', 'time signature', 'timesig'),
      mkMenu('|:', 'repeat start', 'repeatstart'),
      mkMenu(':|', 'repeat end', 'repeatend'),
      mkMenu('TF', 'triplet feel', 'tripletfeel'),
      mkMenu('⌒', 'fermata', 'fermata'),
      mkMenu('T', 'text', 'text')
    );
    bar.appendChild(sig);

    // ---- octave / clef (visual placeholders; no editor backing yet) ----
    const oct = el('div', 'eb-group');
    oct.appendChild(el('span', 'eb-label', 'octave / clef'));
    oct.append(
      mkMenu('8va', 'octave up', 'ottava:8va'),
      mkMenu('8vb', 'octave down', 'ottava:8vb'),
      mkMenu('15ma', '2 octaves up', 'ottava:15ma'),
      mkMenu('15mb', '2 octaves down', 'ottava:15mb')
    );
    bar.appendChild(oct);

    // ---- duration ----
    const durs = el('div', 'eb-group');
    durs.appendChild(el('span', 'eb-label', 'duration'));
    DURS.forEach(d => {
      const b = mkBtn(d.label, d.name, () => E.setDuration(d.v));
      b.classList.add('dur-btn', 'eb-sq');
      durBtns[d.v] = b;
      durs.appendChild(b);
    });
    dotBtn = mkBtn('.', 'dotted (.)', () => E.toggleDot());
    dot2Btn = mkBtn('‥', 'double dotted (⌘.)', () => E.toggleDoubleDot());
    dotBtn.classList.add('eb-sq'); dot2Btn.classList.add('eb-sq');
    durs.append(dotBtn, dot2Btn);
    bar.appendChild(durs);

    // ---- tuplets ----
    const tup = el('div', 'eb-group');
    tup.appendChild(el('span', 'eb-label', 'tuplets'));
    tripletBtn = mkBtn('3', 'triplet (/)', () => E.toggleTriplet());
    tripletBtn.classList.add('eb-sq');
    tup.appendChild(tripletBtn);
    [5, 6, 7, 9].forEach(n => {
      const b = mkBtn(String(n), n + '-tuplet', () => E.setTuplet(n));
      b.classList.add('eb-sq');
      tup.appendChild(b);
    });
    bar.appendChild(tup);

    // ---- dynamics (visual placeholders) ----
    const dyn = el('div', 'eb-group');
    dyn.appendChild(el('span', 'eb-label', 'dynamics'));
    ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'].forEach(d =>
      dyn.appendChild(mkMenu(d, d, 'dyn:' + d, false, 'eb-dyn')));
    dyn.append(
      mkMenu('<', 'crescendo', 'cresc:cresc'),
      mkMenu('>', 'diminuendo', 'cresc:dim')
    );
    bar.appendChild(dyn);

    // ---- articulations / effects ----
    const fx = el('div', 'eb-group');
    fx.appendChild(el('span', 'eb-label', 'articulations'));
    pmBtn = mkBtn('P.M.', 'palm mute (P / ⇧P)', () => E.palmMute());
    deadBtn = mkBtn('✕', 'dead note (X)', () => E.deadNote());
    lrBtn = mkBtn('L.R.', 'let ring (I)', () => E.letRing());
    tieBtn = mkBtn('⌣', 'tie (L / ⇧L)', () => E.tieNote());
    hpBtn = mkBtn('H', 'hammer-on / pull-off (H)', () => E.hammerPull());
    slideBtn = mkBtn('sl', 'legato slide (S)', () => E.slideNote(false));
    ghostBtn = mkBtn('gh', 'ghost note (O)', () => E.ghostNote());
    stacBtn = mkBtn('·', 'staccato (!)', () => E.staccato());
    accentBtn = mkBtn('>', 'accent (;) · heavy (:)', () => E.accent(false));
    harmBtn = mkBtn('◇', 'natural harmonic (Y)', () => E.naturalHarmonic());
    vibBtn = mkBtn('∿', 'vibrato (V)', () => E.vibratoNote());
    [pmBtn, deadBtn, lrBtn, tieBtn, hpBtn, slideBtn, ghostBtn, stacBtn, accentBtn, harmBtn, vibBtn]
      .forEach(b => b.classList.add('eb-sq'));
    fx.append(pmBtn, deadBtn, lrBtn, tieBtn, hpBtn, slideBtn, ghostBtn, stacBtn, accentBtn, harmBtn, vibBtn);
    // more fx (wired through the menu dispatch; no per-state highlight)
    [
      ['sh', 'shift slide', 'shiftslide'], ['≡', 'wide vibrato', 'widevibrato'],
      ['⤳', 'brush up', 'brushup'], ['⤴', 'brush down', 'brushdown'],
      ['↻', 'arpeggio up', 'arpup'], ['↺', 'arpeggio down', 'arpdown'],
      ['↑', 'pick stroke up', 'pickup'], ['↓', 'pick stroke down', 'pickdown'],
      ['tr', 'trill', 'trill'], ['⦀', 'tremolo picking', 'tremolo'],
      ['gr', 'grace note', 'grace'], ['slap', 'slap', 'slap'], ['pop', 'pop', 'pop'],
      ['◹', 'fade in', 'fadein'], ['◿', 'fade out', 'fadeout'], ['⋈', 'volume swell', 'swell'],
      ['p↗', 'pick slide up', 'pickslideup'], ['p↘', 'pick slide down', 'pickslidedown'],
      ['AH', 'artificial harmonic', 'artharmonic'], ['PH', 'pinch harmonic', 'pinchharmonic']
    ].forEach(([lbl, title, act]) => fx.appendChild(mkMenu(lbl, title, 'fx:' + act, false, 'eb-sq')));
    bar.appendChild(fx);

    // ---- bars & beats ----
    const ops = el('div', 'eb-group');
    ops.appendChild(el('span', 'eb-label', 'bars & beats'));
    ops.append(
      mkBtn('R', 'rest (R)', () => E.makeRest()),
      mkBtn('＋beat', 'insert beat (⌃+)', () => E.insertBeat()),
      mkBtn('－beat', 'delete beat (⌘-)', () => E.removeBeat()),
      mkBtn('＋bar', 'insert bar (⌘+)', () => E.addBar()),
      mkBtn('－bar', 'delete bar (⌃-)', () => E.deleteBar())
    );
    bar.appendChild(ops);
  }

  function mkBtn(label, title, fn) {
    const b = el('button', 'eb-btn', label);
    b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); refocus(); });
    return b;
  }
  // Button wired to the global menu dispatch (window.gomidasMenu). `todo` => disabled placeholder.
  function mkMenu(label, title, action, todo, extraCls) {
    const b = el('button', 'eb-btn' + (extraCls ? ' ' + extraCls : '') + (todo ? ' eb-todo' : ''), label);
    b.title = title;
    if (todo) { b.disabled = true; return b; }
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (action && window.gomidasMenu) window.gomidasMenu(action);
      refocus();
    });
    return b;
  }
  function refocus() { try { document.getElementById('at-wrap').focus(); } catch (e) {} }

  // ---- fretboard -------------------------------------------------------------
  function buildFretboard(stringCount, tuningNames) {
    const fb = document.getElementById('fretboard');
    fb.innerHTML = '';
    cellEls = [];

    const grid = el('div', 'fb-grid');
    grid.style.gridTemplateColumns = `46px repeat(${NFRETS + 1}, minmax(28px, 1fr))`;

    // header: corner + fret numbers
    grid.appendChild(el('div', 'fb-corner', ''));
    for (let f = 0; f <= NFRETS; f++) {
      const h = el('div', 'fb-fnum' + (MARKERS.has(f) ? ' fb-marker' : ''), String(f));
      grid.appendChild(h);
    }

    const midRow = Math.floor((stringCount - 1) / 2);
    const dblA = Math.max(0, midRow - 1), dblB = Math.min(stringCount - 1, midRow + 1);
    for (let row = 0; row < stringCount; row++) {
      grid.appendChild(el('div', 'fb-strlabel', tuningNames[row] || ''));
      cellEls[row] = [];
      for (let f = 0; f <= NFRETS; f++) {
        let cls = 'fb-cell' + (f === 0 ? ' fb-open' : '');
        if ((SINGLE_INLAY.has(f) && row === midRow) ||
            (DOUBLE_INLAY.has(f) && (row === dblA || row === dblB))) cls += ' fb-inlay';
        const c = el('div', cls);
        c.dataset.row = row; c.dataset.fret = f;
        cellEls[row][f] = c;
        grid.appendChild(c);
      }
    }

    grid.addEventListener('click', (e) => {
      const c = e.target.closest('.fb-cell');
      if (!c) return;
      E.setFret(parseInt(c.dataset.row, 10), parseInt(c.dataset.fret, 10));
      refocus();
    });
    fb.appendChild(grid);
    gridStrings = stringCount;
  }

  // ---- KIT VIEW (drum panel: clickable kit + quick tools + articulation + tabs) ----
  let paletteMode = null;     // 'fretboard' | 'drums'
  let drumPanelEl = null;
  let kitMode = 'draw';       // select | draw | erase | paint
  // On tight screens (13"), default to the compact step-grid editor + a shorter panel
  // so the score stays visible; roomier screens keep the photo KIT VIEW.
  const SMALL_SCREEN = (typeof window !== 'undefined' && window.innerHeight > 0 && window.innerHeight < 880);
  let drumTab = SMALL_SCREEN ? 'groove' : 'kit';   // kit | groove | mixer

  // ---- drum panel sizing (resizable / collapsible, persisted) ----------------
  const DRUM_H_KEY = 'gomidasDrumH';
  function drumDefaultH() { return SMALL_SCREEN ? 240 : 360; }
  function clampDrumH(px) {
    const max = Math.max(180, Math.round((window.innerHeight || 800) * 0.62));
    return Math.max(120, Math.min(max, Math.round(px)));
  }
  function savedDrumH() {
    let v = NaN; try { v = parseInt(localStorage.getItem(DRUM_H_KEY), 10); } catch (e) {}
    return clampDrumH(Number.isFinite(v) ? v : drumDefaultH());
  }
  function applyDrumH(px) {
    const fb = document.getElementById('fretboard'); if (!fb) return;
    const v = clampDrumH(px);
    fb.style.setProperty('--drum-h', v + 'px');
    try { localStorage.setItem(DRUM_H_KEY, String(v)); } catch (e) {}
  }
  function setDrumCollapsed(on) {
    const fb = document.getElementById('fretboard'); if (!fb) return;
    fb.classList.toggle('collapsed', on);
    const ch = fb.querySelector('.dp-collapse');
    if (ch) { ch.textContent = on ? '▴' : '▾'; ch.classList.toggle('on', on); }
  }
  function toggleDrumCollapse() {
    const fb = document.getElementById('fretboard'); if (!fb) return;
    setDrumCollapsed(!fb.classList.contains('collapsed')); refocus();
  }
  function startDrumDrag(e) {
    e.preventDefault();
    const fb = document.getElementById('fretboard'); if (!fb) return;
    setDrumCollapsed(false);
    const startY = e.clientY, startH = fb.getBoundingClientRect().height;
    document.body.classList.add('dp-resizing');
    function move(ev) { applyDrumH(startH + (startY - ev.clientY)); }   // drag up = grow
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dp-resizing'); refocus();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  let selPiece = 'snare';     // selected kit piece (drives the articulation panel)
  const pieceArtic = {};      // pieceId -> chosen articulation index

  // Kit pieces with hotspot rectangles (percent of the kit image frame) + GM articulations.
  const KIT_PIECES = [
    { id: 'hihat', label: 'Hi-Hat',    x: 18, y: 41, w: 15, h: 16, artics: [['Closed', 42], ['Open', 46], ['Pedal', 44]] },
    { id: 'crash', label: 'Crash',     x: 31, y: 18, w: 20, h: 13, artics: [['Crash', 49], ['Splash', 55]] },
    { id: 'tom1',  label: 'Tom 1',     x: 45, y: 34, w: 11, h: 15, artics: [['Tom Hi', 48]] },
    { id: 'tom2',  label: 'Tom 2',     x: 57, y: 34, w: 11, h: 15, artics: [['Tom Mid', 47]] },
    { id: 'ride',  label: 'Ride',      x: 76, y: 18, w: 20, h: 13, artics: [['Ride', 51], ['Bell', 53]] },
    { id: 'china', label: 'China',     x: 90, y: 35, w: 14, h: 12, artics: [['China', 52]] },
    { id: 'snare', label: 'Snare',     x: 32, y: 55, w: 14, h: 17, artics: [['Center', 38], ['Side Stick', 37]] },
    { id: 'kick',  label: 'Kick',      x: 51, y: 61, w: 20, h: 23, artics: [['Kick', 36]] },
    { id: 'floor', label: 'Floor Tom', x: 70, y: 57, w: 15, h: 19, artics: [['Floor', 43]] }
  ];
  const QUICK_TOOLS = [
    { id: 'select', label: 'Select', kind: 'mode' },
    { id: 'draw',   label: 'Draw',   kind: 'mode' },
    { id: 'erase',  label: 'Erase',  kind: 'mode' },
    { id: 'paint',  label: 'Paint',  kind: 'mode', key: 'Shift' },
    { id: 'accent', label: 'Accent', kind: 'act', key: 'A' },
    { id: 'ghost',  label: 'Ghost',  kind: 'act', key: 'G' },
    { id: 'repeat', label: 'Repeat', kind: 'act', key: 'R' },
    { id: 'tie',    label: 'Tie',    kind: 'act', key: 'T' }
  ];
  const VEL_NAMES = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
  function pieceById(id) { return KIT_PIECES.find(p => p.id === id); }
  function pieceMidi(p) { const ai = Math.min(pieceArtic[p.id] || 0, p.artics.length - 1); return p.artics[ai][1]; }
  function pieceIsHit(p, s) { return p.artics.some(a => (s.drums || []).some(d => d.midi === a[1] && d.active)); }

  function buildDrumPanel() {
    const fb = document.getElementById('fretboard');
    fb.innerHTML = '';
    fb.classList.add('kit');
    const panel = el('div', 'drumpanel');

    const tabs = el('div', 'dp-tabs');
    [['kit', 'KIT VIEW'], ['groove', 'GROOVE EDITOR'], ['mixer', 'MIXER']].forEach(([id, lbl]) => {
      const t = el('button', 'dp-tab' + (id === drumTab ? ' active' : ''), lbl);
      t.dataset.tab = id;
      t.addEventListener('click', () => { drumTab = id; renderDrumPalette(E.getState()); refocus(); });
      tabs.appendChild(t);
    });
    // header controls: height presets + collapse (more score)
    const ctl = el('div', 'dp-ctl');
    [['S', 200], ['M', 340], ['L', 480]].forEach(([lbl, h]) => {
      const b = el('button', 'dp-hbtn', lbl);
      b.title = lbl + ' drum panel height';
      b.addEventListener('click', () => { setDrumCollapsed(false); applyDrumH(h); refocus(); });
      ctl.appendChild(b);
    });
    const col = el('button', 'dp-hbtn dp-collapse', '▾');
    col.title = 'Collapse drum panel — give the score more room';
    col.addEventListener('click', toggleDrumCollapse);
    ctl.appendChild(col);
    tabs.appendChild(ctl);
    panel.appendChild(tabs);

    const body = el('div', 'dp-body');

    // KIT pane: quick tools | stage | articulation
    const kit = el('div', 'dp-pane' + (drumTab === 'kit' ? ' active' : ''));
    kit.dataset.pane = 'kit';
    const tools = el('div', 'kit-tools');
    tools.appendChild(el('div', 'kit-h', 'Quick Tools'));
    QUICK_TOOLS.forEach(q => {
      const b = el('div', 'qtool' + (q.kind === 'mode' && q.id === kitMode ? ' active' : ''), q.label);
      b.dataset.tool = q.id; b.dataset.kind = q.kind;
      if (q.key) b.appendChild(el('span', 'qk', q.key));
      tools.appendChild(b);
    });
    tools.addEventListener('click', (e) => { const b = e.target.closest('.qtool'); if (b) onQuickTool(b.dataset.tool, b.dataset.kind); });
    kit.appendChild(tools);

    const stage = el('div', 'kit-stage');
    const frame = el('div', 'kit-frame');
    const img = document.createElement('img'); img.src = '/drumkit.png'; img.alt = 'Drum kit';
    frame.appendChild(img);
    KIT_PIECES.forEach(p => {
      const h = el('div', 'kit-hot'); h.dataset.piece = p.id;
      h.style.left = p.x + '%'; h.style.top = p.y + '%'; h.style.width = p.w + '%'; h.style.height = p.h + '%';
      h.appendChild(el('span', 'kit-lbl', p.label));
      frame.appendChild(h);
    });
    frame.addEventListener('click', (e) => { const h = e.target.closest('.kit-hot'); if (h) onKitHit(h.dataset.piece); });
    stage.appendChild(frame); kit.appendChild(stage);

    kit.appendChild(el('div', 'kit-artic')); // filled by renderArticPanel
    body.appendChild(kit);

    const groove = el('div', 'dp-pane' + (drumTab === 'groove' ? ' active' : '')); groove.dataset.pane = 'groove';
    const ge = el('div', 'ge'); ge.dataset.role = 'ge';
    ge.addEventListener('click', (e) => {
      const c = e.target.closest('.ge-cell'); if (!c) return;
      E.toggleGridCell(c.dataset.lane, parseInt(c.dataset.step, 10), e.shiftKey ? 2 : (e.altKey ? 3 : null));
      renderDrumPalette(E.getState()); refocus();
    });
    groove.appendChild(ge);
    body.appendChild(groove);

    const mixer = el('div', 'dp-pane' + (drumTab === 'mixer' ? ' active' : '')); mixer.dataset.pane = 'mixer';
    const km = el('div', 'kit-mixer'); km.dataset.role = 'mixer';
    km.addEventListener('input', (e) => {
      const r = e.target.closest('input[type=range]'); if (!r) return;
      const midi = parseInt(r.dataset.midi, 10);
      const g = (parseInt(r.value, 10) || 0) / 100;
      (window.gomidasDrumGains || (window.gomidasDrumGains = {}))[midi] = g;
      const v = r.parentElement.querySelector('.kmv'); if (v) v.textContent = r.value + '%';
    });
    km.addEventListener('change', () => { if (window.gomidasRebuild) window.gomidasRebuild(); });
    km.addEventListener('mousedown', (e) => e.stopPropagation());
    mixer.appendChild(km);
    body.appendChild(mixer);

    panel.appendChild(body);
    panel.appendChild(buildPatternLib());
    fb.appendChild(panel);

    const split = el('div', 'dp-splitter');
    split.title = 'Drag to resize · double-click to collapse';
    split.addEventListener('mousedown', startDrumDrag);
    split.addEventListener('dblclick', toggleDrumCollapse);
    fb.appendChild(split);

    applyDrumH(savedDrumH());
    drumPanelEl = panel;
  }

  // ---- Pattern library (always-visible row under the kit) ----
  let plCategory = 'Pop Punk', plSearch = '', selGroove = null;
  function plFavs() { try { return new Set(JSON.parse(localStorage.getItem('gomidasGrooveFavs') || '[]')); } catch (e) { return new Set(); } }
  function plSaveFavs(set) { try { localStorage.setItem('gomidasGrooveFavs', JSON.stringify([...set])); } catch (e) {} }
  function buildPatternLib() {
    const wrap = el('div', 'pattern-lib');
    wrap.appendChild(el('div', 'pl-cats')); // filled by renderPatternLib
    wrap.appendChild(el('div', 'pl-cards'));
    return wrap;
  }
  function dotRow(lane16, kick) {
    const row = el('div', 'pl-dotrow');
    for (let i = 0; i < 16; i++) {
      const d = el('div', 'pl-dot' + (lane16 && lane16[i] ? ' on' : '') + (kick ? ' k' : ''));
      row.appendChild(d);
    }
    return row;
  }
  function renderPatternLib() {
    if (!drumPanelEl) return;
    const G = window.GomidasGrooves; if (!G) return;
    const catsEl = drumPanelEl.querySelector('.pl-cats');
    const cardsEl = drumPanelEl.querySelector('.pl-cards');
    if (!catsEl || !cardsEl) return;
    const favs = plFavs();

    // categories + search (rebuild once; cheap)
    catsEl.innerHTML = '';
    const search = el('input'); search.type = 'text'; search.placeholder = 'Search grooves…'; search.value = plSearch;
    search.addEventListener('input', () => { plSearch = search.value; renderPatternLib(); });
    search.addEventListener('mousedown', (e) => e.stopPropagation());
    catsEl.appendChild(search);
    G.CATEGORIES.forEach(cat => {
      const c = el('div', 'pl-cat' + (cat === plCategory ? ' active' : ''), cat);
      c.addEventListener('click', () => { plCategory = cat; renderPatternLib(); refocus(); });
      catsEl.appendChild(c);
    });

    // cards for the active category (or favourites / search)
    let list;
    if (plCategory === 'User Grooves') list = G.GROOVES.filter(g => favs.has(g.name));
    else list = G.byCategory(plCategory);
    if (plSearch.trim()) { const q = plSearch.toLowerCase(); list = G.GROOVES.filter(g => g.name.toLowerCase().includes(q)); }

    cardsEl.innerHTML = '';
    list.forEach(g => {
      const card = el('div', 'pl-card' + (selGroove === g.name ? ' sel' : ''));
      const head = el('div', 'pl-name');
      head.appendChild(el('span', null, g.name));
      const fav = el('span', 'pl-fav' + (favs.has(g.name) ? ' on' : ''), favs.has(g.name) ? '♥' : '♡');
      fav.addEventListener('click', (e) => { e.stopPropagation(); const f = plFavs(); f.has(g.name) ? f.delete(g.name) : f.add(g.name); plSaveFavs(f); renderPatternLib(); });
      head.appendChild(fav);
      card.appendChild(head);
      const pv = G.previewLanes(g);
      const dots = el('div', 'pl-dots');
      dots.appendChild(dotRow(pv.top, false));
      dots.appendChild(dotRow(pv.snare, false));
      dots.appendChild(dotRow(pv.kick, true));
      card.appendChild(dots);
      const foot = el('div', 'pl-foot');
      const previewing = window.gomidasGroovePreviewName && window.gomidasGroovePreviewName() === g.name;
      const play = el('div', 'pl-play' + (previewing ? ' on' : ''), previewing ? '■' : '▶');
      play.title = previewing ? 'Stop' : 'Preview (loops)';
      play.addEventListener('click', (e) => { e.stopPropagation(); if (window.gomidasPreviewGroove) window.gomidasPreviewGroove(g); });
      foot.appendChild(play);
      const ins = el('div', 'pl-play', '＋'); ins.title = 'Insert at cursor';
      ins.addEventListener('click', (e) => { e.stopPropagation(); selGroove = g.name; E.insertGroove(g); refocus(); });
      foot.appendChild(ins);
      card.appendChild(foot);
      card.addEventListener('click', () => { selGroove = g.name; renderPatternLib(); });
      card.addEventListener('dblclick', () => { selGroove = g.name; E.insertGroove(g); refocus(); });
      cardsEl.appendChild(card);
    });
    const add = el('div', 'pl-add'); add.appendChild(el('div', null, '＋')); add.appendChild(el('div', null, 'Add Pattern'));
    add.addEventListener('click', () => { if (window.gomidasAddGrooveFromBar) window.gomidasAddGrooveFromBar(); });
    cardsEl.appendChild(add);
  }
  window.gomidasInsertSelectedGroove = function () {
    const G = window.GomidasGrooves; if (!G || !selGroove) return;
    const g = G.find(selGroove); if (g) E.insertGroove(g);
  };

  // ---- Groove step-grid (GROOVE EDITOR tab) ----
  function renderGrooveGrid(s) {
    if (!drumPanelEl) return;
    const ge = drumPanelEl.querySelector('.ge[data-role="ge"]'); if (!ge) return;
    const G = window.GomidasGrooves; if (!G) return;
    const grid = E.readBarGrid ? E.readBarGrid() : { lanes: {} };
    ge.innerHTML = '';
    G.LANE_ORDER.forEach(lane => {
      const row = el('div', 'ge-row');
      row.appendChild(el('div', 'ge-lane', G.LANE_LABEL[lane] || lane));
      const cells = el('div', 'ge-cells');
      const arr = grid.lanes[lane] || [];
      for (let s2 = 0; s2 < 16; s2++) {
        const flag = arr[s2] | 0;
        const c = el('div', 'ge-cell' + (s2 % 4 === 0 ? ' beat' : '') + (flag ? ' on' : '') + (flag === 2 ? ' acc' : '') + (flag === 3 ? ' gho' : ''));
        c.dataset.lane = lane; c.dataset.step = s2;
        cells.appendChild(c);
      }
      row.appendChild(cells);
      ge.appendChild(row);
    });
  }

  function onQuickTool(id, kind) {
    if (kind === 'mode') { kitMode = id; renderDrumPalette(E.getState()); refocus(); return; }
    if (id === 'accent') E.accent(false);
    else if (id === 'ghost') E.ghostNote();
    else if (id === 'repeat') E.copyLastBeat();
    else if (id === 'tie') E.tieBeat();
    refocus();
  }
  function onKitHit(pieceId) {
    const p = pieceById(pieceId); if (!p) return;
    selPiece = pieceId;
    const midi = pieceMidi(p);
    if (kitMode === 'erase') { if (pieceIsHit(p, E.getState())) E.toggleDrum(midi); }
    else if (kitMode === 'select') { /* select only */ }
    else E.toggleDrum(midi); // draw / paint
    renderDrumPalette(E.getState());
    refocus();
  }
  function renderArticPanel() {
    if (!drumPanelEl) return;
    const wrap = drumPanelEl.querySelector('.kit-artic'); if (!wrap) return;
    const p = pieceById(selPiece) || KIT_PIECES[0];
    const ai = Math.min(pieceArtic[p.id] || 0, p.artics.length - 1);
    let html = '<div class="kit-h">Articulation</div><div class="apiece">' + p.label + '</div>';
    p.artics.forEach((a, i) => { html += '<div class="artic-opt' + (i === ai ? ' active' : '') + '" data-ai="' + i + '">' + a[0] + '</div>'; });
    html += '<div class="kit-srow"><div class="lab"><span>Velocity</span><span id="kit-vel-v">90</span></div>'
          + '<input type="range" id="kit-vel" min="20" max="127" value="90"></div>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('.artic-opt').forEach(o => o.addEventListener('click', () => {
      pieceArtic[p.id] = parseInt(o.dataset.ai, 10); renderArticPanel(); refocus();
    }));
    const vel = wrap.querySelector('#kit-vel');
    if (vel) {
      vel.addEventListener('input', () => { const v = wrap.querySelector('#kit-vel-v'); if (v) v.textContent = vel.value; });
      // commit on release → map 20..127 to a beat dynamic level (drives playback velocity)
      vel.addEventListener('change', () => {
        const dyn = Math.max(0, Math.min(7, Math.round((parseInt(vel.value, 10) - 20) / 107 * 7)));
        if (E.setDynamics) E.setDynamics(VEL_NAMES[dyn]);
        refocus();
      });
    }
  }
  function renderDrumPalette(s) {
    if (paletteMode !== 'drums' || !drumPanelEl) { buildDrumPanel(); paletteMode = 'drums'; gridStrings = -1; }
    if (!drumPanelEl) return;
    drumPanelEl.querySelectorAll('.dp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === drumTab));
    drumPanelEl.querySelectorAll('.dp-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === drumTab));
    drumPanelEl.querySelectorAll('.qtool').forEach(b => { if (b.dataset.kind === 'mode') b.classList.toggle('active', b.dataset.tool === kitMode); });
    drumPanelEl.querySelectorAll('.kit-hot').forEach(h => {
      const p = pieceById(h.dataset.piece); if (!p) return;
      h.classList.toggle('hit', pieceIsHit(p, s));
      h.classList.toggle('sel', h.dataset.piece === selPiece);
    });
    renderArticPanel();
    renderPatternLib();
    if (drumTab === 'groove') renderGrooveGrid(s);
    if (drumTab === 'mixer') renderKitMixer();
  }

  // MIXER tab: per-kit-piece level (scales hit velocity in rebuildSequence via gomidasDrumGains).
  function renderKitMixer() {
    if (!drumPanelEl) return;
    const km = drumPanelEl.querySelector('.kit-mixer[data-role="mixer"]'); if (!km) return;
    const gains = window.gomidasDrumGains || (window.gomidasDrumGains = {});
    let html = '';
    KIT_PIECES.forEach(p => {
      const midi = p.artics[0][1];
      const pct = Math.round(((gains[midi] != null ? gains[midi] : 1)) * 100);
      html += '<div class="km-row"><span class="km-name">' + p.label + '</span>' +
              '<input type="range" min="0" max="150" value="' + pct + '" data-midi="' + midi + '">' +
              '<span class="kmv">' + pct + '%</span></div>';
    });
    km.innerHTML = html;
  }

  function renderFretboard(s) {
    if (paletteMode !== 'fretboard') {
      paletteMode = 'fretboard'; gridStrings = -1;
      const fb = document.getElementById('fretboard'); fb.classList.remove('kit', 'collapsed'); drumPanelEl = null;
    }
    if (s.stringCount !== gridStrings) buildFretboard(s.stringCount, s.tuningNames);

    // clear note marks + current-string highlight (inlay class stays on the cell)
    for (let row = 0; row < cellEls.length; row++) {
      const isCur = (row === s.curString);
      for (let f = 0; f < cellEls[row].length; f++) {
        const c = cellEls[row][f];
        c.innerHTML = '';
        c.classList.toggle('fb-curstr', isCur);
      }
    }
    // place current beat's notes as a centered circular badge (notes: row(0=top) -> fret)
    for (const k in s.notes) {
      const row = parseInt(k, 10);
      const fret = s.notes[k];
      if (cellEls[row] && cellEls[row][fret]) {
        const dot = el('div', 'fb-dot', String(fret));
        cellEls[row][fret].appendChild(dot);
      }
    }
  }

  function updateToolbarState(s) {
    for (const v in durBtns) durBtns[v].classList.toggle('active', Number(v) === s.duration);
    if (dotBtn) dotBtn.classList.toggle('active', s.dots === 1);
    if (dot2Btn) dot2Btn.classList.toggle('active', s.dots === 2);
    if (tripletBtn) tripletBtn.classList.toggle('active', !!s.triplet);
    // note-effect buttons don't apply to drums; dim them on percussion tracks
    [pmBtn, deadBtn, lrBtn, tieBtn, hpBtn, slideBtn, ghostBtn, stacBtn, accentBtn, harmBtn, vibBtn].forEach(btn => {
      if (btn) btn.style.opacity = s.isPercussion ? '.35' : '';
    });
    if (pmBtn) pmBtn.classList.toggle('active', !!s.palmMute);
    if (deadBtn) deadBtn.classList.toggle('active', !!s.deadNote);
    if (lrBtn) lrBtn.classList.toggle('active', !!s.letRing);
    if (tieBtn) tieBtn.classList.toggle('active', !!s.tie);
    if (hpBtn) hpBtn.classList.toggle('active', !!s.hammerPull);
    if (slideBtn) slideBtn.classList.toggle('active', !!s.slide);
    if (ghostBtn) ghostBtn.classList.toggle('active', !!s.ghost);
    if (stacBtn) stacBtn.classList.toggle('active', !!s.staccato);
    if (accentBtn) accentBtn.classList.toggle('active', !!(s.accent || s.heavyAccent));
    if (harmBtn) harmBtn.classList.toggle('active', !!s.harmonic);
    if (vibBtn) vibBtn.classList.toggle('active', !!s.vibrato);
    voiceBtns.forEach((b, i) => b && b.classList.toggle('active', i === (s.curVoice | 0)));
    if (playBtn) playBtn.innerHTML = window.Icons ? window.Icons.use(s.isPlaying ? 'pause' : 'play', 'lg')
                                                  : (s.isPlaying ? '⏹' : '▶');
    if (trackLabel) trackLabel.textContent = (s.curTrackIndex + 1) + '. ' + s.trackName;
    if (posLabel) posLabel.textContent = s.pos;
    const tsEl = document.getElementById('tp-timesig');
    if (tsEl) tsEl.textContent = (s.timeSigNum || 4) + '/' + (s.timeSigDen || 4);
  }

  // ---- right inspector (SONG / TRACK panels, live) ---------------------------
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function sliderRow(label, val) { return '<div class="insp-row"><span>' + label + '</span><input type="range" class="insp-slider" value="' + (val || 20) + '" disabled></div>'; }
  function toggleRow(label, on) { return '<div class="insp-row"><span>' + label + '</span><div class="insp-toggle ' + (on ? 'on' : '') + '"></div></div>'; }
  function valRow(label, val) { return '<div class="insp-row"><span>' + label + '</span><span class="v">' + esc(val) + '</span></div>'; }
  // 0 = hard left, 0.5 = center, 1 = hard right → "L42 / C / R42".
  function panLabel(pan) {
    const d = Math.round((pan - 0.5) * 200);
    return d === 0 ? 'Center' : (d < 0 ? 'L' + (-d) : 'R' + d);
  }

  let inspTab = 'track';            // 'song' | 'track'
  // Tuning presets offered in the inspector, keyed by string count (high→low MIDI).
  const INSP_TUNINGS = {
    6: [ { name: 'Standard', midis: [64,59,55,50,45,40] }, { name: 'Drop D', midis: [64,59,55,50,45,38] },
         { name: 'Eb Standard', midis: [63,58,54,49,44,39] }, { name: 'D Standard', midis: [62,57,53,48,43,38] } ],
    7: [ { name: '7-string', midis: [64,59,55,50,45,40,35] } ],
    4: [ { name: 'Standard', midis: [43,38,33,28] }, { name: 'Drop D', midis: [43,38,33,26] } ],
    5: [ { name: '5-string', midis: [43,38,33,28,23] } ]
  };
  // Common General MIDI sounds for the program picker (value = GM program number).
  const GM_SOUNDS = [
    [24, 'Nylon Guitar'], [25, 'Steel Guitar'], [26, 'Jazz Guitar'], [27, 'Clean Guitar'],
    [29, 'Overdrive Guitar'], [30, 'Distortion Guitar'], [33, 'Finger Bass'], [34, 'Pick Bass'],
    [35, 'Fretless Bass'], [38, 'Synth Bass'], [0, 'Acoustic Piano'], [48, 'Strings'], [56, 'Trumpet'], [81, 'Synth Lead']
  ];
  // GM percussion kits (program number on channel 9 selects the kit in the SoundFont).
  const DRUM_KITS = [
    [0, 'Standard Kit'], [8, 'Room Kit'], [16, 'Rock Kit'], [24, 'Electronic Kit'],
    [25, 'TR-808 Kit'], [32, 'Jazz Kit'], [40, 'Brush Kit'], [48, 'Orchestra Kit']
  ];
  function optionList(items, sel) {
    return items.map(([v, label]) => '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
  }

  // Drum-track-only inspector sections: Generate Variation + Insert Options.
  function drumInspectorExtra(s) {
    const mode = window.gomidasInsertMode || 'replace';
    const voice = (s.curVoice | 0);
    return '<div class="insp-sec"><button class="insp-bigbtn" id="ins-genvar">✨ Generate Variation</button></div>' +
      '<div class="insp-sec"><div class="insp-h">Insert Options</div>' +
        '<div class="insp-row"><span>Insert</span><select class="insp-select" id="ins-insmode">' +
          '<option value="replace"' + (mode === 'replace' ? ' selected' : '') + '>Replace Bar</option>' +
          '<option value="append"' + (mode === 'append' ? ' selected' : '') + '>Append Bars</option>' +
        '</select></div>' +
        '<div class="insp-row"><span>Voices</span><span class="insp-voices" id="ins-voices">' +
          [1, 2, 3, 4].map(n => '<span class="iv' + (n - 1 === voice ? ' on' : '') + '" data-v="' + (n - 1) + '">' + n + '</span>').join('') +
        '</span></div>' +
        '<button class="insp-bigbtn primary" id="ins-insbtn">Insert Pattern</button>' +
      '</div>';
  }

  function buildInspector(s) {
    const ins = document.getElementById('inspector');
    if (!ins) return;
    // Don't clobber a field the user is actively typing into / dragging (incl. the pan slider).
    const ae = document.activeElement;
    if (ae && ins.contains(ae) && ae.tagName === 'INPUT' && (ae.type === 'text' || ae.type === 'number' || ae.type === 'range')) return;

    const tabs = '<div class="insp-tabs">' +
      '<div class="insp-tab ' + (inspTab === 'song' ? 'active' : '') + '" data-tab="song">SONG</div>' +
      '<div class="insp-tab ' + (inspTab === 'track' ? 'active' : '') + '" data-tab="track">TRACK</div></div>';

    if (inspTab === 'song') {
      ins.innerHTML = tabs +
        '<div class="insp-sec"><div class="insp-h">Score</div>' +
          '<div class="m-field"><label style="font-size:11px;color:var(--dim)">Title</label>' +
            '<input type="text" class="insp-input" id="ins-title" value="' + esc(s.title || '') + '"></div>' +
          '<div class="insp-row" style="margin-top:10px"><span>Tempo</span>' +
            '<input type="number" class="insp-select" id="ins-tempo" min="20" max="400" value="' + (s.songTempo || 120) + '" style="width:80px"></div>' +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Info</div>' +
          valRow('Tracks', (s.allTracks ? s.allTracks.length : 1)) + '</div>';
    } else {
      const sc = s.stringCount || 6;
      const presets = INSP_TUNINGS[sc] || [];
      const curMidis = (s.tuning || []).join(',');
      const tuningSel = presets.length
        ? '<select class="insp-select" id="ins-tuning">' +
            presets.map(p => '<option value="' + p.midis.join(',') + '"' + (p.midis.join(',') === curMidis ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
            (presets.some(p => p.midis.join(',') === curMidis) ? '' : '<option value="" selected>Custom</option>') +
          '</select>'
        : '<span class="insp-tuning">' + esc((s.tuningNames || []).join(' ')) + '</span>';
      const ct = (s.allTracks || []).find(t => t.current) || {};
      const tcolor = ct.color || '#888';
      const shortName = ct.shortName || (s.trackName || 'Trk').slice(0, 6).toLowerCase();
      ins.innerHTML = tabs +
        '<div class="insp-sec"><div class="insp-h">Information</div>' +
          '<div class="insp-info">' +
            '<span class="insp-swatch" style="background:' + tcolor + '"></span>' +
            '<span class="insp-tico">' + IC(s.isPercussion ? 'drum' : 'guitar', 'sm') + '</span>' +
            '<input type="text" class="insp-input" id="ins-name" value="' + esc(s.trackName || 'Track') + '">' +
            '<span class="insp-short">' + esc(shortName) + '</span>' +
          '</div></div>' +
        '<div class="insp-sec"><div class="insp-h">Musical notation</div>' +
          '<div class="insp-row"><span>Notation</span><span class="insp-pill insp-noticons" id="ins-notation">' +
            '<span class="' + (s.showStandard ? 'on' : '') + '" data-not="score" title="Standard notation">' + IC('staff', 'sm') + '</span>' +
            '<span class="' + (s.showTab ? 'on' : '') + '" data-not="tab" title="Tablature">' + IC('tabgrid', 'sm') + '</span></span></div>' +
          (s.isPercussion ? '' : '<div class="insp-row"><span>Tuning</span><span class="insp-tunwrap">' + IC('gear', 'sm') + tuningSel + '</span></div>') +
        '</div>' +
        (function () {
          const ch = window.gomidasCurrentTrackChannel ? window.gomidasCurrentTrackChannel() : null;
          const sfzName = (ch != null && window.gomidasTrackSfz) ? window.gomidasTrackSfz[ch] : null;
          // Instrument dropdown: GM SoundFont (clear) | built-in presets | a loaded
          // custom file (shown as its own option) | Load file… (native chooser).
          const presets = window.gomidasSfzPresets || [];
          const match = presets.find(p => p.name === sfzName);
          let sfzOpts = '<option value="">GM SoundFont</option>' +
            presets.map(p => '<option value="' + p.id + '"' + (match && match.id === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
            ((sfzName && !match) ? '<option value="__current__" selected>' + esc(sfzName) + '</option>' : '') +
            '<option value="__file__">Load file…</option>';
          return '<div class="insp-sec"><div class="insp-h">Sounds</div>' +
            // RSE = SFZ sample instrument (active when one is loaded); MIDI = GM SoundFont.
            '<div class="insp-row"><span class="insp-pill" id="ins-engine">' +
              '<span class="' + (sfzName ? 'on' : '') + '" data-eng="rse" title="SFZ sample instrument">RSE</span>' +
              '<span class="' + (sfzName ? '' : 'on') + '" data-eng="midi" title="MIDI / SoundFont">MIDI</span></span>' +
              '<span class="insp-chain">' + IC('guitar', 'sm') + IC('eq', 'sm') + IC('wave', 'sm') + IC('volume', 'sm') + '</span></div>' +
            '<div class="insp-row" style="margin-top:8px"><span>Instrument</span>' +
              '<span class="insp-sfz" id="ins-sfz-name" title="' + esc(sfzName || '') + '">' + esc(sfzName || 'GM SoundFont') + '</span></div>' +
            '<div class="insp-row" style="margin-top:6px"><span>Preset</span>' +
              '<select class="insp-select" id="ins-sfz-preset">' + sfzOpts + '</select></div>' +
            (s.isPercussion
              ? '<div class="insp-row" style="margin-top:8px"><span>Kit</span><select class="insp-select" id="ins-kit">' + optionList(DRUM_KITS, s.trackProgram | 0) + '</select></div>'
              : '<div class="insp-row" style="margin-top:8px"><span>Sound</span><select class="insp-select" id="ins-sound">' + optionList(GM_SOUNDS, s.trackProgram | 0) + '</select></div>') +
          '</div>';
        })() +
        '<div class="insp-sec"><div class="insp-h">Mixer</div>' +
          '<div class="insp-row"><span>Pan</span>' +
            '<input type="range" class="insp-slider" id="ins-pan" min="0" max="100" value="' + Math.round((s.trackPan != null ? s.trackPan : 0.5) * 100) + '"></div>' +
          '<div class="insp-row"><span class="v" id="ins-pan-lbl" style="font-size:11px">' + panLabel(s.trackPan != null ? s.trackPan : 0.5) + '</span></div>' +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Interpretation<span class="gd-soon-tag">soon</span></div>' +
          '<div class="gd-soon">' +
          valRow('Playing style', 'Pick') + sliderRow('Palm mute') + sliderRow('Accentuation') +
          toggleRow('Auto let ring', false) + toggleRow('Auto brush', true) + toggleRow('Stringed', true) +
          '</div>' +
        '</div>' +
        (s.isPercussion ? drumInspectorExtra(s) : '');
    }
    wireInspector();
  }

  function wireInspector() {
    const ins = document.getElementById('inspector');
    if (!ins) return;
    ins.querySelectorAll('.insp-tab').forEach(t =>
      t.onclick = () => { inspTab = t.dataset.tab; if (E && E.getState) buildInspector(E.getState()); });
    const byId = (id) => document.getElementById(id);
    const name = byId('ins-name');
    if (name) name.onchange = () => E.setTrackName(name.value);
    const title = byId('ins-title');
    if (title) title.onchange = () => E.setSongTitle(title.value);
    const tempo = byId('ins-tempo');
    if (tempo) tempo.onchange = () => E.setSongTempo(parseInt(tempo.value, 10));
    // Choosing a GM program switches the track back to the MIDI engine: clear any SFZ
    // instrument on it (otherwise sfizz keeps overriding and the GM choice is inaudible).
    const switchToMidi = () => {
      const ch = window.gomidasCurrentTrackChannel && window.gomidasCurrentTrackChannel();
      if (ch != null && window.gomidasTrackSfz && window.gomidasTrackSfz[ch] && window.gomidasClearTrackSfz)
        window.gomidasClearTrackSfz();
    };
    const sound = byId('ins-sound');
    if (sound) sound.onchange = () => { E.setTrackProgram(parseInt(sound.value, 10)); switchToMidi(); };
    // SFZ instrument dropdown: '' = GM (clear), a preset id = load it, __file__ = native
    // chooser, __current__ = the already-loaded custom file (no-op).
    const sfzPreset = byId('ins-sfz-preset');
    if (sfzPreset) sfzPreset.onchange = () => {
      const v = sfzPreset.value;
      if (v === '') { if (window.gomidasClearTrackSfz) window.gomidasClearTrackSfz(); }
      else if (v === '__file__') { if (window.gomidasMenu) window.gomidasMenu('loadsfz'); }
      else if (v === '__current__') { /* keep current */ }
      else {
        const p = (window.gomidasSfzPresets || []).find(x => x.id === v);
        if (p && window.gomidasLoadSfzPreset) window.gomidasLoadSfzPreset(p);
      }
    };
    // RSE/MIDI pill shortcut: RSE = open the native file chooser, MIDI = clear to GM.
    const engine = byId('ins-engine');
    if (engine) engine.querySelectorAll('span').forEach(sp => sp.onclick = () => {
      if (!window.gomidasMenu) return;
      window.gomidasMenu(sp.dataset.eng === 'rse' ? 'loadsfz' : 'clearsfz');
    });
    const tuning = byId('ins-tuning');
    if (tuning) tuning.onchange = () => { const v = tuning.value; if (v) E.setTuningPreset(v.split(',').map(Number)); };
    const pan = byId('ins-pan');
    if (pan) pan.oninput = () => {
      const st = E && E.getState && E.getState();
      if (!st) return;
      const i = st.curTrackIndex;
      const flags = window.gomidasTrackFlags || (window.gomidasTrackFlags = {});
      const f = flags[i] || (flags[i] = {});
      f.pan = (parseInt(pan.value, 10) || 50) / 100;
      const lbl = byId('ins-pan-lbl'); if (lbl) lbl.textContent = panLabel(f.pan);
      if (window.gomidasApplyMixer) window.gomidasApplyMixer();
    };
    const not = byId('ins-notation');
    if (not) not.querySelectorAll('span').forEach(sp => sp.onclick = () => E.toggleNotation(sp.dataset.not));
    // ---- drum-track inspector controls ----
    const kit = byId('ins-kit');
    if (kit) kit.onchange = () => { E.setTrackProgram(parseInt(kit.value, 10)); switchToMidi(); };
    const genvar = byId('ins-genvar');
    if (genvar) genvar.onclick = () => { if (E.generateVariation) E.generateVariation(); refocus(); };
    const insmode = byId('ins-insmode');
    if (insmode) insmode.onchange = () => { window.gomidasInsertMode = insmode.value; };
    const voices = byId('ins-voices');
    if (voices) voices.querySelectorAll('.iv').forEach(b => b.onclick = () => { E.selectVoice(parseInt(b.dataset.v, 10)); refocus(); });
    const insbtn = byId('ins-insbtn');
    if (insbtn) insbtn.onclick = () => {
      if (window.gomidasInsertSelectedGroove) window.gomidasInsertSelectedGroove();
      else if (E.getState) refresh(E.getState());
      refocus();
    };
  }

  // Rebuild the inspector (e.g. after a per-track SFZ instrument loads/clears).
  window.gomidasRefreshInspector = function () { if (E && E.getState) buildInspector(E.getState()); };

  // ---- bottom track list (GP8: controls + per-bar timeline + Master row) ------
  const IC = (n, c) => (window.Icons ? window.Icons.use(n, c) : '');
  function buildTrackList(s) {
    const tk = document.getElementById('tracks');
    if (!tk || !s.allTracks) return;
    // Don't rebuild (and lose the thumb) while a fader/knob is being dragged.
    const ae = document.activeElement;
    if (ae && ae.classList && (ae.classList.contains('tk-volrange') || ae.classList.contains('tk-fader-in')) && tk.contains(ae)) return;
    const flags = window.gomidasTrackFlags || (window.gomidasTrackFlags = {});
    const nBars = Math.max(1, s.barCount || (s.allTracks[0] && s.allTracks[0].bars ? s.allTracks[0].bars.length : 1));
    const BARW = 18; // small fixed GP-style bar squares (px)
    const cols = 'repeat(' + nBars + ',' + BARW + 'px)';

    // ruler: label bar 1, every 4th, and the last
    let ruler = '';
    for (let i = 0; i < nBars; i++) {
      const show = (i === 0 || (i + 1) % 4 === 0 || i === nBars - 1);
      ruler += '<span>' + (show ? (i + 1) : '') + '</span>';
    }

    let html =
      '<div class="tk-head2">' +
        '<div class="tk-hc">' +
          '<div class="tk-tool" data-tool="add" title="Add track">' + IC('plus') + '</div>' +
          '<span style="font-weight:600;color:var(--text)">Tracks</span>' +
          '<div class="tk-tool" data-tool="menu" title="Track options">' + IC('dots-v') + '</div>' +
          '<div class="tk-collabels"><span class="tk-cl-vol">Vol.</span><span class="tk-cl-pan">Pan.</span><span class="tk-cl-eq">Eq.</span></div>' +
        '</div>' +
        '<div class="tk-ruler" style="grid-template-columns:' + cols + '">' + ruler + '</div>' +
      '</div>';

    for (const t of s.allTracks) {
      const f = flags[t.index] || {};
      const vol = (typeof f.vol === 'number') ? f.vol : (typeof t.volume === 'number' ? t.volume : 0.75);
      const pan = (typeof f.pan === 'number') ? f.pan : 0.5;
      const ang = Math.round((pan - 0.5) * 270);
      let bars = '';
      const arr = t.bars || [];
      for (let i = 0; i < nBars; i++) {
        const fill = arr[i] ? ' fill' : '';
        const curCell = (t.current && i === s.curBar) ? ' cur' : '';
        bars += '<div class="tk-bar' + fill + curCell + '" data-bar="' + i + '" title="Bar ' + (i + 1) + '" style="--bc:' + t.color + '"></div>';
      }
      html +=
        '<div class="tk-row2 ' + (t.current ? 'current' : '') + '" data-idx="' + t.index + '">' +
          '<div class="tk-ctrls">' +
            '<div class="tk-swatch" style="background:' + t.color + '"></div>' +
            '<div class="tk-ico2">' + IC(t.isPercussion ? 'drum' : 'guitar') + '</div>' +
            '<div class="tk-name2" title="' + esc(t.name) + '">' + (t.index + 1) + '. ' + esc(t.name) + '</div>' +
            '<div class="tk-mini' + (f.hidden ? '' : ' on') + '" data-act="eye" title="show / hide">' + IC(f.hidden ? 'eye-off' : 'eye', 'sm') + '</div>' +
            '<div class="tk-mini' + (f.muted ? ' mute' : '') + '" data-act="mute" title="mute">' + IC(f.muted ? 'volume-mute' : 'volume', 'sm') + '</div>' +
            '<div class="tk-mini' + (f.soloed ? ' solo' : '') + '" data-act="solo" title="solo">' + IC('headphone', 'sm') + '</div>' +
            '<div class="tk-fader"><input type="range" class="tk-fader-in" min="0" max="100" value="' + Math.round(vol * 100) + '"><span class="v">' + Math.round(vol * 100) + '</span></div>' +
            '<div class="tk-knob" data-act="pan" title="Pan (double-click = center)" style="--ang:' + ang + 'deg"></div>' +
            '<div class="tk-mini tk-eq" data-act="eq" title="EQ (todo)">' + IC('eq', 'sm') + '</div>' +
          '</div>' +
          '<div class="tk-bars" style="grid-template-columns:' + cols + '">' + bars + '</div>' +
        '</div>';
    }

    // Master row
    html +=
      '<div class="tk-row2 master">' +
        '<div class="tk-ctrls">' +
          '<div class="tk-swatch" style="background:#777"></div>' +
          '<div class="tk-ico2">' + IC('wave') + '</div>' +
          '<div class="tk-name2">Master</div>' +
          '<div class="tk-fader"><input type="range" class="tk-master-vol" min="0" max="100" value="100"><span class="v">100</span></div>' +
          '<div class="tk-knob tk-master-pan" style="--ang:0deg"></div>' +
          '<div class="tk-mini tk-eq tk-master-eq" title="Master EQ">' + IC('eq', 'sm') + '</div>' +
        '</div>' +
        '<div class="tk-bars" style="grid-template-columns:' + cols + '"></div>' +
      '</div>';

    tk.innerHTML = html;
    wireTrackList(tk, s.curBar | 0);
  }

  function wireTrackList(tk, curBar) {
    // header tools
    tk.querySelectorAll('.tk-tool').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.tool === 'add' && window.gomidasMenu) window.gomidasMenu('addtrack:guitar');
      else if (b.dataset.tool === 'menu' && window.gomidasOpenTrackMenu) {
        const s = E.getState ? E.getState() : null;
        window.gomidasOpenTrackMenu(s ? s.curTrackIndex : 0);
      }
    }));

    tk.querySelectorAll('.tk-row2[data-idx]').forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      const flagsFor = () => (window.gomidasTrackFlags[idx] || (window.gomidasTrackFlags[idx] = {}));

      const vr = row.querySelector('.tk-fader-in');
      if (vr) {
        const lbl = row.querySelector('.tk-fader .v');
        const apply = () => {
          flagsFor().vol = (parseInt(vr.value, 10) || 0) / 100;
          if (lbl) lbl.textContent = vr.value;
          if (window.gomidasApplyMixer) window.gomidasApplyMixer();
        };
        vr.addEventListener('input', (e) => { e.stopPropagation(); apply(); });
        vr.addEventListener('mousedown', (e) => e.stopPropagation());
      }

      const knob = row.querySelector('.tk-knob[data-act="pan"]');
      if (knob) {
        let dragging = false, startY = 0, startPan = 0.5;
        const setPan = (p) => {
          p = Math.max(0, Math.min(1, p));
          flagsFor().pan = p;
          knob.style.setProperty('--ang', Math.round((p - 0.5) * 270) + 'deg');
          if (window.gomidasApplyMixer) window.gomidasApplyMixer();
        };
        knob.addEventListener('mousedown', (e) => {
          e.stopPropagation(); e.preventDefault();
          dragging = true; startY = e.clientY; startPan = (flagsFor().pan != null ? flagsFor().pan : 0.5);
          const mv = (ev) => { if (dragging) setPan(startPan + (startY - ev.clientY) / 150); };
          const up = () => { dragging = false; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
        knob.addEventListener('dblclick', (e) => { e.stopPropagation(); setPan(0.5); });
      }

      row.addEventListener('click', (e) => {
        const barCell = e.target.closest('.tk-bar');
        if (barCell) {
          e.stopPropagation();
          const barNo = parseInt(barCell.dataset.bar, 10);
          if (e.shiftKey && E.selectBars) { // shift-click selects a bar range on this track
            const st = E.getState ? E.getState() : null;
            const anchorBar = (st && st.curTrackIndex === idx) ? st.curBar : barNo;
            E.selectBars(idx, anchorBar, barNo);
          } else { // plain click jumps to that bar of this track
            E.selectTrack(idx);
            if (E.goToBar) E.goToBar(barNo + 1);
          }
          refocus();
          if (E.getState) refresh(E.getState());
          return;
        }
        const ctl = e.target.closest('.tk-mini');
        if (ctl && ctl.dataset.act) {
          e.stopPropagation();
          const f = flagsFor();
          const act = ctl.dataset.act;
          if (act === 'eye') { f.hidden = !f.hidden; if (window.gomidasShowMulti) window.gomidasShowMulti(); }
          else if (act === 'mute') { f.muted = !f.muted; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); }
          else if (act === 'solo') { f.soloed = !f.soloed; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); }
          else if (act === 'eq') { if (window.gomidasOpenEq) window.gomidasOpenEq({ idx }); return; }
          if (E && E.getState) refresh(E.getState());
          return;
        }
        if (e.target.closest('.tk-fader') || e.target.closest('.tk-knob')) return;
        E.selectTrack(idx); refocus();
      });
    });

    // ---- Master row: volume fader, balance knob, EQ ----
    const M = window.gomidasMaster || (window.gomidasMaster = { vol: 1, pan: 0.5, eq: { low: 0, mid: 0, high: 0 } });
    const mvol = tk.querySelector('.tk-master-vol');
    if (mvol) {
      const lbl = mvol.parentElement.querySelector('.v');
      mvol.value = Math.round((M.vol != null ? M.vol : 1) * 100);
      if (lbl) lbl.textContent = mvol.value;
      const apply = () => {
        M.vol = (parseInt(mvol.value, 10) || 0) / 100;
        if (lbl) lbl.textContent = mvol.value;
        if (window.gomidasApplyMaster) window.gomidasApplyMaster();
      };
      mvol.addEventListener('input', (e) => { e.stopPropagation(); apply(); });
      mvol.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    const mpan = tk.querySelector('.tk-master-pan');
    if (mpan) {
      const setPan = (p) => {
        p = Math.max(0, Math.min(1, p));
        M.pan = p;
        mpan.style.setProperty('--ang', Math.round((p - 0.5) * 270) + 'deg');
        if (window.gomidasApplyMaster) window.gomidasApplyMaster();
      };
      mpan.style.setProperty('--ang', Math.round(((M.pan != null ? M.pan : 0.5) - 0.5) * 270) + 'deg');
      mpan.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        const startY = e.clientY, startPan = (M.pan != null ? M.pan : 0.5);
        const mv = (ev) => setPan(startPan + (startY - ev.clientY) / 150);
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
      mpan.addEventListener('dblclick', (e) => { e.stopPropagation(); setPan(0.5); });
    }
    const meq = tk.querySelector('.tk-master-eq');
    if (meq) meq.addEventListener('click', (e) => { e.stopPropagation(); if (window.gomidasOpenEq) window.gomidasOpenEq({ master: true }); });

    // ---- horizontal scroll-sync: ruler + every bar row move in lockstep ----
    const scrollers = [tk.querySelector('.tk-ruler')].concat(Array.prototype.slice.call(tk.querySelectorAll('.tk-bars'))).filter(Boolean);
    let syncing = false;
    scrollers.forEach(sc => sc.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const x = sc.scrollLeft;
      scrollers.forEach(o => { if (o !== sc) o.scrollLeft = x; });
      syncing = false;
    }));
    // innerHTML rebuild resets scrollLeft to 0 each refresh; keep the current bar in view
    // (GP-style timeline follow) so navigating to a far bar reveals its square.
    const ruler = scrollers[0];
    if (ruler && ruler.clientWidth > 0) {
      const BARW = 19; // 18px square + 1px gap
      const curX = (curBar | 0) * BARW;
      const vw = ruler.clientWidth;
      let target = 0;
      if (curX + BARW > vw - 8) target = curX - vw + BARW + 8;
      target = Math.max(0, target);
      scrollers.forEach(o => { o.scrollLeft = target; });
    }
  }

  // ---- refresh (called by editor on every cursor/edit change) ----------------
  function refresh(s) {
    if (!s) return;
    updateToolbarState(s);
    if (s.isPercussion) renderDrumPalette(s);
    else renderFretboard(s);
    buildInspector(s);
    buildTrackList(s);
  }

  function init() {
    buildEditBar();
    playBtn = document.getElementById('tp-play');
    trackLabel = document.getElementById('tp-track');
    posLabel = document.getElementById('tp-pos');
    if (playBtn) playBtn.addEventListener('click', (e) => { e.preventDefault(); E.togglePlay(); refocus(); });
    const tsEl = document.getElementById('tp-timesig');
    if (tsEl) tsEl.addEventListener('click', () => { if (window.gomidasMenu) window.gomidasMenu('timesig'); refocus(); });
    window.GomidasUI = { refresh };
    if (E && E.getState) refresh(E.getState());
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
