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
  let lastPlayBeat = null;
  let dirty = false;             // unsaved-changes flag (drives New/Open confirmation)
  function markDirty() { dirty = true; }
  function isDirty() { return dirty; }
  function markClean() { dirty = false; }

  const cur = { track: 0, bar: 0, voice: 0, beat: 0, string: 0 };

  function nlog(m) { try { window.__JUCE__.backend.emitEvent('__juce__invoke',
      { name: 'log', params: ['[editor] ' + m], resultId: 0 }); } catch (e) {} }

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
        // Last beat of the last bar: append ONE trailing rest you can fill (GP-style),
        // but don't keep piling rests — if the last beat is already an empty rest, stop.
        const last = v.beats[v.beats.length - 1];
        if (last && !last.isRest) { insertBeatAfter(); return; }
        // else: already a trailing empty beat → stay put (use ＋bar to continue)
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

  // ---- selection + clipboard (beat range on voice 0 of the current track) -----
  // GP: ⇧→/⇧← extend, ⌘A select all, ⌘C/⌘X/⌘V copy/cut/paste, C copy last beat.
  const sel = { active: false, anchor: null, head: null }; // anchor/head = {bar, beat}
  let clipboard = null;     // array of serialized beats (plain objects, see serializeBeat)

  function clearSelection() { sel.active = false; sel.anchor = null; sel.head = null; }

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
    if (!sel.active) { sel.active = true; sel.anchor = { bar: cur.bar, beat: cur.beat }; }
    let idx = posIndex(positions, { bar: cur.bar, beat: cur.beat });
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(positions.length - 1, idx + delta));
    cur.bar = positions[idx].bar; cur.beat = positions[idx].beat;
    sel.head = { bar: cur.bar, beat: cur.beat };
    refreshCursor();
  }
  // GP: ⌘A — select every beat in the current track.
  function selectAll() {
    const positions = beatPositions();
    if (!positions.length) return;
    sel.active = true; sel.anchor = positions[0]; sel.head = positions[positions.length - 1];
    cur.bar = sel.head.bar; cur.beat = sel.head.beat;
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

  // GP: ⌘C — copy the selection (or the current beat if nothing is selected).
  function copySelection() {
    const s = staff(); if (!s) return;
    const ps = selectedPositions();
    const list = ps.length ? ps : [{ bar: cur.bar, beat: cur.beat }];
    clipboard = list.map(p => {
      const v = s.bars[p.bar] && s.bars[p.bar].voices[0];
      const b = v && v.beats[p.beat];
      return b ? serializeBeat(b) : null;
    }).filter(Boolean);
  }
  // GP: ⌘V — insert the clipboard's beats right after the cursor (current bar/voice).
  function pasteClipboard() {
    if (!clipboard || !clipboard.length) return;
    const v = voice(); if (!v) return;
    let at = cur.beat + 1;
    for (const sb of clipboard) { v.beats.splice(at, 0, deserializeBeat(sb, v)); at++; }
    cur.beat = at - 1;
    clearSelection();
    applyEdit(true);
    previewBeat();
  }
  // GP: ⌘X — copy the selection then remove those beats (keeping ≥1 beat per bar).
  function cutSelection() {
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

  // Draw a highlight rect over each selected beat column (pool of .sel-cell divs).
  let selOverlayEls = [];
  function renderSelection() {
    const ps = selectedPositions();
    const at = document.getElementById('at');
    const s = staff();
    let k = 0;
    if (ps.length && at && s) {
      for (const p of ps) {
        const v = s.bars[p.bar] && s.bars[p.bar].voices[0];
        const b = v && v.beats[p.beat];
        const col = beatColumn(b);
        if (!col) continue;
        let el = selOverlayEls[k];
        if (!el) { el = document.createElement('div'); el.className = 'sel-cell'; at.appendChild(el); selOverlayEls[k] = el; }
        el.style.display = 'block';
        el.style.left = col.x + 'px'; el.style.top = col.y + 'px';
        el.style.width = col.w + 'px'; el.style.height = col.h + 'px';
        k++;
      }
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

  function insertBeatAfter() {
    const v = voice();
    if (!v) return;
    const nb = new alphaTab.model.Beat();
    nb.duration = beat() ? beat().duration : 4;
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
    if (window.gomidasNativeInvoke)
      window.gomidasNativeInvoke('preview', { channel, program: pb.program | 0, percussion, keys });
  }

  // ---- drums -----------------------------------------------------------------
  // The New Drums / Full Band templates carry a registration chord in bar 1 (so
  // alphaTab builds the kit); we clear it right after that specific load. Armed
  // only by newScore() — never on import, so real drum files are untouched.
  let _clearDrumRegOnLoad = false;
  function armDrumRegClear() { _clearDrumRegOnLoad = true; }
  function clearDrumRegistration() {
    for (const t of api.score.tracks) {
      const st = t.staves && t.staves[0];
      if (!st || !st.isPercussion) continue;
      const be = st.bars[0] && st.bars[0].voices[0] && st.bars[0].voices[0].beats[0];
      if (be) while (be.notes.length) be.removeNote(be.notes[0]);
    }
    try { api.score.finish(api.settings); } catch (e) {}
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
      if (window.gomidasNativeInvoke)
        window.gomidasNativeInvoke('preview', { channel: 9, program: 0, percussion: true, keys: [midi] });
    }
    b.isEmpty = false;
    applyEdit(true);
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
    if (window.gomidasNativeInvoke) window.gomidasNativeInvoke('setTempo', bpm);
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
      allTracks: api.score.tracks.map((t, i) => ({
        index: i,
        name: t.name || ('Track ' + (i + 1)),
        isPercussion: !!(t.staves[0] && t.staves[0].isPercussion),
        program: (t.playbackInfo ? t.playbackInfo.program | 0 : 0),
        volume: (t.playbackInfo && t.playbackInfo.volume != null) ? (t.playbackInfo.volume / 16) : 0.75,
        current: i === cur.track
      }))
    };
  }

  // ---- transport -------------------------------------------------------------
  // ---- count-in --------------------------------------------------------------
  let countInOn = false, countInRunning = false, countInTimers = [];
  function setCountIn(on) { countInOn = !!on; }
  function toggleCountIn() { countInOn = !countInOn; return countInOn; }
  function isCountIn() { return countInOn; }
  function cancelCountIn() { countInRunning = false; countInTimers.forEach(clearTimeout); countInTimers = []; }
  // Reflect a forced stop (e.g. Panic) in the UI without sending another transport msg.
  function notifyStopped() { cancelCountIn(); isPlaying = false; refreshCursor(); }

  function startPlayback() {
    countInRunning = false;
    isPlaying = true; lastPlayBeat = null;
    if (window.gomidasSeekToCursor) window.gomidasSeekToCursor(cur.track, cur.bar, cur.voice, cur.beat);
    window.__JUCE__.backend.emitEvent('__juce__invoke', { name: 'play', params: [1], resultId: 0 });
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
    let i = 0;
    const step = () => {
      if (!countInRunning) return;
      if (window.gomidasNativeInvoke)
        window.gomidasNativeInvoke('preview', { channel: ch, program: 115, percussion: false, keys: [(i === 0) ? 84 : 72] });
      i++;
      const next = (i < num) ? step : () => { if (countInRunning) startPlayback(); };
      countInTimers.push(setTimeout(next, unitMs));
    };
    step();
  }

  function togglePlay() {
    flushHeavy(); // make sure native has the latest edited MIDI before playing
    if (countInRunning) { cancelCountIn(); return; }     // pressing play during count-in aborts it
    if (!isPlaying && countInOn) { playWithCountIn(); return; }
    isPlaying = !isPlaying;
    if (isPlaying) {
      // Start from the edit cursor, not bar 1 (seek the native transport there first).
      lastPlayBeat = null;
      if (window.gomidasSeekToCursor) window.gomidasSeekToCursor(cur.track, cur.bar, cur.voice, cur.beat);
    }
    window.__JUCE__.backend.emitEvent('__juce__invoke',
      { name: isPlaying ? 'play' : 'stop', params: [1], resultId: 0 });
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
    const st = document.getElementById('status');
    if (st) st.textContent = `${track() ? track().name : ''} · bar ${cur.bar + 1} · beat ${cur.beat + 1} · string ${cur.string + 1}`
      + (cur.voice > 0 ? ` · voice ${cur.voice + 1}` : '')
      + (fretBuffer ? ` · fret ${fretBuffer}` : '');
    if (window.GomidasUI) window.GomidasUI.refresh(getState());
  }

  function onPlayTick(tick) {
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
    const col = beatColumn(b);
    if (!col) { playCursorEl.style.display = 'none'; return; }
    playCursorEl.style.display = 'block';
    playCursorEl.style.left = col.x + 'px';
    playCursorEl.style.top = col.y + 'px';
    playCursorEl.style.width = col.w + 'px';
    playCursorEl.style.height = col.h + 'px';
    if (autoScrollOn) autoScrollToPlayCursor();
  }

  // Keep the play cursor in view while playing (GP-style "page turn"). Only scrolls
  // when the cursor nears an edge, so it doesn't yank on every beat. Uses the
  // already-positioned cursor element's rect, so it's robust to offsetParent quirks.
  let autoScrollOn = true;
  function autoScrollToPlayCursor() {
    const wrap = document.getElementById('at-wrap');
    if (!wrap || !playCursorEl || playCursorEl.style.display === 'none') return;
    const wrapRect = wrap.getBoundingClientRect();
    const curRect = playCursorEl.getBoundingClientRect();
    const m = 56; // edge margin
    const relTop = curRect.top - wrapRect.top;
    const relBottom = curRect.bottom - wrapRect.top;
    if (relTop < m || relBottom > wrap.clientHeight - m) {
      const target = wrap.scrollTop + relTop - wrap.clientHeight * 0.35;
      wrap.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
    if (wrap.scrollWidth > wrap.clientWidth + 1) { // horizontal layouts only
      const relLeft = curRect.left - wrapRect.left;
      const relRight = curRect.right - wrapRect.left;
      if (relLeft < m || relRight > wrap.clientWidth - m) {
        const target = wrap.scrollLeft + relLeft - wrap.clientWidth * 0.35;
        wrap.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
      }
    }
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
      if (k === 'g' || k === 'G') { if (window.gomidasOpenGoTo) window.gomidasOpenGoTo(); return true; } // Go To ⌘G
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
    if (k === 'r' || k === 'R') { makeRest(); return true; }            // GP: Rest
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
  }

  // Select the beat under a score click — works on empty/rest beats (unlike
  // beatMouseDown, which only fires on actual note/beat glyphs).
  function selectBeatAt(clientX, clientY) {
    const at = document.getElementById('at');
    const bl = api.boundsLookup;
    if (!bl || !at) return false;
    const rect = at.getBoundingClientRect();
    const off = surfaceOffset();
    const xs = clientX - rect.left - off.x, ys = clientY - rect.top - off.y;
    const hit = bl.getBeatAtPos(xs, ys);
    if (!hit) return false;
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
    cur.track = b.voice.bar.staff.track.index;
    cur.bar = b.voice.bar.index;
    cur.voice = b.voice.index;
    cur.beat = b.index;
    // If the click landed on the tablature staff, pick the string from its Y.
    const s = staff();
    if (s && s.showTablature) {
      const all = bl.findBeats(b);
      if (all && all.length) {
        let tab = all[0];
        for (const bb of all) if (bb.barBounds.realBounds.y > tab.barBounds.realBounds.y) tab = bb;
        const r = tab.barBounds.realBounds;
        if (all.length === 1 || (ys >= r.y - 8 && ys <= r.y + r.h + 8)) {
          const sc = stringCount();
          const row = Math.round((ys - r.y) / (r.h / Math.max(1, sc - 1)));
          cur.string = Math.max(0, Math.min(sc - 1, row));
        }
      }
    }
    refreshCursor();
    return true;
  }

  function init(apiGetter) {
    api = apiGetter();
    window.addEventListener('keydown', onKey, true);
    // Click anywhere in the score to move the cursor to that beat (incl. empty bars).
    // selectBeatAt is authoritative — it re-picks the correct track by click Y in
    // multiview. (alphaTab's beatMouseDown returns the wrong track there, so we don't
    // let it set the cursor or it would override selectBeatAt.)
    document.getElementById('at').addEventListener('mousedown', (e) => selectBeatAt(e.clientX, e.clientY));
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
    move: (d) => moveBeat(d), moveString: (d) => moveString(d), moveTrack: (d) => moveTrack(d),
    selectTrack, selectVoice, deleteTrack, goToBar, moveToBarEdge, moveToScoreEdge,
    setTimeSignature, setKeySignature, toggleRepeatStart, toggleRepeatEnd, toggleTripletFeel,
    toggleDirection, toggleFermata,
    selectAll, copySelection, cutSelection, pasteClipboard, copyLastBeat, extendSelection,
    loopSelection, clearLoop, toggleLoop, isLoopActive,
    insertBeat: insertBeatAfter, removeBeat, deleteBar, togglePlay, getState,
    setTrackName, setTrackProgram, toggleNotation, setTuningPreset, setSongTitle, setSongTempo,
    setBeatText, getBeatText, setBeatChord, getBeatChord,
    isDirty, markClean, setAutoScroll, setCountIn, toggleCountIn, isCountIn, notifyStopped,
    undo, redo, snapshot, loadProject: loadProjectJson, addTrack: addTrackOfKind,
    canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0
  };
})();
