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
// ---- backend seam (GMD-30, docs/WEB_PORT.md §2) -------------------------------------------
// Everything that used to call nativeInvoke() directly now goes through these two interfaces.
// The browser build (GMD-33) swaps in a Web Audio implementation here and nothing above this
// line changes. core/backend.js owns the JUCE wire format.
const { audio: Audio, host: Host } = window.GomidasBackend.createBackends(window);
window.GomidasAudio = Audio;   // editor.js / fretboard.js reach the backend through these
window.GomidasHost = Host;

function nlog(msg) { Host.log(msg); }
// Startup banner. Deliberately the FIRST thing JS says to native: if core/backend.js ever fails
// to load, app.js throws here — before window.onerror below is installed — and the failure is
// otherwise completely silent. Absence of this line in the log means the seam is broken.
nlog('backend ready (' + (window.GomidasBackend.hasJuceBridge(window) ? 'juce' : 'web') + '), caps=' + JSON.stringify(Audio.caps));
window.onerror = (m, src, line, col, err) =>
  nlog('JS error: ' + m + ' @' + line + ':' + col + (err && err.stack ? '\n' + err.stack : ''));
const _origErr = console.error.bind(console);
console.error = (...a) => { try { nlog('console.error: ' + a.map(String).join(' ')); } catch (e) {} _origErr(...a); };

// ---- native -> editor events --------------------------------------------------------------
// MainComponent.cpp calls these globals BY LITERAL NAME through evaluateJavascript
// (src/ui/MainComponent.cpp:879 etc.), so they must keep existing. They are now thin adapters
// that emit onto the backend's event bus; consumers subscribe with Audio.on(...).
window.gomidas = {
  onTick(tick) { Audio.emit('tick', { tick }); }
};
Audio.on('tick', ({ tick }) => { if (window.GomidasEditor) window.GomidasEditor.onPlayTick(tick); });

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
// Extracted + unit-tested in web/core/gomidas-core.js (see docs/TESTING.md); these are
// thin adapters so the shipping path and the tests share one implementation.
function beatTicks(beat) { return GomidasCore.beatTicks(beat); }

function dynamicsToVelocity(dyn) { return GomidasCore.dynamicsToVelocity(dyn); }

// Octave/clef line → MIDI semitone offset, so playback matches the displayed octave.
function ottavaSemitones(ott) {
  return GomidasCore.ottavaSemitones(ott, (window.alphaTab && alphaTab.model && alphaTab.model.Ottava) || null);
}

// Builds the native sequence AND a tick->beat map (primary track) for the cursor.
// Full duration of master bar i from its time signature (a bar always occupies
// its time-signature length; underfilled bars are padded with silence).
function masterBarTicks(score, i) { return GomidasCore.masterBarTicks(score.masterBars, i); }

// First MIDI channel not used by any track (and not the percussion channel 9), for the
// metronome's melodic wood-block. Returns -1 if all 16 are taken (then we use channel 9).
function freeMelodicChannel(score) { return GomidasCore.freeMelodicChannel(score); }

// Expand repeat barlines AND D.C./D.S. jumps into the order master bars are actually
// played. Repeat end (repeatCount>0) replays from the last repeat-start; a Da Capo /
// Dal Segno jump (executed once) returns to the start / Segno, optionally stopping at
// Fine. Alternate endings + al-Coda variants aren't handled. With no repeats/directions
// this is just [0,1,…,n-1], so plain scores are unchanged.
function computePlaybackOrder(score) {
  return GomidasCore.computePlaybackOrder(score,
    (typeof alphaTab !== 'undefined' && alphaTab.model && alphaTab.model.Direction) || null);
}

let metronomeOn = false;
// Toggle the metronome; rebuilds so the click events appear/disappear in the sequence.
window.gomidasToggleMetronome = function () {
  metronomeOn = !metronomeOn;
  if (api && api.score) rebuildSequence();
  return metronomeOn;
};
window.gomidasMetronomeOn = () => metronomeOn;
// A free melodic channel for the count-in click (editor reads this).
window.gomidasFreeClickChannel = function () { return (api && api.score) ? freeMelodicChannel(api.score) : 15; };

// Per-beat velocity multipliers for crescendo / diminuendo hairpins: a run of
// consecutive beats carrying the same crescendo type ramps 0.6→1.0 (cresc) or
// 1.0→0.6 (dim) across the span. Returns an array aligned to `beats`.
function crescendoFactors(beats) {
  return GomidasCore.crescendoFactors(beats, (alphaTab.model && alphaTab.model.CrescendoType) || null);
}

// Swing map for triplet-feel bars: warps a within-bar tick onto a triplet 8th grid
// (frac 0→0, 0.5→2/3, 1→1 — a monotonic 2:1 swing). Fixed at the 8th points so 8th
// pairs swing while bar boundaries stay put. ⚠ Timing feel — confirm by ear.
function swungTickInBar(rel) { return GomidasCore.swungTickInBar(rel); }

// Pitch-bend MIDI. alphaTab BendPoint.value is in 1/4 tones (4 = a full/whole-tone bend
// = 2 semitones), offset 0..60 across the note. The native bend range is ±12 semitones
// over the 14-bit wheel (8192 = centre).
function bendValueToSemitones(v) { return GomidasCore.bendValueToSemitones(v); }
function semitonesToWheel(semis) { return GomidasCore.semitonesToWheel(semis); }
// Emit pitch-bend events tracing a note's bend curve from onTick→offTick, then RESET the
// wheel to centre just before the note ends so following notes on the same channel aren't
// left detuned (the reset tick is fractional so it sorts before the next note-on).
// NOTE: pitch bend is per-CHANNEL — in a chord a bent note bends the whole channel. Fine
// for single-note lead bends; documented limitation. ⚠ confirm pitch by ear.
function emitBendEvents(events, channel, program, onTick, offTick, bendPoints) {
  return GomidasCore.emitBendEvents(events, channel, program, onTick, offTick, bendPoints);
}

function rebuildSequence() {
  const score = api.score;
  const model = (typeof alphaTab !== 'undefined' && alphaTab.model) || {};
  // The model→MIDI walk is extracted + unit-tested (see build-sequence.test.js). Here we
  // just feed it the alphaTab enums + session globals and do the two side effects.
  const { events, tickMap, lengthTicks } = GomidasCore.buildSequence(score, {
    primaryTrack: renderedTracks[0] || score.tracks[0],
    tripletFeel: model.TripletFeel,
    ottava: model.Ottava,
    crescendoType: model.CrescendoType,
    direction: model.Direction,
    metronomeOn: metronomeOn,
    drumGains: window.gomidasDrumGains || null,
  });
  window.gomidasTickMap = tickMap;
  Audio.setSequence({ lengthTicks, events });
  lastSequenceLength = lengthTicks;
}
window.gomidasRebuild = rebuildSequence;
let lastSequenceLength = 0;
window.gomidasSequenceLength = () => lastSequenceLength;
window.gomidasGetRenderedTracks = () => renderedTracks;

// Absolute tick of a cursor position, mirroring rebuildSequence's layout (each bar
// spans max(time-signature capacity, its filled length); within a bar, beats sum by
// duration). Used to start playback from the edit cursor instead of bar 1.
function tickForCursor(trackIndex, barIdx, voiceIdx, beatIdx) {
  if (!api || !api.score) return 0;
  const score = api.score;
  const track = score.tracks[trackIndex] || renderedTracks[0] || score.tracks[0];
  const stave = track && track.staves[0];
  if (!stave) return 0;
  // Walk the unrolled playback order to the FIRST time this bar is played, so the
  // seek lands at the right place even when earlier bars repeat.
  const order = computePlaybackOrder(score);
  let tick = 0;
  for (const mbIndex of order) {
    if (mbIndex === barIdx) break;
    const bar = stave.bars[mbIndex];
    let filled = 0;
    if (bar) for (const v of bar.voices) {
      let t = 0; for (const be of v.beats) t += beatTicks(be);
      if (t > filled) filled = t;
    }
    tick += Math.max(masterBarTicks(score, mbIndex), filled);
  }
  const bar = stave.bars[barIdx];
  const voice = bar && bar.voices[voiceIdx];
  if (voice) for (let j = 0; j < beatIdx && j < voice.beats.length; j++) tick += beatTicks(voice.beats[j]);
  return Math.round(tick);
}
// Seek the native transport to the edit cursor; returns the tick.
window.gomidasSeekToCursor = function (trackIndex, barIdx, voiceIdx, beatIdx) {
  const tick = tickForCursor(trackIndex | 0, barIdx | 0, voiceIdx | 0, beatIdx | 0);
  Audio.seek(tick);
  return tick;
};

