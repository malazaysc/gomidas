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
      mkMenu('Lyrics', 'lyrics (coming soon)', null, true),
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
      mkMenu('8va', 'octave up (coming soon)', null, true),
      mkMenu('8vb', 'octave down (coming soon)', null, true),
      mkMenu('15ma', '2 octaves up (coming soon)', null, true),
      mkMenu('15mb', '2 octaves down (coming soon)', null, true)
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
      dyn.appendChild(mkMenu(d, d + ' (coming soon)', null, true, 'eb-dyn')));
    dyn.append(
      mkMenu('<', 'crescendo (coming soon)', null, true),
      mkMenu('>', 'diminuendo (coming soon)', null, true)
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

  // ---- drum palette (shown instead of the fretboard on percussion tracks) ----
  let paletteMode = null;     // 'fretboard' | 'drums'
  let drumPads = null;

  function buildDrumPalette(drums) {
    const fb = document.getElementById('fretboard');
    fb.innerHTML = '';
    const grid = el('div', 'dp-grid');
    drums.forEach((d, i) => {
      const pad = el('div', 'dp-pad');
      pad.dataset.midi = d.midi;
      if (i < 9) pad.appendChild(el('span', 'dp-key', String(i + 1)));   // keyboard hotkey (digits 1–9)
      pad.appendChild(el('span', 'dp-name', d.name));
      grid.appendChild(pad);
    });
    grid.addEventListener('click', (e) => {
      const p = e.target.closest('.dp-pad');
      if (!p) return;
      E.toggleDrum(parseInt(p.dataset.midi, 10));
      refocus();
    });
    fb.appendChild(grid);
    drumPads = grid;
  }

  function renderDrumPalette(s) {
    if (paletteMode !== 'drums' || !drumPads) { buildDrumPalette(s.drums || []); paletteMode = 'drums'; gridStrings = -1; }
    if (!drumPads) return;
    drumPads.querySelectorAll('.dp-pad').forEach(p => {
      const midi = parseInt(p.dataset.midi, 10);
      const d = (s.drums || []).find(x => x.midi === midi);
      p.classList.toggle('active', !!(d && d.active));
    });
  }

  function renderFretboard(s) {
    if (paletteMode !== 'fretboard') { paletteMode = 'fretboard'; gridStrings = -1; }
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
  function optionList(items, sel) {
    return items.map(([v, label]) => '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + esc(label) + '</option>').join('');
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
        '<div class="insp-sec"><div class="insp-h">Sounds</div>' +
          '<div class="insp-row"><span class="insp-pill" id="ins-engine"><span data-eng="rse" title="Realistic Sound Engine (coming soon)">RSE</span><span class="on" data-eng="midi" title="MIDI / SoundFont">MIDI</span></span>' +
            '<span class="insp-chain">' + IC('guitar', 'sm') + IC('eq', 'sm') + IC('wave', 'sm') + IC('volume', 'sm') + '</span></div>' +
          (s.isPercussion
            ? valRow('Kit', 'Drum Kit')
            : '<div class="insp-row" style="margin-top:8px"><span>Sound</span><select class="insp-select" id="ins-sound">' + optionList(GM_SOUNDS, s.trackProgram | 0) + '</select></div>') +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Mixer</div>' +
          '<div class="insp-row"><span>Pan</span>' +
            '<input type="range" class="insp-slider" id="ins-pan" min="0" max="100" value="' + Math.round((s.trackPan != null ? s.trackPan : 0.5) * 100) + '"></div>' +
          '<div class="insp-row"><span class="v" id="ins-pan-lbl" style="font-size:11px">' + panLabel(s.trackPan != null ? s.trackPan : 0.5) + '</span></div>' +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Interpretation</div>' +
          valRow('Playing style', 'Pick') + sliderRow('Palm mute') + sliderRow('Accentuation') +
          toggleRow('Auto let ring', false) + toggleRow('Auto brush', true) + toggleRow('Stringed', true) +
        '</div>';
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
    const sound = byId('ins-sound');
    if (sound) sound.onchange = () => E.setTrackProgram(parseInt(sound.value, 10));
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
  }

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
          '<div class="tk-knob" style="--ang:0deg"></div>' +
          '<div class="tk-mini tk-eq">' + IC('eq', 'sm') + '</div>' +
        '</div>' +
        '<div class="tk-bars" style="grid-template-columns:' + cols + '"></div>' +
      '</div>';

    tk.innerHTML = html;
    wireTrackList(tk);
  }

  function wireTrackList(tk) {
    // header tools
    tk.querySelectorAll('.tk-tool').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.tool === 'add' && window.gomidasMenu) window.gomidasMenu('addtrack:guitar');
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
        if (barCell) { // jump to that bar of this track
          e.stopPropagation();
          E.selectTrack(idx);
          if (E.goToBar) E.goToBar(parseInt(barCell.dataset.bar, 10) + 1);
          refocus();
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
          else if (act === 'eq') return; // todo
          if (E && E.getState) refresh(E.getState());
          return;
        }
        if (e.target.closest('.tk-fader') || e.target.closest('.tk-knob')) return;
        E.selectTrack(idx); refocus();
      });
    });
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
