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

    const nav = el('div', 'eb-group');
    nav.appendChild(el('span', 'eb-label', 'navigate'));
    nav.append(
      mkBtn('◀', 'prev beat', () => E.move(-1)),
      mkBtn('▶', 'next beat', () => E.move(1)),
      mkBtn('▲', 'string up', () => E.moveString(-1)),
      mkBtn('▼', 'string down', () => E.moveString(1))
    );
    bar.appendChild(nav);

    const durs = el('div', 'eb-group');
    durs.appendChild(el('span', 'eb-label', 'duration'));
    DURS.forEach(d => {
      const b = mkBtn(d.label, d.name, () => E.setDuration(d.v));
      b.classList.add('dur-btn');
      durBtns[d.v] = b;
      durs.appendChild(b);
    });
    dotBtn = mkBtn('.', 'dotted (.)', () => E.toggleDot());
    dot2Btn = mkBtn('‥', 'double dotted (⌘.)', () => E.toggleDoubleDot());
    durs.append(dotBtn, dot2Btn);
    bar.appendChild(durs);

    const fx = el('div', 'eb-group');
    fx.appendChild(el('span', 'eb-label', 'fx'));
    tripletBtn = mkBtn('3', 'triplet (/)', () => E.toggleTriplet());
    pmBtn = mkBtn('P.M.', 'palm mute (P / ⇧P)', () => E.palmMute());
    deadBtn = mkBtn('✕', 'dead note (X)', () => E.deadNote());
    lrBtn = mkBtn('L.R.', 'let ring (I)', () => E.letRing());
    tieBtn = mkBtn('⌣', 'tie (L / ⇧L)', () => E.tieNote());
    hpBtn = mkBtn('H', 'hammer-on / pull-off (H)', () => E.hammerPull());
    slideBtn = mkBtn('sl', 'slide (S)', () => E.slideNote(false));
    fx.append(tripletBtn, pmBtn, deadBtn, lrBtn, tieBtn, hpBtn, slideBtn);
    bar.appendChild(fx);

    const fx2 = el('div', 'eb-group');
    fx2.appendChild(el('span', 'eb-label', 'art'));
    ghostBtn = mkBtn('gh', 'ghost note (O)', () => E.ghostNote());
    stacBtn = mkBtn('·', 'staccato (!)', () => E.staccato());
    accentBtn = mkBtn('>', 'accent (;) · heavy (:)', () => E.accent(false));
    harmBtn = mkBtn('◇', 'natural harmonic (Y)', () => E.naturalHarmonic());
    vibBtn = mkBtn('∿', 'vibrato (V)', () => E.vibratoNote());
    fx2.append(ghostBtn, stacBtn, accentBtn, harmBtn, vibBtn);
    bar.appendChild(fx2);

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
    if (playBtn) playBtn.textContent = s.isPlaying ? '⏹' : '▶';
    if (trackLabel) trackLabel.textContent = (s.curTrackIndex + 1) + '. ' + s.trackName;
    if (posLabel) posLabel.textContent = s.pos;
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
      ins.innerHTML = tabs +
        '<div class="insp-sec"><div class="insp-h">Information</div>' +
          '<input type="text" class="insp-input" id="ins-name" value="' + esc(s.trackName || 'Track') + '"></div>' +
        '<div class="insp-sec"><div class="insp-h">Musical notation</div>' +
          '<div class="insp-row"><span>Notation</span><span class="insp-pill" id="ins-notation">' +
            '<span class="' + (s.showStandard ? 'on' : '') + '" data-not="score">Score</span>' +
            '<span class="' + (s.showTab ? 'on' : '') + '" data-not="tab">Tab</span></span></div>' +
          (s.isPercussion ? '' : '<div class="insp-row"><span>Tuning</span>' + tuningSel + '</div>') +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Sounds</div>' +
          (s.isPercussion
            ? valRow('Kit', 'Drum Kit')
            : '<div class="insp-row"><span>Sound</span><select class="insp-select" id="ins-sound">' + optionList(GM_SOUNDS, s.trackProgram | 0) + '</select></div>') +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Mixer</div>' +
          '<div class="insp-row"><span>Pan</span>' +
            '<input type="range" class="insp-slider" id="ins-pan" min="0" max="100" value="' + Math.round((s.trackPan != null ? s.trackPan : 0.5) * 100) + '"></div>' +
          '<div class="insp-row"><span class="v" id="ins-pan-lbl" style="font-size:11px">' + panLabel(s.trackPan != null ? s.trackPan : 0.5) + '</span></div>' +
        '</div>' +
        '<div class="insp-sec"><div class="insp-h">Interpretation</div>' +
          valRow('Playing style', 'Pick') + sliderRow('Palm mute') + sliderRow('Accentuation') +
          toggleRow('Auto let ring', false) + toggleRow('Auto brush', true) +
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

  // ---- bottom track list -----------------------------------------------------
  function buildTrackList(s) {
    const tk = document.getElementById('tracks');
    if (!tk || !s.allTracks) return;
    // Don't rebuild (and lose the thumb) while a volume slider is being dragged.
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('tk-volrange') && tk.contains(ae)) return;
    const flags = window.gomidasTrackFlags || (window.gomidasTrackFlags = {});
    let html = '<div class="tk-head"><span style="flex:1">Tracks</span><span style="width:110px">Vol</span></div>';
    for (const t of s.allTracks) {
      const f = flags[t.index] || {};
      const vol = (typeof f.vol === 'number') ? f.vol : (typeof t.volume === 'number' ? t.volume : 0.75);
      html += '<div class="tk-row ' + (t.current ? 'current' : '') + '" data-idx="' + t.index + '">' +
        '<div class="tk-ico">' + (t.isPercussion ? '🥁' : '🎸') + '</div>' +
        '<div class="tk-name">' + (t.index + 1) + '. ' + esc(t.name) + '</div>' +
        '<span class="tk-badge">' + (t.isPercussion ? 'Drums' : ('GM ' + t.program)) + '</span>' +
        '<div class="tk-ctl">' +
          '<div class="tk-mini' + (f.hidden ? '' : ' on') + '" data-act="eye" title="show / hide">👁</div>' +
          '<div class="tk-mini' + (f.muted ? ' mute' : '') + '" data-act="mute" title="mute">M</div>' +
          '<div class="tk-mini' + (f.soloed ? ' solo' : '') + '" data-act="solo" title="solo">S</div>' +
        '</div>' +
        '<div class="tk-vol"><input type="range" class="tk-volrange" min="0" max="100" value="' + Math.round(vol * 100) + '"></div></div>';
    }
    tk.innerHTML = html;
    tk.querySelectorAll('.tk-row[data-idx]').forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      const flagsFor = () => (window.gomidasTrackFlags[idx] || (window.gomidasTrackFlags[idx] = {}));
      const vr = row.querySelector('.tk-volrange');
      if (vr) {
        const apply = () => { flagsFor().vol = (parseInt(vr.value, 10) || 0) / 100; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); };
        vr.addEventListener('input', (e) => { e.stopPropagation(); apply(); });
        vr.addEventListener('mousedown', (e) => e.stopPropagation()); // don't trigger row-select
      }
      row.addEventListener('click', (e) => {
        const ctl = e.target.closest('.tk-mini');
        if (ctl) {
          e.stopPropagation();
          const f = flagsFor();
          const act = ctl.dataset.act;
          if (act === 'eye') { f.hidden = !f.hidden; if (window.gomidasShowMulti) window.gomidasShowMulti(); }
          else if (act === 'mute') { f.muted = !f.muted; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); }
          else if (act === 'solo') { f.soloed = !f.soloed; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); }
          if (E && E.getState) refresh(E.getState()); // reflect button states now
          return;
        }
        if (e.target.closest('.tk-volrange')) return;
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
    window.GomidasUI = { refresh };
    if (E && E.getState) refresh(E.getState());
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