// Set an A/B loop spanning a beat range [first..last] (inclusive) on one track/voice.
// End tick = the last beat's start + its own duration. Returns {startTick, endTick}.
window.gomidasSetLoopBars = function (trackIndex, bar0, voice0, beat0, bar1, voice1, beat1) {
  if (!api || !api.score) return null;
  const startTick = tickForCursor(trackIndex, bar0, voice0, beat0);
  const track = api.score.tracks[trackIndex] || renderedTracks[0] || api.score.tracks[0];
  const stave = track && track.staves[0];
  const lastVoice = stave && stave.bars[bar1] && stave.bars[bar1].voices[voice1];
  const lastBeat = lastVoice && lastVoice.beats[beat1];
  const endTick = tickForCursor(trackIndex, bar1, voice1, beat1) + (lastBeat ? beatTicks(lastBeat) : WHOLE_TICKS);
  Audio.setLoop(true, startTick, endTick);
  return { startTick, endTick };
};
window.gomidasClearLoop = function () { Audio.setLoop(false); };

// Push the loaded score's tempo to the native clock + the tempo field, so opening
// a file plays at its own tempo instead of a hard-coded 120.
function applyScoreTempo(score) {
  let bpm = score && score.tempo;
  if (!(bpm >= 20 && bpm <= 400)) bpm = 120;
  Audio.setTempo(bpm);
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
// GP F3: flip between the focused single track and the full multi-track view.
window.gomidasToggleMultiView = function () {
  if (viewMode === 'single') { window.gomidasShowMulti(); return; }
  const st = window.GomidasEditor && window.GomidasEditor.getState && window.GomidasEditor.getState();
  window.gomidasShowTrack(st ? st.curTrackIndex : 0);
};

function trackChannel(track) {
  // One rule for "which channel is this track on", shared with buildSequence — a drum track is
  // channel 9 whatever the file says, or the mixer would address a channel nothing plays on.
  return GomidasCore.trackChannelInfo(track).channel;
}

// MIDI channel of the currently-edited track (for per-track SFZ/instrument actions).
function currentTrackChannel() {
  if (!api || !api.score) return null;
  const st = window.GomidasEditor && window.GomidasEditor.getState && window.GomidasEditor.getState();
  const idx = st ? st.curTrackIndex : 0;
  const t = api.score.tracks[idx];
  return t ? trackChannel(t) : null;
}
window.gomidasCurrentTrackChannel = currentTrackChannel;

// Per-channel SFZ instrument name (session state; drives the inspector display).
window.gomidasTrackSfz = window.gomidasTrackSfz || {};

// Built-in SFZ instruments bundled in the app (Resources/instruments/<file>). All CC0.
// `kind` is for future per-track-kind filtering. Extend as more content is bundled.
window.gomidasSfzPresets = [
  { id: 'classical-guitar', name: 'Classical Guitar (CC0)', file: 'classical-guitar/classical-guitar.sfz', kind: 'guitar' },
  { id: 'electric-bass',    name: 'Electric Bass (CC0)',    file: 'electric-bass/electric-bass.sfz',       kind: 'bass' },
];

// Load a built-in preset onto the current track (native resolves the bundle path;
// gomidasSfzLoaded fires with the result and updates the inspector).
window.gomidasLoadSfzPreset = function (p) {
  const ch = currentTrackChannel();
  if (ch == null || !p) return;
  Audio.loadTrackPreset(ch, p);
};

// Native reports the result of a per-track instrument load. The global is the C++ entry point
// (MainComponent.cpp:354/379) and only adapts onto the bus; the handler is the real consumer.
window.gomidasSfzLoaded = function (channel, ok, name) {
  Audio.emit('instrumentLoaded', { channel, ok, name });
};
Audio.on('instrumentLoaded', ({ channel, ok, name }) => {
  if (ok) window.gomidasTrackSfz[channel] = name;
  setStatus(ok ? ('SFZ instrument loaded: ' + name) : 'SFZ load failed');
  if (window.gomidasRefreshInspector) window.gomidasRefreshInspector();
});

// Clear the SFZ instrument on the current track (back to the GM SoundFont).
window.gomidasClearTrackSfz = function () {
  const ch = currentTrackChannel();
  if (ch == null) return;
  Audio.clearTrackInstrument(ch);
  delete window.gomidasTrackSfz[ch];
  setStatus('SFZ instrument cleared');
  if (window.gomidasRefreshInspector) window.gomidasRefreshInspector();
};
// Compute each track's live gain (volume × mute/solo) + pan and push to the engine.
// Mute = gain 0; with any track soloed, non-soloed tracks are silenced.
function applyMixer() {
  if (!api || !api.score) return;
  const flags = window.gomidasTrackFlags || {};
  const anySolo = GomidasCore.anyTrackSoloed(api.score.tracks, flags);
  api.score.tracks.forEach((track, i) => {
    const f = flags[i] || {};
    // Gain (vol × mute/solo) + pan resolution is extracted + unit-tested (see mixer.test.js).
    const { gain, pan } = GomidasCore.computeChannelMix(track, f, anySolo);
    const ch = trackChannel(track);
    Audio.setChannelMix(ch, gain, pan);
    if (f.eq) Audio.setTrackEq(ch, f.eq.low || 0, f.eq.mid || 0, f.eq.high || 0);
  });
  applyMaster();
}
window.gomidasApplyMixer = applyMixer;
// Back-compat: the track list calls this after toggling eye/mute/solo/volume.
window.gomidasApplyTrackFlags = function () { window.gomidasShowMulti(); applyMixer(); };

// Master output: volume (linear) + balance pan + 3-band EQ (dB). Persisted in
// gomidasMaster and pushed to the engine.
window.gomidasMaster = window.gomidasMaster || { vol: 1, pan: 0.5, eq: { low: 0, mid: 0, high: 0 } };
function applyMaster() {
  const m = window.gomidasMaster;
  Audio.setMasterMix(Math.max(0, Math.min(1.5, m.vol)), Math.max(0, Math.min(1, m.pan)));
  Audio.setMasterEq(m.eq.low || 0, m.eq.mid || 0, m.eq.high || 0);
}
window.gomidasApplyMaster = applyMaster;
// Direct EQ setters (used by the EQ popups for live feedback while dragging).
window.gomidasSetTrackEq = function (channel, low, mid, high) {
  Audio.setTrackEq(channel, low, mid, high);
};
window.gomidasSetMasterEq = function (low, mid, high) {
  Audio.setMasterEq(low, mid, high);
};

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
const DRUM_REG = '(49 55 52 51 53 46 42 44 48 47 43 38 37 39 54 56 36).1';
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

// ---- panel collapse / full-view (session view state) ------------------------
// alphaTab doesn't always reflow on container resize; force a re-render shortly
// after a layout change so the score uses the new width.
function reflowScore() { setTimeout(() => { try { if (api) api.render(); } catch (e) {} }, 40); }
const PANEL_CLASS = { palette: 'hide-palette', inspector: 'hide-inspector', tracks: 'hide-tracks', fretboard: 'hide-fretboard' };
function togglePanel(which) {
  const cls = PANEL_CLASS[which]; if (!cls) return;
  const hidden = document.body.classList.toggle(cls);
  const btn = document.querySelector('#transport [data-act="toggle:' + which + '"]');
  if (btn) btn.classList.toggle('on', !hidden); // .on = panel visible
  reflowScore();
}
// Collapsible "drawer" handle on each dockable panel. Clicking collapses the panel to a
// thin rail (chevron flips). State persists. Panels that rebuild via innerHTML (#inspector/
// #tracks/#fretboard) wipe the handle but keep their .collapsed class, so a MutationObserver
// re-appends the handle; the rebuilt content stays hidden by CSS while collapsed.
function chevronFor(side, collapsed) {
  if (side === 'left') return collapsed ? '»' : '«';   // » / «
  if (side === 'right') return collapsed ? '«' : '»';
  return collapsed ? '▴' : '▾';                        // ▴ / ▾
}
function initDrawers() {
  const defs = [
    { id: 'palette', side: 'left', title: 'Tools' }, { id: 'inspector', side: 'right', title: 'Inspector' },
    { id: 'beatlane-panel', side: 'bottom', title: 'Beat Grid' }, { id: 'fretboard', side: 'bottom', title: 'Fretboard' },
    { id: 'tracks', side: 'bottom', title: 'Tracks' },
  ];
  for (const d of defs) {
    const el = document.getElementById(d.id); if (!el) continue;
    el.classList.add('drawerable', 'drawer-' + d.side);
    const tab = document.createElement('button');
    tab.className = 'drawer-tab'; tab.type = 'button'; tab.title = 'Collapse / expand panel';
    tab.innerHTML = '<span class="drawer-chev"></span><span class="drawer-title"></span>';
    tab.querySelector('.drawer-title').textContent = d.title;
    const chev = tab.querySelector('.drawer-chev');
    const key = 'gomidasDrawer_' + d.id;
    const setGlyph = () => { chev.textContent = chevronFor(d.side, el.classList.contains('collapsed')); };
    const apply = (collapsed, persist) => {
      el.classList.toggle('collapsed', collapsed); setGlyph();
      if (persist) try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch (e) {}
      reflowScore();
      if (d.id === 'beatlane-panel' && !collapsed && window.GomidasEditor && window.GomidasEditor.redrawLane)
        requestAnimationFrame(() => window.GomidasEditor.redrawLane());
    };
    tab.addEventListener('click', (e) => { e.stopPropagation(); apply(!el.classList.contains('collapsed'), true); });
    el.appendChild(tab);
    new MutationObserver(() => { if (!el.contains(tab)) { el.appendChild(tab); setGlyph(); } }).observe(el, { childList: true });
    let collapsed = false; try { collapsed = localStorage.getItem(key) === '1'; } catch (e) {}
    apply(collapsed, false);
  }
}

function toggleFullScore() {
  const on = document.body.classList.toggle('fullscore');
  const btn = document.getElementById('fullscore-btn');
  if (btn) btn.classList.toggle('on', on);
  reflowScore();
}
window.gomidasTogglePanel = togglePanel;
window.gomidasToggleFullScore = toggleFullScore;

// ---- drum groove preview + capture (pattern library) ------------------------
// The card ▶ loops the groove as an audition; clicking it again (or starting transport
// playback) stops it. gomidasGroovePreviewName drives the ▶/■ state on the cards.
let groovePreviewTimers = [];
let groovePreviewName = null;
function refreshGrooveUI() {
  if (window.GomidasUI && window.GomidasEditor && window.GomidasEditor.getState)
    window.GomidasUI.refresh(window.GomidasEditor.getState());
}
function stopGroovePreview() {
  if (!groovePreviewTimers.length && groovePreviewName == null) return;
  groovePreviewTimers.forEach(clearTimeout); groovePreviewTimers = [];
  groovePreviewName = null;
  Audio.preview(9, 0, true, []); // silence ringing hits
  refreshGrooveUI();
}
window.gomidasStopGroovePreview = stopGroovePreview;
window.gomidasGroovePreviewName = function () { return groovePreviewName; };
window.gomidasPreviewGroove = function (groove) {
  const G = window.GomidasGrooves;
  if (!G || !groove) return;
  if (groovePreviewName === groove.name) { stopGroovePreview(); return; } // toggle off
  groovePreviewTimers.forEach(clearTimeout); groovePreviewTimers = [];
  groovePreviewName = groove.name;
  const lanes = (groove.bars ? groove.bars[0].lanes : groove.lanes) || {};
  const tf = document.getElementById('tempo');
  const bpm = (tf && parseInt(tf.value, 10)) || 120;
  const stepMs = Math.max(45, (60000 / bpm) / 4); // 16th-note step
  const playOnce = () => {
    groovePreviewTimers = []; // previous bar's timers have all fired by now
    for (let s = 0; s < 16; s++) {
      const keys = [];
      for (const lane in lanes) { if (lanes[lane][s]) { const m = G.LANE_MIDI[lane]; if (m != null) keys.push(m); } }
      if (keys.length)
        groovePreviewTimers.push(setTimeout(() => Audio.preview(9, 0, true, keys), s * stepMs));
    }
    groovePreviewTimers.push(setTimeout(() => { if (groovePreviewName) playOnce(); }, stepMs * 16)); // loop the bar
  };
  playOnce();
  refreshGrooveUI();
};
// "Add Pattern": capture the current bar as a reusable User Groove.
window.gomidasAddGrooveFromBar = function () {
  const E = window.GomidasEditor, G = window.GomidasGrooves;
  if (!E || !G) return;
  if (!E.isPercussion || !E.isPercussion()) { setStatus('Add Pattern: select a drum track first'); return; }
  const grid = E.readBarGrid();
  const name = (window.prompt && window.prompt('Name this groove:', 'My Groove')) || '';
  if (!name.trim()) return;
  G.addUserGroove(name.trim(), grid.lanes);
  if (window.GomidasUI && E.getState) window.GomidasUI.refresh(E.getState());
  setStatus('Saved groove "' + name.trim() + '"');
};

// ---- modal (New dialog + unsaved-changes confirm) ---------------------------
const modalOverlay = document.getElementById('modal-overlay');
const modalBox = document.getElementById('modal-box');
function hideModal() { modalOverlay.classList.remove('show'); modalBox.innerHTML = ''; focusEditor(); }
function showModal() { modalOverlay.classList.add('show'); }
modalOverlay.addEventListener('mousedown', (e) => { if (e.target === modalOverlay) hideModal(); });

// ---- custom tunings (author + save/load, persisted in localStorage) ----------
function userTuningList() { try { return JSON.parse(localStorage.getItem('gomidasUserTunings') || '[]'); } catch (e) { return []; } }
function saveUserTuning(name, midis) {
  const list = userTuningList().filter(t => t.name !== name);
  list.push({ name: String(name).slice(0, 40), midis: midis.slice() });
  try { localStorage.setItem('gomidasUserTunings', JSON.stringify(list)); } catch (e) {}
}
window.gomidasUserTunings = userTuningList;
window.gomidasSaveUserTuning = saveUserTuning;

const TUN_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToTuningName(m) { return TUN_NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
// Per-string tuning editor: pick each string's pitch (high→low), Apply, optionally Save.
function openTuningEditor(midis, onApply) {
  let cur = (midis && midis.length) ? midis.slice() : [64, 59, 55, 50, 45, 40];
  const noteOpts = (sel) => { let o = ''; for (let m = 24; m <= 84; m++) o += '<option value="' + m + '"' + (m === sel ? ' selected' : '') + '>' + midiToTuningName(m) + '</option>'; return o; };
  function render() {
    modalBox.innerHTML =
      '<div class="modal-h">Custom tuning</div>' +
      '<div class="modal-body"><div class="m-msg">Set each string’s pitch (string 1 = highest). Frets are kept; pitches shift.</div>' +
        '<div class="m-tunstrings" id="te-strings">' +
          cur.map((m, i) => '<div class="m-row" style="align-items:center;gap:8px;margin:4px 0">' +
            '<span style="width:64px;color:var(--dim);font-size:12px">String ' + (i + 1) + '</span>' +
            '<select class="te-note" data-i="' + i + '">' + noteOpts(m) + '</select></div>').join('') +
        '</div>' +
        '<div class="m-field" style="margin-top:10px"><label>Save as (optional)</label><input type="text" id="te-name" placeholder="My tuning"></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="m-btn ghost" id="te-cancel">Cancel</button>' +
        '<button class="m-btn" id="te-save">Save &amp; apply</button>' +
        '<button class="m-btn primary" id="te-apply">Apply</button>' +
      '</div>';
    wire();
  }
  function readStrings() {
    return Array.from(modalBox.querySelectorAll('.te-note')).map(s => parseInt(s.value, 10));
  }
  function wire() {
    modalBox.querySelectorAll('.te-note').forEach(s => s.onchange = () => { cur = readStrings(); });
    document.getElementById('te-cancel').onclick = hideModal;
    document.getElementById('te-apply').onclick = () => { const m = readStrings(); hideModal(); if (onApply) onApply(m); };
    document.getElementById('te-save').onclick = () => {
      const m = readStrings();
      const nm = (document.getElementById('te-name').value || '').trim();
      if (nm) saveUserTuning(nm, m);
      hideModal(); if (onApply) onApply(m);
    };
  }
  render();
  showModal();
}
window.gomidasOpenTuningEditor = openTuningEditor;

// ---- bend dialog (GP "B") — preset bend shapes on the current note ----------
function openBendDialog() {
  const E = window.GomidasEditor; if (!E) return;
  const opts = [
    ['full', 'Bend — full (whole step)'],
    ['half', 'Bend — half (½ step)'],
    ['fullrelease', 'Bend & Release'],
    ['prebend', 'Pre-bend (hold)'],
    ['prebendrelease', 'Pre-bend & Release'],
    ['none', 'Remove bend'],
  ];
  modalBox.innerHTML =
    '<div class="modal-h">Bend</div>' +
    '<div class="modal-body"><div class="m-msg">Apply a bend to the note under the cursor.</div>' +
      opts.map(([k, l]) => '<button class="m-btn bendopt" data-k="' + k + '" style="display:block;width:100%;margin:5px 0;text-align:left">' + l + '</button>').join('') +
    '</div>' +
    '<div class="modal-foot"><button class="m-btn ghost" id="bend-cancel">Cancel</button></div>';
  showModal();
  document.getElementById('bend-cancel').onclick = hideModal;
  modalBox.querySelectorAll('.bendopt').forEach(b => b.onclick = () => { E.setBend(b.dataset.k); hideModal(); });
}
window.gomidasOpenBend = openBendDialog;

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

// GP8-style "Go To" (Cmd+G): jump the cursor to a bar number.
function openGoToDialog() {
  const E = window.GomidasEditor;
  if (!E) return;
  const st = E.getState ? E.getState() : null;
  const nBars = (api && api.score) ? api.score.masterBars.length : 1;
  const cur = st ? (parseInt((st.pos.match(/bar (\d+)/) || [])[1], 10) || 1) : 1;
  modalBox.innerHTML =
    '<div class="modal-h">Go to bar</div>' +
    '<div class="modal-body"><div class="m-field"><label>Bar number (1–' + nBars + ')</label>' +
      '<input type="number" id="gt-bar" min="1" max="' + nBars + '" value="' + cur + '"></div></div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="gt-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="gt-ok">Go</button>' +
    '</div>';
  showModal();
  const input = document.getElementById('gt-bar');
  if (input) { input.focus(); input.select(); }
  const go = () => { const n = parseInt(input.value, 10); hideModal(); if (n >= 1) E.goToBar(n); };
  document.getElementById('gt-cancel').onclick = hideModal;
  document.getElementById('gt-ok').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); else if (e.key === 'Escape') hideModal(); };
}
window.gomidasOpenGoTo = openGoToDialog;

