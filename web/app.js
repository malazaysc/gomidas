// Gomidas front-end. alphaTab owns the score model + rendering; we walk that
// model into a flat MIDI event list (computing absolute ticks ourselves so edits
// stay timing-correct) and hand it to the native engine, which owns the clock,
// the SoundFont synth and (later) the live VST chain.
'use strict';

const PPQ = 960;                 // ticks per quarter note
const WHOLE_TICKS = PPQ * 4;     // 3840

const statusEl = document.getElementById('status');
function setStatus(s) { statusEl.textContent = s; }

// ---- native bridge -----------------------------------------------------------
// JUCE WebView wire format (see juce_native_interop.js Backend.emitEvent):
// postMessage {eventId:"__juce__invoke", payload:{name, params, resultId}}.
let __juceResultId = 0;
function nativeInvoke(name, payload) {
  try {
    const j = window.__JUCE__;
    if (j && j.backend && j.backend.emitEvent) {
      j.backend.emitEvent('__juce__invoke',
        { name: name, params: [payload], resultId: __juceResultId++ });
    }
  } catch (e) { /* swallow to avoid recursion in the error handler */ }
}
function nlog(msg) { nativeInvoke('log', String(msg)); }
window.gomidasNativeInvoke = nativeInvoke; // used by editor.js for preview/transport
window.onerror = (m, src, line, col, err) =>
  nlog('JS error: ' + m + ' @' + line + ':' + col + (err && err.stack ? '\n' + err.stack : ''));
const _origErr = console.error.bind(console);
console.error = (...a) => { try { nlog('console.error: ' + a.map(String).join(' ')); } catch (e) {} _origErr(...a); };

// Called by native (~30Hz) with the current transport position in ticks.
window.gomidas = {
  onTick(tick) { if (window.GomidasEditor) window.GomidasEditor.onPlayTick(tick); }
};

// ---- alphaTab ----------------------------------------------------------------
let api = null;
let renderedTracks = [];

function makeSettings() {
  const base = new URL('.', document.baseURI).href; // resource root
  const settings = new alphaTab.Settings();
  settings.core.engine = 'svg';
  settings.core.useWorkers = false;            // no worker file in the embedded webview
  settings.core.enableLazyLoading = false;     // lazy tiles wait on a rAF this WebView won't service promptly → ~700ms+ deferred renders
  settings.core.fontDirectory = base;          // serves Bravura.woff2 / .woff
  // Show standard notation AND guitar tablature (Guitar Pro style).
  settings.display.staveProfile = (alphaTab.StaveProfile ? alphaTab.StaveProfile.ScoreTab : 1);
  // Native synthesizes audio; alphaTab's own player stays OFF. Cursors are ours.
  settings.player.enablePlayer = false;
  settings.display.scale = 1.0;
  return settings;
}

function initAlphaTab() {
  const el = document.getElementById('at');
  el.style.position = 'relative';              // anchor for cursor overlays
  api = new alphaTab.AlphaTabApi(el, makeSettings());
  window.gomidasApi = api;

  api.scoreLoaded.on((score) => {
    try {
      renderedTracks = score.tracks.slice();
      viewMode = 'multi';              // reloads (new/open/undo) show all tracks
      populateTracks(score);
      applyScoreTempo(score);          // honour the loaded file's tempo (not always 120)
      rebuildSequence();
      applyMixer();                    // push per-track gains/pans (flags reset on fresh load in editor)
      if (window.GomidasEditor) window.GomidasEditor.onScoreLoaded(score);
      setStatus(`${score.title || 'Untitled'} — ${score.tracks.length} track(s)`);
    } catch (e) { nlog('scoreLoaded handler: ' + (e && e.stack || e)); }
  });
  api.renderFinished.on(() => { if (window.GomidasEditor) window.GomidasEditor.onRenderFinished(); });
  api.error.on((err) => { console.error(err); setStatus('error: ' + (err && err.message)); });
}

