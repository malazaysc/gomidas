// Gomidas tab editor — keyboard-primary, mouse-assist editing on alphaTab's
// score model. After every edit we re-render alphaTab and rebuild the native
// MIDI sequence (window.gomidasRebuild), so playback always reflects the score.
'use strict';

(function () {
  const DURATIONS = [1, 2, 4, 8, 16, 32]; // whole..thirty-second (alphaTab Duration enum values)
  // Drum palette (kit order, top→bottom). midi = GM percussion key; we resolve it to
  // the track's percussionArticulation index at runtime (works for any drum track).
  // Full-ish GM kit, top(cymbals)→bottom(kick). The first 9 get digit hotkeys 1–9;
  // all are click-able. Only pieces present in the track's percussionArticulations
  // render (getState filters by outputMidiNumber), so imported drum tracks adapt.
  const DRUM_KIT = [
    { name: 'Crash',     midi: 49 },
    { name: 'Splash',    midi: 55 },
    { name: 'China',     midi: 52 },
    { name: 'Ride',      midi: 51 },
    { name: 'Ride Bell', midi: 53 },
    { name: 'HH open',   midi: 46 },
    { name: 'Hi-Hat',    midi: 42 },
    { name: 'HH pedal',  midi: 44 },
    { name: 'Tom Hi',    midi: 48 },
    { name: 'Tom Mid',   midi: 47 },
    { name: 'Floor',     midi: 43 },
    { name: 'Snare',     midi: 38 },
    { name: 'Side Stick', midi: 37 },
    { name: 'Hand Clap', midi: 39 },
    { name: 'Tambourine', midi: 54 },
    { name: 'Cowbell',   midi: 56 },
    { name: 'Kick',      midi: 36 }
  ];
  let api = null;
  let isPlaying = false;
  let fretBuffer = '';
  let fretTimer = null;
  let lastPlayBeat = null;       // alphaTab beat the single cursor last reached while playing
  let dirty = false;             // unsaved-changes flag (drives New/Open confirmation)
  function markDirty() { dirty = true; }
  function isDirty() { return dirty; }
  function markClean() { dirty = false; }

  const cur = { track: 0, bar: 0, voice: 0, beat: 0, string: 0 };

  // Backend seam (GMD-30). Resolved lazily: app.js creates the backends, and load order is not
  // guaranteed to have run by the time this module body evaluates.
  const A = () => window.GomidasAudio;
  const H = () => window.GomidasHost;

  function nlog(m) { try { H().log('[editor] ' + m); } catch (e) {} }

  // ---- model accessors -------------------------------------------------------
  function track() { return api.score.tracks[cur.track]; }
  function staff() { const t = track(); return t && t.staves[0]; }
  function bar() { const s = staff(); return s && s.bars[cur.bar]; }
  function voice() { const b = bar(); return b && b.voices[cur.voice]; }
  function beat() { const v = voice(); return v && v.beats[cur.beat]; }
  function stringCount() {
    const s = staff();
    return (s && s.tuning && s.tuning.length) ? s.tuning.length : 6;
  }
  function isPercussionTrack() { const s = staff(); return !!(s && s.isPercussion); }
  function clampString() { cur.string = Math.max(0, Math.min(stringCount() - 1, cur.string)); }
  // Fretboard rows are top(0)=highest pitch; alphaTab note.string is 1-based from the
  // BOTTOM (1 = lowest pitch). Convert between a display row and an alphaTab string number.
  function rowToStringNo(row) { return stringCount() - row; }
  function stringNoToRow(stringNo) { return stringCount() - stringNo; }

  // ---- navigation ------------------------------------------------------------
  function moveBeat(delta) {
    const v = voice();
    if (!v) return;
    let nb = cur.beat + delta;
    if (nb < 0) {
      if (cur.bar > 0) { cur.bar--; if (!voice()) cur.voice = 0; const nv = voice(); cur.beat = nv ? nv.beats.length - 1 : 0; }
      else cur.beat = 0;
    } else if (nb >= v.beats.length) {
      const s = staff();
      if (cur.bar < s.bars.length - 1) { cur.bar++; if (!voice()) cur.voice = 0; cur.beat = 0; }
      else {
        // Last beat of the last bar: always extend on →. insertBeatAfter appends a
        // beat within the bar, or flows into a new bar when this one is full —
        // including after a silence, so you can keep adding beats freely (GP-style).
        insertBeatAfter();
        return;
      }
    } else {
      cur.beat = nb;
    }
    refreshCursor();
  }

  function moveString(delta) { cur.string += delta; clampString(); refreshCursor(); }

  // GP: Home / End — jump to the first / last beat of the current bar.
  function moveToBarEdge(toEnd) {
    const v = voice();
    if (!v) return;
    cur.beat = toEnd ? Math.max(0, v.beats.length - 1) : 0;
    refreshCursor();
  }
  // GP: Cmd+Home / Cmd+End — jump to the first / last bar (cursor lands on its first beat).
  function moveToScoreEdge(toEnd) {
    const s = staff();
    if (!s) return;
    cur.bar = toEnd ? Math.max(0, s.bars.length - 1) : 0;
    cur.voice = 0; cur.beat = 0;
    refreshCursor();
  }
  // GP: Go To (Cmd+G) — jump to a 1-based bar number, clamped to the score.
  function goToBar(barNo1) {
    const s = staff();
    if (!s) return;
    cur.bar = Math.max(0, Math.min(s.bars.length - 1, (barNo1 | 0) - 1));
    cur.voice = 0; cur.beat = 0;
    refreshCursor();
  }

  // ---- selection + clipboard (voice-0 beat range, or a cross-track whole-bar block) ----
  // GP: ⇧→/⇧← extend, ⌘A select all, ⌘C/⌘X/⌘V copy/cut/paste, C copy last beat.
  const sel = { active: false, anchor: null, head: null }; // anchor/head = {track, bar, beat}
  let clipboard = null;     // { kind:'beats'|'block', ... } (see copySelection)

  function clearSelection() { sel.active = false; sel.anchor = null; sel.head = null; }

  // A selection spanning more than one track is a GP-style whole-bar BLOCK; within one
  // track it's a beat range (existing behaviour).
  function isBlockSelection() { return !!(sel.active && sel.anchor && sel.head && sel.anchor.track !== sel.head.track); }
  function selectionTrackRange() { const a = sel.anchor.track | 0, b = sel.head.track | 0; return [Math.min(a, b), Math.max(a, b)]; }
  function selectionBarRange() { const a = sel.anchor.bar | 0, b = sel.head.bar | 0; return [Math.min(a, b), Math.max(a, b)]; }

  // Flat ordered list of every (bar,beat) on voice 0 of the current track's staff.
  function beatPositions() {
    const s = staff(); const out = [];
    if (!s) return out;
    for (let bi = 0; bi < s.bars.length; bi++) {
      const v = s.bars[bi].voices[0];
      if (!v) continue;
      for (let be = 0; be < v.beats.length; be++) out.push({ bar: bi, beat: be });
    }
    return out;
  }
  function posIndex(positions, p) {
    if (!p) return -1;
    for (let i = 0; i < positions.length; i++) if (positions[i].bar === p.bar && positions[i].beat === p.beat) return i;
    return -1;
  }
  // The beat objects under the selection (voice 0), or just the current beat if none.
  // Lets beat-level ops (duration, tuplet) apply across a GP-style range selection.
  function selectedBeats() {
    const ps = selectedPositions();
    if (!ps.length) { const b = beat(); return b ? [b] : []; }
    const s = staff(); const out = [];
    for (const p of ps) {
      const v = s.bars[p.bar] && s.bars[p.bar].voices[0];
      const b = v && v.beats[p.beat];
      if (b) out.push(b);
    }
    return out;
  }

  // The selected positions, inclusive, in score order (empty if no active selection).
  function selectedPositions() {
    if (!sel.active || !sel.anchor || !sel.head) return [];
    const positions = beatPositions();
    let a = posIndex(positions, sel.anchor), b = posIndex(positions, sel.head);
    if (a < 0 || b < 0) return [];
    if (a > b) { const t = a; a = b; b = t; }
    return positions.slice(a, b + 1);
  }

  // GP: ⇧→ / ⇧← — start (or grow) a selection from the cursor by one beat.
  function extendSelection(delta) {
    const positions = beatPositions();
    if (!positions.length) return;
    if (!sel.active) { sel.active = true; sel.anchor = { track: cur.track, bar: cur.bar, beat: cur.beat }; }
    let idx = posIndex(positions, { bar: cur.bar, beat: cur.beat });
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(positions.length - 1, idx + delta));
    cur.bar = positions[idx].bar; cur.beat = positions[idx].beat;
    sel.head = { track: cur.track, bar: cur.bar, beat: cur.beat };
    refreshCursor();
  }
  // GP: ⌘A — select every beat in the current track.
  function selectAll() {
    const positions = beatPositions();
    if (!positions.length) return;
    sel.active = true;
    sel.anchor = { track: cur.track, bar: positions[0].bar, beat: positions[0].beat };
    sel.head = { track: cur.track, bar: positions[positions.length - 1].bar, beat: positions[positions.length - 1].beat };
    cur.bar = sel.head.bar; cur.beat = sel.head.beat;
    refreshCursor();
  }

  // Select whole bars [bar0..bar1] on a track (used by shift-clicking the track-list
  // bar squares). Single-track whole-bar range.
  function selectBars(trackIndex, bar0, bar1) {
    const t = api.score.tracks[trackIndex]; if (!t) return;
    const st = t.staves[0]; if (!st) return;
    const lo = Math.max(0, Math.min(bar0, bar1));
    const hi = Math.min(st.bars.length - 1, Math.max(bar0, bar1));
    const v1 = st.bars[hi] && st.bars[hi].voices[0];
    const lastBeat = v1 ? Math.max(0, v1.beats.length - 1) : 0;
    cur.track = trackIndex; cur.voice = 0; cur.bar = hi; cur.beat = lastBeat;
    sel.active = true;
    sel.anchor = { track: trackIndex, bar: lo, beat: 0 };
    sel.head = { track: trackIndex, bar: hi, beat: lastBeat };
    refreshCursor();
  }

  // Plain-object (clipboard-safe) capture of a beat's musically meaningful fields.
  function serializeNote(n) {
    return { string: n.string, fret: n.fret, percussionArticulation: n.percussionArticulation,
      isPalmMute: !!n.isPalmMute, isDead: !!n.isDead, isGhost: !!n.isGhost, isStaccato: !!n.isStaccato,
      isLetRing: !!n.isLetRing, accentuated: n.accentuated, harmonicType: n.harmonicType, vibrato: n.vibrato };
  }
  function serializeBeat(b) {
    return { duration: b.duration, dots: b.dots || 0,
      tupletNumerator: b.tupletNumerator, tupletDenominator: b.tupletDenominator,
      notes: b.notes.map(serializeNote) };
  }
  function deserializeBeat(sb, v) {
    const nb = new alphaTab.model.Beat();
    nb.voice = v;                 // splice bypasses voice.addBeat(), which sets this back-ref
    nb.duration = sb.duration || 4;
    if (sb.dots) nb.dots = sb.dots;
    if (sb.tupletNumerator > 0) { nb.tupletNumerator = sb.tupletNumerator; nb.tupletDenominator = sb.tupletDenominator; }
    nb.isEmpty = false;           // a 0-note beat becomes a timed rest (not a blank)
    for (const sn of (sb.notes || [])) {
      const n = new alphaTab.model.Note();
      if (sn.string != null) n.string = sn.string;
      if (typeof sn.fret === 'number') n.fret = sn.fret;
      if (sn.percussionArticulation != null) n.percussionArticulation = sn.percussionArticulation;
      if (sn.isPalmMute) n.isPalmMute = true;
      if (sn.isDead) n.isDead = true;
      if (sn.isGhost) n.isGhost = true;
      if (sn.isStaccato) n.isStaccato = true;
      if (sn.isLetRing) n.isLetRing = true;
      if (sn.accentuated) n.accentuated = sn.accentuated;
      if (sn.harmonicType) n.harmonicType = sn.harmonicType;
      if (sn.vibrato) n.vibrato = sn.vibrato;
      nb.addNote(n);
    }
    return nb;
  }

  // GP: ⌘C — copy the selection. A within-track selection copies a beat list; a
  // cross-track selection copies a whole-bar block (per track × per bar).
  function copySelection() {
    if (isBlockSelection()) { copyBlock(); return; }
    const s = staff(); if (!s) return;
    const ps = selectedPositions();
    const list = ps.length ? ps : [{ bar: cur.bar, beat: cur.beat }];
    clipboard = { kind: 'beats', beats: list.map(p => {
      const v = s.bars[p.bar] && s.bars[p.bar].voices[0];
      const b = v && v.beats[p.beat];
      return b ? serializeBeat(b) : null;
    }).filter(Boolean) };
  }
  function copyBlock() {
    const [t0, t1] = selectionTrackRange();
    const [b0, b1] = selectionBarRange();
    const tracks = [];
    for (let ti = t0; ti <= t1; ti++) {
      const st = api.score.tracks[ti] && api.score.tracks[ti].staves[0];
      const bars = [];
      for (let bi = b0; bi <= b1; bi++) {
        const v = st && st.bars[bi] && st.bars[bi].voices[0];
        bars.push(v ? v.beats.map(serializeBeat) : []);
      }
      tracks.push({ bars });
    }
    clipboard = { kind: 'block', trackCount: t1 - t0 + 1, barCount: b1 - b0 + 1, tracks };
  }
  // GP: ⌘V — paste. Beat-list: insert after the cursor (current bar/voice). Block: write
  // each captured track/bar into the destination tracks/bars from the cursor (replacing
  // those bars' voice-0 beats), clamped to the available tracks/bars.
  function pasteClipboard() {
    if (!clipboard) return;
    if (clipboard.kind === 'block') { pasteBlock(); return; }
    const beats = clipboard.beats || [];
    if (!beats.length) return;
    const v = voice(); if (!v) return;
    let at = cur.beat + 1;
    for (const sb of beats) { v.beats.splice(at, 0, deserializeBeat(sb, v)); at++; }
    cur.beat = at - 1;
    clearSelection();
    applyEdit(true);
    previewBeat();
  }
  function replaceBarBeats(v, sbs) {
    v.beats.length = 0;
    if (sbs && sbs.length) { for (const sb of sbs) v.beats.push(deserializeBeat(sb, v)); }
    else { const nb = new alphaTab.model.Beat(); nb.voice = v; nb.duration = 4; nb.isEmpty = false; v.beats.push(nb); }
  }
  function pasteBlock() {
    const startTrack = cur.track, startBar = cur.bar;
    for (let ti = 0; ti < clipboard.tracks.length; ti++) {
      const st = api.score.tracks[startTrack + ti] && api.score.tracks[startTrack + ti].staves[0];
      if (!st) continue;
      const capBars = clipboard.tracks[ti].bars;
      for (let bi = 0; bi < capBars.length; bi++) {
        const v = st.bars[startBar + bi] && st.bars[startBar + bi].voices[0];
        if (v) replaceBarBeats(v, capBars[bi]);
      }
    }
    clearSelection();
    commitStructuralAll();   // multi-track change → re-render all tracks (one undo step)
    previewBeat();
  }
  // GP: ⌘X — copy the selection then remove it. Block cut clears the covered bars; a
  // within-track cut removes the selected beats (keeping ≥1 beat per bar).
  function cutSelection() {
    if (isBlockSelection()) {
      copyBlock();
      const [t0, t1] = selectionTrackRange();
      const [b0, b1] = selectionBarRange();
      for (let ti = t0; ti <= t1; ti++) {
        const st = api.score.tracks[ti] && api.score.tracks[ti].staves[0]; if (!st) continue;
        for (let bi = b0; bi <= b1; bi++) {
          const v = st.bars[bi] && st.bars[bi].voices[0]; if (v) replaceBarBeats(v, null);
        }
      }
      clearSelection();
      commitStructuralAll();
      return;
    }
    copySelection();
    const ps = selectedPositions();
    if (!ps.length) { removeBeat(); return; }
    const s = staff();
    const byBar = {};
    for (const p of ps) (byBar[p.bar] = byBar[p.bar] || []).push(p.beat);
    const firstBar = ps[0].bar, firstBeat = ps[0].beat;
    Object.keys(byBar).map(Number).sort((a, b) => b - a).forEach(bi => {
      const v = s.bars[bi] && s.bars[bi].voices[0]; if (!v) return;
      byBar[bi].sort((a, b) => b - a).forEach(be => { if (v.beats.length > 1) v.beats.splice(be, 1); });
      if (!v.beats.length) { const nb = new alphaTab.model.Beat(); nb.voice = v; nb.duration = 4; nb.isEmpty = false; v.beats.push(nb); }
    });
    cur.bar = firstBar;
    const fv = s.bars[firstBar] && s.bars[firstBar].voices[0];
    cur.beat = Math.max(0, Math.min(firstBeat, (fv ? fv.beats.length : 1) - 1));
    clearSelection();
    applyEdit(true);
  }
  // GP: C — duplicate the previous beat at the cursor (copy last beat).
  function copyLastBeat() {
    const pb = prevBeat(), v = voice();
    if (!pb || !v) return;
    v.beats.splice(cur.beat + 1, 0, deserializeBeat(serializeBeat(pb), v));
    cur.beat += 1;
    applyEdit(true);
    previewBeat();
  }

  // The beat objects to highlight: a beat range on the current track, or — for a
  // cross-track block — every voice-0 beat of the covered bars on each covered track
  // that is currently rendered.
  function selectionHighlightBeats() {
    const out = [];
    if (isBlockSelection()) {
      const [t0, t1] = selectionTrackRange();
      const [b0, b1] = selectionBarRange();
      for (const t of window.gomidasGetRenderedTracks()) {
        if (t.index < t0 || t.index > t1) continue;
        const st = t.staves && t.staves[0]; if (!st) continue;
        for (let bi = b0; bi <= b1; bi++) {
          const v = st.bars[bi] && st.bars[bi].voices[0];
          if (!v) continue;
          for (const be of v.beats) out.push(be);
        }
      }
      return out;
    }
    const ps = selectedPositions();
    const s = staff();
    if (!s) return out;
    for (const p of ps) {
      const v = s.bars[p.bar] && s.bars[p.bar].voices[0];
      const be = v && v.beats[p.beat];
      if (be) out.push(be);
    }
    return out;
  }
  // Draw the selection as continuous bands (GP-style): merge the selected beat columns
  // that share a staff row (same y/height) into one rectangle spanning them, rather than
  // one box per beat. Different systems (wrapped lines) and different tracks naturally
  // fall into separate rows. Pool of .sel-cell divs.
  let selOverlayEls = [];
  function renderSelection() {
    const beats = selectionHighlightBeats();
    const at = document.getElementById('at');
    const rows = {}; // key (rounded y:h) -> merged {x0,x1,y,h}
    if (at) {
      for (const b of beats) {
        const col = beatColumn(b);
        if (!col) continue;
        const key = Math.round(col.y) + ':' + Math.round(col.h);
        const r = rows[key];
        if (!r) rows[key] = { x0: col.x, x1: col.x + col.w, y: col.y, h: col.h };
        else { r.x0 = Math.min(r.x0, col.x); r.x1 = Math.max(r.x1, col.x + col.w); }
      }
    }
    let k = 0;
    for (const key in rows) {
      const r = rows[key];
      let el = selOverlayEls[k];
      if (!el) { el = document.createElement('div'); el.className = 'sel-cell'; at.appendChild(el); selOverlayEls[k] = el; }
      el.style.display = 'block';
      el.style.left = r.x0 + 'px'; el.style.top = r.y + 'px';
      el.style.width = (r.x1 - r.x0) + 'px'; el.style.height = r.h + 'px';
      k++;
    }
    for (; k < selOverlayEls.length; k++) selOverlayEls[k].style.display = 'none';
  }

  // ---- A/B loop ---------------------------------------------------------------
  // Loop over the current beat selection (or the current bar if nothing is selected).
  let loopActive = false;
  function loopSelection() {
    const ps = selectedPositions();
    let first, last, vIdx;
    if (ps.length) { first = ps[0]; last = ps[ps.length - 1]; vIdx = 0; }
    else {
      const v = voice(); if (!v) return;
      first = { bar: cur.bar, beat: 0 };
      last = { bar: cur.bar, beat: v.beats.length - 1 };
      vIdx = cur.voice;
    }
    if (window.gomidasSetLoopBars) {
      window.gomidasSetLoopBars(cur.track, first.bar, vIdx, first.beat, last.bar, vIdx, last.beat);
      loopActive = true;
    }
  }
  function clearLoop() { loopActive = false; if (window.gomidasClearLoop) window.gomidasClearLoop(); }
  function toggleLoop() { if (loopActive) clearLoop(); else loopSelection(); }
  function isLoopActive() { return loopActive; }

  function moveTrack(delta) {
    const n = api.score.tracks.length;
    cur.track = Math.max(0, Math.min(n - 1, cur.track + delta));
    cur.bar = Math.min(cur.bar, staff().bars.length - 1);
    cur.voice = 0; cur.beat = 0; clampString();
    refreshCursor();
  }
  function selectTrack(i) {
    const n = api.score.tracks.length;
    cur.track = Math.max(0, Math.min(n - 1, i | 0));
    cur.bar = Math.min(cur.bar, staff().bars.length - 1);
    cur.voice = 0;
    const v = voice(); cur.beat = Math.min(cur.beat, (v ? v.beats.length : 1) - 1);
    clampString();
    // Focus this track in the score (single-track view, GP-style). Re-renders, then
    // onRenderFinished → refreshCursor repositions the cursor.
    if (window.gomidasShowTrack) window.gomidasShowTrack(cur.track);
    else refreshCursor();
  }

  // GP: Voices 1–4 (⌘1–⌘4) — switch the editing voice. Lazily create the voice (a
  // whole-bar rest) in EVERY bar of the current track's staff so navigation across
  // bars stays consistent. alphaTab already renders/plays all voices.
  function selectVoice(n) {
    n = Math.max(0, Math.min(3, n | 0));
    const s = staff();
    if (!s) return;
    if (n > 0) {
      for (const b of s.bars) {
        while (b.voices.length <= n) {
          const v = new alphaTab.model.Voice();
          const be = new alphaTab.model.Beat();
          be.duration = 1; be.isEmpty = true;   // whole-bar rest
          v.addBeat(be);
          b.addVoice(v);
        }
      }
    }
    cur.voice = n;
    const v = voice();
    cur.beat = Math.min(cur.beat, (v ? v.beats.length : 1) - 1);
    applyEdit(true);   // finish() lays out the (possibly new) voice
  }

  // ---- undo / redo (JSON score snapshots) ------------------------------------
  const undoStack = [], redoStack = [];
  let currentSnap = null;        // serialized post-state of the last applied edit
  let preserveCursorNext = false;
  function JC() {
    return (alphaTab.model && alphaTab.model.JsonConverter)
        || (alphaTab.importer && alphaTab.importer.JsonConverter)
        || alphaTab.JsonConverter || null;
  }
  function snapshot() { const jc = JC(); try { return jc ? jc.scoreToJson(api.score) : null; } catch (e) { return null; } }
  function loadSnapshot(json) {
    const jc = JC(); if (!jc) return;
    const score = jc.jsonToScore(json, api.settings);
    preserveCursorNext = true;
    api.renderScore(score, score.tracks.map((_, i) => i));
  }
  // Fresh load from a project file (resets cursor + undo history via onScoreLoaded).
  function loadProjectJson(json) {
    const jc = JC(); if (!jc) return false;
    try {
      const score = jc.jsonToScore(json, api.settings);
      api.renderScore(score, score.tracks.map((_, i) => i));
      return true;
    } catch (e) { nlog('loadProject failed: ' + e); return false; }
  }
  function undo() {
    flushHeavy();
    if (!undoStack.length) return;
    redoStack.push(currentSnap);
    currentSnap = undoStack.pop();
    loadSnapshot(currentSnap);
  }
  function redo() {
    flushHeavy();
    if (!redoStack.length) return;
    undoStack.push(currentSnap);
    currentSnap = redoStack.pop();
    loadSnapshot(currentSnap);
  }

  // ---- edits -----------------------------------------------------------------
  // Render immediately (visual feedback); coalesce the heavier native MIDI rebuild
  // and the undo snapshot across a burst of edits so typing stays responsive.
  let _heavyTimer = null, _undoBase = null;
  function _commitHeavy() {
    _heavyTimer = null;
    if (_undoBase != null) {
      undoStack.push(_undoBase);
      if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0;
      _undoBase = null;
    }
    window.gomidasRebuild();   // push MIDI to native
    currentSnap = snapshot();  // serialize for undo
    markDirty();
  }
  function flushHeavy() { if (_heavyTimer) { clearTimeout(_heavyTimer); _commitHeavy(); } }

  // alphaTab flushes its render on a deferred callback. When the page goes idle
  // right after an input event, WKWebView throttles that callback for ~0.5-1s,
  // so the note appears late and the UI feels frozen. A MessageChannel ping is a
  // macrotask that the throttle doesn't clamp — we pulse it (bounded) to keep the
  // loop awake until the render lands. stopPump() is called from onRenderFinished.
  const _pumpChan = (typeof MessageChannel !== 'undefined') ? new MessageChannel() : null;
  let _pumpUntil = 0;
  if (_pumpChan) _pumpChan.port1.onmessage = () => {
    if (performance.now() < _pumpUntil) _pumpChan.port2.postMessage(0);
  };
  function pumpLoop() {
    if (!_pumpChan) return;
    const wasActive = _pumpUntil > performance.now();
    _pumpUntil = performance.now() + 250;   // safety cap; stopPump ends it sooner
    if (!wasActive) _pumpChan.port2.postMessage(0);
  }
  function stopPump() { _pumpUntil = 0; }

  let _editStartedAt = 0;        // timestamp of the in-flight edit, for the slow-render log
  function applyEdit(structural) {
    clearSelection();   // any model-mutating edit collapses the beat selection
    if (_undoBase === null) _undoBase = currentSnap; // capture pre-burst state once
    try {
      if (structural) api.score.finish(api.settings);
    } catch (e) { nlog('finish failed: ' + e); }
    _editStartedAt = performance.now();
    api.renderTracks(window.gomidasGetRenderedTracks());
    pumpLoop();   // keep the event loop warm so the WebView flushes the render promptly when idle
    clearTimeout(_heavyTimer);
    _heavyTimer = setTimeout(_commitHeavy, 180);
  }

  // Place/replace a fret on the current string of the current beat. Renders
  // immediately so keyboard entry shows the note with no perceptible delay.
  function placeFret(fret) {
    const b = beat();
    if (!b || isNaN(fret)) return;
    const stringNo = rowToStringNo(cur.string);
    const existing = b.notes.find(n => n.string === stringNo);
    if (existing) b.removeNote(existing);
    const note = new alphaTab.model.Note();
    note.fret = fret;
    note.string = stringNo;
    b.addNote(note);
    b.isEmpty = false;
    applyEdit(true);   // finish() turns a rest beat into a note beat (same path as fretboard clicks)
    previewBeat();
  }

  function deleteNote() {
    const b = beat();
    if (!b) return;
    const existing = b.notes.find(n => n.string === rowToStringNo(cur.string));
    if (existing) { b.removeNote(existing); applyEdit(false); }
  }

  function changeDuration(longer) {
    const b = beat();
    if (!b) return;
    let idx = DURATIONS.indexOf(b.duration);
    if (idx < 0) idx = 2; // default quarter
    idx += longer ? -1 : 1;
    idx = Math.max(0, Math.min(DURATIONS.length - 1, idx));
    b.duration = DURATIONS[idx];
    applyEdit(true);
  }

  // ---- bar capacity (ticks) — keep bars within their time signature ----------
  const WHOLE_TICKS = 3840;        // PPQ(960) * 4; mirrors app.js
  // Thin adapters over the unit-tested core (web/core/gomidas-core.js; docs/TESTING.md).
  function beatTicksOf(b) { return GomidasCore.beatTicksRaw(b); }
  function barCapacityTicks(barIndex) { return GomidasCore.barCapacityTicks(api.score.masterBars, barIndex); }
  function barFilledTicks(barIndex, voiceIndex) {
    const st = staff();
    return GomidasCore.barFilledTicks(st && st.bars[barIndex], voiceIndex);
  }
  // A bar is "full" once its beats occupy its whole time-signature length.
  function barIsFull(barIndex, voiceIndex) {
    return barFilledTicks(barIndex, voiceIndex) >= barCapacityTicks(barIndex) - 1;
  }
  // Flow entry into the next bar (creating one if at the end). The landing beat
  // becomes a rest of `dur` so the new bar starts underfilled and accepts entry.
  function startNextBarForEntry(dur) {
    const s = staff();
    if (cur.bar >= s.bars.length - 1) addBar(); // creates the bar + lands cursor on its beat 0
    else { cur.bar += 1; cur.voice = 0; cur.beat = 0; }
    const b = beat();
    if (b && b.isRest) { b.duration = dur || 4; b.isEmpty = false; applyEdit(true); }
    refreshCursor();
  }

  function insertBeatAfter() {
    const v = voice();
    if (!v) return;
    const dur = beat() ? beat().duration : 4;
    // Appending past the end of a full bar flows into the next bar (GP-style),
    // instead of overfilling the current one beyond its time signature.
    if (cur.beat >= v.beats.length - 1 && barIsFull(cur.bar, cur.voice)) {
      startNextBarForEntry(dur);
      return;
    }
    const nb = new alphaTab.model.Beat();
    nb.duration = dur;
    nb.voice = v;          // splice bypasses voice.addBeat(), which sets this back-ref
    nb.isEmpty = false;    // show as a rest, not a blank
    v.beats.splice(cur.beat + 1, 0, nb);
    cur.beat += 1;
    applyEdit(true);
  }

  function removeBeat() {
    const v = voice();
    if (!v || v.beats.length <= 1) return; // keep at least one beat in the bar
    v.beats.splice(cur.beat, 1);
    cur.beat = Math.max(0, cur.beat - 1);
    applyEdit(true);
  }

  // GP: Delete Bar (⌃-) — remove the cursor's bar from the master list and every
  // track/staff. alphaTab sets masterBar index/prev/next links at add-time and
  // doesn't rebuild them in finish(), so we splice the arrays then round-trip
  // through JSON (same proven path as undo) to rebuild a clean, consistent score.
  function deleteBar() {
    const score = api.score;
    const mbs = score.masterBars;
    if (!mbs || mbs.length <= 1) return; // always keep at least one bar
    const idx = Math.min(cur.bar, mbs.length - 1);
    mbs.splice(idx, 1);
    for (const t of score.tracks)
      for (const st of t.staves)
        if (st.bars.length > idx) st.bars.splice(idx, 1);
    const jc = JC();
    if (!jc) return;
    const json = jc.scoreToJson(score); // post-delete state
    if (currentSnap != null) {
      undoStack.push(currentSnap);
      if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0;
    }
    currentSnap = json;
    markDirty();
    cur.bar = Math.min(idx, mbs.length - 1); cur.voice = 0; cur.beat = 0; clampString();
    loadSnapshot(json); // jsonToScore + renderScore (preserves cursor)
  }

  // Append an empty bar (a whole rest) to every track, keeping master bars aligned.
  function addBar() {
    const score = api.score;
    const mbs = score.masterBars;
    const last = mbs.length ? mbs[mbs.length - 1] : null;
    const mb = new alphaTab.model.MasterBar();
    mb.timeSignatureNumerator = last ? last.timeSignatureNumerator : 4;
    mb.timeSignatureDenominator = last ? last.timeSignatureDenominator : 4;
    score.addMasterBar(mb);
    for (const t of score.tracks) {
      for (const st of t.staves) {
        const bar = new alphaTab.model.Bar();
        const voice = new alphaTab.model.Voice();
        const beat = new alphaTab.model.Beat();
        beat.duration = 1;           // whole-note rest fills a 4/4 bar
        voice.addBeat(beat);
        bar.addVoice(voice);
        st.addBar(bar);
      }
    }
    applyEdit(true);
    // Land the cursor on the new bar so the next fret click edits it.
    cur.voice = 0; cur.beat = 0; cur.bar = staff().bars.length - 1;
    refreshCursor();
  }

  // GP: Time Signature (⌘T) — set the current bar's time signature and propagate it
  // forward to the end (GP applies a change from the current bar onward). Existing
  // beats are kept; playback pads/truncates each bar to its new capacity.
  function setTimeSignature(num, den) {
    const score = api.score;
    num = Math.max(1, Math.min(32, num | 0));
    if ([1, 2, 4, 8, 16, 32].indexOf(den | 0) < 0) den = 4;
    const i = Math.min(cur.bar, score.masterBars.length - 1);
    for (let j = i; j < score.masterBars.length; j++) {
      score.masterBars[j].timeSignatureNumerator = num;
      score.masterBars[j].timeSignatureDenominator = den;
    }
    applyEdit(true);
  }

  // GP: Key Signature (⌘K) — set the current bar's key (−7..+7 accidentals) and
  // major/minor type, propagated forward to the end.
  function setKeySignature(ksValue, minor) {
    const score = api.score;
    ksValue = Math.max(-7, Math.min(7, ksValue | 0));
    const KST = (alphaTab.model && alphaTab.model.KeySignatureType) || { Major: 0, Minor: 1 };
    const type = minor ? KST.Minor : KST.Major;
    const i = Math.min(cur.bar, score.masterBars.length - 1);
    for (let j = i; j < score.masterBars.length; j++) {
      score.masterBars[j].keySignature = ksValue;
      score.masterBars[j].keySignatureType = type;
    }
    applyEdit(true);
  }

  function curMasterBar() {
    const score = api.score;
    return score && score.masterBars[Math.min(cur.bar, score.masterBars.length - 1)];
  }
  // GP: Open Repeat ([) — toggle a repeat-start barline on the current bar.
  function toggleRepeatStart() {
    const mb = curMasterBar(); if (!mb) return;
    mb.isRepeatStart = !mb.isRepeatStart;
    applyEdit(true);
  }
  // GP: Close Repeat (]) — toggle a repeat-end barline (default 2 plays) on the current bar.
  function toggleRepeatEnd() {
    const mb = curMasterBar(); if (!mb) return;
    mb.repeatCount = (mb.repeatCount && mb.repeatCount > 0) ? 0 : 2;
    applyEdit(true);
  }
  // GP: Directions (D) — Segno / Coda / Fine markers + Da Capo / Dal Segno jumps,
  // stored in the current master bar's `directions` set. Toggles the given one.
  function toggleDirection(name) {
    const D = alphaTab.model && alphaTab.model.Direction;
    const mb = curMasterBar();
    if (!D || !mb || D[name] == null) return;
    const val = D[name];
    try {
      if (mb.directions && mb.directions.has && mb.directions.has(val)) mb.directions.delete(val);
      else mb.addDirection(val);
    } catch (e) { nlog('toggleDirection: ' + e); return; }
    applyEdit(true);
  }
  // GP: Fermata (F) — hold on the current beat. Toggles a medium fermata.
  function toggleFermata() {
    const b = beat();
    if (!b) return;
    try {
      if (b.fermata) { b.fermata = null; }
      else {
        const F = alphaTab.model && alphaTab.model.Fermata;
        const FT = alphaTab.model && alphaTab.model.FermataType;
        if (!F) return;
        const f = new F();
        if (FT && FT.Medium != null) f.type = FT.Medium;
        b.fermata = f;
      }
    } catch (e) { nlog('toggleFermata: ' + e); return; }
    applyEdit(true);
  }

  // GP: Triplet Feel (⌘/) — toggle swing 8ths from the current bar onward.
  function toggleTripletFeel() {
    const score = api.score;
    const TF = (alphaTab.model && alphaTab.model.TripletFeel) || { NoTripletFeel: 0, Triplet8th: 1 };
    const i = Math.min(cur.bar, score.masterBars.length - 1);
    const want = (score.masterBars[i].tripletFeel === TF.Triplet8th) ? TF.NoTripletFeel : TF.Triplet8th;
    for (let j = i; j < score.masterBars.length; j++) score.masterBars[j].tripletFeel = want;
    applyEdit(true);
  }

  // Like applyEdit, but re-renders ALL tracks (for structural changes that add tracks).
  function commitStructuralAll() {
    try { api.score.finish(api.settings); } catch (e) { nlog('finish failed: ' + e); }
    if (currentSnap != null) {
      undoStack.push(currentSnap);
      if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0;
    }
    preserveCursorNext = true;
    api.renderScore(api.score, api.score.tracks.map((_, i) => i));
    currentSnap = snapshot();
    markDirty();
  }

  function freeChannel(score) {
    const used = new Set([9]); // 9 reserved for GM percussion
    for (const t of score.tracks) {
      const c = t.playbackInfo && t.playbackInfo.primaryChannel;
      if (c != null) used.add(c & 0x0f);
    }
    for (let c = 0; c < 16; c++) if (! used.has(c)) return c;
    return 0;
  }

  // Add a drum track to the current score. Percussion needs a full articulation
  // set, which alphaTab builds from `\instrument percussion` — so we parse a
  // bar-matched drums tex and graft its track in via JSON merge (then reload).
  function addDrumTrack() {
    const Imp = alphaTab.importer && alphaTab.importer.AlphaTexImporter;
    const jc = JC();
    if (!Imp || !jc) { nlog('addDrumTrack: importer/JsonConverter unavailable'); return; }
    const score = api.score;
    const nMasters = Math.max(1, score.masterBars.length);
    // alphaTab builds percussion articulations on-demand from drum notes, so bar 1
    // hits every palette piece to register the kit; we clear those notes afterward.
    const reg = '(' + DRUM_KIT.map(d => d.midi).join(' ') + ').1';
    let texBars = reg + ' |';
    for (let i = 1; i < nMasters; i++) texBars += ' r r r r |';
    const tex = '\\track "Drums" \\instrument percussion\n' + texBars;
    let drumScore;
    try {
      const imp = new Imp();
      imp.initFromString(tex, api.settings);
      drumScore = imp.readScore();
      drumScore.finish(api.settings);
      // strip the registration notes — keep the (now-populated) articulation kit
      for (const st of drumScore.tracks[0].staves)
        for (const bar of st.bars)
          for (const v of bar.voices)
            for (const be of v.beats) while (be.notes.length) be.removeNote(be.notes[0]);
    } catch (e) { nlog('addDrumTrack: tex parse failed: ' + e); return; }
    try {
      const asObj = (j) => (typeof j === 'string') ? JSON.parse(j) : j;
      const raw = jc.scoreToJson(score);
      const wasStr = (typeof raw === 'string');
      const obj = asObj(raw);
      const dtrack = asObj(jc.scoreToJson(drumScore)).tracks[0];
      if (!dtrack) { nlog('addDrumTrack: no drum track parsed'); return; }
      obj.tracks.push(dtrack);
      const finalJson = wasStr ? JSON.stringify(obj) : obj;
      if (currentSnap != null) { undoStack.push(currentSnap); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
      currentSnap = finalJson;
      cur.track = obj.tracks.length - 1; cur.bar = 0; cur.voice = 0; cur.beat = 0; cur.string = 0;
      markDirty();
      loadSnapshot(finalJson); // jsonToScore + renderScore (preserves cursor)
    } catch (e) { nlog('addDrumTrack: merge failed: ' + e); }
  }

  // Add a new guitar/bass track with empty bars matching the existing master bars.
  function addTrackOfKind(kind) {
    if (kind === 'drums') return addDrumTrack();
    const score = api.score;
    const track = new alphaTab.model.Track();
    track.name = (kind === 'bass') ? 'Bass' : 'Guitar';
    if (! track.playbackInfo) track.playbackInfo = new alphaTab.model.PlaybackInformation();
    const sc = (kind === 'bass') ? 4 : 6;
    const ch = freeChannel(score);
    track.playbackInfo.program = (kind === 'bass') ? 33 : 27;
    track.playbackInfo.primaryChannel = ch;
    track.playbackInfo.secondaryChannel = ch;
    track.playbackInfo.volume = 12;
    track.playbackInfo.balance = 8;
    const staff = new alphaTab.model.Staff();
    staff.showStandardNotation = true;
    staff.showTablature = true;
    const tuning = alphaTab.model.Tuning.getDefaultTuningFor(sc);
    if (tuning) staff.stringTuning = tuning;
    const nMasters = Math.max(1, score.masterBars.length);
    for (let i = 0; i < nMasters; i++) {
      const b = new alphaTab.model.Bar();
      const v = new alphaTab.model.Voice();
      const be = new alphaTab.model.Beat(); be.duration = 1;
      v.addBeat(be); b.addVoice(v); staff.addBar(b);
    }
    track.addStaff(staff);
    score.addTrack(track);
    cur.track = score.tracks.length - 1; cur.bar = 0; cur.voice = 0; cur.beat = 0; cur.string = 0;
    commitStructuralAll();
  }

  // GP: Delete Track (⌥⌘R) — remove the cursor's track. alphaTab sets per-track
  // index/channel links at add-time and doesn't rebuild them in finish(), so we
  // splice the JSON tracks array and round-trip (same proven path as deleteBar /
  // addDrumTrack) for a clean, consistent score. Always keep at least one track.
  function deleteTrack() {
    const score = api.score;
    if (!score || score.tracks.length <= 1) return;
    const jc = JC();
    if (!jc) return;
    const idx = Math.min(cur.track, score.tracks.length - 1);
    const raw = jc.scoreToJson(score);
    const wasStr = (typeof raw === 'string');
    const obj = wasStr ? JSON.parse(raw) : raw;
    if (!obj.tracks || obj.tracks.length <= idx) return;
    obj.tracks.splice(idx, 1);
    const finalJson = wasStr ? JSON.stringify(obj) : obj;
    if (currentSnap != null) { undoStack.push(currentSnap); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
    currentSnap = finalJson;
    cur.track = Math.max(0, idx - 1); cur.bar = 0; cur.voice = 0; cur.beat = 0; cur.string = 0;
    markDirty();
    loadSnapshot(finalJson); // jsonToScore + renderScore (scoreLoaded resets to multi view)
  }

  // ---- granular UI actions (fretboard / toolbar) -----------------------------
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiToName(m) { return NOTE_NAMES[(((m | 0) % 12) + 12) % 12]; }

  // Play the current beat's notes (chord) as editor feedback.
  function previewBeat() {
    const b = beat(), t = track();
    if (!b || !t) return;
    const pb = t.playbackInfo || {};
    const channel = (pb.primaryChannel != null) ? (pb.primaryChannel & 0x0f) : 0;
    const percussion = (channel === 9);
    let keys;
    if (percussion) {
      const arts = t.percussionArticulations || [];
      keys = b.notes.map(n => { const a = arts[n.percussionArticulation | 0]; return a ? a.outputMidiNumber : null; });
    } else {
      keys = b.notes.map(n => n.realValue);
    }
    keys = keys.filter(k => k != null && k >= 0 && k <= 127);
    if (!keys.length) return;
    if (A()) A().preview(channel, pb.program | 0, percussion, keys);
  }

  // ---- drums -----------------------------------------------------------------
  // The New Drums / Full Band templates carry a registration chord in bar 1 (so
  // alphaTab builds the kit); we clear it right after that specific load. Armed
  // only by newScore() — never on import, so real drum files are untouched.
  let _clearDrumRegOnLoad = false;
  function armDrumRegClear() { _clearDrumRegOnLoad = true; }
  function clearDrumRegistration() {
    // alphaTab builds percussionArticulations lazily from drum notes, so finish()
    // after stripping the registration chord would re-derive an EMPTY kit (then
    // toggleDrum/insertGroove find no articulation index and emit zero notes — a
    // silent track). Capture the populated kit, strip the notes, finish, restore.
    const saved = [];
    for (const t of api.score.tracks) {
      const st = t.staves && t.staves[0];
      if (!st || !st.isPercussion) continue;
      saved.push([t, t.percussionArticulations]);
      const be = st.bars[0] && st.bars[0].voices[0] && st.bars[0].voices[0].beats[0];
      if (be) while (be.notes.length) be.removeNote(be.notes[0]);
    }
    try { api.score.finish(api.settings); } catch (e) {}
    for (const [t, arts] of saved)
      if (arts && arts.length && (!t.percussionArticulations || !t.percussionArticulations.length))
        t.percussionArticulations = arts;
    api.renderTracks(window.gomidasGetRenderedTracks());
    window.gomidasRebuild();
  }

  function drumArtIndex(t, midi) {
    const arts = t && t.percussionArticulations;
    if (!arts) return -1;
    for (let i = 0; i < arts.length; i++)
      if (arts[i] && arts[i].outputMidiNumber === midi) return i;
    return -1;
  }
  // Toggle a drum hit (by GM midi key) on the current beat. Multiple pieces can stack.
  function toggleDrum(midi) {
    const b = beat(), t = track();
    if (!b || !t) return;
    const ai = drumArtIndex(t, midi);
    if (ai < 0) return;
    const existing = b.notes.find(n => (n.percussionArticulation | 0) === ai);
    if (existing) { b.removeNote(existing); }
    else {
      const n = new alphaTab.model.Note();
      n.percussionArticulation = ai;
      b.addNote(n);
      if (A()) A().preview(9, 0, true, [midi]);
    }
    b.isEmpty = false;
    applyEdit(true);
  }

  // ---- drum grooves: pattern insert, step-grid read/write, variation ----------
  function artMidi(t, ai) { const arts = t && t.percussionArticulations; return (arts && arts[ai]) ? arts[ai].outputMidiNumber : null; }
  function midiToLane(midi) { const M = window.GomidasGrooves && window.GomidasGrooves.LANE_MIDI; if (!M) return null; for (const k in M) if (M[k] === midi) return k; return null; }

  // Build a Beat for one 16-step slot from a {lane:flag} map (flag 1/2/3 = normal/accent/ghost).
  function grooveStepBeat(t, v, laneFlags) {
    const G = window.GomidasGrooves;
    const nb = new alphaTab.model.Beat(); nb.voice = v; nb.duration = 16; nb.isEmpty = false;
    for (const lane in laneFlags) {
      const flag = laneFlags[lane]; if (!flag) continue;
      const midi = G.LANE_MIDI[lane]; if (midi == null) continue;
      const ai = drumArtIndex(t, midi); if (ai < 0) continue;
      const n = new alphaTab.model.Note(); n.percussionArticulation = ai;
      if (flag === 2) n.accentuated = 1; else if (flag === 3) n.isGhost = true;
      nb.addNote(n);
    }
    return nb;
  }

  // Insert a groove from the cursor bar onward, replacing each covered bar's beats with
  // sixteen 16th-note steps. Adds bars if the groove is longer than the song's tail.
  function insertGroove(groove) {
    if (!isPercussionTrack() || !window.GomidasGrooves) return;
    const t = track(), st = staff(); if (!t || !st) return;
    const bars = groove.bars || [{ lanes: groove.lanes }];
    // Insert mode: 'replace' (default) overwrites from the cursor bar; 'append' writes
    // into new bars at the end of the song.
    const startBar = (window.gomidasInsertMode === 'append') ? st.bars.length : cur.bar;
    for (let bi = 0; bi < bars.length; bi++) {
      const targetBar = startBar + bi;
      while (st.bars.length <= targetBar) addBar();
      const bar = st.bars[targetBar];
      const v = bar.voices[Math.min(cur.voice, bar.voices.length - 1)] || bar.voices[0];
      if (!v) continue;
      v.beats.length = 0;
      for (let s = 0; s < 16; s++) {
        const slot = {};
        for (const lane in bars[bi].lanes) slot[lane] = bars[bi].lanes[lane][s];
        v.beats.push(grooveStepBeat(t, v, slot));
      }
    }
    cur.bar = startBar; cur.beat = 0;
    commitStructuralAll();
  }

  // Read the current bar into a 16-step lane grid (snaps each beat to the nearest 16th).
  function readBarGrid() {
    const G = window.GomidasGrooves;
    const grid = {}; (G ? G.LANE_ORDER : []).forEach(l => grid[l] = new Array(16).fill(0));
    const t = track(), v = voice();
    if (!t || !v || !G) return { steps: 16, lanes: grid };
    const stepTicks = WHOLE_TICKS / 16;
    let tick = 0;
    for (const b of v.beats) {
      const step = Math.round(tick / stepTicks);
      if (step >= 0 && step < 16 && !b.isRest) {
        for (const n of b.notes) {
          const lane = midiToLane(artMidi(t, n.percussionArticulation | 0));
          if (lane && grid[lane]) grid[lane][step] = n.isGhost ? 3 : (n.accentuated ? 2 : 1);
        }
      }
      tick += beatTicksOf(b);
    }
    return { steps: 16, lanes: grid };
  }

  // Rewrite the current bar from a 16-step grid (sixteen 16th beats).
  function writeBarGrid(grid) {
    const t = track(), v = voice(); if (!t || !v) return;
    v.beats.length = 0;
    for (let s = 0; s < 16; s++) {
      const slot = {};
      for (const lane in grid.lanes) slot[lane] = grid.lanes[lane][s];
      v.beats.push(grooveStepBeat(t, v, slot));
    }
    cur.beat = Math.min(cur.beat, 15);
    applyEdit(true);
  }
  function toggleGridCell(lane, step, flag) {
    const grid = readBarGrid();
    if (!grid.lanes[lane]) grid.lanes[lane] = new Array(16).fill(0);
    const cur0 = grid.lanes[lane][step] | 0;
    grid.lanes[lane][step] = (flag != null) ? (cur0 === flag ? 0 : flag) : (cur0 ? 0 : 1);
    writeBarGrid(grid);
  }

  // Generate a musical variation of the current bar (seeded; successive calls differ).
  let _varSeed = 0x2545f;
  function _rnd() { _varSeed = (_varSeed * 1103515245 + 12345) & 0x7fffffff; return _varSeed / 0x7fffffff; }
  function generateVariation() {
    if (!isPercussionTrack()) return;
    const grid = readBarGrid();
    const hat = grid.lanes.hihat || (grid.lanes.hihat = new Array(16).fill(0));
    const snare = grid.lanes.snare || (grid.lanes.snare = new Array(16).fill(0));
    const kick = grid.lanes.kick || (grid.lanes.kick = new Array(16).fill(0));
    for (let s = 0; s < 16; s++) if (hat[s] === 1 && _rnd() < 0.18) hat[s] = 3;       // some hats → ghosts
    for (let s = 0; s < 16; s++) if (!snare[s] && s % 4 !== 0 && _rnd() < 0.12) snare[s] = 3; // ghost snares
    for (let s = 2; s < 16; s += 4) if (!kick[s] && _rnd() < 0.4) kick[s] = 1;        // extra off-beat kicks
    [4, 12].forEach(s => { if (snare[s]) snare[s] = 2; });                            // accent the backbeat
    writeBarGrid(grid);
  }

  // Set (or toggle off) a fret on a given string row (0 = top string) of the current beat.
  // finish() converts a rest beat into a note beat and recomputes layout/playback.
  function setFret(row, fret) {
    const b = beat();
    if (!b) return;
    cur.string = row; clampString();
    const stringNo = rowToStringNo(row);
    const existing = b.notes.find(n => n.string === stringNo);
    let removed = false;
    if (existing) { b.removeNote(existing); removed = (existing.fret === fret); }
    if (!removed) {
      const note = new alphaTab.model.Note();
      note.fret = fret;
      note.string = stringNo;
      b.addNote(note);
    }
    b.isEmpty = false; // auto-padded bars start isEmpty=true and won't render notes otherwise
    applyEdit(true);
    if (!removed) previewBeat();
  }

  function deleteNoteOnString(row) {
    const b = beat();
    if (!b) return;
    const existing = b.notes.find(n => n.string === rowToStringNo(row));
    if (existing) { b.removeNote(existing); applyEdit(false); }
  }

  // Set the note duration across the selection (or the current beat).
  function setDuration(d) {
    if (DURATIONS.indexOf(d) < 0) return;
    const targets = selectedBeats();
    if (!targets.length) return;
    for (const b of targets) b.duration = d;
    applyEdit(true);
  }

  // GP: Dotting (.) toggles a single dot; Double Dotting (⌘.) toggles two dots.
  function toggleDot() {
    const b = beat();
    if (!b) return;
    b.dots = (b.dots === 1) ? 0 : 1;
    applyEdit(true);
  }
  function toggleDoubleDot() {
    const b = beat();
    if (!b) return;
    b.dots = (b.dots === 2) ? 0 : 2;
    applyEdit(true);
  }

  // The "in the space of" denominator for an n-tuplet = the nearest lower power of two
  // (GP/alphaTab convention: 3→2, 5→4, 6→4, 7→4, 9→8, 11→8, 13→8).
  function tupletDenomFor(n) { let d = 1; while (d * 2 < n) d *= 2; return d; }

  // GP: Triolet (/) — make the current beat a triplet (3 in the space of 2); toggles off.
  function toggleTriplet() { setTuplet(3); }

  // GP: Tuplet — set an n-tuplet (3/5/6/7/9…) across the selection (or the current
  // beat); when every target already has it, toggles it off (spanning tuplet group).
  function setTuplet(n) {
    n = n | 0;
    const targets = selectedBeats();
    if (!targets.length) return;
    if (n <= 1) {
      for (const b of targets) { b.tupletNumerator = -1; b.tupletDenominator = -1; }
      applyEdit(true); return;
    }
    const den = tupletDenomFor(n);
    const allSame = targets.every(b => b.tupletNumerator === n && b.tupletDenominator === den);
    for (const b of targets) {
      if (allSame) { b.tupletNumerator = -1; b.tupletDenominator = -1; }
      else { b.tupletNumerator = n; b.tupletDenominator = den; }
    }
    applyEdit(true);
  }

  // GP: Palm Mute On Note (P) — toggle on the current string's note;
  //     Palm Mute On Beat (⇧P) — toggle on every note of the beat.
  function palmMuteNote() {
    const b = beat();
    if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string));
    if (!n) return;
    n.isPalmMute = !n.isPalmMute;
    applyEdit(true);
  }
  function palmMuteBeat() {
    const b = beat();
    if (!b || !b.notes.length) return;
    const turnOn = b.notes.some(n => !n.isPalmMute); // any off → all on, else all off
    for (const n of b.notes) n.isPalmMute = turnOn;
    applyEdit(true);
  }

  // GP: Dead Note (X) — toggle a muted/“x” note on the current string.
  function deadNote() {
    const b = beat();
    if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string));
    if (!n) return;
    n.isDead = !n.isDead;
    applyEdit(true);
  }

  // GP: Let Ring (I) — toggle let-ring on the current string's note (rings past its duration).
  function letRing() {
    const b = beat();
    if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string));
    if (!n) return;
    n.isLetRing = !n.isLetRing;
    applyEdit(true);
  }

  // The beat immediately before the cursor (handles the bar boundary), or null.
  function prevBeat() {
    if (cur.beat > 0) { const v = voice(); return v ? v.beats[cur.beat - 1] : null; }
    if (cur.bar > 0) {
      const s = staff(); const pb = s && s.bars[cur.bar - 1];
      const pv = pb && pb.voices[cur.voice];
      return (pv && pv.beats.length) ? pv.beats[pv.beats.length - 1] : null;
    }
    return null;
  }

  // GP: Tie Note (L) — tie the current string's note back to the preceding note on
  // that string (finish() resolves the origin and copies its pitch). On an empty
  // beat it creates the continuation note. Toggles off.
  function tieNote() {
    const b = beat();
    if (!b) return;
    const stringNo = rowToStringNo(cur.string);
    let n = b.notes.find(x => x.string === stringNo);
    if (n && n.isTieDestination) { n.isTieDestination = false; n.tieOrigin = null; applyEdit(true); return; }
    const pb = prevBeat();
    const prevN = pb && pb.notes.find(x => x.string === stringNo);
    if (!prevN) return; // nothing to tie to
    if (!n) { n = new alphaTab.model.Note(); n.string = stringNo; n.fret = prevN.fret; b.addNote(n); b.isEmpty = false; }
    n.isTieDestination = true;
    applyEdit(true);
    previewBeat();
  }

  // GP: Tie Beat (⇧L) — continue the whole previous beat/chord into this beat.
  function tieBeat() {
    const b = beat();
    if (!b) return;
    const pb = prevBeat();
    if (!pb || !pb.notes.length) return;
    for (const pn of pb.notes) {
      let n = b.notes.find(x => x.string === pn.string);
      if (!n) { n = new alphaTab.model.Note(); n.string = pn.string; n.fret = pn.fret; b.addNote(n); }
      n.isTieDestination = true;
    }
    b.isEmpty = false;
    applyEdit(true);
  }

  // GP: Hammer On / Pull Off (H) — set on the current note; finish() links it to the
  // next note on the same string (and clears it if there is none). Toggles off.
  function hammerPull() {
    const b = beat();
    if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string));
    if (!n) return;
    n.isHammerPullOrigin = !n.isHammerPullOrigin;
    applyEdit(true);
  }

  // GP: Legato Slide (S) — slide from the current note to the next on the same string.
  function slideNote(shiftSlide) {
    const b = beat();
    if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string));
    if (!n) return;
    const SO = (alphaTab.model && alphaTab.model.SlideOutType) || { None: 0, Shift: 1, Legato: 2 };
    const want = shiftSlide ? SO.Shift : SO.Legato;
    n.slideOutType = (n.slideOutType === want) ? SO.None : want;
    applyEdit(true);
  }

  // Apply a mutation to the current string's note (if any), then re-render.
  function withCurNote(fn) {
    const b = beat();
    if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string));
    if (!n) return;
    fn(n);
    applyEdit(true);
  }
  // GP: Ghost Note (O), Staccato (!), Accent (;) / Heavy Accent (:),
  //     Natural Harmonic (Y), Left-Hand Vibrato (V).
  function ghostNote() { withCurNote(n => { n.isGhost = !n.isGhost; }); }
  function staccato()  { withCurNote(n => { n.isStaccato = !n.isStaccato; }); }
  function accent(heavy) {
    const AC = (alphaTab.model && alphaTab.model.AccentuationType) || { None: 0, Normal: 1, Heavy: 2 };
    const want = heavy ? AC.Heavy : AC.Normal;
    withCurNote(n => { n.accentuated = (n.accentuated === want) ? AC.None : want; });
  }
  // GP: Harmonics — Natural (Y), Artificial (⌥Y), Pinch. Toggles the given type.
  function setHarmonic(type) {
    const HT = (alphaTab.model && alphaTab.model.HarmonicType) || { None: 0, Natural: 1, Artificial: 2, Pinch: 3 };
    const want = (HT[type] != null) ? HT[type] : HT.Natural;
    withCurNote(n => {
      const on = n.harmonicType === want;
      n.harmonicType = on ? HT.None : want;
      if (!on && !n.harmonicValue) n.harmonicValue = 12;
    });
  }
  function naturalHarmonic() { setHarmonic('Natural'); }
  function artificialHarmonic() { setHarmonic('Artificial'); }
  function pinchHarmonic() { setHarmonic('Pinch'); }
  // GP: Pick slide down/up — note-level slide-out (PickSlideDown / PickSlideUp).
  function pickSlide(up) {
    const b = beat(); if (!b) return;
    const n = b.notes.find(x => x.string === rowToStringNo(cur.string)); if (!n) return;
    const SO = (alphaTab.model && alphaTab.model.SlideOutType) || { None: 0 };
    const want = up ? SO.PickSlideUp : SO.PickSlideDown;
    if (want == null) return;
    n.slideOutType = (n.slideOutType === want) ? (SO.None != null ? SO.None : 0) : want;
    applyEdit(true);
  }
  function vibratoNote() {
    const VT = (alphaTab.model && alphaTab.model.VibratoType) || { None: 0, Slight: 1 };
    withCurNote(n => { n.vibrato = (n.vibrato === VT.Slight) ? VT.None : VT.Slight; });
  }
  // GP: Move note one semitone (⌥⇧↑/↓) or an octave (⌥↑/↓) — shifts the fret.
  function transposeNote(semitones) {
    withCurNote(n => { if (typeof n.fret === 'number') n.fret = Math.max(0, Math.min(36, n.fret + semitones)); });
    previewBeat();
  }

  // ---- P2 expressive effects (notation; MIDI plain for now) ------------------
  // GP: Brush Up/Down (⌘U/⌘D) + Arpeggio Up/Down (⇧⌘U/⇧⌘D) — beat-level strum.
  function setBrush(kind) {
    const b = beat(); if (!b) return;
    const BT = (alphaTab.model && alphaTab.model.BrushType) || { None: 0, BrushUp: 1, BrushDown: 2, ArpeggioUp: 3, ArpeggioDown: 4 };
    const map = { up: BT.BrushUp, down: BT.BrushDown, arpup: BT.ArpeggioUp, arpdown: BT.ArpeggioDown };
    const want = map[kind]; if (want == null) return;
    b.brushType = (b.brushType === want) ? BT.None : want;
    applyEdit(true);
  }
  // GP: Pick Stroke Up/Down (⇧U/⇧D) — beat-level.
  function setPickStroke(up) {
    const b = beat(); if (!b) return;
    const PS = (alphaTab.model && alphaTab.model.PickStroke) || { None: 0, Up: 1, Down: 2 };
    const want = up ? PS.Up : PS.Down;
    b.pickStroke = (b.pickStroke === want) ? PS.None : want;
    applyEdit(true);
  }
  // GP: Wide Vibrato (⌥W) — note-level; distinct from slight vibrato (V).
  function wideVibrato() {
    const VT = (alphaTab.model && alphaTab.model.VibratoType) || { None: 0, Slight: 1, Wide: 2 };
    withCurNote(n => { n.vibrato = (n.vibrato === VT.Wide) ? VT.None : VT.Wide; });
  }
  // GP: Tremolo Picking (") — beat-level rapid repick; speed is a Duration (16th).
  function tremoloPicking() {
    const b = beat(); if (!b) return;
    const D = (alphaTab.model && alphaTab.model.Duration) || {};
    const fast = (D.Sixteenth != null) ? D.Sixteenth : 16;
    const on = (b.tremoloSpeed != null && b.tremoloSpeed !== -1);
    b.tremoloSpeed = on ? null : fast;
    applyEdit(true);
  }
  // GP: Trill (N) — note trills to an adjacent fret; toggles off.
  function trillNote() {
    const D = (alphaTab.model && alphaTab.model.Duration) || {};
    const spd = (D.Sixteenth != null) ? D.Sixteenth : 16;
    withCurNote(n => {
      if (n.isTrill) { n.trillValue = -1; }
      else { n.trillValue = (typeof n.fret === 'number' ? n.fret : 0) + 2; n.trillSpeed = spd; }
    });
  }
  // GP: Grace note — before-beat (G) or on-beat (⌥G); beat-level type, toggles off.
  function graceNote(onBeat) {
    const b = beat(); if (!b) return;
    const GT = (alphaTab.model && alphaTab.model.GraceType) || { None: 0, OnBeat: 1, BeforeBeat: 2 };
    const want = onBeat ? GT.OnBeat : GT.BeforeBeat;
    b.graceType = (b.graceType === want) ? GT.None : want;
    applyEdit(true);
  }
  // GP: Slap ($) / Pop — bass technique, beat-level booleans.
  function slapBeat() { const b = beat(); if (!b) return; b.slap = !b.slap; applyEdit(true); }
  function popBeat() { const b = beat(); if (!b) return; b.pop = !b.pop; applyEdit(true); }
  // GP: Fade In (<) / Fade Out (>) / Volume Swell (⌥<) — beat-level.
  function setFade(kind) {
    const b = beat(); if (!b) return;
    const FT = alphaTab.model && alphaTab.model.FadeType;
    if (FT) {
      const map = { in: FT.FadeIn, out: FT.FadeOut, swell: FT.VolumeSwell };
      const want = map[kind]; if (want == null) return;
      b.fade = (b.fade === want) ? FT.None : want;
    } else {
      b.fadeIn = !b.fadeIn; // legacy bundle: only fade-in supported
    }
    applyEdit(true);
  }

  // GP: Tremolo / whammy bar (⌥V) — beat-level dip-and-return; toggles off.
  function tremoloBar() {
    const b = beat(); if (!b) return;
    const WT = (alphaTab.model && alphaTab.model.WhammyType) || { None: 0, Dip: 3 };
    const none = (WT.None != null) ? WT.None : 0;
    const dip = (WT.Dip != null) ? WT.Dip : 3;
    const on = (b.whammyBarType != null && b.whammyBarType !== none);
    if (on) { b.whammyBarType = none; b.whammyBarPoints = []; }
    else {
      b.whammyBarType = dip;
      const BP = alphaTab.model && alphaTab.model.BendPoint;
      b.whammyBarPoints = BP ? [new BP(0, 0), new BP(15, -4), new BP(30, 0)] : [];
    }
    applyEdit(true);
  }
  // GP: Bend (B) — note-level. Applies a preset bend shape (alphaTab BendType + points;
  // value units are 1/4 tones, 4 = whole step). rebuildSequence emits the pitch-bend.
  function setBend(kind) {
    const BT = (alphaTab.model && alphaTab.model.BendType) || { None: 0, Bend: 2, BendRelease: 4, Prebend: 6, PrebendRelease: 8 };
    const BP = alphaTab.model && alphaTab.model.BendPoint;
    withCurNote(n => {
      if (kind === 'none' || !BP) { n.bendType = BT.None; n.bendPoints = []; return; }
      const mk = (o, v) => new BP(o, v);
      let type = BT.Bend, pts = [];
      switch (kind) {
        case 'half':           type = BT.Bend;           pts = [mk(0, 0), mk(60, 2)]; break;            // ½ step up
        case 'full':           type = BT.Bend;           pts = [mk(0, 0), mk(60, 4)]; break;            // whole step up
        case 'fullrelease':    type = BT.BendRelease;    pts = [mk(0, 0), mk(30, 4), mk(60, 0)]; break; // up then back
        case 'prebend':        type = BT.Prebend;        pts = [mk(0, 4), mk(60, 4)]; break;            // start bent, hold
        case 'prebendrelease': type = BT.PrebendRelease; pts = [mk(0, 4), mk(60, 0)]; break;            // start bent, release
        default:               type = BT.Bend;           pts = [mk(0, 0), mk(60, 4)]; break;
      }
      n.bendType = type; n.bendPoints = pts;
    });
  }
  // GP: Wah pedal — open (⌥O) / closed (⌥C); beat-level. Re-applying clears it.
  function setWah(closed) {
    const b = beat(); if (!b) return;
    const WP = (alphaTab.model && alphaTab.model.WahPedal) || { None: 0, Open: 1, Closed: 2 };
    const want = closed ? WP.Closed : WP.Open;
    b.wahPedal = (b.wahPedal === want) ? WP.None : want;
    applyEdit(true);
  }
  // GP: Rasgueado (⇧R) — flamenco strum technique; beat-level. Toggles off.
  function rasgueadoBeat() {
    const b = beat(); if (!b) return;
    const RG = (alphaTab.model && alphaTab.model.Rasgueado) || { None: 0, Ii: 1 };
    const want = (RG.Ii != null) ? RG.Ii : 1;
    const none = (RG.None != null) ? RG.None : 0;
    b.rasgueado = (b.rasgueado === want) ? none : want;
    applyEdit(true);
  }
  // GP: Left-hand tapping ( ( ) — note-level boolean.
  function leftHandTap() { withCurNote(n => { n.isLeftHandTapped = !n.isLeftHandTapped; }); }
  // GP: Tapping ( ) ) — right-hand tap, beat-level boolean.
  function tapBeat() { const b = beat(); if (!b) return; b.tap = !b.tap; applyEdit(true); }

  // GP: Dynamics (ppp..fff) — beat-level loudness; mapped to MIDI velocity by
  // rebuildSequence (dynamicsToVelocity). Re-applying the same value clears it.
  function setDynamics(name) {
    const b = beat(); if (!b) return;
    const DY = alphaTab.model && alphaTab.model.Dynamics;
    if (!DY) return;
    const want = DY[String(name).toUpperCase()];
    if (want == null) return;
    b.dynamics = want; // dynamics has no "none" state; always set the chosen level
    applyEdit(true);
  }

  // GP: Crescendo (<) / Diminuendo (>) — beat-level hairpin marking. Toggles off.
  // (Notation marking; a velocity ramp across the hairpin span is a follow-up.)
  function setCrescendo(kind) {
    const b = beat(); if (!b) return;
    const CT = alphaTab.model && alphaTab.model.CrescendoType;
    if (!CT) return;
    const want = (kind === 'dim') ? CT.Decrescendo : CT.Crescendo;
    const none = (CT.None != null) ? CT.None : 0;
    b.crescendo = (b.crescendo === want) ? none : want;
    applyEdit(true);
  }

  // GP: Octave / clef line (8va/8vb/15ma/15mb) — beat-level ottava. rebuildSequence
  // shifts the MIDI octave to match the displayed line. Toggles off.
  function setOttava(kind) {
    const b = beat(); if (!b) return;
    const OT = alphaTab.model && alphaTab.model.Ottava;
    if (!OT) return;
    const map = { '8va': OT.Va8, '8vb': OT.Vb8, '15ma': OT.Ma15, '15mb': OT.Mb15 };
    const want = map[kind];
    if (want == null) return;
    const none = (OT.Regular != null) ? OT.Regular : 0;
    b.ottava = (b.ottava === want) ? none : want;
    applyEdit(true);
  }

  // GP: Lyrics — set/clear the current beat's lyric syllable (blank clears).
  function setLyrics(text) {
    const b = beat(); if (!b) return;
    text = (text == null) ? '' : String(text).trim();
    b.lyrics = text ? [text] : null;
    applyEdit(true);
  }
  function getLyrics() { const b = beat(); return (b && b.lyrics && b.lyrics[0]) ? b.lyrics[0] : ''; }

  // Tools → Transpose: shift pitches by N semitones. scope 'track' = the whole current
  // track, otherwise just the current beat. Tab tracks shift the fret (keeping the
  // string); percussion staves are skipped. Clamps fret to 0..36.
  function transpose(semitones, scope) {
    semitones = semitones | 0;
    if (!semitones) return;
    const t = track(); if (!t) return;
    const shift = (n) => { if (typeof n.fret === 'number') n.fret = Math.max(0, Math.min(36, n.fret + semitones)); };
    if (scope === 'track') {
      for (const st of t.staves) {
        if (st.isPercussion) continue;
        for (const bar of st.bars)
          for (const v of bar.voices)
            for (const bt of v.beats)
              for (const n of bt.notes) shift(n);
      }
    } else {
      const b = beat(); if (!b) return;
      for (const n of b.notes) shift(n);
    }
    applyEdit(true);
  }

  // GP: Rest (R) — clear the beat's notes so it renders/plays as a rest (keeps its duration).
  function makeRest() {
    const b = beat();
    if (!b) return;
    while (b.notes.length) b.removeNote(b.notes[0]);
    b.isEmpty = false; // isRest = isEmpty || notes.length===0; keep it a real (timed) rest
    applyEdit(true);
  }

  // GP: Text (T) — set or clear a text annotation on the current beat.
  function setBeatText(text) {
    const b = beat();
    if (!b) return;
    b.text = (text == null || String(text).trim() === '') ? null : String(text);
    applyEdit(true);
  }
  function getBeatText() { const b = beat(); return (b && b.text) ? b.text : ''; }

  // GP: Chord (A) — attach a named chord (with an optional fret diagram) to the
  // current beat. Stored in the staff's chord map and referenced by beat.chordId.
  function setBeatChord(name, frets) {
    const b = beat(), s = staff();
    if (!b || !s) return;
    name = String(name == null ? '' : name).trim();
    const hasFrets = Array.isArray(frets) && frets.length > 0;
    if (!name && !hasFrets) { b.chordId = null; applyEdit(true); return; } // clear
    const Chord = alphaTab.model && alphaTab.model.Chord;
    if (!Chord) return;
    const ch = new Chord();
    ch.name = name || 'Chord';
    ch.showName = true;
    if (hasFrets) {
      ch.strings = frets.slice();          // fret per string (alphaTab order); -1 = muted/unplayed
      ch.showDiagram = true;
      const pos = frets.filter(f => f > 0);
      ch.firstFret = pos.length ? Math.max(1, Math.min.apply(null, pos)) : 1;
    } else {
      ch.showDiagram = false;
    }
    const id = 'gx-' + ch.name + '-' + (hasFrets ? frets.join('.') : 'n');
    try { s.addChord(id, ch); } catch (e) { nlog('addChord: ' + e); return; }
    b.chordId = id;
    applyEdit(true);
  }
  function getBeatChord() {
    const b = beat(), s = staff();
    if (!b || !s || !b.chordId || !s.chords || !s.chords.get) return null;
    const ch = s.chords.get(b.chordId);
    return ch ? { name: ch.name || '', frets: (ch.strings || []).slice() } : null;
  }

  // ---- inspector / song meta edits (right panel is now live, not mocked) ------
  // Rename the current track. Light commit: re-render (track name shows in the
  // score header) + rebuild + snapshot, no structural finish() needed.
  function setTrackName(name) {
    const t = track();
    if (!t) return;
    t.name = String(name == null ? '' : name);
    api.renderTracks(window.gomidasGetRenderedTracks());  // track label is drawn in the score
    markDirty();
    scheduleHeavy();
  }
  // Change the current track's MIDI sound (GM program); rebuild so playback updates.
  function setTrackProgram(program) {
    const t = track();
    if (!t || !t.playbackInfo) return;
    t.playbackInfo.program = program | 0;
    markDirty();
    scheduleHeavy();
    if (window.gomidasApplyMixer) window.gomidasApplyMixer();
    previewBeat();
  }
  // Toggle standard-notation / tablature staves for the current track (keep ≥1 on).
  function toggleNotation(which) {
    const s = staff();
    if (!s) return;
    if (which === 'score') {
      if (s.showStandardNotation && !s.showTablature) return; // keep at least one
      s.showStandardNotation = !s.showStandardNotation;
    } else {
      if (s.showTablature && !s.showStandardNotation) return;
      s.showTablature = !s.showTablature;
    }
    markDirty();
    applyEdit(true); // re-render the staves
  }
  // Re-tune the current track from a preset (array of MIDI note numbers, high→low,
  // matching GP/alphaTab string order). Frets are kept (pitches shift), GP-style.
  function setTuningPreset(midis) {
    const s = staff();
    if (!s || !Array.isArray(midis) || !midis.length) return;
    try {
      if (s.stringTuning && Array.isArray(s.stringTuning.tunings)) {
        // Mutate in place (keeps string count + note→string links intact, GP-style).
        s.stringTuning.tunings = midis.slice();
      } else {
        const T = alphaTab.model.Tuning;
        s.stringTuning = new T('Custom', midis.slice(), false);
      }
    } catch (e) { nlog('setTuning: ' + e); return; }
    markDirty();
    applyEdit(true);
  }
  function setSongTitle(title) {
    if (!api || !api.score) return;
    api.score.title = String(title == null ? '' : title);
    api.renderTracks(window.gomidasGetRenderedTracks());  // title is drawn at the top of the score
    markDirty();
    scheduleHeavy();
  }
  function setSongTempo(bpm) {
    if (!api || !api.score) return;
    bpm = Math.max(20, Math.min(400, bpm | 0));
    // Score.tempo is read-only in alphaTab; the master-bar tempo automation is the
    // model home for it. Set whatever sticks (for persistence), but the native clock
    // is what actually drives playback.
    try { api.score.tempo = bpm; } catch (e) {
      try {
        const mb = api.score.masterBars && api.score.masterBars[0];
        if (mb && mb.tempoAutomation) mb.tempoAutomation.value = bpm;
      } catch (e2) {}
    }
    if (A()) A().setTempo(bpm);
    const tf = document.getElementById('tempo'); if (tf) tf.value = String(bpm);
    markDirty();
    scheduleHeavy();
  }
  // Coalesced rebuild+snapshot without a re-render (caller already rendered).
  function scheduleHeavy() {
    if (_undoBase === null) _undoBase = currentSnap;
    clearTimeout(_heavyTimer);
    _heavyTimer = setTimeout(_commitHeavy, 180);
  }

  // Snapshot for the visual UI (fretboard + duration toolbar).
  // Track accent color: prefer the GP-authored color, else a stable palette by index.
  const TRACK_PALETTE = ['#e08a6e', '#6ec6e0', '#9ad06e', '#e0cf6e', '#c98ae0',
                         '#e06e9a', '#6e9ae0', '#e0a96e', '#7ad0b0', '#d07a7a'];
  function trackColor(t, i) {
    // GP-style fixed scheme by kind (matches the timeline in the reference design):
    // drums/percussion = purple, bass = blue, guitar = orange; others keep their file
    // colour or cycle the palette.
    const st = t && t.staves && t.staves[0];
    if (st && st.isPercussion) return '#7b5cff';
    const name = ((t && t.name) || '').toLowerCase();
    if (/\bbass\b/.test(name)) return '#3a6ad0';
    if (/guitar|gtr|guit/.test(name)) return '#d4673e';
    const c = t && t.color;
    if (c && typeof c.r === 'number') return 'rgb(' + (c.r | 0) + ',' + (c.g | 0) + ',' + (c.b | 0) + ')';
    return TRACK_PALETTE[i % TRACK_PALETTE.length];
  }
  // Per-master-bar "does this track have any sounding note in this bar?" (for the bar-block timeline).
  function trackBarFill(t) {
    const st = t && t.staves && t.staves[0];
    const n = api.score.masterBars.length;
    const out = new Array(n).fill(false);
    if (!st) return out;
    for (let bi = 0; bi < n && bi < st.bars.length; bi++) {
      const bar = st.bars[bi];
      if (!bar) continue;
      for (const v of bar.voices) {
        if (v.beats && v.beats.some(be => !be.isRest && be.notes && be.notes.length)) { out[bi] = true; break; }
      }
    }
    return out;
  }
  // GP-style bar-fill classification per bar (across ALL voices): 'under' (beats occupy
  // less than the time signature), 'exact' (exactly full), or 'over' (overfilled).
  function trackBarFillClass(t) {
    const st = t && t.staves && t.staves[0];
    const n = api.score.masterBars.length;
    const out = new Array(n).fill('under');
    if (!st) return out;
    for (let bi = 0; bi < n && bi < st.bars.length; bi++) {
      const bar = st.bars[bi];
      if (!bar) continue;
      let maxFill = 0;
      for (const v of bar.voices) {
        const f = (v.beats || []).reduce((s, be) => s + beatTicksOf(be), 0);
        if (f > maxFill) maxFill = f;
      }
      const cap = barCapacityTicks(bi);
      out[bi] = (maxFill > cap + 1) ? 'over' : (maxFill >= cap - 1 ? 'exact' : 'under');
    }
    return out;
  }

  function getState() {
    if (!api || !api.score) return null;
    const s = staff();
    const b = beat();
    const tuning = (s && s.tuning && s.tuning.length) ? s.tuning.slice() : [64, 59, 55, 50, 45, 40];
    const notes = {};
    if (b) for (const n of b.notes) notes[stringNoToRow(n.string)] = n.fret; // row(0=top) -> fret
    // Drum palette state (only meaningful on a percussion track).
    const isPercussion = !!(s && s.isPercussion);
    let drums = null;
    if (isPercussion) {
      const t = track();
      drums = DRUM_KIT.map(d => {
        const index = drumArtIndex(t, d.midi);
        const active = !!(b && index >= 0 && b.notes.some(n => (n.percussionArticulation | 0) === index));
        return { name: d.name, midi: d.midi, index, active };
      }).filter(d => d.index >= 0);
    }
    return {
      isPercussion, drums,
      tuning, tuningNames: tuning.map(midiToName), stringCount: tuning.length,
      curString: cur.string, notes,
      duration: b ? b.duration : 4, dots: b ? (b.dots || 0) : 0,
      triplet: b ? (b.tupletNumerator === 3 && b.tupletDenominator === 2) : false,
      palmMute: b ? b.notes.some(n => n.isPalmMute) : false,
      deadNote: b ? b.notes.some(n => n.isDead) : false,
      letRing: b ? b.notes.some(n => n.isLetRing) : false,
      tie: b ? b.notes.some(n => n.isTieDestination) : false,
      hammerPull: b ? b.notes.some(n => n.isHammerPullOrigin) : false,
      slide: b ? b.notes.some(n => n.slideOutType && n.slideOutType !== 0) : false,
      ghost: b ? b.notes.some(n => n.isGhost) : false,
      staccato: b ? b.notes.some(n => n.isStaccato) : false,
      accent: b ? b.notes.some(n => n.accentuated === 1) : false,
      heavyAccent: b ? b.notes.some(n => n.accentuated === 2) : false,
      harmonic: b ? b.notes.some(n => n.harmonicType && n.harmonicType !== 0) : false,
      vibrato: b ? b.notes.some(n => n.vibrato && n.vibrato !== 0) : false,
      isRest: b ? b.isRest : false,
      isPlaying, trackName: track() ? (track().name || 'Track') : '',
      pos: `bar ${cur.bar + 1} · beat ${cur.beat + 1}`,
      curBar: cur.bar,
      timeSigNum: (function () { const mb = api.score.masterBars[cur.bar]; return mb ? (mb.timeSignatureNumerator || 4) : 4; })(),
      timeSigDen: (function () { const mb = api.score.masterBars[cur.bar]; return mb ? (mb.timeSignatureDenominator || 4) : 4; })(),
      keySig: (function () { const mb = api.score.masterBars[cur.bar]; return mb ? (mb.keySignature | 0) : 0; })(),
      keySigMinor: (function () { const mb = api.score.masterBars[cur.bar]; const KST = (alphaTab.model && alphaTab.model.KeySignatureType) || { Minor: 1 }; return !!(mb && mb.keySignatureType === KST.Minor); })(),
      // ---- panel data (transport / inspector / track list) ----
      title: api.score.title || 'Untitled',
      artist: api.score.artist || '',
      // #tempo field is kept in sync with the engine + loads; preferred over the
      // (sometimes read-only) score.tempo so the SONG tab reflects live changes.
      songTempo: (function () { const tf = document.getElementById('tempo'); const v = tf && parseInt(tf.value, 10); return (v >= 20 && v <= 400) ? v : (api.score.tempo || 120); })(),
      curTrackIndex: cur.track,
      curVoice: cur.voice,
      voiceCount: (bar() ? bar().voices.length : 1),
      trackProgram: (track() && track().playbackInfo) ? (track().playbackInfo.program | 0) : 0,
      trackPan: (function () {
        const f = (window.gomidasTrackFlags || {})[cur.track] || {};
        if (typeof f.pan === 'number') return f.pan;
        const pb = track() && track().playbackInfo;
        return (pb && pb.balance != null) ? Math.max(0, Math.min(1, pb.balance / 16)) : 0.5;
      })(),
      showStandard: !!(s && s.showStandardNotation),
      showTab: !!(s && s.showTablature),
      barCount: api.score.masterBars.length,
      allTracks: api.score.tracks.map((t, i) => ({
        index: i,
        name: t.name || ('Track ' + (i + 1)),
        shortName: t.shortName || '',
        isPercussion: !!(t.staves[0] && t.staves[0].isPercussion),
        program: (t.playbackInfo ? t.playbackInfo.program | 0 : 0),
        volume: (t.playbackInfo && t.playbackInfo.volume != null) ? (t.playbackInfo.volume / 16) : 0.75,
        color: trackColor(t, i),
        bars: trackBarFill(t),
        barsFill: trackBarFillClass(t),
        current: i === cur.track
      })),
      curBarFill: (function () { const cls = trackBarFillClass(track()); return cls[cur.bar] || 'under'; })()
    };
  }

  // ---- transport -------------------------------------------------------------
  // ---- count-in --------------------------------------------------------------
  let countInOn = false, countInRunning = false, countInTimers = [];
  let countInBars = 1; // GP-style count-in length (1 or 2 bars)
  function setCountIn(on) { countInOn = !!on; }
  function toggleCountIn() { countInOn = !countInOn; return countInOn; }
  function isCountIn() { return countInOn; }
  function setCountInBars(n) { countInBars = (n === 2) ? 2 : 1; return countInBars; }
  function getCountInBars() { return countInBars; }
  function cancelCountIn() { countInRunning = false; countInTimers.forEach(clearTimeout); countInTimers = []; hideCountdownOverlay(); }

  // Big centered count-down number over the score during the count-in.
  let countdownEl = null;
  function countdownOverlay() {
    if (!countdownEl) {
      countdownEl = document.createElement('div');
      countdownEl.id = 'countdown-ov';
      const host = document.getElementById('at-wrap') || document.body;
      host.appendChild(countdownEl);
    }
    return countdownEl;
  }
  function showCountdownNumber(n) {
    const el = countdownOverlay();
    el.textContent = String(n);
    el.classList.remove('pulse');
    void el.offsetWidth;      // restart the CSS pulse animation
    el.style.display = 'flex';
    el.classList.add('pulse');
  }
  function hideCountdownOverlay() { if (countdownEl) { countdownEl.style.display = 'none'; countdownEl.classList.remove('pulse'); } }
  // Reflect a forced stop (e.g. Panic) in the UI without sending another transport msg.
  function notifyStopped() {
    cancelCountIn(); commitPlayPositionToCursor(); isPlaying = false; refreshCursor();
    if (_lanePlay) _lanePlay.style.display = 'none';
  }

  function startPlayback() {
    countInRunning = false;
    isPlaying = true; lastPlayBeat = null;
    if (window.gomidasSeekToCursor) window.gomidasSeekToCursor(cur.track, cur.bar, cur.voice, cur.beat);
    A().play();
    if (window.GomidasUI) window.GomidasUI.refresh(getState());
  }

  // One bar of wood-block clicks at the playback tempo, then start. Clicks go through
  // the editor preview path on a free melodic channel; pressing play again aborts it.
  function playWithCountIn() {
    cancelCountIn();
    countInRunning = true;
    const mb = api.score.masterBars[Math.min(cur.bar, api.score.masterBars.length - 1)] || api.score.masterBars[0];
    const num = mb ? (mb.timeSignatureNumerator || 4) : 4;
    const den = mb ? (mb.timeSignatureDenominator || 4) : 4;
    const tf = document.getElementById('tempo');
    const bpm = (tf && parseInt(tf.value, 10)) || 120;
    const ss = document.getElementById('speed-select');
    const rate = (ss && parseFloat(ss.value)) || 1;
    const unitMs = Math.max(80, (60000 / bpm) * (4 / den) / rate);
    let ch = 15;
    if (window.gomidasFreeClickChannel) { const c = window.gomidasFreeClickChannel(); if (c >= 0) ch = c; }
    const totalBeats = num * Math.max(1, countInBars);
    let i = 0;
    const step = () => {
      if (!countInRunning) return;
      const beatInBar = i % num;
      if (A()) A().preview(ch, 115, false, [(beatInBar === 0) ? 84 : 72]);
      // Visual count: count up within each bar (1..num), GP-style.
      showCountdownNumber(beatInBar + 1);
      i++;
      const next = (i < totalBeats) ? step : () => { hideCountdownOverlay(); if (countInRunning) startPlayback(); };
      countInTimers.push(setTimeout(next, unitMs));
    };
    step();
  }

  // Single-cursor model: there is one cursor. During playback it follows the transport
  // (onPlayTick moves it); when playback stops it stays where it landed by writing the
  // play position back into `cur`. So Play always starts from the cursor, and stopping
  // mid-song then pressing Play again naturally resumes from there.
  function commitPlayPositionToCursor() {
    const b = lastPlayBeat;
    if (!b) return;
    const v = b.voice, bar = v && v.bar, st = bar && bar.staff, tk = st && st.track;
    if (!v || !bar || !tk) return;
    cur.track = tk.index | 0; cur.bar = bar.index | 0; cur.voice = v.index | 0; cur.beat = b.index | 0;
    clampString();
  }

  function togglePlay() {
    if (window.gomidasStopGroovePreview) window.gomidasStopGroovePreview(); // stop any groove audition
    flushHeavy(); // make sure native has the latest edited MIDI before playing
    if (countInRunning) { cancelCountIn(); return; }     // pressing play during count-in aborts it
    if (!isPlaying && countInOn) { playWithCountIn(); return; }
    isPlaying = !isPlaying;
    if (isPlaying) {
      lastPlayBeat = null;
      if (window.gomidasSeekToCursor) window.gomidasSeekToCursor(cur.track, cur.bar, cur.voice, cur.beat);
    } else {
      commitPlayPositionToCursor();   // single cursor: land where playback stopped
      refreshCursor();
    }
    if (isPlaying) A().play(); else A().stop();
  }

  // ---- cursors (overlays inside #at) -----------------------------------------
  let editCursorEl = null, playCursorEl = null, stringCursorEl = null;
  function ensureOverlays() {
    const at = document.getElementById('at');
    if (!editCursorEl) {
      editCursorEl = document.createElement('div');
      editCursorEl.id = 'edit-cursor';
      at.appendChild(editCursorEl);
    }
    if (!stringCursorEl) {
      stringCursorEl = document.createElement('div');
      stringCursorEl.id = 'string-cursor';
      at.appendChild(stringCursorEl);
    }
    if (!playCursorEl) {
      playCursorEl = document.createElement('div');
      playCursorEl.id = 'play-cursor';
      at.appendChild(playCursorEl);
    }
  }

  // Offset of alphaTab's render surface within #at (its padding box).
  function surfaceOffset() {
    const surf = document.querySelector('#at .at-surface');
    return surf ? { x: surf.offsetLeft, y: surf.offsetTop } : { x: 0, y: 0 };
  }

  // A beat's column spanning ALL its staves (notation + tab) for the current track,
  // in #at coordinates. findBeats returns one BeatBounds per staff.
  function beatColumn(b) {
    const bl = api.boundsLookup;
    if (!bl || !b) return null;
    let list = null;
    try { list = bl.findBeats(b); } catch (e) {}
    if (!list || !list.length) { const one = bl.findBeat(b); if (one) list = [one]; }
    if (!list || !list.length) return null;
    let minY = Infinity, maxY = -Infinity, x = null, w = 0;
    for (const bb of list) {
      const v = bb.visualBounds;
      if (v.y < minY) minY = v.y;
      if (v.y + v.h > maxY) maxY = v.y + v.h;
      if (x === null) { x = v.x; w = v.w; }
    }
    const off = surfaceOffset();
    return { x: off.x + x, y: off.y + minY, w: Math.max(6, w), h: maxY - minY };
  }

  // Rect of the current string's cell on the tab staff for the current beat.
  function stringCellRect(b) {
    const bl = api.boundsLookup;
    const s = staff();
    if (!bl || !b || !s || !s.showTablature) return null;
    let all = null;
    try { all = bl.findBeats(b); } catch (e) {}
    if (!all || !all.length) return null;
    let tab = all[0];
    for (const bb of all) if (bb.barBounds.realBounds.y > tab.barBounds.realBounds.y) tab = bb;
    const r = tab.barBounds.realBounds, vb = tab.visualBounds;
    const sc = stringCount();
    const spacing = r.h / Math.max(1, sc - 1);
    const off = surfaceOffset();
    return { x: off.x + vb.x - 2, y: off.y + r.y + cur.string * spacing - spacing / 2,
             w: Math.max(8, vb.w) + 4, h: spacing };
  }

  function refreshCursor() {
    ensureOverlays();
    const col = beatColumn(beat());
    if (col) {
      editCursorEl.style.display = 'block';
      editCursorEl.style.left = col.x + 'px';
      editCursorEl.style.top = col.y + 'px';
      editCursorEl.style.width = col.w + 'px';
      editCursorEl.style.height = col.h + 'px';
    } else {
      editCursorEl.style.display = 'none';
    }
    const cell = stringCellRect(beat());
    if (cell) {
      stringCursorEl.style.display = 'block';
      stringCursorEl.style.left = cell.x + 'px';
      stringCursorEl.style.top = cell.y + 'px';
      stringCursorEl.style.width = cell.w + 'px';
      stringCursorEl.style.height = cell.h + 'px';
    } else {
      stringCursorEl.style.display = 'none';
    }
    renderSelection();
    autoScrollToEditCursor();
    const st = document.getElementById('status');
    if (st) {
      const fc = (function () { try { return trackBarFillClass(track())[cur.bar]; } catch (e) { return 'under'; } })();
      st.textContent = `${track() ? track().name : ''} · bar ${cur.bar + 1} · beat ${cur.beat + 1} · string ${cur.string + 1}`
        + (cur.voice > 0 ? ` · voice ${cur.voice + 1}` : '')
        + (fretBuffer ? ` · fret ${fretBuffer}` : '')
        + (fc === 'under' ? ' · ⚠ bar incomplete' : (fc === 'over' ? ' · ⚠ bar overfilled' : ''));
      st.classList.toggle('bar-warn', fc !== 'exact');
    }
    if (window.GomidasUI) window.GomidasUI.refresh(getState());
    updateLaneEditCursor();
  }

  // ---- proportional beat lane (consistent rhythm timeline) -------------------
  // A non-reader's pulse helper, rendered entirely by us on its OWN even time-scale so
  // spacing is perfectly consistent (which the engraved score, being optically spaced,
  // can never be): every 4/4 bar is the same width, beats are evenly spaced, and each note
  // is a block sized by its duration (ties/long notes = long blocks, rests = gaps). Lives
  // in its own strip below the score; doesn't try to column-align with the notation above.
  const LANE_PXQ = 84;          // pixels per quarter note (the whole grid's time scale)
  const LANE_PAD = 14;
  let _laneEdit = null, _lanePlay = null, _laneHookedResize = false;

  function laneWrap() { return document.getElementById('beatlane-wrap'); }
  function laneCanvas() { return document.getElementById('beatlane'); }
  function laneVisible() { return !document.body.classList.contains('hide-beatlane'); }
  function laneAbsX(tick) { return LANE_PAD + (tick / 960) * LANE_PXQ; }   // 960 = PPQ
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function ensureLaneCursors() {
    const w = laneWrap(); if (!w) return;
    if (!_laneEdit) { _laneEdit = document.createElement('div'); _laneEdit.className = 'bl-edit'; w.appendChild(_laneEdit); }
    if (!_lanePlay) { _lanePlay = document.createElement('div'); _lanePlay.className = 'bl-play'; w.appendChild(_lanePlay); }
  }

  // Absolute song tick of the current edit cursor (bars are full time-signature length).
  function laneCurrentTick() {
    const score = api.score; let tk = 0;
    for (let i = 0; i < cur.bar; i++) tk += masterBarTicks(score, i);
    const v = voice(); if (v) for (let j = 0; j < cur.beat && j < v.beats.length; j++) tk += beatTicks(v.beats[j]);
    return tk;
  }

  // Counting syllable for subdivision cell j (0..K-1) of beat `bn`. j===0 is the beat itself.
  function countSyllable(K, j, bn) {
    if (j === 0) return String(bn);
    if (K === 2) return '+';
    if (K === 4) return ['', 'e', '+', 'a'][j];
    if (K === 8) return ['', 'e', '+', 'a', '·', 'e', '+', 'a'][j] || '·';
    if (K === 3) return '·';
    if (K === 6) return j === 3 ? '+' : '·';
    return '·';
  }
  // Adaptive subdivisions-per-beat from the smallest straight value present in the bar.
  function laneBeatK(bar, beatUnit, compound) { return GomidasCore.laneBeatK(bar, beatUnit, compound); }

  // Vertical-layout metrics (shared by render + cursors), derived from the panel height.
  function laneMetrics() {
    const t = track(), st = t && t.staves && t.staves[0];
    const perc = !!(st && st.isPercussion);
    const tuning = (st && st.tuning && st.tuning.length) ? st.tuning : [64, 59, 55, 50, 45, 40];
    const nStr = perc ? 1 : tuning.length;
    const beatY = 15, gridY = 31, gridTop = 38, stringTop = 54, stringGap = 18;
    const stringBot = stringTop + (nStr - 1) * stringGap;
    const gridBot = stringBot + 12;
    return { perc, tuning, nStr, beatY, gridY, gridTop, stringTop, stringGap, stringBot, gridBot };
  }

  function renderBeatLane() {
    ensureLaneCursors();
    const w = laneWrap(), cv = laneCanvas(), gut = document.getElementById('beatlane-gutter');
    if (!w || !cv || !api || !api.score || !laneVisible()) return;
    const score = api.score, t = track(); if (!t) return;
    const st = t.staves && t.staves[0]; if (!st) return;
    const dpr = window.devicePixelRatio || 1;
    const H = w.clientHeight || 184;
    const m = laneMetrics();
    const col = trackColor(t, cur.track);
    let songTicks = 0;
    for (let i = 0; i < score.masterBars.length; i++) songTicks += masterBarTicks(score, i);
    const totalW = Math.max(w.clientWidth, LANE_PAD * 2 + (songTicks / 960) * LANE_PXQ);
    cv.style.width = totalW + 'px'; cv.style.height = H + 'px';
    cv.width = Math.round(totalW * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, totalW, H);
    const vline = (px, top, bot, style, lw) => {
      ctx.strokeStyle = style; ctx.lineWidth = lw || 1;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, top); ctx.lineTo(Math.round(px) + 0.5, bot); ctx.stroke();
    };
    // horizontal string lines across the whole timeline
    ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
    for (let r = 0; r < m.nStr; r++) {
      const y = Math.round(m.stringTop + r * m.stringGap) + 0.5;
      ctx.beginPath(); ctx.moveTo(LANE_PAD, y); ctx.lineTo(totalW - LANE_PAD, y); ctx.stroke();
    }

    let x = LANE_PAD;
    for (let i = 0; i < score.masterBars.length; i++) {
      const bt = masterBarTicks(score, i), bw = (bt / 960) * LANE_PXQ;
      const mb = score.masterBars[i];
      const num = (mb && mb.timeSignatureNumerator) || 4, den = (mb && mb.timeSignatureDenominator) || 4;
      const compound = (den === 8 || den === 16) && num % 3 === 0 && num > 3;
      const beatUnit = compound ? (WHOLE_TICKS * 3 / den) : (WHOLE_TICKS / den);
      const N = compound ? num / 3 : num;
      const K = laneBeatK(st.bars[i], beatUnit, compound);
      vline(x, m.gridTop, m.gridBot, 'rgba(255,255,255,.22)', 1);       // barline
      for (let k = 0; k < N; k++) {
        const bx = x + (k * beatUnit / bt) * bw, down = k === 0;
        ctx.textAlign = 'center';
        for (let j = 0; j < K; j++) {
          const cx = x + ((k + j / K) * beatUnit / bt) * bw;
          if (j > 0) vline(cx, m.gridTop, m.gridBot, 'rgba(255,255,255,.07)', 1);   // subdivision col
          ctx.fillStyle = j === 0 ? '#9aa3b8' : '#5f6675';
          ctx.font = (j === 0 ? '700 ' : '600 ') + (j === 0 ? '11' : '9') + 'px -apple-system,system-ui,sans-serif';
          ctx.fillText(countSyllable(K, j, k + 1), cx, m.gridY);
        }
        vline(bx, m.gridTop, m.gridBot, down ? 'rgba(123,92,255,.85)' : 'rgba(255,255,255,.30)', down ? 2 : 1);
        ctx.fillStyle = down ? '#a78bff' : '#7f8aa3';
        ctx.font = '700 12px -apple-system,system-ui,sans-serif';
        ctx.fillText(String(k + 1), bx, m.beatY);
      }
      // notes: fret number on its string row at its start time, with a duration bar
      const v0 = st.bars[i] && st.bars[i].voices && st.bars[i].voices[0];
      if (v0) {
        let acc = 0;
        for (const be of v0.beats) {
          const d = beatTicks(be);
          if (be.notes && be.notes.length) {
            const nx = x + (acc / bt) * bw, dw = Math.max(4, (d / bt) * bw);
            for (const note of be.notes) {
              const row = m.perc ? 0 : (m.nStr - (note.string | 0));
              if (row < 0 || row >= m.nStr) continue;
              const y = m.stringTop + row * m.stringGap;
              ctx.globalAlpha = 0.28; ctx.fillStyle = col;            // duration bar
              roundRect(ctx, nx, y - 2, dw - 2, 4, 2); ctx.fill(); ctx.globalAlpha = 1;
              ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              if (m.perc) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(nx, y, 4, 0, 7); ctx.fill(); }
              else {
                const fret = String(note.fret | 0);
                ctx.font = '700 12px -apple-system,system-ui,sans-serif';
                ctx.lineWidth = 3; ctx.strokeStyle = '#101015'; ctx.strokeText(fret, nx, y);
                ctx.fillStyle = '#fff'; ctx.fillText(fret, nx, y);
              }
              ctx.textBaseline = 'alphabetic';
            }
          }
          acc += d;
        }
      }
      x += bw;
    }
    vline(x, m.gridTop, m.gridBot, 'rgba(255,255,255,.22)', 1);         // final barline

    // gutter: string letters aligned with the rows (pinned; doesn't scroll)
    if (gut) {
      const GW = gut.clientWidth || 34;
      gut.style.height = H + 'px'; gut.width = Math.round(GW * dpr); gut.height = Math.round(H * dpr);
      const gx = gut.getContext('2d'); gx.setTransform(dpr, 0, 0, dpr, 0, 0); gx.clearRect(0, 0, GW, H);
      gx.fillStyle = '#5f6675'; gx.font = '600 8px -apple-system,system-ui,sans-serif';
      gx.textAlign = 'left'; gx.fillText('BEAT', 3, m.beatY);
      gx.textAlign = 'center'; gx.textBaseline = 'middle';
      for (let r = 0; r < m.nStr; r++) {
        const y = m.stringTop + r * m.stringGap;
        gx.fillStyle = '#cdd3df'; gx.font = '700 11px -apple-system,system-ui,sans-serif';
        gx.fillText(m.perc ? '•' : midiToName(m.tuning[r]), GW / 2, y);
      }
      gx.textBaseline = 'alphabetic';
    }

    const cTop = m.beatY - 11, cH = m.gridBot - cTop;
    _laneEdit.style.top = _lanePlay.style.top = cTop + 'px';
    _laneEdit.style.height = _lanePlay.style.height = cH + 'px';
    updateLaneEditCursor();
    if (!_laneHookedResize) {
      _laneHookedResize = true;
      window.addEventListener('resize', () => { if (laneVisible()) renderBeatLane(); });
      cv.addEventListener('mousedown', laneSeek);
    }
  }

  function updateLaneEditCursor() {
    if (!_laneEdit || !api || !api.score || !laneVisible()) return;
    const v = voice(), be = v && v.beats[cur.beat];
    const d = be ? beatTicks(be) : 960;
    const x = laneAbsX(laneCurrentTick()), wdt = Math.max(6, (d / 960) * LANE_PXQ);
    _laneEdit.style.display = 'block';
    _laneEdit.style.left = x + 'px';
    _laneEdit.style.width = wdt + 'px';
    if (isPlaying) return;                                           // playhead owns scroll while playing
    const w = laneWrap();
    if (w) {                                                          // edge-triggered keep-in-view
      const sl = w.scrollLeft, vw = w.clientWidth, margin = Math.min(120, vw / 3);
      if (x < sl + margin) w.scrollLeft = Math.max(0, x - margin);
      else if (x + wdt > sl + vw - margin) w.scrollLeft = x + wdt - vw + margin;
    }
  }

  function updateLanePlayCursor(tick) {
    if (!_lanePlay || !laneVisible()) return;
    const x = laneAbsX(tick);
    _lanePlay.style.display = 'block';
    _lanePlay.style.left = x + 'px';
    const w = laneWrap();
    if (w) {                                                          // center-lock: keep the
      const maxS = Math.max(0, w.scrollWidth - w.clientWidth);       // playhead centered so the
      w.scrollLeft = Math.max(0, Math.min(maxS, x - w.clientWidth / 2)); // music flows in from the right
    }
  }

  // Click the lane → move the edit cursor to that beat (mirrors clicking the score).
  function laneSeek(e) {
    const cv = laneCanvas(); if (!cv || !api || !api.score) return;
    const rect = cv.getBoundingClientRect();
    const tick = Math.max(0, (e.clientX - rect.left - LANE_PAD) / LANE_PXQ * 960);
    const score = api.score; let acc = 0, bar = 0;
    for (let i = 0; i < score.masterBars.length; i++) {
      const bt = masterBarTicks(score, i);
      if (tick < acc + bt) { bar = i; break; }
      acc += bt; bar = i;
    }
    const into = tick - acc;
    const t = track(), st = t && t.staves && t.staves[0];
    const v = st && st.bars[bar] && (st.bars[bar].voices[cur.voice] || st.bars[bar].voices[0]);
    let bacc = 0, beat = 0;
    if (v) for (let j = 0; j < v.beats.length; j++) {
      const d = beatTicks(v.beats[j]);
      if (into < bacc + d) { beat = j; break; }
      bacc += d; beat = j;
    }
    cur.bar = bar; cur.beat = beat; clampString(); refreshCursor();
  }

  function toggleBeatGrid() {
    const hidden = document.body.classList.toggle('hide-beatlane');
    try { localStorage.setItem('gomidasBeatGrid', hidden ? '0' : '1'); } catch (e) {}
    if (!hidden) renderBeatLane();
    setStatus('Beat lane ' + (hidden ? 'off' : 'on'));
    return !hidden;
  }

  function onPlayTick(tick) {
    updateLanePlayCursor(tick);          // smooth lane play-head (every tick)
    const map = window.gomidasTickMap;
    if (!map || !map.length) return;
    // largest tick <= current
    let lo = 0, hi = map.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (map[mid].tick <= tick) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0) return;
    const b = map[found].beat;
    if (b === lastPlayBeat) return;
    lastPlayBeat = b;
    ensureOverlays();
    // Single cursor: the one cursor follows the transport during playback (no separate
    // green play cursor). The string highlight is hidden while playing.
    const col = beatColumn(b);
    if (!col) { editCursorEl.style.display = 'none'; return; }
    editCursorEl.style.display = 'block';
    editCursorEl.style.left = col.x + 'px';
    editCursorEl.style.top = col.y + 'px';
    editCursorEl.style.width = col.w + 'px';
    editCursorEl.style.height = col.h + 'px';
    stringCursorEl.style.display = 'none';
    if (autoScrollOn) autoScrollToCursor(editCursorEl, true);
  }

  // Keep the play cursor in view while playing (GP-style "page turn"). Only scrolls
  // when the cursor nears an edge, so it doesn't yank on every beat. Uses the
  // already-positioned cursor element's rect, so it's robust to offsetParent quirks.
  let autoScrollOn = true;
  // Edge-triggered scroll to keep a cursor element in view (vertical always;
  // horizontal only in horizontal layouts). Used for both the play and edit cursors.
  function autoScrollToCursor(el, smooth) {
    const wrap = document.getElementById('at-wrap');
    if (!wrap || !el || el.style.display === 'none') return;
    const wrapRect = wrap.getBoundingClientRect();
    const curRect = el.getBoundingClientRect();
    const m = 56; // edge margin
    const behavior = smooth ? 'smooth' : 'auto';
    const relTop = curRect.top - wrapRect.top;
    const relBottom = curRect.bottom - wrapRect.top;
    if (relTop < m || relBottom > wrap.clientHeight - m) {
      const target = wrap.scrollTop + relTop - wrap.clientHeight * 0.4;
      wrap.scrollTo({ top: Math.max(0, target), behavior });
    }
    if (wrap.scrollWidth > wrap.clientWidth + 1) { // horizontal layouts only
      const relLeft = curRect.left - wrapRect.left;
      const relRight = curRect.right - wrapRect.left;
      if (relLeft < m || relRight > wrap.clientWidth - m) {
        const target = wrap.scrollLeft + relLeft - wrap.clientWidth * 0.4;
        wrap.scrollTo({ left: Math.max(0, target), behavior });
      }
    }
  }
  function autoScrollToPlayCursor() { autoScrollToCursor(playCursorEl, true); }
  // Keep the edit cursor in view as you navigate/edit (instant; only when not playing).
  function autoScrollToEditCursor() {
    if (autoScrollOn && !isPlaying) autoScrollToCursor(editCursorEl, false);
  }
  function setAutoScroll(on) { autoScrollOn = !!on; }

  // ---- input -----------------------------------------------------------------
  // Shared key logic — used by the JS keydown listener AND native key forwarding
  // (MainComponent::keyPressed → window.gomidasNativeKey). Returns true if handled.
  function handleKey(k, mods) {
    if (!api || !api.score) return false;
    mods = mods || {};
    const meta = !!mods.meta;    // Command ⌘
    const ctrl = !!mods.ctrl;    // Control ⌃
    const shift = !!mods.shift;
    const alt = !!mods.alt;      // Option ⌥

    // ---- Command (⌘) shortcuts ----
    if (meta) {
      if (alt && (k === 'r' || k === 'R')) { deleteTrack(); return true; } // Delete Track ⌥⌘R
      if (k === 'z' || k === 'Z') { shift ? redo() : undo(); return true; } // Undo / Redo (⇧⌘Z)
      if (k === 'y' || k === 'Y') { redo(); return true; }
      if (k === 'a' || k === 'A') { selectAll(); return true; }     // Select All ⌘A
      if (k === 'c' || k === 'C') { copySelection(); return true; } // Copy ⌘C
      if (k === 'x' || k === 'X') { cutSelection(); return true; }  // Cut ⌘X
      if (k === 'v' || k === 'V') { pasteClipboard(); return true; }// Paste ⌘V
      if (k === '.') { toggleDoubleDot(); return true; }       // Double Dotting ⌘.
      if (k === '+' || k === '=') { addBar(); return true; }    // Insert Bar ⌘+
      if (k === '-' || k === '_') { removeBeat(); return true; }// Delete the Beats ⌘-
      if (k === 'ArrowUp') { moveTrack(-1); return true; }      // Previous Track ⌘↑
      if (k === 'ArrowDown') { moveTrack(1); return true; }     // Next Track ⌘↓
      if (k === 'Home') { moveToScoreEdge(false); return true; }// First Bar ⌘Home
      if (k === 'End') { moveToScoreEdge(true); return true; }  // Last Bar ⌘End
      if (k === 'g' || k === 'G') {
        if (shift) { toggleBeatGrid(); return true; }                       // Toggle Beat Grid ⇧⌘G
        if (window.gomidasOpenGoTo) window.gomidasOpenGoTo(); return true;   // Go To ⌘G
      }
      if (k === 't' || k === 'T') { if (window.gomidasOpenTimeSig) window.gomidasOpenTimeSig(); return true; } // Time Signature ⌘T
      if (k === 'k' || k === 'K') { if (window.gomidasOpenKeySig) window.gomidasOpenKeySig(); return true; }   // Key Signature ⌘K
      if (k === 'u' || k === 'U') { setBrush(shift ? 'arpup' : 'up'); return true; }    // Brush Up ⌘U / Arpeggio Up ⇧⌘U
      if (k === 'd' || k === 'D') { setBrush(shift ? 'arpdown' : 'down'); return true; }// Brush Down ⌘D / Arpeggio Down ⇧⌘D
      if (k === '>') { if (window.gomidasZoom) window.gomidasZoom(1); return true; }    // Zoom In ⌘>
      if (k === '<') { if (window.gomidasZoom) window.gomidasZoom(-1); return true; }   // Zoom Out ⌘<
      if (k === '/') { toggleTripletFeel(); return true; }                              // Triplet Feel ⌘/
      if (k.length === 1 && k >= '1' && k <= '4') { selectVoice(parseInt(k, 10) - 1); return true; } // Voices 1–4 ⌘1–⌘4
      if (k === 'l' || k === 'L') { toggleLoop(); return true; }                        // A/B loop toggle ⌘L
      return false; // leave other ⌘ combos to the system
    }
    // ---- Control (⌃) shortcuts ----
    if (ctrl) {
      if (k === '+' || k === '=') { insertBeatAfter(); return true; } // Insert a Beat ⌃+
      if (k === '-' || k === '_') { deleteBar(); return true; }       // Delete Bar ⌃-
      return false;
    }
    // ---- Option (⌥) shortcuts: note transpose (arrows survive ⌥; letters don't) ----
    if (alt) {
      if (k === 'ArrowUp') { transposeNote(shift ? 1 : 12); return true; }    // ⌥⇧↑ semitone / ⌥↑ octave
      if (k === 'ArrowDown') { transposeNote(shift ? -1 : -12); return true; }// ⌥⇧↓ semitone / ⌥↓ octave
      // ⌥-letter combos are unreliable (the OS eats the letter) — these mirror the
      // Effects menu entries, which are the dependable path.
      if (k === 'v' || k === 'V') { tremoloBar(); return true; }              // ⌥V Tremolo Bar
      if (k === 'o' || k === 'O') { setWah(false); return true; }             // ⌥O Wah Open
      if (k === 'c' || k === 'C') { setWah(true); return true; }              // ⌥C Wah Closed
      return false;
    }

    // ---- no modifier ----
    if (k === 'ArrowRight') { if (shift) extendSelection(1); else { clearSelection(); moveBeat(1); } return true; }  // ⇧→ extends selection
    if (k === 'ArrowLeft') { if (shift) extendSelection(-1); else { clearSelection(); moveBeat(-1); } return true; } // ⇧← extends selection
    if (k === 'ArrowUp') { clearSelection(); moveString(-1); return true; }
    if (k === 'ArrowDown') { clearSelection(); moveString(1); return true; }
    if (k === 'PageUp') { moveTrack(-1); return true; }   // alias for ⌘↑ (no muscle-memory cost)
    if (k === 'PageDown') { moveTrack(1); return true; }  // alias for ⌘↓
    if (k === 'F3') { if (window.gomidasToggleMultiView) window.gomidasToggleMultiView(); return true; } // GP: Multitrack view toggle
    if (k === 'Home') { moveToBarEdge(false); return true; }  // GP: beginning of bar
    if (k === 'End') { moveToBarEdge(true); return true; }    // GP: end of bar
    if (k === 'Tab') { moveTrack(shift ? -1 : 1); return true; } // GP: next / prev staff (Tab / ⇧Tab)
    if (k.length === 1 && k >= '0' && k <= '9') {
      // On a drum track, digits 1–9 toggle the matching kit piece on the current beat
      // (palette order; the pad labels show the hotkey number). 0 clears the beat.
      if (isPercussionTrack()) {
        const drums = (getState() && getState().drums) || [];
        const n = parseInt(k, 10);
        if (n === 0) makeRest();
        else if (n >= 1 && n <= drums.length) toggleDrum(drums[n - 1].midi);
        return true;
      }
      // Place the note instantly; a 2nd digit within 600ms amends it (1 then 2 → 12).
      fretBuffer += k;
      if (parseInt(fretBuffer, 10) > 24) fretBuffer = k; // frets cap at 24; restart the buffer
      clearTimeout(fretTimer);
      fretTimer = setTimeout(() => { fretBuffer = ''; refreshCursor(); }, 600);
      placeFret(parseInt(fretBuffer, 10));
      return true;
    }
    if (k === 'Enter') { clearTimeout(fretTimer); fretBuffer = ''; refreshCursor(); return true; }
    if (k === 'Backspace' || k === 'Delete') { deleteNote(); return true; }
    if (k === '+' || k === '=') { changeDuration(false); return true; } // GP: Decrease Note Duration
    if (k === '-' || k === '_') { changeDuration(true); return true; }  // GP: Increase Note Duration
    if (k === 'r' || k === 'R') { (shift || k === 'R') ? rasgueadoBeat() : makeRest(); return true; } // GP: Rest / ⇧R Rasgueado
    if (k === '.') { toggleDot(); return true; }                        // GP: Dotting
    if (k === '/') { toggleTriplet(); return true; }                    // GP: Triolet (triplet)
    if (k === 'p' || k === 'P') { (shift || k === 'P') ? palmMuteBeat() : palmMuteNote(); return true; } // GP: Palm Mute (P / ⇧P)
    if (k === 'x' || k === 'X') { deadNote(); return true; }            // GP: Dead Note
    if (k === 'i' || k === 'I' || k === 'Insert') { letRing(); return true; } // GP: Let Ring
    if (k === 'l' || k === 'L') { (shift || k === 'L') ? tieBeat() : tieNote(); return true; } // GP: Tie Note / Tie Beat
    if (k === 'h' || k === 'H') { hammerPull(); return true; }          // GP: Hammer On / Pull Off
    if (k === 's' || k === 'S') { slideNote(false); return true; }      // GP: Legato Slide
    if (k === 'c' || k === 'C') { copyLastBeat(); return true; }        // GP: Copy Last Beat
    if (k === 'o' || k === 'O') { ghostNote(); return true; }           // GP: Ghost Note
    if (k === '!') { staccato(); return true; }                        // GP: Staccato
    if (k === ';') { accent(false); return true; }                     // GP: Note accented
    if (k === ':') { accent(true); return true; }                      // GP: Heavily Accented Note
    if (k === 'y' || k === 'Y') { naturalHarmonic(); return true; }     // GP: Natural Harmonic
    if (k === 'v' || k === 'V') { vibratoNote(); return true; }         // GP: Left-Hand Vibrato
    if ((k === 'u' || k === 'U') && shift) { setPickStroke(true); return true; }  // GP: Pick Stroke Up ⇧U
    if ((k === 'd' || k === 'D') && shift) { setPickStroke(false); return true; } // GP: Pick Stroke Down ⇧D
    if (k === 'n' || k === 'N') { trillNote(); return true; }           // GP: Trill
    if (k === 'g' || k === 'G') { graceNote(false); return true; }      // GP: Grace note (before beat)
    if (k === '"') { tremoloPicking(); return true; }                  // GP: Tremolo Picking
    if (k === '$') { slapBeat(); return true; }                        // GP: Slap
    if (k === '(') { leftHandTap(); return true; }                     // GP: Left-Hand Tapping
    if (k === ')') { tapBeat(); return true; }                         // GP: Tapping
    if (k === 'b' || k === 'B') { if (window.gomidasOpenBend) window.gomidasOpenBend(); return true; } // GP: Bend
    if (k === '<') { setFade('in'); return true; }                     // GP: Fade In
    if (k === '>') { setFade('out'); return true; }                    // GP: Fade Out
    if (k === '[') { toggleRepeatStart(); return true; }               // GP: Open Repeat
    if (k === ']') { toggleRepeatEnd(); return true; }                 // GP: Close Repeat
    if (k === 't' || k === 'T') { if (window.gomidasOpenText) window.gomidasOpenText(); return true; } // GP: Text
    if (k === 'f' || k === 'F') { toggleFermata(); return true; }      // GP: Fermata
    if (k === 'a' || k === 'A') { if (window.gomidasOpenChord) window.gomidasOpenChord(); return true; } // GP: Chord
    if (k === ' ' || k === 'Spacebar') { togglePlay(); return true; }
    return false;
  }

  // Don't hijack keys while the user is typing in a field or a modal dialog is open
  // (so Space types a space in the name/title/tempo inputs instead of toggling play).
  function isTypingTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const ty = (t.type || 'text').toLowerCase();
      return ['text', 'number', 'search', 'email', 'url', 'password', 'tel'].indexOf(ty) >= 0;
    }
    return !!t.isContentEditable;
  }
  function modalIsOpen() { const m = document.getElementById('modal-overlay'); return !!(m && m.classList.contains('show')); }

  function onKey(e) {
    if (modalIsOpen() || isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (handleKey(e.key, { ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey, alt: e.altKey })) {
      e.preventDefault(); e.stopPropagation();
    }
  }

  // ---- lifecycle hooks (called from app.js) ----------------------------------
  function onScoreLoaded(score) {
    lastPlayBeat = null;
    clearSelection();
    if (preserveCursorNext) {
      // Re-render from an undo/redo snapshot: keep cursor (clamped), keep history.
      preserveCursorNext = false;
      cur.track = Math.min(cur.track, score.tracks.length - 1);
      const s = staff(); cur.bar = Math.min(cur.bar, (s ? s.bars.length : 1) - 1);
      cur.voice = 0;
      const v = voice(); cur.beat = Math.min(cur.beat, (v ? v.beats.length : 1) - 1);
      clampString();
    } else {
      // Fresh load (New/Open/Sample): reset cursor + undo history.
      cur.track = 0; cur.bar = 0; cur.voice = 0; cur.beat = 0; cur.string = 0;
      undoStack.length = 0; redoStack.length = 0;
      if (_clearDrumRegOnLoad) { _clearDrumRegOnLoad = false; clearDrumRegistration(); }
      currentSnap = snapshot();
      dirty = false;             // freshly loaded score has no unsaved edits
      clearLoop();               // drop any A/B loop from the previous score
      window.gomidasTrackFlags = {};   // clear mute/solo/hide/volume for the new score
      if (window.gomidasApplyMixer) window.gomidasApplyMixer();  // push per-track gains for the new score
    }
  }

  function onRenderFinished() {
    stopPump();
    if (_editStartedAt) {
      const ms = performance.now() - _editStartedAt;
      _editStartedAt = 0;
      // Quiet in normal use; only flags genuine lag so we can see if it tracks score size.
      if (ms > 150 && ms < 8000)
        nlog('slow render: edit→display ' + ms.toFixed(0) + 'ms ('
          + (api.score ? api.score.masterBars.length : '?') + ' bars, '
          + window.gomidasGetRenderedTracks().length + ' tracks shown)');
    }
    refreshCursor();
    renderBeatLane();
  }

  // Select the beat under a score click — works on empty/rest beats (unlike
  // beatMouseDown, which only fires on actual note/beat glyphs).
  // Resolve the (track,bar,voice,beat[,string]) under a client point WITHOUT moving the
  // cursor — so click, drag-select and block-select can share one hit-test. Returns null
  // if the point isn't over a beat.
  function beatPosAt(clientX, clientY) {
    const at = document.getElementById('at');
    const bl = api.boundsLookup;
    if (!bl || !at) return null;
    const rect = at.getBoundingClientRect();
    const off = surfaceOffset();
    const xs = clientX - rect.left - off.x, ys = clientY - rect.top - off.y;
    const hit = bl.getBeatAtPos(xs, ys);
    if (!hit) return null;
    // getBeatAtPos resolves the system + column, but in multiview returns a beat
    // without distinguishing which track's staff was clicked (it keys off the whole
    // system's Y). Re-pick the track whose staff bounds actually contain the click Y,
    // so clicking the drum row switches to drum controls.
    let b = hit;
    const barIdx = hit.voice.bar.index, voiceIdx = hit.voice.index, beatIdx = hit.index;
    for (const t of window.gomidasGetRenderedTracks()) {
      const st = t.staves && t.staves[0];
      const bar = st && st.bars[barIdx];
      const v = bar && bar.voices[voiceIdx];
      const be = v && v.beats[Math.min(beatIdx, v.beats.length - 1)];
      if (!be) continue;
      let bbs = null; try { bbs = bl.findBeats(be); } catch (e) {}
      if (!bbs || !bbs.length) continue;
      let inY = false;
      for (const bb of bbs) {
        const rb = bb.barBounds.realBounds;
        if (ys >= rb.y - 2 && ys <= rb.y + rb.h + 2) { inY = true; break; }
      }
      if (inY) { b = be; break; }
    }
    const pos = { track: b.voice.bar.staff.track.index, bar: b.voice.bar.index,
                  voice: b.voice.index, beat: b.index, string: null };
    // If the click landed on the (resolved track's) tablature staff, pick the string from Y.
    const ts = api.score.tracks[pos.track] && api.score.tracks[pos.track].staves[0];
    if (ts && ts.showTablature) {
      const all = bl.findBeats(b);
      if (all && all.length) {
        let tab = all[0];
        for (const bb of all) if (bb.barBounds.realBounds.y > tab.barBounds.realBounds.y) tab = bb;
        const r = tab.barBounds.realBounds;
        if (all.length === 1 || (ys >= r.y - 8 && ys <= r.y + r.h + 8)) {
          const sc = (ts.tuning && ts.tuning.length) ? ts.tuning.length : stringCount();
          const row = Math.round((ys - r.y) / (r.h / Math.max(1, sc - 1)));
          pos.string = Math.max(0, Math.min(sc - 1, row));
        }
      }
    }
    return pos;
  }
  // Commit a resolved position to the cursor.
  function commitPos(pos) {
    if (!pos) return false;
    cur.track = pos.track; cur.bar = pos.bar; cur.voice = pos.voice; cur.beat = pos.beat;
    if (pos.string != null) cur.string = pos.string;
    refreshCursor();
    return true;
  }
  function selectBeatAt(clientX, clientY) { return commitPos(beatPosAt(clientX, clientY)); }

  function init(apiGetter) {
    api = apiGetter();
    window.addEventListener('keydown', onKey, true);
    // Beat lane: hidden iff the user turned it off last session (default on).
    try { if (localStorage.getItem('gomidasBeatGrid') === '0') document.body.classList.add('hide-beatlane'); } catch (e) {}
    // Click moves the cursor to that beat (incl. empty bars); click-drag selects a beat
    // range — and dragging across staves selects a cross-track block. beatPosAt re-picks
    // the correct track by click Y in multiview (alphaTab's beatMouseDown returns the
    // wrong track there, so we don't let it set the cursor).
    {
      const atEl = document.getElementById('at');
      let dragging = false, dragMoved = false;
      atEl.addEventListener('mousedown', (e) => {
        const pos = beatPosAt(e.clientX, e.clientY);
        if (!pos) return;
        commitPos(pos);
        sel.anchor = { track: pos.track, bar: pos.bar, beat: pos.beat };
        sel.head = { track: pos.track, bar: pos.bar, beat: pos.beat };
        sel.active = false; // not a selection until the mouse actually moves
        dragging = true; dragMoved = false;
        const mv = (ev) => {
          if (!dragging) return;
          const p2 = beatPosAt(ev.clientX, ev.clientY);
          if (!p2) return;
          if (p2.track !== sel.head.track || p2.bar !== sel.head.bar || p2.beat !== sel.head.beat) {
            sel.head = { track: p2.track, bar: p2.bar, beat: p2.beat };
            sel.active = true; dragMoved = true;
            commitPos(p2); // moves the cursor + re-renders the selection
          }
        };
        const up = () => {
          dragging = false;
          document.removeEventListener('mousemove', mv);
          document.removeEventListener('mouseup', up);
          if (!dragMoved) { clearSelection(); refreshCursor(); } // a plain click clears any selection
        };
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      });
    }
    api.noteMouseDown.on((n) => {
      try { cur.string = stringNoToRow(n.string | 0); clampString(); refreshCursor(); }
      catch (err) { nlog('noteMouseDown: ' + err); }
    });
  }

  window.GomidasEditor = {
    init, onScoreLoaded, onRenderFinished, onPlayTick, handleKey,
    addBar, setFret, deleteNoteOnString, setDuration, toggleDot, toggleDoubleDot, makeRest,
    toggleTriplet, setTuplet, palmMute: palmMuteBeat, palmMuteNote, deadNote, letRing,
    tieNote, tieBeat, hammerPull, slideNote, toggleDrum, armDrumRegClear,
    ghostNote, staccato, accent, naturalHarmonic, artificialHarmonic, pinchHarmonic, vibratoNote, transposeNote,
    setBrush, setPickStroke, wideVibrato, tremoloPicking, trillNote, graceNote, slapBeat, popBeat, setFade, pickSlide,
    tremoloBar, setWah, rasgueadoBeat, leftHandTap, tapBeat, setBend,
    setDynamics, setCrescendo, setOttava, setLyrics, getLyrics, transpose,
    insertGroove, readBarGrid, toggleGridCell, generateVariation, isPercussion: isPercussionTrack,
    move: (d) => moveBeat(d), moveString: (d) => moveString(d), moveTrack: (d) => moveTrack(d),
    selectTrack, selectVoice, deleteTrack, goToBar, moveToBarEdge, moveToScoreEdge,
    setTimeSignature, setKeySignature, toggleRepeatStart, toggleRepeatEnd, toggleTripletFeel,
    toggleDirection, toggleFermata,
    selectAll, selectBars, copySelection, cutSelection, pasteClipboard, copyLastBeat, extendSelection,
    loopSelection, clearLoop, toggleLoop, isLoopActive,
    insertBeat: insertBeatAfter, removeBeat, deleteBar, togglePlay, getState,
    setTrackName, setTrackProgram, toggleNotation, setTuningPreset, setSongTitle, setSongTempo,
    setBeatText, getBeatText, setBeatChord, getBeatChord,
    isDirty, markClean, setAutoScroll, setCountIn, toggleCountIn, isCountIn, setCountInBars, getCountInBars, notifyStopped,
    toggleBeatGrid, isBeatGrid: () => laneVisible(), redrawLane: renderBeatLane,
    undo, redo, snapshot, loadProject: loadProjectJson, addTrack: addTrackOfKind,
    canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0
  };
})();