// GP8 "Time Signature" (Cmd+T): set the current bar onward to a new time signature.
function openTimeSigDialog() {
  const E = window.GomidasEditor;
  if (!E) return;
  const st = E.getState ? E.getState() : null;
  const num = st ? st.timeSigNum : 4, den = st ? st.timeSigDen : 4;
  const bar = st ? (st.curBar + 1) : 1;
  modalBox.innerHTML =
    '<div class="modal-h">Time signature</div>' +
    '<div class="modal-body"><div class="m-msg" style="margin-bottom:8px;color:var(--dim)">From bar ' + bar + ' to the end.</div>' +
      '<div class="m-row"><div class="m-field"><label>Beats</label>' +
        '<input type="number" id="ts-num" min="1" max="32" value="' + num + '" style="width:64px"></div>' +
        '<span style="align-self:flex-end;padding-bottom:8px;color:var(--dim)">/</span>' +
        '<div class="m-field"><label>Note value</label><select id="ts-den">' +
          [1, 2, 4, 8, 16, 32].map(d => '<option' + (d === den ? ' selected' : '') + '>' + d + '</option>').join('') +
        '</select></div></div></div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="ts-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="ts-ok">Apply</button>' +
    '</div>';
  showModal();
  const numEl = document.getElementById('ts-num');
  if (numEl) { numEl.focus(); numEl.select(); }
  const apply = () => {
    const n = parseInt(numEl.value, 10), d = parseInt(document.getElementById('ts-den').value, 10);
    hideModal(); E.setTimeSignature(n, d);
  };
  document.getElementById('ts-cancel').onclick = hideModal;
  document.getElementById('ts-ok').onclick = apply;
  numEl.onkeydown = (e) => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') hideModal(); };
}
window.gomidasOpenTimeSig = openTimeSigDialog;