function populateTracks(score) {
  const sel = document.getElementById('track-select');
  sel.innerHTML = '';
  score.tracks.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i + 1}. ${t.name || 'Track'}`;
    sel.appendChild(opt);
  });
  const allOpt = document.createElement('option');
  allOpt.value = 'all'; allOpt.textContent = 'All tracks';
  sel.appendChild(allOpt);
  sel.value = 'all';
}

// ---- model -> MIDI events (we compute absolute ticks) ------------------------
function beatTicks(beat) {
  let t = WHOLE_TICKS / beat.duration;         // duration enum value == note fraction
  if (beat.dots) t *= (2 - Math.pow(0.5, beat.dots));
  if (beat.tupletNumerator && beat.tupletNumerator > 0)
    t *= beat.tupletDenominator / beat.tupletNumerator;
  return Math.max(1, Math.round(t));
}

function dynamicsToVelocity(dyn) {
  if (typeof dyn !== 'number') return 0.85;
  return Math.max(0.2, Math.min(1.0, 0.3 + dyn * 0.1));
}

// Builds the native sequence AND a tick->beat map (primary track) for the cursor.
// Full duration of master bar i from its time signature (a bar always occupies
// its time-signature length; underfilled bars are padded with silence).
function masterBarTicks(score, i) {
  const mb = score.masterBars[i];
  const num = mb ? (mb.timeSignatureNumerator || 4) : 4;
  const den = mb ? (mb.timeSignatureDenominator || 4) : 4;
  return Math.round(WHOLE_TICKS * num / den);
}

function rebuildSequence() {
  const score = api.score;
  const events = [];
  const tickMap = [];               // [{tick, beat}] ascending, primary rendered track
  let lengthTicks = 0;
  const primaryTrack = renderedTracks[0] || score.tracks[0];

  // Mute/solo/volume are applied LIVE via per-channel gain (see applyMixer), not by
  // dropping events here — so toggling them takes effect instantly during playback.
  score.tracks.forEach((track, trackIndex) => {
    const pb = track.playbackInfo || {};
    const program = pb.program | 0;
    const channel = (pb.primaryChannel != null) ? (pb.primaryChannel & 0x0f) : 0;
    const percussion = (channel === 9);
    const isPrimary = (track === primaryTrack);
    const lastOff = {};   // "channel:key" -> note-off event, so ties can extend it

    for (const stave of track.staves) {
      let trackTick = 0;
      let barIndex = 0;
      for (const bar of stave.bars) {
        const barStart = trackTick;
        let barEnd = barStart;
        for (const voice of bar.voices) {
          let t = barStart;
          for (const beat of voice.beats) {
            const dur = beatTicks(beat);
            if (isPrimary && voice.index === 0) tickMap.push({ tick: t, beat });
            if (!beat.isEmpty && !beat.isRest) {
              const vel = dynamicsToVelocity(beat.dynamics);
              for (const note of beat.notes) {
                let key;
                if (percussion) {
                  // Percussion: map articulation index -> GM drum MIDI note.
                  const arts = track.percussionArticulations;
                  const ai = note.percussionArticulation | 0;
                  key = (arts && arts[ai] && arts[ai].outputMidiNumber != null)
                        ? arts[ai].outputMidiNumber : note.realValue;
                } else {
                  key = note.realValue;
                }
                if (key == null || key < 0 || key > 127) continue;
                // Articulation → audible MIDI shape: dead = short percussive thunk,
                // palm mute = shorter+softer, let ring = sustains past its duration.
                let noteVel = vel, noteDur = dur;
                if (note.isDead) { noteVel = vel * 0.6; noteDur = Math.max(1, Math.round(dur * 0.12)); }
                else if (note.isPalmMute) { noteVel = vel * 0.85; noteDur = Math.max(1, Math.round(dur * 0.45)); }
                if (note.isStaccato) noteDur = Math.max(1, Math.round(noteDur * 0.5));
                if (note.isGhost) noteVel *= 0.55;
                if (note.accentuated === 2) noteVel = Math.min(1, noteVel * 1.3);       // heavy accent
                else if (note.accentuated === 1) noteVel = Math.min(1, noteVel * 1.15); // accent
                if (note.isLetRing) noteDur = Math.max(noteDur, dur * 4); // approx: ring well past the beat
                const id = channel + ':' + key;
                // Tie: don't re-trigger — extend the still-ringing note's note-off.
                if (note.isTieDestination && lastOff[id]) { lastOff[id][0] = t + noteDur; continue; }
                events.push([t, channel, key, noteVel, true, program, percussion]);
                const off = [t + noteDur, channel, key, 0.0, false, program, percussion];
                events.push(off);
                lastOff[id] = off;
              }
            }
            t += dur;
          }
          if (t > barEnd) barEnd = t;
        }
        // A bar always spans its full time-signature duration (silence-pad the
        // remainder) so the next bar starts on the downbeat — never early.
        const capacity = masterBarTicks(score, barIndex);
        trackTick = barStart + Math.max(capacity, barEnd - barStart);
        barIndex++;
      }
      if (trackTick > lengthTicks) lengthTicks = trackTick;
    }
  });

  tickMap.sort((a, b) => a.tick - b.tick);
  window.gomidasTickMap = tickMap;
  nativeInvoke('setSequence', { lengthTicks, events });
}
window.gomidasRebuild = rebuildSequence;
window.gomidasGetRenderedTracks = () => renderedTracks;

// Push the loaded score's tempo to the native clock + the tempo field, so opening
// a file plays at its own tempo instead of a hard-coded 120.
function applyScoreTempo(score) {
  let bpm = score && score.tempo;
  if (!(bpm >= 20 && bpm <= 400)) bpm = 120;
  nativeInvoke('setTempo', bpm);
  const tf = document.getElementById('tempo');
  if (tf) tf.value = String(Math.round(bpm));
}

// ---- view + mixer ------------------------------------------------------------
// Two view modes: 'single' (one focused track, GP-style — set by clicking a track
// row) and 'multi' (all non-hidden tracks — set by the eye/show-hide control).
let viewMode = 'multi';
let focusIndex = 0;
// Per-track flags from the track list. index -> {muted, soloed, hidden, vol(0..1)}.
window.gomidasTrackFlags = {};

function computeRendered() {
  const flags = window.gomidasTrackFlags || {};
  if (viewMode === 'single') {
    const t = api.score.tracks[focusIndex];
    return t ? [t] : api.score.tracks.slice();
  }
  const shown = api.score.tracks.filter((t, i) => !(flags[i] && flags[i].hidden));
  return shown.length ? shown : api.score.tracks.slice();
}
function renderView() {
  if (!api || !api.score) return;
  const next = computeRendered();
  const changed = next.length !== renderedTracks.length || next.some((t, i) => t !== renderedTracks[i]);
  renderedTracks = next;
  if (changed) api.renderTracks(renderedTracks);
  rebuildSequence();
  const sel = document.getElementById('track-select');
  if (sel) sel.value = (viewMode === 'single') ? String(focusIndex) : 'all';
}

// Focus a single track in the score (GP-style: clicking a track shows that track).
window.gomidasShowTrack = function (index) {
  if (!api || !api.score || !api.score.tracks[index]) return;
  viewMode = 'single'; focusIndex = index;
  renderView();
};
// Show all non-hidden tracks (multi-track view; driven by the eye control).
window.gomidasShowMulti = function () {
  viewMode = 'multi';
  renderView();
};

function trackChannel(track) {
  const pb = track.playbackInfo || {};
  return (pb.primaryChannel != null) ? (pb.primaryChannel & 0x0f) : 0;
}
// Compute each track's live gain (volume × mute/solo) + pan and push to the engine.
// Mute = gain 0; with any track soloed, non-soloed tracks are silenced.
function applyMixer() {
  if (!api || !api.score) return;
  const flags = window.gomidasTrackFlags || {};
  const anySolo = api.score.tracks.some((_, i) => flags[i] && flags[i].soloed);
  api.score.tracks.forEach((track, i) => {
    const f = flags[i] || {};
    const pb = track.playbackInfo || {};
    const baseVol = (typeof f.vol === 'number') ? f.vol : ((pb.volume != null ? pb.volume : 12) / 16);
    const audible = anySolo ? !!f.soloed : !f.muted;
    const gain = audible ? Math.max(0, Math.min(1.5, baseVol)) : 0;
    const pan = (pb.balance != null) ? Math.max(0, Math.min(1, pb.balance / 16)) : 0.5;
    nativeInvoke('setChannelMix', { channel: trackChannel(track), gain, pan });
  });
}
window.gomidasApplyMixer = applyMixer;
// Back-compat: the track list calls this after toggling eye/mute/solo/volume.
window.gomidasApplyTrackFlags = function () { window.gomidasShowMulti(); applyMixer(); };

// ---- sample / file loading ---------------------------------------------------
const SAMPLE_TEX = `\\title "Gomidas Test" \\tempo 120 .
\\track "Guitar" \\instrument 27
(0.5 2.4 2.3).8 (0.5 2.4 2.3).8 3.3 5.3 3.3 0.3 0.2 2.2 |
\\track "Bass" \\instrument 33
3.3 3.3 5.3 5.3 | 0.3 0.3 3.3 3.3 |`;

function loadSample() { if (api) api.tex(SAMPLE_TEX); }

// \instrument percussion → alphaTab builds drum articulations on-demand from notes,
// so bar 1 hits every palette piece to register the kit (channel 9). The editor
// clears this registration chord right after load (GomidasEditor.armDrumRegClear).
const DRUM_REG = '(49 51 46 42 48 47 43 38 36).1';
const PROGRAMS = { guitar: 27, bass: 33 };
// Tuning presets (alphaTex tokens, high→low string), shown in the New dialog + inspector.
const TUNING_PRESETS = {
  guitar: [
    { name: 'Standard (E A D G B E)', tuning: 'E4 B3 G3 D3 A2 E2' },
    { name: 'Drop D',                 tuning: 'E4 B3 G3 D3 A2 D2' },
    { name: 'Eb Standard',            tuning: 'D#4 A#3 F#3 C#3 G#2 D#2' },
    { name: 'D Standard',             tuning: 'D4 A3 F3 C3 G2 D2' },
    { name: '7-string (B E A D G B E)', tuning: 'E4 B3 G3 D3 A2 E2 B1' }
  ],
  bass: [
    { name: 'Standard (E A D G)',     tuning: 'G2 D2 A1 E1' },
    { name: 'Drop D',                 tuning: 'G2 D2 A1 D1' },
    { name: '5-string (B E A D G)',   tuning: 'G2 D2 A1 E1 B0' }
  ]
};
function tuningFor(kind) { return (TUNING_PRESETS[kind] && TUNING_PRESETS[kind][0].tuning) || TUNING_PRESETS.guitar[0].tuning; }

// Build alphaTex for one track (one bar of rests in the chosen time signature).
function trackTex(t, num, den) {
  if (t.kind === 'drums')
    return '\\track "Drums" \\instrument percussion\n\\ts ' + num + ' ' + den + ' ' + DRUM_REG + ' |';
  const prog = PROGRAMS[t.kind] || 27;
  const name = (t.kind === 'bass') ? 'Bass' : 'Guitar';
  const rests = ('r.' + den + ' ').repeat(num).trim();
  return '\\track "' + name + '" \\instrument ' + prog + ' \\tuning(' + (t.tuning || tuningFor(t.kind)) + ')'
       + '\n\\ts ' + num + ' ' + den + ' ' + rests + ' |';
}
function buildTexFromConfig(cfg) {
  const title = String(cfg.title || 'Untitled').replace(/"/g, '');
  const head = '\\title "' + title + '" \\tempo ' + (cfg.tempo | 0) + '\n';
  return head + cfg.tracks.map(t => trackTex(t, cfg.numerator, cfg.denominator)).join('\n');
}
// Default track set for a New… preset (also used to prefill the dialog).
function presetTracks(kind) {
  const g = () => ({ kind: 'guitar', tuning: tuningFor('guitar') });
  const b = () => ({ kind: 'bass',   tuning: tuningFor('bass') });
  const d = () => ({ kind: 'drums' });
  switch (kind) {
    case 'bass':  return [b()];
    case 'gb':    return [g(), b()];
    case 'drums': return [d()];
    case 'band':  return [g(), b(), d()];
    default:      return [g()];
  }
}
function createNewFromConfig(cfg) {
  if (!api || !cfg.tracks.length) return;
  if (cfg.tracks.some(t => t.kind === 'drums') && window.GomidasEditor && window.GomidasEditor.armDrumRegClear)
    window.GomidasEditor.armDrumRegClear();
  api.tex(buildTexFromConfig(cfg));
  focusEditor();
}

// ---- modal (New dialog + unsaved-changes confirm) ---------------------------
const modalOverlay = document.getElementById('modal-overlay');
const modalBox = document.getElementById('modal-box');
function hideModal() { modalOverlay.classList.remove('show'); modalBox.innerHTML = ''; focusEditor(); }
function showModal() { modalOverlay.classList.add('show'); }
modalOverlay.addEventListener('mousedown', (e) => { if (e.target === modalOverlay) hideModal(); });

// Run cb, but if there are unsaved edits first ask the user to confirm discarding them.
function confirmDiscard(cb) {
  const E = window.GomidasEditor;
  if (!E || !E.isDirty || !E.isDirty()) { cb(); return; }
  modalBox.innerHTML =
    '<div class="modal-h">Unsaved changes</div>' +
    '<div class="modal-body"><div class="m-msg">You have unsaved changes that will be lost.<br>Discard them and continue?</div></div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="cd-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="cd-ok">Discard</button>' +
    '</div>';
  showModal();
  document.getElementById('cd-cancel').onclick = hideModal;
  document.getElementById('cd-ok').onclick = () => { hideModal(); cb(); };
}

// GP8-style "new score" dialog: title, tempo, time signature, and a track list.
function tuningOptions(kind, selected) {
  const list = TUNING_PRESETS[kind] || [];
  return list.map(p => '<option value="' + p.tuning + '"' + (p.tuning === selected ? ' selected' : '') + '>' + p.name + '</option>').join('');
}
function trackRowHtml(t, i) {
  const isDrums = t.kind === 'drums';
  const inst = ['guitar', 'bass', 'drums'].map(k =>
    '<option value="' + k + '"' + (k === t.kind ? ' selected' : '') + '>' + (k[0].toUpperCase() + k.slice(1)) + '</option>').join('');
  return '<div class="m-track" data-i="' + i + '">' +
    '<select class="m-inst">' + inst + '</select>' +
    '<select class="m-tuning"' + (isDrums ? ' style="visibility:hidden"' : '') + '>' + (isDrums ? '' : tuningOptions(t.kind, t.tuning)) + '</select>' +
    '<button class="m-del" title="remove track">✕</button>' +
  '</div>';
}
function openNewDialog(presetKind) {
  let tracks = presetTracks(presetKind || 'guitar');
  function render() {
    modalBox.innerHTML =
      '<div class="modal-h">New score</div>' +
      '<div class="modal-body">' +
        '<div class="m-field"><label>Title</label><input type="text" id="nd-title" value="Untitled"></div>' +
        '<div class="m-row">' +
          '<div class="m-field" style="flex:1"><label>Tempo (BPM)</label><input type="number" id="nd-tempo" min="20" max="400" value="120"></div>' +
          '<div class="m-field"><label>Time signature</label><div class="m-row">' +
            '<input type="number" id="nd-num" min="1" max="32" value="4" style="width:56px">' +
            '<span style="color:var(--dim)">/</span>' +
            '<select id="nd-den">' + [1,2,4,8,16].map(d => '<option' + (d === 4 ? ' selected' : '') + '>' + d + '</option>').join('') + '</select>' +
          '</div></div>' +
        '</div>' +
        '<div class="m-field"><label>Tracks</label><div class="m-tracks" id="nd-tracks">' +
          tracks.map(trackRowHtml).join('') +
        '</div><button class="m-add" id="nd-add">+ Add track</button></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="m-btn ghost" id="nd-cancel">Cancel</button>' +
        '<button class="m-btn primary" id="nd-create">Create</button>' +
      '</div>';
    wire();
  }
  function readTitleTempoTime() {
    const get = (id) => document.getElementById(id);
    return {
      title: get('nd-title').value || 'Untitled',
      tempo: Math.max(20, Math.min(400, parseInt(get('nd-tempo').value, 10) || 120)),
      numerator: Math.max(1, Math.min(32, parseInt(get('nd-num').value, 10) || 4)),
      denominator: parseInt(get('nd-den').value, 10) || 4
    };
  }
  function syncTracksFromDom() {
    const rows = modalBox.querySelectorAll('.m-track');
    tracks = Array.from(rows).map(r => {
      const kind = r.querySelector('.m-inst').value;
      const tsel = r.querySelector('.m-tuning');
      return (kind === 'drums') ? { kind } : { kind, tuning: (tsel && tsel.value) || tuningFor(kind) };
    });
  }
  function wire() {
    document.getElementById('nd-cancel').onclick = hideModal;
    document.getElementById('nd-add').onclick = () => { syncTracksFromDom(); tracks.push({ kind: 'guitar', tuning: tuningFor('guitar') }); render(); };
    modalBox.querySelectorAll('.m-track').forEach(row => {
      row.querySelector('.m-inst').onchange = () => { syncTracksFromDom(); render(); };
      row.querySelector('.m-del').onclick = () => { syncTracksFromDom(); const i = +row.dataset.i; tracks.splice(i, 1); if (!tracks.length) tracks.push({ kind: 'guitar', tuning: tuningFor('guitar') }); render(); };
    });
    document.getElementById('nd-create').onclick = () => {
      syncTracksFromDom();
      const cfg = Object.assign(readTitleTempoTime(), { tracks: tracks.slice() });
      confirmDiscard(() => { hideModal(); createNewFromConfig(cfg); });
    };
  }
  render();
  showModal();
  const tEl = document.getElementById('nd-title');
  if (tEl) { tEl.focus(); tEl.select(); }
}
window.gomidasOpenNew = openNewDialog;

// Keep keyboard focus in the score area so editor keys are received.
function focusEditor() { try { window.focus(); document.getElementById('at-wrap').focus(); } catch (e) {} }

// ---- project save / load (.gomidas = alphaTab score JSON) --------------------
function saveProject() {
  const json = window.GomidasEditor && window.GomidasEditor.snapshot();
  if (json) { nativeInvoke('saveProject', json); if (window.GomidasEditor.markClean) window.GomidasEditor.markClean(); }
}
function openProject() { nativeInvoke('openProject', 1); }
// Called by native after reading a .gomidas file.
window.gomidasLoadProject = function (json) {
  if (window.GomidasEditor && window.GomidasEditor.loadProject(json)) focusEditor();
};
// Called by native with a base64 of a .gp / MusicXML file's raw bytes (native Open
// + Open Recent give us a real path; the bytes come back here for alphaTab to parse).
window.gomidasLoadBinary = function (b64) {
  if (!api) return;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    api.load(bytes.buffer);
    focusEditor();
  } catch (e) { setStatus('load failed: ' + e); nlog('gomidasLoadBinary: ' + e); }
};
// Native "Open Recent" routes here first so the unsaved-changes guard runs.
window.gomidasConfirmOpenRecent = function (index) {
  confirmDiscard(() => nativeInvoke('openRecent', index));
};
// Called by native (MainComponent::keyPressed) so editor keys work even when the
// WebView doesn't hold first-responder focus.
window.gomidasNativeKey = function (key, cmd, ctrl, shift, alt) {
  if (window.GomidasEditor) window.GomidasEditor.handleKey(key, { meta: !!cmd, ctrl: !!ctrl, shift: !!shift, alt: !!alt });
};

// Dispatch a native menu-bar action (MainComponent menuItemSelected → here).
window.gomidasMenu = function (action) {
  const E = window.GomidasEditor;
  if (!E && !/^(new|open|save|import|sample)/.test(action)) return;
  const i = action.indexOf(':');
  const cmd = i < 0 ? action : action.slice(0, i);
  const arg = i < 0 ? '' : action.slice(i + 1);
  switch (cmd) {
    case 'new': openNewDialog(arg); break;
    case 'open': confirmDiscard(() => nativeInvoke('openFile')); break;
    case 'save': saveProject(); break;
    case 'sample': loadSample(); focusEditor(); break;
    case 'undo': E.undo(); break;
    case 'redo': E.redo(); break;
    case 'addtrack': E.addTrack(arg); focusEditor(); break;
    case 'addbar': E.addBar(); break;
    case 'deletebar': E.deleteBar(); break;
    case 'dur': E.setDuration(parseInt(arg, 10)); break;
    case 'dot': E.toggleDot(); break;
    case 'tie': E.tieNote(); break;
    case 'rest': E.makeRest(); break;
    case 'dead': E.deadNote(); break;
    case 'fx': {
      const m = { palmmute: () => E.palmMute(), letring: () => E.letRing(), hammer: () => E.hammerPull(),
        slide: () => E.slideNote(false), ghost: () => E.ghostNote(), staccato: () => E.staccato(),
        accent: () => E.accent(false), harmonic: () => E.naturalHarmonic(), vibrato: () => E.vibratoNote() };
      (m[arg] || (() => {}))(); break;
    }
    case 'play': E.togglePlay(); break;
    case 'zoom': window.gomidasZoom(arg === 'in' ? 1 : -1); break;
    default: break;
  }
  focusEditor();
};

document.getElementById('addtrack-select').addEventListener('change', (ev) => {
  const v = ev.target.value; ev.target.value = '';
  if (v && window.GomidasEditor) { window.GomidasEditor.addTrack(v); focusEditor(); }
});
document.getElementById('save-btn').addEventListener('click', saveProject);
// "Open" opens any supported file directly (.gp / .gpx / .gp3-8 / MusicXML / .gomidas).
document.getElementById('openproj-btn').addEventListener('click',
  () => confirmDiscard(() => nativeInvoke('openFile')));
document.getElementById('sample-btn').addEventListener('click',
  () => confirmDiscard(() => { loadSample(); focusEditor(); }));
document.getElementById('new-select').addEventListener('change', (ev) => {
  const v = ev.target.value; ev.target.value = '';
  if (v) openNewDialog(v);
});
// ---- transport extras (zoom, undo/redo, rewind) ----
let zoomScale = 1.0;
window.gomidasZoom = function (dir) {
  zoomScale = Math.max(0.5, Math.min(2.0, Math.round((zoomScale + dir * 0.1) * 10) / 10));
  if (api) { api.settings.display.scale = zoomScale; api.updateSettings(); api.render(); }
  const z = document.getElementById('zoom-pct'); if (z) z.textContent = Math.round(zoomScale * 100) + '%';
  focusEditor();
};
const onClick = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('click', fn); };
onClick('zoom-in', () => window.gomidasZoom(1));
onClick('zoom-out', () => window.gomidasZoom(-1));
onClick('undo-btn', () => { if (window.GomidasEditor) window.GomidasEditor.undo(); focusEditor(); });
onClick('redo-btn', () => { if (window.GomidasEditor) window.GomidasEditor.redo(); focusEditor(); });
onClick('rewind-btn', () => { nativeInvoke('stop', 1); focusEditor(); });
// Clicking anywhere in the score grabs keyboard focus for the editor.
document.getElementById('at-wrap').addEventListener('mousedown', focusEditor);
document.getElementById('tempo').addEventListener('change', (ev) => {
  const bpm = parseInt(ev.target.value, 10);
  if (bpm >= 40 && bpm <= 240) nativeInvoke('setTempo', bpm);
});
document.getElementById('file-input').addEventListener('change', (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file || !api) { ev.target.value = ''; return; }
  const name = (file.name || '').toLowerCase();
  const reader = new FileReader();
  if (name.endsWith('.gomidas')) {
    // our project format (alphaTab score JSON)
    reader.onload = () => { if (window.GomidasEditor) window.GomidasEditor.loadProject(reader.result); focusEditor(); };
    reader.readAsText(file);
  } else {
    // Guitar Pro / MusicXML — alphaTab parses the raw bytes
    reader.onload = () => { try { api.load(reader.result); } catch (e) { setStatus('load failed: ' + e); } focusEditor(); };
    reader.readAsArrayBuffer(file);
  }
  ev.target.value = ''; // allow re-opening the same file
});
document.getElementById('track-select').addEventListener('change', (ev) => {
  if (!api) return;
  const v = ev.target.value;
  if (v === 'all') window.gomidasShowMulti();
  else window.gomidasShowTrack(parseInt(v, 10));
});

// ---- boot --------------------------------------------------------------------
window.addEventListener('load', () => {
  if (typeof alphaTab === 'undefined') { setStatus('alphaTab failed to load'); return; }
  initAlphaTab();
  if (window.GomidasEditor) window.GomidasEditor.init(() => api);
  setStatus('ready');
  loadSample();
  focusEditor();
});
