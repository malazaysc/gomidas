// gomidas-core.js — the PURE logic of the editor/model layer, extracted so it can be
// unit-tested in Node (Vitest) without a browser, alphaTab, or the JUCE bridge.
//
// Dual-mode: in the browser it attaches to `window.GomidasCore` (loaded by index.html
// BEFORE editor.js / app.js, which delegate to it); under Node it is `module.exports`.
// Keep this file free of DOM / window / alphaTab / native-bridge references — every
// function here must be a pure (data) -> (data) transform.
//
// See docs/TESTING.md for the strategy this file anchors.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;      // Node / Vitest
  if (typeof window !== 'undefined') window.GomidasCore = api;                     // browser global
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Timebase ──────────────────────────────────────────────────────────────
  const PPQ = 960;                 // ticks per quarter note
  const WHOLE_TICKS = PPQ * 4;     // 3840 — a whole note

  // ── Beat / bar tick math ────────────────────────────────────────────────────

  // Fractional duration of a beat, in ticks (duration enum value == note fraction:
  // 1=whole, 2=half, 4=quarter, 8=eighth, …). Dots multiply by (2 - 0.5^dots);
  // tuplets scale by denom/numer. This is the RAW value (no rounding/flooring) — used
  // for bar-fill accounting where fractional accuracy matters.
  function beatTicksRaw(beat) {
    let t = WHOLE_TICKS / beat.duration;
    if (beat.dots) t *= (2 - Math.pow(0.5, beat.dots));
    if (beat.tupletNumerator && beat.tupletNumerator > 0)
      t *= beat.tupletDenominator / beat.tupletNumerator;
    return t;
  }

  // Same as beatTicksRaw but clamped to an integer >= 1 tick — used when emitting MIDI
  // events (a note must occupy at least one tick).
  function beatTicks(beat) {
    return Math.max(1, Math.round(beatTicksRaw(beat)));
  }

  // Full duration of master bar `i` from its time signature. A bar always occupies its
  // time-signature length (underfilled bars are silence-padded), so this is the bar's
  // capacity, not its filled amount. Defaults to 4/4 for a missing/blank master bar.
  function masterBarTicks(masterBars, i) {
    const mb = masterBars && masterBars[i];
    const num = mb ? (mb.timeSignatureNumerator || 4) : 4;
    const den = mb ? (mb.timeSignatureDenominator || 4) : 4;
    return Math.round(WHOLE_TICKS * num / den);
  }

  // Capacity of a bar in ticks, UNROUNDED — used by the editor's capacity check against
  // the (also unrounded) filled amount, so odd time signatures compare exactly.
  function barCapacityTicks(masterBars, barIndex) {
    const mb = masterBars && masterBars[barIndex];
    const num = mb ? (mb.timeSignatureNumerator || 4) : 4;
    const den = mb ? (mb.timeSignatureDenominator || 4) : 4;
    return WHOLE_TICKS * num / den;
  }

  // Sum of a bar/voice's beat durations (raw), i.e. how full the bar is.
  function barFilledTicks(bar, voiceIndex) {
    const v = bar && bar.voices && bar.voices[voiceIndex || 0];
    if (!v) return 0;
    return v.beats.reduce((s, b) => s + beatTicksRaw(b), 0);
  }

  // A bar is "full" once its beats occupy its whole time-signature length. The -1 slack
  // absorbs floating-point dust so an exactly-filled bar still reads as full.
  function barIsFull(masterBars, bar, barIndex, voiceIndex) {
    return barFilledTicks(bar, voiceIndex) >= barCapacityTicks(masterBars, barIndex) - 1;
  }

  // ── Dynamics / octave ───────────────────────────────────────────────────────

  // alphaTab dynamic value (ppp..fff ~ 0..8) → 0..1 velocity. Non-numeric → default mf.
  function dynamicsToVelocity(dyn) {
    if (typeof dyn !== 'number') return 0.85;
    return Math.max(0.2, Math.min(1.0, 0.3 + dyn * 0.1));
  }

  // Ottava (octave-shift clef line) → semitone offset so playback matches the shown
  // octave. `OT` is alphaTab.model.Ottava (pass it in; tests use a stand-in). Regular /
  // missing enum / non-numeric → 0.
  function ottavaSemitones(ott, OT) {
    if (!OT || typeof ott !== 'number' || ott === OT.Regular) return 0;
    if (ott === OT.Va8) return 12;
    if (ott === OT.Vb8) return -12;
    if (ott === OT.Ma15) return 24;
    if (ott === OT.Mb15) return -24;
    return 0;
  }

  // ── Triplet-feel swing ────────────────────────────────────────────────────────

  // Map a within-bar tick to its swung position: eighth-note pairs become long-short
  // (2:1) while quarter-note beat boundaries stay put. Identity at beat starts/ends.
  function swungTickInBar(rel) {
    const quarter = WHOLE_TICKS / 4;
    const beatIdx = Math.floor(rel / quarter);
    const frac = (rel - beatIdx * quarter) / quarter;                 // 0..1 within the quarter
    const sf = (frac <= 0.5) ? (frac * (2 / 3) / 0.5)
                             : (2 / 3 + (frac - 0.5) * (1 / 3) / 0.5);
    return Math.round(beatIdx * quarter + sf * quarter);
  }

  // ── Pitch bend (MIDI) ─────────────────────────────────────────────────────────

  // alphaTab BendPoint.value is in 1/4 tones (4 == a whole-tone bend == 2 semitones).
  function bendValueToSemitones(v) { return (v || 0) / 2.0; }

  // Semitones → 14-bit pitch-wheel value (8192 = centre), for a ±12 semitone bend range.
  function semitonesToWheel(semis) {
    return Math.max(0, Math.min(16383, Math.round(8192 + (semis / 12.0) * 8192)));
  }

  // Emit pitch-bend events tracing a note's bend curve from onTick→offTick, then RESET
  // the wheel to centre just before the note ends so following notes on the same channel
  // aren't left detuned (the reset tick is fractional so it sorts before the next
  // note-on). Pushes native event tuples onto `events`; returns `events`. Pure aside from
  // the push into the caller-supplied array (kept for parity with the shipping caller).
  function emitBendEvents(events, channel, program, onTick, offTick, bendPoints) {
    const pts = bendPoints.slice().sort((a, b) => (a.offset || 0) - (b.offset || 0));
    if (!pts.length) return events;
    const valAt = (off) => {
      if (off <= (pts[0].offset || 0)) return pts[0].value || 0;
      for (let i = 1; i < pts.length; i++) {
        if (off <= (pts[i].offset || 0)) {
          const a = pts[i - 1], b = pts[i];
          const span = ((b.offset || 0) - (a.offset || 0)) || 1;
          const t = (off - (a.offset || 0)) / span;
          return (a.value || 0) + ((b.value || 0) - (a.value || 0)) * t;
        }
      }
      return pts[pts.length - 1].value || 0;
    };
    const dur = Math.max(1, offTick - onTick);
    const resetTick = offTick - 0.5;            // sorts just before the next note-on
    const STEPS = 12;
    for (let i = 0; i <= STEPS; i++) {
      const f = i / STEPS;
      const tick = onTick + f * dur;
      if (tick >= resetTick - 0.25) break;      // don't overshoot the held end value
      events.push([tick, channel, 0, 0, false, program, false, 1, semitonesToWheel(bendValueToSemitones(valAt(f * 60)))]);
    }
    // Hold the curve's end value right up to the note end, then reset to centre.
    events.push([resetTick - 0.25, channel, 0, 0, false, program, false, 1, semitonesToWheel(bendValueToSemitones(valAt(60)))]);
    events.push([resetTick, channel, 0, 0, false, program, false, 1, 8192]);
    return events;
  }

  // ── Beat-lane (time-grid tab view) subdivisions ───────────────────────────────

  // Adaptive subdivisions-per-beat from the smallest straight (non-tuplet) value in the
  // bar. `beatUnit` = ticks per counted beat, `compound` = compound meter (6/8 etc).
  function laneBeatK(bar, beatUnit, compound) {
    const v0 = bar && bar.voices && bar.voices[0];
    let minDur = Infinity;
    if (v0) for (const be of v0.beats) {
      if (be.tupletNumerator && be.tupletNumerator > 0) continue;
      const d = beatTicks(be); if (d > 0 && d < minDur) minDur = d;
    }
    if (!isFinite(minDur)) minDur = beatUnit;
    const K = Math.max(1, Math.round(beatUnit / Math.max(minDur, WHOLE_TICKS / 16)));
    return compound ? (K >= 5 ? 6 : K >= 2 ? 3 : 1)
                    : (K >= 8 ? 8 : K >= 4 ? 4 : K >= 2 ? 2 : 1);
  }

  // ── Sequence-assembly helpers ─────────────────────────────────────────────────

  // Per-beat velocity multipliers for crescendo / diminuendo hairpins: a run of
  // consecutive beats carrying the same crescendo type ramps 0.6→1.0 (cresc) or 1.0→0.6
  // (dim) across the span. Returns an array aligned to `beats`. `CT` is
  // alphaTab.model.CrescendoType (defaults to the standard None/Crescendo/Decrescendo).
  function crescendoFactors(beats, CT) {
    CT = CT || { None: 0, Crescendo: 1, Decrescendo: 2 };
    const f = new Array(beats.length).fill(1);
    let i = 0;
    while (i < beats.length) {
      const c = beats[i].crescendo | 0;
      if (!c || c === CT.None) { i++; continue; }
      let j = i;
      while (j < beats.length && (beats[j].crescendo | 0) === c) j++;
      const run = j - i;
      for (let k = 0; k < run; k++) {
        const frac = run > 1 ? k / (run - 1) : 1;
        f[i + k] = (c === CT.Crescendo) ? (0.6 + 0.4 * frac) : (1.0 - 0.4 * frac);
      }
      i = j;
    }
    return f;
  }

  // First MIDI channel not used by any track (and not percussion channel 9), e.g. for the
  // metronome's melodic wood-block. Returns -1 if all 16 are taken.
  function freeMelodicChannel(score) {
    const used = new Set([9]);
    for (const t of (score && score.tracks) || []) {
      const c = t.playbackInfo && t.playbackInfo.primaryChannel;
      if (c != null) used.add(c & 0x0f);
    }
    for (let c = 0; c < 16; c++) if (!used.has(c)) return c;
    return -1;
  }

  // ── Playback order (repeat barlines + D.C./D.S. jumps) ────────────────────────

  // Expand repeat barlines AND D.C./D.S. jumps into the order master bars are actually
  // played. Repeat end (repeatCount>0) replays from the last repeat-start; a Da Capo /
  // Dal Segno jump (executed once) returns to the start / Segno, optionally stopping at
  // Fine. Alternate endings + al-Coda variants aren't handled. With no repeats/directions
  // this is just [0,1,…,n-1]. `D` is alphaTab.model.Direction (pass null to skip all
  // direction handling — repeats still work); `mb.directions` is a Set of Direction values.
  function computePlaybackOrder(score, D) {
    const mbs = (score && score.masterBars) || [];
    const has = (mb, v) => !!(D && v != null && mb.directions && mb.directions.has && mb.directions.has(v));
    // Marker bars (first occurrence).
    let segnoBar = -1, fineBar = -1;
    if (D) for (let k = 0; k < mbs.length; k++) {
      if (segnoBar < 0 && has(mbs[k], D.TargetSegno)) segnoBar = k;
      if (fineBar < 0 && has(mbs[k], D.TargetFine)) fineBar = k;
    }
    const order = [];
    const passes = {};            // repeat-end bar index -> completed passes
    let i = 0, repeatStart = 0, guard = 0;
    let jumpUsed = false;         // a D.C./D.S. jump fires once
    let fineActive = false;       // Fine stops the song only after an "al Fine" jump
    while (i < mbs.length && guard++ < 50000) {
      order.push(i);
      const mb = mbs[i];
      if (mb.isRepeatStart) repeatStart = i;
      const rc = mb.repeatCount | 0;
      if (rc > 0) {
        passes[i] = (passes[i] || 0) + 1;
        if (passes[i] < rc) { i = repeatStart; continue; }
        passes[i] = 0;            // reset so an enclosing repeat can re-trigger this end
      }
      if (fineActive && fineBar === i) break;   // "al Fine" reached → stop
      if (D && !jumpUsed) {
        if (has(mb, D.JumpDaCapo))       { jumpUsed = true; i = 0; continue; }            // D.C.
        if (has(mb, D.JumpDaCapoAlFine)) { jumpUsed = true; fineActive = true; i = 0; continue; } // D.C. al Fine
        if (segnoBar >= 0 && has(mb, D.JumpDalSegno))       { jumpUsed = true; i = segnoBar; continue; }            // D.S.
        if (segnoBar >= 0 && has(mb, D.JumpDalSegnoAlFine)) { jumpUsed = true; fineActive = true; i = segnoBar; continue; } // D.S. al Fine
      }
      i++;
    }
    return order.length ? order : mbs.map((_, k) => k);
  }

  // ── Articulation → MIDI note shape (velocity + duration) ──────────────────────

  // Reshape a note's velocity/duration for its articulations, matching how the played
  // note should sound: dead = short percussive thunk, palm-mute = shorter+softer,
  // staccato = halved, ghost = quiet, accent = louder, legato (hammer/pull dest) = softer
  // (not picked). `vel` is 0..1, `dur` is in ticks; returns the shaped { vel, dur }.
  function shapeNote(note, vel, dur) {
    let noteVel = vel, noteDur = dur;
    if (note.isDead) { noteVel = vel * 0.6; noteDur = Math.max(1, Math.round(dur * 0.12)); }
    else if (note.isPalmMute) { noteVel = vel * 0.85; noteDur = Math.max(1, Math.round(dur * 0.45)); }
    if (note.isStaccato) noteDur = Math.max(1, Math.round(noteDur * 0.5));
    if (note.isGhost) noteVel *= 0.55;
    if (note.accentuated === 2) noteVel = Math.min(1, noteVel * 1.3);       // heavy accent
    else if (note.accentuated === 1) noteVel = Math.min(1, noteVel * 1.15); // accent
    if (note.isHammerPullDestination) noteVel *= 0.7;                       // legato: not picked
    return { vel: noteVel, dur: noteDur };
  }

  // ── Model → flat MIDI event list (the playback walk) ──────────────────────────

  // Walk a score into a flat native event list + a primary-track tick→beat map for the
  // cursor. This is the heart of playback: it unrolls the repeat/jump order, lays each bar
  // out at max(time-signature capacity, filled length), applies swing / dynamics / hairpins
  // / articulation shaping / ties / let-ring / pitch-bends, and (optionally) a metronome.
  //
  // PURE: returns { events, tickMap, lengthTicks }; the caller does the side effects
  // (native setSequence, publishing the tick map). `opts` carries what used to be globals:
  //   primaryTrack   — the track whose voice 0 feeds tickMap (default score.tracks[0])
  //   tripletFeel / ottava / crescendoType / direction — the matching alphaTab.model enums
  //   metronomeOn    — add the wood-block click track
  //   drumGains      — optional {midi: gain} scaling percussion hit velocity
  //
  // Native event tuple: [tick, channel, key, velocity, isNoteOn, program, isPercussion]
  // (bend events carry two extra elements — see emitBendEvents).
  function buildSequence(score, opts) {
    opts = opts || {};
    const TF = opts.tripletFeel || { NoTripletFeel: 0, Triplet8th: 1 };
    const Ottava = opts.ottava || null;
    const CrescendoType = opts.crescendoType || null;
    const Direction = opts.direction || null;
    const drumGains = opts.drumGains || null;
    const metronomeOn = !!opts.metronomeOn;

    const events = [];
    const tickMap = [];               // [{tick, beat}] ascending, primary rendered track
    let lengthTicks = 0;
    const tracks = (score && score.tracks) || [];
    const primaryTrack = opts.primaryTrack || tracks[0];
    const playbackOrder = computePlaybackOrder(score, Direction);   // unroll repeat barlines

    // Mute/solo/volume are applied LIVE via per-channel gain (see computeChannelMix), not
    // by dropping events here — so toggling them takes effect instantly during playback.
    tracks.forEach((track) => {
      const pb = track.playbackInfo || {};
      const program = pb.program | 0;
      const channel = (pb.primaryChannel != null) ? (pb.primaryChannel & 0x0f) : 0;
      const percussion = (channel === 9);
      const isPrimary = (track === primaryTrack);
      const lastOff = {};   // "channel:key" -> note-off event, so ties can extend it

      for (const stave of track.staves) {
        let trackTick = 0;
        const ringOff = {};   // note.string -> note-off of a let-ring note still sounding on that string
        for (const mbIndex of playbackOrder) {
          const bar = stave.bars[mbIndex];
          if (!bar) continue;
          const barStart = trackTick;
          let barEnd = barStart;
          // Triplet feel → swing the within-bar 8th grid (identity otherwise).
          const mbar = score.masterBars[mbIndex];
          const swung = !!(mbar && mbar.tripletFeel === TF.Triplet8th);
          const sw = swung ? (abs) => barStart + swungTickInBar(abs - barStart) : (abs) => abs;
          for (const voice of bar.voices) {
            let t = barStart;
            const cresc = crescendoFactors(voice.beats, CrescendoType);   // hairpin velocity ramp
            let bIdx = -1;
            for (const beat of voice.beats) {
              bIdx++;
              const dur = beatTicks(beat);
              if (isPrimary && voice.index === 0) tickMap.push({ tick: sw(t), beat });
              if (!beat.isEmpty && !beat.isRest) {
                const vel = dynamicsToVelocity(beat.dynamics) * cresc[bIdx];
                const ottava = percussion ? 0 : ottavaSemitones(beat.ottava, Ottava);
                for (const note of beat.notes) {
                  let key;
                  if (percussion) {
                    // Percussion: map articulation index -> GM drum MIDI note.
                    const arts = track.percussionArticulations;
                    const ai = note.percussionArticulation | 0;
                    key = (arts && arts[ai] && arts[ai].outputMidiNumber != null)
                          ? arts[ai].outputMidiNumber : note.realValue;
                  } else {
                    key = note.realValue + ottava;
                  }
                  if (key == null || key < 0 || key > 127) continue;
                  // Articulation → audible MIDI shape (dead/palm-mute/staccato/ghost/accent/legato).
                  let { vel: noteVel, dur: noteDur } = shapeNote(note, vel, dur);
                  // Per-piece drum level (set by the kit MIXER tab): scales the hit velocity.
                  if (percussion && drumGains) {
                    const g = drumGains[key];
                    if (g != null) noteVel = Math.max(0, Math.min(1, noteVel * g));
                  }
                  const onTick = sw(t), offTick = sw(t + noteDur);
                  const id = channel + ':' + key;
                  // Tie: don't re-trigger — extend the still-ringing note's note-off.
                  if (note.isTieDestination && lastOff[id]) { lastOff[id][0] = offTick; continue; }
                  // A new note on a string cuts (or, for a let-ring note, extends) any
                  // let-ring note still sounding on that same string.
                  const stringNo = (!percussion && note.string != null) ? note.string : null;
                  if (stringNo != null && ringOff[stringNo]) { ringOff[stringNo][0] = onTick; ringOff[stringNo] = null; }
                  events.push([onTick, channel, key, noteVel, true, program, percussion]);
                  const off = [offTick, channel, key, 0.0, false, program, percussion];
                  events.push(off);
                  lastOff[id] = off;
                  // Pitch-bend curve for bent notes (imported or edited). Per-channel; resets
                  // to centre at the note end. Skipped for percussion and tie destinations.
                  if (!percussion && !note.isTieDestination && note.bendPoints && note.bendPoints.length)
                    emitBendEvents(events, channel, program, onTick, offTick, note.bendPoints);
                  // Let ring: hold until the next note on this string (or the track end).
                  if (note.isLetRing && stringNo != null) ringOff[stringNo] = off;
                }
              }
              t += dur;
            }
            if (t > barEnd) barEnd = t;
          }
          // A bar always spans its full time-signature duration (silence-pad the
          // remainder) so the next bar starts on the downbeat — never early.
          const capacity = masterBarTicks(score.masterBars, mbIndex);
          trackTick = barStart + Math.max(capacity, barEnd - barStart);
        }
        // Any let-ring note never cut by a later same-string note rings to the track end.
        for (const k in ringOff) if (ringOff[k]) { ringOff[k][0] = Math.max(ringOff[k][0], trackTick); ringOff[k] = null; }
        if (trackTick > lengthTicks) lengthTicks = trackTick;
      }
    });

    // Metronome: a wood-block click on each time-signature beat (downbeat accented),
    // following the same unrolled playback order so it loops/repeats with the music.
    // Uses a free melodic channel (GM Woodblock) when available, else percussion ch 9.
    if (metronomeOn) {
      const mch = freeMelodicChannel(score);
      const melodic = (mch >= 0);
      const ch = melodic ? mch : 9;
      const prog = melodic ? 115 : 0;          // 115 = GM Woodblock
      const perc = !melodic;
      const hi = melodic ? 84 : 76, lo = melodic ? 72 : 77;
      let mtick = 0;
      for (const mbIndex of playbackOrder) {
        const mb = score.masterBars[mbIndex];
        const num = mb ? (mb.timeSignatureNumerator || 4) : 4;
        const den = mb ? (mb.timeSignatureDenominator || 4) : 4;
        const unit = WHOLE_TICKS / den;
        for (let bi = 0; bi < num; bi++) {
          const t = Math.round(mtick + bi * unit);
          const key = (bi === 0) ? hi : lo;
          const vel = (bi === 0) ? 1.0 : 0.7;
          events.push([t, ch, key, vel, true, prog, perc]);
          events.push([t + 30, ch, key, 0.0, false, prog, perc]);
        }
        mtick += masterBarTicks(score.masterBars, mbIndex);
      }
    }

    tickMap.sort((a, b) => a.tick - b.tick);
    return { events, tickMap, lengthTicks };
  }

  // ── Mixer (vol / mute / solo / pan → per-channel gain) ────────────────────────

  // True if any track is soloed (mute is then overridden by solo).
  function anyTrackSoloed(tracks, flags) {
    return tracks.some((_, i) => flags[i] && flags[i].soloed);
  }

  // A track's live per-channel gain + pan. Mute → gain 0; with any solo active, a
  // non-soloed track is silenced. Gain clamps to [0, 1.5], pan to [0, 1] (0.5 = centre).
  // baseVol precedence: explicit flag.vol → file playbackInfo.volume/16 → default 12/16.
  // pan precedence: flag.pan → playbackInfo.balance/16 → centre.
  function computeChannelMix(track, flag, anySolo) {
    const f = flag || {};
    const pb = (track && track.playbackInfo) || {};
    const baseVol = (typeof f.vol === 'number') ? f.vol
                  : ((pb.volume != null ? pb.volume : 12) / 16);
    const audible = anySolo ? !!f.soloed : !f.muted;
    const gain = audible ? Math.max(0, Math.min(1.5, baseVol)) : 0;
    const pan = (typeof f.pan === 'number') ? Math.max(0, Math.min(1, f.pan))
              : (pb.balance != null) ? Math.max(0, Math.min(1, pb.balance / 16)) : 0.5;
    return { gain, pan };
  }

  // ── .gomidas project envelope ─────────────────────────────────────────────────

  // Wrap a serialized score + instrument/mix state in the versioned envelope written to
  // `.gomidas`. `scoreJson` is alphaTab's score JSON (string or object).
  function buildEnvelope(scoreJson, opts) {
    const o = opts || {};
    const env = { gomidasVersion: 1, instruments: o.instruments || {}, mix: o.mix || null, score: scoreJson };
    // Effect chains (GMD-35). CRITICAL: the DESKTOP build must write this back even though it
    // does not render effects (WEB_PORT §5.2) — otherwise opening a web-authored project on
    // macOS and saving silently destroys its effects. app.js is shared, so passing `fx` straight
    // through here is what makes desktop preservation automatic.
    if (o.fx) env.fx = o.fx;
    return env;
  }

  // Parse a `.gomidas` file. Understands both the versioned envelope and the legacy
  // raw-score JSON (older files were just the score). Never throws: a non-envelope /
  // unparseable input is treated as a legacy raw score. Returns { scoreJson, instruments,
  // mix, legacy }.
  function parseEnvelope(json) {
    try {
      const env = JSON.parse(json);
      if (env && env.gomidasVersion && env.score != null)
        return { scoreJson: env.score, instruments: env.instruments || {}, mix: env.mix || null,
                 fx: env.fx || null, legacy: false };
    } catch (e) { /* not an envelope — treat as a legacy raw-score JSON string */ }
    return { scoreJson: json, instruments: null, mix: null, fx: null, legacy: true };
  }

  return {
    PPQ, WHOLE_TICKS,
    beatTicksRaw, beatTicks, masterBarTicks, barCapacityTicks, barFilledTicks, barIsFull,
    dynamicsToVelocity, ottavaSemitones, swungTickInBar,
    bendValueToSemitones, semitonesToWheel, emitBendEvents,
    laneBeatK,
    crescendoFactors, freeMelodicChannel, computePlaybackOrder, shapeNote, buildSequence,
    anyTrackSoloed, computeChannelMix,
    buildEnvelope, parseEnvelope,
  };
}));