// GP8 "Key Signature" (Cmd+K): set the current bar onward. Value = accidental count
// (−7..+7); a Minor checkbox flips the key type (relative minor shares the value).
const KEY_NAMES = [
  { v: -7, major: 'Cb', minor: 'Ab' }, { v: -6, major: 'Gb', minor: 'Eb' },
  { v: -5, major: 'Db', minor: 'Bb' }, { v: -4, major: 'Ab', minor: 'F' },
  { v: -3, major: 'Eb', minor: 'C' },  { v: -2, major: 'Bb', minor: 'G' },
  { v: -1, major: 'F',  minor: 'D' },  { v: 0,  major: 'C',  minor: 'A' },
  { v: 1,  major: 'G',  minor: 'E' },  { v: 2,  major: 'D',  minor: 'B' },
  { v: 3,  major: 'A',  minor: 'F#' }, { v: 4,  major: 'E',  minor: 'C#' },
  { v: 5,  major: 'B',  minor: 'G#' }, { v: 6,  major: 'F#', minor: 'D#' },
  { v: 7,  major: 'C#', minor: 'A#' }
];
function keyOptions(value, minor) {
  return KEY_NAMES.map(k => {
    const name = (minor ? k.minor + 'm' : k.major) +
      (k.v === 0 ? '' : ' (' + Math.abs(k.v) + (k.v > 0 ? '♯' : '♭') + ')');
    return '<option value="' + k.v + '"' + (k.v === value ? ' selected' : '') + '>' + name + '</option>';
  }).join('');
}
function openKeySigDialog() {
  const E = window.GomidasEditor;
  if (!E) return;
  const st = E.getState ? E.getState() : null;
  const value = st ? st.keySig : 0, minor = st ? st.keySigMinor : false;
  const bar = st ? (st.curBar + 1) : 1;
  function render() {
    const min = document.getElementById('ks-minor') ? document.getElementById('ks-minor').checked : minor;
    const val = document.getElementById('ks-key') ? parseInt(document.getElementById('ks-key').value, 10) : value;
    modalBox.innerHTML =
      '<div class="modal-h">Key signature</div>' +
      '<div class="modal-body"><div class="m-msg" style="margin-bottom:8px;color:var(--dim)">From bar ' + bar + ' to the end.</div>' +
        '<div class="m-field"><label>Key</label><select id="ks-key">' + keyOptions(val, min) + '</select></div>' +
        '<label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="ks-minor"' + (min ? ' checked' : '') + '> Minor</label>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="m-btn ghost" id="ks-cancel">Cancel</button>' +
        '<button class="m-btn primary" id="ks-ok">Apply</button>' +
      '</div>';
    document.getElementById('ks-minor').onchange = render; // re-label options major↔minor
    document.getElementById('ks-cancel').onclick = hideModal;
    document.getElementById('ks-ok').onclick = () => {
      const v = parseInt(document.getElementById('ks-key').value, 10);
      const m = document.getElementById('ks-minor').checked;
      hideModal(); E.setKeySignature(v, m);
    };
  }
  render();
  showModal();
}
window.gomidasOpenKeySig = openKeySigDialog;

// GP8 "Text" (T): attach a free-text annotation to the current beat (blank clears it).
function openTextDialog() {
  const E = window.GomidasEditor;
  if (!E) return;
  const cur = (E.getBeatText && E.getBeatText()) || '';
  const safe = cur.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  modalBox.innerHTML =
    '<div class="modal-h">Beat text</div>' +
    '<div class="modal-body"><div class="m-field"><label>Text (blank to clear)</label>' +
      '<input type="text" id="bt-text" value="' + safe + '" placeholder="e.g. Intro, x4, Solo"></div></div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="bt-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="bt-ok">Apply</button>' +
    '</div>';
  showModal();
  const input = document.getElementById('bt-text');
  if (input) { input.focus(); input.select(); }
  const apply = () => { const v = input.value; hideModal(); E.setBeatText(v); };
  document.getElementById('bt-cancel').onclick = hideModal;
  document.getElementById('bt-ok').onclick = apply;
  input.onkeydown = (e) => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') hideModal(); };
}
window.gomidasOpenText = openTextDialog;

// Lyrics: attach a lyric syllable to the current beat (blank clears it).
function openLyricsDialog() {
  const E = window.GomidasEditor;
  if (!E) return;
  const cur = (E.getLyrics && E.getLyrics()) || '';
  const safe = cur.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  modalBox.innerHTML =
    '<div class="modal-h">Lyrics</div>' +
    '<div class="modal-body"><div class="m-field"><label>Syllable for this beat (blank to clear)</label>' +
      '<input type="text" id="ly-text" value="' + safe + '" placeholder="e.g. love"></div></div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="ly-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="ly-ok">Apply</button>' +
    '</div>';
  showModal();
  const input = document.getElementById('ly-text');
  if (input) { input.focus(); input.select(); }
  const apply = () => { const v = input.value; hideModal(); E.setLyrics(v); };
  document.getElementById('ly-cancel').onclick = hideModal;
  document.getElementById('ly-ok').onclick = apply;
  input.onkeydown = (e) => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') hideModal(); };
}
window.gomidasOpenLyrics = openLyricsDialog;

// Tools → Transpose: shift the current beat or the whole track by N semitones.
function openTransposeDialog() {
  const E = window.GomidasEditor;
  if (!E) return;
  modalBox.innerHTML =
    '<div class="modal-h">Transpose</div>' +
    '<div class="modal-body">' +
      '<div class="m-field"><label>Semitones (−24 to +24)</label>' +
        '<input type="number" id="tr-amt" min="-24" max="24" value="0"></div>' +
      '<div class="m-field" style="margin-top:8px"><label>Scope</label><select id="tr-scope">' +
        '<option value="track">Whole track</option>' +
        '<option value="beat">Current beat</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="tr-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="tr-ok">Transpose</button>' +
    '</div>';
  showModal();
  const amt = document.getElementById('tr-amt');
  if (amt) { amt.focus(); amt.select(); }
  const apply = () => {
    const n = Math.max(-24, Math.min(24, parseInt(amt.value, 10) || 0));
    const scope = document.getElementById('tr-scope').value;
    hideModal(); E.transpose(n, scope);
  };
  document.getElementById('tr-cancel').onclick = hideModal;
  document.getElementById('tr-ok').onclick = apply;
  amt.onkeydown = (e) => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') hideModal(); };
}
window.gomidasOpenTranspose = openTransposeDialog;

// Track-options "⋮" menu: rename + mixer toggles + add/delete, over existing funcs.
function openTrackMenu(idx) {
  const E = window.GomidasEditor;
  if (!E) return;
  const st = E.getState ? E.getState() : null;
  const tr = st && st.allTracks && st.allTracks[idx];
  const name = tr ? tr.name : ('Track ' + (idx + 1));
  const safe = String(name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const flag = () => (window.gomidasTrackFlags[idx] || (window.gomidasTrackFlags[idx] = {}));
  const f = flag();
  modalBox.innerHTML =
    '<div class="modal-h">' + safe + '</div>' +
    '<div class="modal-body">' +
      '<div class="m-field"><label>Rename track</label><input type="text" id="tm-name" value="' + safe + '"></div>' +
      '<div class="m-row" style="margin-top:10px;flex-wrap:wrap;gap:6px">' +
        '<button class="m-btn ghost" id="tm-mute">' + (f.muted ? 'Unmute' : 'Mute') + '</button>' +
        '<button class="m-btn ghost" id="tm-solo">' + (f.soloed ? 'Unsolo' : 'Solo') + '</button>' +
        '<button class="m-btn ghost" id="tm-hide">' + (f.hidden ? 'Show' : 'Hide') + '</button>' +
      '</div>' +
      '<div class="m-row" style="margin-top:6px;flex-wrap:wrap;gap:6px">' +
        '<button class="m-btn ghost" id="tm-add-g">+ Guitar</button>' +
        '<button class="m-btn ghost" id="tm-add-b">+ Bass</button>' +
        '<button class="m-btn ghost" id="tm-add-d">+ Drums</button>' +
        '<button class="m-btn ghost" id="tm-del" style="color:#e66">Delete track</button>' +
      '</div>' +
    '</div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="tm-cancel">Close</button>' +
      '<button class="m-btn primary" id="tm-ok">Apply name</button>' +
    '</div>';
  showModal();
  E.selectTrack(idx);
  const nameEl = document.getElementById('tm-name');
  if (nameEl) { nameEl.focus(); nameEl.select(); }
  const refreshUI = () => { if (window.GomidasUI && E.getState) window.GomidasUI.refresh(E.getState()); };
  const applyName = () => { const v = nameEl.value; hideModal(); if (v && v.trim()) E.setTrackName(v.trim()); };
  document.getElementById('tm-ok').onclick = applyName;
  document.getElementById('tm-cancel').onclick = hideModal;
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') applyName(); else if (e.key === 'Escape') hideModal(); };
  document.getElementById('tm-mute').onclick = () => { flag().muted = !flag().muted; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); hideModal(); refreshUI(); };
  document.getElementById('tm-solo').onclick = () => { flag().soloed = !flag().soloed; if (window.gomidasApplyMixer) window.gomidasApplyMixer(); hideModal(); refreshUI(); };
  document.getElementById('tm-hide').onclick = () => { flag().hidden = !flag().hidden; if (window.gomidasShowMulti) window.gomidasShowMulti(); hideModal(); };
  document.getElementById('tm-add-g').onclick = () => { hideModal(); E.addTrack('guitar'); };
  document.getElementById('tm-add-b').onclick = () => { hideModal(); E.addTrack('bass'); };
  document.getElementById('tm-add-d').onclick = () => { hideModal(); E.addTrack('drums'); };
  document.getElementById('tm-del').onclick = () => { hideModal(); E.deleteTrack(); };
}
window.gomidasOpenTrackMenu = openTrackMenu;

// 3-band EQ popup (Low/Mid/High in dB). target: { master:true } or { idx:trackIndex }.
// Drags update the engine live; Cancel reverts to the stored values. EQ is session-live
// (held in gomidasTrackFlags[i].eq / gomidasMaster.eq) — not yet saved to .gomidas.
function openEqDialog(target) {
  if (!api || !api.score) return;
  const isMaster = !!target.master;
  const stored = isMaster
    ? Object.assign({ low: 0, mid: 0, high: 0 }, window.gomidasMaster.eq)
    : Object.assign({ low: 0, mid: 0, high: 0 }, (window.gomidasTrackFlags[target.idx] || {}).eq || {});
  const channel = isMaster ? -1 : trackChannel(api.score.tracks[target.idx]);
  const tname = isMaster ? 'Master EQ'
    : ('EQ — ' + ((api.score.tracks[target.idx] || {}).name || ('Track ' + (target.idx + 1))));
  const row = (id, label, val) =>
    '<div class="m-field"><label>' + label + ' (<span id="eq-' + id + '-v">' + val + '</span> dB)</label>' +
    '<input type="range" id="eq-' + id + '" min="-12" max="12" step="0.5" value="' + val + '"></div>';
  modalBox.innerHTML =
    '<div class="modal-h">' + tname + '</div>' +
    '<div class="modal-body">' +
      row('low', 'Low', stored.low) + row('mid', 'Mid', stored.mid) + row('high', 'High', stored.high) +
      '<button class="m-btn ghost" id="eq-reset" style="margin-top:8px">Reset (flat)</button>' +
    '</div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="eq-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="eq-ok">Apply</button>' +
    '</div>';
  showModal();
  const get = (id) => parseFloat(document.getElementById('eq-' + id).value) || 0;
  const push = (lo, mi, hi) => { if (isMaster) window.gomidasSetMasterEq(lo, mi, hi); else window.gomidasSetTrackEq(channel, lo, mi, hi); };
  const live = () => {
    const lo = get('low'), mi = get('mid'), hi = get('high');
    document.getElementById('eq-low-v').textContent = lo;
    document.getElementById('eq-mid-v').textContent = mi;
    document.getElementById('eq-high-v').textContent = hi;
    push(lo, mi, hi);
  };
  ['low', 'mid', 'high'].forEach(id => document.getElementById('eq-' + id).addEventListener('input', live));
  document.getElementById('eq-reset').onclick = () => { ['low', 'mid', 'high'].forEach(id => { document.getElementById('eq-' + id).value = 0; }); live(); };
  document.getElementById('eq-ok').onclick = () => {
    const eq = { low: get('low'), mid: get('mid'), high: get('high') };
    if (isMaster) window.gomidasMaster.eq = eq;
    else (window.gomidasTrackFlags[target.idx] || (window.gomidasTrackFlags[target.idx] = {})).eq = eq;
    push(eq.low, eq.mid, eq.high);
    hideModal();
  };
  document.getElementById('eq-cancel').onclick = () => { push(stored.low, stored.mid, stored.high); hideModal(); };
}
window.gomidasOpenEq = openEqDialog;

// GP8 "Chord" (A): name the chord on the current beat, with an optional fret diagram
// (comma/space-separated frets per string in alphaTab order; x or - = unplayed).
function openChordDialog() {
  const E = window.GomidasEditor;
  if (!E || !E.getBeatChord) return;
  const cur = E.getBeatChord() || { name: '', frets: [] };
  const nameSafe = String(cur.name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const fretsStr = (cur.frets || []).map(f => (f < 0 ? 'x' : f)).join(' ');
  modalBox.innerHTML =
    '<div class="modal-h">Chord</div>' +
    '<div class="modal-body">' +
      '<div class="m-field"><label>Name (blank to clear)</label><input type="text" id="ch-name" value="' + nameSafe + '" placeholder="e.g. Cmaj7"></div>' +
      '<div class="m-field" style="margin-top:8px"><label>Frets per string — optional (e.g. x 3 2 0 1 0)</label>' +
        '<input type="text" id="ch-frets" value="' + fretsStr + '" placeholder="x 3 2 0 1 0"></div>' +
    '</div>' +
    '<div class="modal-foot">' +
      '<button class="m-btn ghost" id="ch-cancel">Cancel</button>' +
      '<button class="m-btn primary" id="ch-ok">Apply</button>' +
    '</div>';
  showModal();
  const nameEl = document.getElementById('ch-name');
  if (nameEl) { nameEl.focus(); nameEl.select(); }
  const apply = () => {
    const name = nameEl.value;
    const raw = document.getElementById('ch-frets').value.trim();
    const frets = raw ? raw.split(/[\s,]+/).map(t => (/^[x\-]$/i.test(t) ? -1 : (parseInt(t, 10)))).filter(n => !isNaN(n)) : [];
    hideModal();
    E.setBeatChord(name, frets);
  };
  document.getElementById('ch-cancel').onclick = hideModal;
  document.getElementById('ch-ok').onclick = apply;
  nameEl.onkeydown = (e) => { if (e.key === 'Enter') apply(); else if (e.key === 'Escape') hideModal(); };
}
window.gomidasOpenChord = openChordDialog;

// Keep keyboard focus in the score area so editor keys are received.
function focusEditor() { try { window.focus(); document.getElementById('at-wrap').focus(); } catch (e) {} }

// ---- project save / load (.gomidas = alphaTab score JSON) --------------------
// Fold the live mixer's per-track volume/pan back into the score's playbackInfo so
// they persist in the .gomidas (mute/solo/hidden are session-only and not saved).
function syncMixerToScore() {
  if (!api || !api.score) return;
  const flags = window.gomidasTrackFlags || {};
  api.score.tracks.forEach((t, i) => {
    const f = flags[i];
    if (!f || !t.playbackInfo) return;
    if (typeof f.vol === 'number') t.playbackInfo.volume = Math.round(Math.max(0, Math.min(1, f.vol)) * 16);
    if (typeof f.pan === 'number') t.playbackInfo.balance = Math.round(Math.max(0, Math.min(1, f.pan)) * 16);
  });
}
function saveProject() {
  syncMixerToScore();
  const scoreJson = window.GomidasEditor && window.GomidasEditor.snapshot();
  if (!scoreJson) return;
  // Wrap the score JSON in a Gomidas envelope so per-track SFZ instruments persist.
  // Only built-in presets are persisted (matched by name) — custom file loads are
  // session-only (absolute paths are fragile). Old raw-score .gomidas files still load.
  const instruments = {};
  const presets = window.gomidasSfzPresets || [];
  const sfz = window.gomidasTrackSfz || {};
  for (const ch in sfz) {
    const p = presets.find(x => x.name === sfz[ch]);
    if (p) instruments[String(ch)] = p.id;
  }
  // Per-track + master EQ (and master vol/pan) are session-live elsewhere; persist them
  // here in the envelope (track vol/pan already ride in playbackInfo). Keyed by track index.
  const mix = { tracks: {}, master: null };
  const flags = window.gomidasTrackFlags || {};
  for (const i in flags) if (flags[i] && flags[i].eq) mix.tracks[i] = { eq: flags[i].eq };
  if (window.gomidasMaster) {
    const m = window.gomidasMaster;
    mix.master = { vol: m.vol, pan: m.pan, eq: Object.assign({ low: 0, mid: 0, high: 0 }, m.eq || {}) };
  }
  // Effect chains (GMD-35). Written on BOTH products: desktop does not render them yet but must
  // not lose them (WEB_PORT §5.2).
  const fx = (window.gomidasTrackFx && Object.keys(window.gomidasTrackFx).length) || window.gomidasMasterFx
    ? { tracks: window.gomidasTrackFx || {}, master: window.gomidasMasterFx || null }
    : null;
  const payload = JSON.stringify(GomidasCore.buildEnvelope(scoreJson, { instruments, mix, fx }));
  Host.saveProject(payload);
  if (window.GomidasEditor.markClean) window.GomidasEditor.markClean();
}
function openProject() { Host.openProject(); }
// Export the current score to a Guitar Pro (.gp) file via alphaTab's Gp7Exporter,
// then hand the bytes (base64) to the native save dialog.
function exportGp() {
  const Exp = alphaTab.exporter && alphaTab.exporter.Gp7Exporter;
  if (!Exp || !api || !api.score) { setStatus('GP export unavailable'); return; }
  try {
    syncMixerToScore();
    const exporter = new Exp();
    const fn = exporter.export || exporter.exportScore;
    const data = fn.call(exporter, api.score, api.settings);   // Uint8Array
    const bytes = new Uint8Array(data);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    Host.saveBinary('gp', btoa(bin));
    setStatus('Exported .gp (' + bytes.length + ' bytes)');
  } catch (e) { setStatus('GP export failed: ' + e); nlog('exportGp: ' + (e && e.stack || e)); }
}
window.gomidasExportGp = exportGp;
// Called by native after reading a .gomidas file. Accepts both the new Gomidas
// envelope ({ gomidasVersion, instruments, score }) and the legacy raw-score JSON.
window.gomidasLoadProject = function (json) {
  // Envelope vs legacy raw-score parsing is extracted + unit-tested (see envelope.test.js).
  const parsed = GomidasCore.parseEnvelope(json);
  let scoreJson = parsed.scoreJson, instruments = parsed.instruments, mix = parsed.mix, fx = parsed.fx;
  // Clear SFZ instruments left on the engine by the previous project, then reset state.
  const prev = window.gomidasTrackSfz || {};
  for (const ch in prev) Audio.clearTrackInstrument(parseInt(ch, 10));
  window.gomidasTrackSfz = {};
  if (window.GomidasEditor && window.GomidasEditor.loadProject(scoreJson)) {
    if (instruments) {
      const presets = window.gomidasSfzPresets || [];
      for (const ch in instruments) {
        const p = presets.find(x => x.id === instruments[ch]);
        if (p) Audio.loadTrackPreset(parseInt(ch, 10), p);
      }
    }
    // Restore per-track + master EQ (loadProject reset gomidasTrackFlags to {}).
    if (mix) {
      if (mix.tracks) for (const i in mix.tracks) {
        if (!mix.tracks[i] || !mix.tracks[i].eq) continue;
        (window.gomidasTrackFlags[i] || (window.gomidasTrackFlags[i] = {})).eq = mix.tracks[i].eq;
      }
      if (mix.master) window.gomidasMaster = Object.assign(window.gomidasMaster || {}, {
        vol: mix.master.vol != null ? mix.master.vol : 1,
        pan: mix.master.pan != null ? mix.master.pan : 0.5,
        eq: Object.assign({ low: 0, mid: 0, high: 0 }, mix.master.eq || {})
      });
      if (window.gomidasApplyMixer) window.gomidasApplyMixer();
    }
    // Effect chains: kept in memory on every host (so save round-trips them) and pushed to the
    // engine only where the backend can actually render them.
    window.gomidasTrackFx = (fx && fx.tracks) || {};
    window.gomidasMasterFx = (fx && fx.master) || null;
    if (Audio.setTrackFx) {
      for (const ch in window.gomidasTrackFx) Audio.setTrackFx(parseInt(ch, 10), window.gomidasTrackFx[ch]);
      if (window.gomidasMasterFx) Audio.setMasterFx(window.gomidasMasterFx);
    }
    focusEditor();
  }
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
  confirmDiscard(() => Host.openRecent(index));
};
// Called by native (MainComponent::keyPressed) so editor keys work even when the
// WebView doesn't hold first-responder focus.
window.gomidasNativeKey = function (key, cmd, ctrl, shift, alt) {
  if (window.GomidasEditor) window.GomidasEditor.handleKey(key, { meta: !!cmd, ctrl: !!ctrl, shift: !!shift, alt: !!alt });
};

// Dispatch a native menu-bar action (MainComponent menuItemSelected → here).
window.gomidasMenu = function (action) {
  const E = window.GomidasEditor;
  if (!E && !/^(new|open|save|export|import|sample)/.test(action)) return;
  const i = action.indexOf(':');
  const cmd = i < 0 ? action : action.slice(0, i);
  const arg = i < 0 ? '' : action.slice(i + 1);
  switch (cmd) {
    case 'new': openNewDialog(arg); break;
    case 'open': confirmDiscard(() => Host.openFile()); break;
    case 'save': saveProject(); break;
    case 'exportgp': exportGp(); break;
    case 'sample': loadSample(); focusEditor(); break;
    case 'undo': E.undo(); break;
    case 'redo': E.redo(); break;
    case 'selectall': E.selectAll(); break;
    case 'copy': E.copySelection(); break;
    case 'cut': E.cutSelection(); break;
    case 'paste': E.pasteClipboard(); break;
    case 'addtrack': E.addTrack(arg); focusEditor(); break;
    case 'deletetrack': E.deleteTrack(); break;
    case 'addbar': E.addBar(); break;
    case 'deletebar': E.deleteBar(); break;
    case 'gotobar': openGoToDialog(); break;
    case 'timesig': openTimeSigDialog(); break;
    case 'keysig': openKeySigDialog(); break;
    case 'repeatstart': E.toggleRepeatStart(); break;
    case 'repeatend': E.toggleRepeatEnd(); break;
    case 'tripletfeel': E.toggleTripletFeel(); break;
    case 'dir': E.toggleDirection(arg); break;
    case 'fermata': E.toggleFermata(); break;
    case 'dyn': E.setDynamics(arg); break;
    case 'cresc': E.setCrescendo(arg); break;
    case 'ottava': E.setOttava(arg); break;
    case 'lyrics': openLyricsDialog(); break;
    case 'transpose': openTransposeDialog(); break;
    case 'print': try { window.print(); } catch (e) { nlog('print: ' + e); } break;
    case 'minimize': Host.minimizeWindow(); break;
    case 'about': Host.showAbout(); break;
    case 'dur': E.setDuration(parseInt(arg, 10)); break;
    case 'voice': E.selectVoice(parseInt(arg, 10) - 1); break;
    case 'tuplet': E.setTuplet(parseInt(arg, 10)); break;
    case 'dot': E.toggleDot(); break;
    case 'tie': E.tieNote(); break;
    case 'text': openTextDialog(); break;
    case 'chord': openChordDialog(); break;
    case 'rest': E.makeRest(); break;
    case 'dead': E.deadNote(); break;
    case 'bend': openBendDialog(); break;
    case 'fx': {
      const m = { palmmute: () => E.palmMute(), letring: () => E.letRing(), hammer: () => E.hammerPull(),
        slide: () => E.slideNote(false), ghost: () => E.ghostNote(), staccato: () => E.staccato(),
        accent: () => E.accent(false), harmonic: () => E.naturalHarmonic(), vibrato: () => E.vibratoNote(),
        brushup: () => E.setBrush('up'), brushdown: () => E.setBrush('down'),
        arpup: () => E.setBrush('arpup'), arpdown: () => E.setBrush('arpdown'),
        pickup: () => E.setPickStroke(true), pickdown: () => E.setPickStroke(false),
        tremolo: () => E.tremoloPicking(), trill: () => E.trillNote(),
        grace: () => E.graceNote(false), graceon: () => E.graceNote(true),
        widevibrato: () => E.wideVibrato(), slap: () => E.slapBeat(), pop: () => E.popBeat(),
        fadein: () => E.setFade('in'), fadeout: () => E.setFade('out'), swell: () => E.setFade('swell'),
        shiftslide: () => E.slideNote(true), pickslidedown: () => E.pickSlide(false), pickslideup: () => E.pickSlide(true),
        artharmonic: () => E.artificialHarmonic(), pinchharmonic: () => E.pinchHarmonic(),
        tremolobar: () => E.tremoloBar(), wahopen: () => E.setWah(false), wahclosed: () => E.setWah(true),
        rasgueado: () => E.rasgueadoBeat(), lefthandtap: () => E.leftHandTap(), tap: () => E.tapBeat() };
      (m[arg] || (() => {}))(); break;
    }
    case 'play': E.togglePlay(); break;
    case 'panic': Audio.panic(); E.notifyStopped(); setStatus('All notes off'); break;
    case 'loopsel': E.loopSelection(); break;
    case 'loopclear': E.clearLoop(); break;
    case 'metronome': { const on = window.gomidasToggleMetronome();
      const b = document.getElementById('metro-btn'); if (b) b.classList.toggle('on', on); break; }
    case 'countin': { const on = E.toggleCountIn();
      const b = document.getElementById('countin-btn'); if (b) b.classList.toggle('on', on); break; }
    case 'liveinput': toggleLiveInput(); break;
    case 'loadplugin': Audio.loadInputPlugin(); break;
    case 'showplugineditor': Audio.showPluginEditor(); break;
    case 'clearplugin': Audio.clearInputPlugin(); setStatus('Input plugin cleared'); break;
    case 'loadsfz': { const ch = currentTrackChannel(); if (ch != null) Audio.loadTrackInstrumentFile(ch); break; }
    case 'clearsfz': window.gomidasClearTrackSfz(); break;
    case 'record': toggleRecord(); break;
    case 'zoom': window.gomidasZoom(arg === 'in' ? 1 : -1); break;
    case 'toggleview': window.gomidasToggleMultiView(); break;
    case 'togglebeatgrid': E.toggleBeatGrid(); break;
    case 'toggle': togglePanel(arg); break;
    case 'fullscore': toggleFullScore(); break;
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
  () => confirmDiscard(() => Host.openFile()));
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
// Go to start / go to end. These SEEK — they must not merely stop.
//
// The native engine's stop() rewinds its seek position to 0 as a side effect, so on desktop
// "go to start" appeared to work while actually just stopping; on web, where stop() correctly
// preserves the position, the same code did nothing at all. "Go to end" had no handler on
// either product. Both now seek explicitly, which is what the tooltips always claimed.
function transportGoTo(toEnd) {
  if (window.gomidasStopGroovePreview) window.gomidasStopGroovePreview();
  Audio.stop();
  const E = window.GomidasEditor;
  // Move the edit cursor too (same as GP's Cmd+Home / Cmd+End), then seek the transport to it
  // so Play resumes from where the cursor now is.
  if (E && E.moveToScoreEdge) E.moveToScoreEdge(toEnd);
  if (toEnd) {
    Audio.seek((window.gomidasSequenceLength && window.gomidasSequenceLength()) || 0);
  } else {
    Audio.seek(0);
  }
  focusEditor();
}
onClick('rewind-btn', () => transportGoTo(false));
onClick('forward-btn', () => transportGoTo(true));
onClick('print-btn', () => window.gomidasMenu('print'));
{
  const cib = document.getElementById('countin-bars');
  if (cib) cib.addEventListener('change', () => {
    if (window.GomidasEditor && window.GomidasEditor.setCountInBars)
      window.GomidasEditor.setCountInBars(parseInt(cib.value, 10) || 1);
    focusEditor();
  });
}
// Panel-toggle / full-view buttons route through gomidasMenu via their data-act.
document.querySelectorAll('#transport [data-act]').forEach(b =>
  b.addEventListener('click', () => { if (window.gomidasMenu) window.gomidasMenu(b.dataset.act); }));
// F11 toggles full view; Escape exits it (only when active, so modals/inputs are unaffected).
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); toggleFullScore(); }
  else if (e.key === 'Escape' && document.body.classList.contains('fullscore')) { e.preventDefault(); toggleFullScore(); }
}, true);
onClick('metro-btn', () => {
  const on = window.gomidasToggleMetronome();
  const b = document.getElementById('metro-btn'); if (b) b.classList.toggle('on', on);
  focusEditor();
});
onClick('countin-btn', () => {
  const on = window.GomidasEditor && window.GomidasEditor.toggleCountIn();
  const b = document.getElementById('countin-btn'); if (b) b.classList.toggle('on', !!on);
  focusEditor();
});
// Live input monitoring: reopens the device with a mic input and mixes it to output
// (first time triggers the macOS mic-permission prompt). Optimistic UI toggle.
let liveInputOn = false, inputGain = 1.0;
function toggleLiveInput() {
  liveInputOn = !liveInputOn;
  Audio.setLiveInput(liveInputOn, inputGain);
  const b = document.getElementById('liveinput-btn'); if (b) b.classList.toggle('on', liveInputOn);
  if (!liveInputOn) window.gomidasMeter(0);   // reset the meter when monitoring stops
}
// Output level meter (native pushes peak 0..1 ~30Hz while playing or monitoring).
window.gomidasMeter = function (peak) { Audio.emit('meter', { peak }); };
Audio.on('meter', ({ peak }) => {
  const f = document.getElementById('vu-fill');
  if (!f) return;
  f.style.width = Math.min(100, Math.round(peak * 100)) + '%';
  f.style.background = peak > 0.92 ? '#e25' : (peak > 0.6 ? '#ec5' : '#5c8');
});
window.gomidasToggleLiveInput = toggleLiveInput;
onClick('liveinput-btn', () => { toggleLiveInput(); focusEditor(); });

// Record the output mix to a WAV (backing tracks + live input).
let recording = false;
function toggleRecord() {
  if (recording) Audio.stopRecording();
  else Audio.startRecording();   // opens a save dialog; state set in callback
}
window.gomidasToggleRecord = toggleRecord;
onClick('record-btn', () => { toggleRecord(); focusEditor(); });
// Native callback with the actual recording state.
window.gomidasRecording = function (on, name) { Audio.emit('recordingState', { recording: !!on, name }); };
Audio.on('recordingState', (ev) => {
  recording = ev.recording;
  const b = document.getElementById('record-btn'); if (b) b.classList.toggle('rec', recording);
  setStatus(recording ? ('Recording → ' + (ev.name || 'WAV')) : (ev.name ? '' : 'Recording stopped'));
});
// Native callback after a plugin-file is chosen (loaded into the live-input insert). Desktop
// only — caps.pluginHost is false on web, where this event never fires.
window.gomidasInputPluginLoaded = function (ok, name) { Audio.emit('pluginLoaded', { ok, name }); };
Audio.on('pluginLoaded', ({ ok, name }) => {
  setStatus(ok ? ('Input plugin: ' + (name || 'loaded')) : 'Plugin load failed (not a valid AU/VST3)');
});
// Clicking anywhere in the score grabs keyboard focus for the editor.
document.getElementById('at-wrap').addEventListener('mousedown', focusEditor);
document.getElementById('tempo').addEventListener('change', (ev) => {
  const bpm = parseInt(ev.target.value, 10);
  if (bpm >= 40 && bpm <= 240) Audio.setTempo(bpm);
});
// Input gain for live-input monitoring (applied live when monitoring is on).
document.getElementById('ingain').addEventListener('input', (ev) => {
  inputGain = (parseInt(ev.target.value, 10) || 100) / 100;
  if (liveInputOn) Audio.setLiveInput(true, inputGain);
});
// Practice speed: scales playback tempo (pitch unchanged — it's re-sequenced MIDI).
document.getElementById('speed-select').addEventListener('change', (ev) => {
  const rate = parseFloat(ev.target.value);
  if (rate > 0) Audio.setPlaybackRate(rate);
  focusEditor();
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
  initDrawers();
  setStatus('ready');
  loadSample();
  focusEditor();
});
