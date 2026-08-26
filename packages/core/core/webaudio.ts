// Gomidas — Web Audio backend (GMD-33, docs/WEB_PORT.md §4 + §7).
//
// Implements AudioBackend against Web Audio. The channel strip deliberately mirrors the native
// signal order (instrument -> gain -> pan -> EQ -> sum -> master EQ -> master gain/pan -> out) so
// a mix translates between the two products.
//
// The hand-written transposed direct-form-II biquads in AudioEngine.h are NOT ported: lowshelf,
// peaking and highshelf are literally the three BiquadFilterNode types already in use.
//
// buildSequence output is consumed UNCHANGED — a flat tick-sorted list of
// [tick, channel, key, velocity, on, program, percussion, kind?, value?]. That is the payoff of
// the extraction work; do not reshape it.
//
// No top-level import/export — this emits as a plain <script> global. See web/tsconfig.json.

declare const GomidasTimebase: any;

// SCOPE NOTE: the whole file body is wrapped in an IIFE. These emit as plain <script> files, so
// every top-level `const`/`function` would otherwise be a GLOBAL and collide across files —
// app.js:7 already declares a global `const PPQ`, which is exactly the collision this avoids.
// Nothing escapes except the published object below.
(function () {
/** Scheduler constants (§7.1). Timer jitter never reaches the audio: start(when) is sample-accurate. */
const LOOKAHEAD_S = 0.1;      // schedule everything falling in the next 100ms
const TICK_INTERVAL_MS = 25;  // ...and re-check every 25ms
const SCHEDULE_LEAD_S = 0.05; // small offset so the first note is not already late

/**
 * BACKGROUND TABS (measured, not theoretical): browsers clamp setInterval to roughly once per
 * second in a hidden tab. A 100ms lookahead fed by a 1s timer starves — playback stutters or
 * drops out entirely the moment you switch tabs, while the audio clock keeps running.
 *
 * So the lookahead grows when the document is hidden: fewer, larger scheduling batches survive
 * the clamp. The cost is latency on transport changes (a seek or tempo change has to discard and
 * re-schedule a bigger window), which nobody can perceive in a tab they are not looking at.
 * requestAnimationFrame stops in hidden tabs too, so the cursor and meter simply pause — correct,
 * since there is nothing to draw.
 */
const LOOKAHEAD_HIDDEN_S = 2.0;

/**
 * Pitch-bend timeline.
 *
 * THE BUG THIS FIXES: every instrument used to ignore the `when` argument and apply a bend at
 * ctx.currentTime. Events are scheduled up to 2s AHEAD, so the entire traced bend curve — every
 * point plus the reset-to-centre that follows it — was applied instantly at SCHEDULE time and
 * had all cancelled out before the note was even heard. Net effect: bends sounded like no bend
 * at all, which is exactly what a bend that is applied and undone before it sounds does.
 *
 * A bend is per-CHANNEL, so it must also apply to voices that do not exist yet at schedule time:
 * bendAt(when) gives the value in force at a note's start.
 */
function createBendTimeline() {
  const points: Array<{ t: number; semis: number }> = [{ t: 0, semis: 0 }];
  return {
    /** Record a bend and return the semitone offset it selects. */
    add(value: number, when: number, rangeSemis: number): number {
      const semis = ((value - 8192) / 8192) * rangeSemis;
      points.push({ t: when, semis });
      // Keep it bounded: anything older than a few seconds can no longer affect a new voice.
      if (points.length > 512) points.splice(0, points.length - 256);
      return semis;
    },
    /** The bend in force at a given context time. */
    at(when: number): number {
      let semis = 0;
      for (const p of points) { if (p.t <= when + 1e-6) semis = p.semis; else break; }
      return semis;
    },
    reset() { points.length = 0; points.push({ t: 0, semis: 0 }); }
  };
}

/**
 * A scheduled gain envelope, and its level at an arbitrary time.
 *
 * THE BUG THIS FIXES (GMD-48): releasing a voice must not read `gain.value`. Notes are scheduled
 * AHEAD, so for most of them the envelope automation has not run when the note-off is scheduled,
 * and `.value` returns the GainNode default of 1.0 — above the note's own peak. Releasing from
 * there jumps the voice to FULL GAIN at the instant it should be ending. Measured on a
 * palm-muted 16th: peak 0.6061, released from 1.0, so the loudest part of the note was its
 * release — which is what "palm mutes sound weird and cut off" is.
 *
 * It bites whenever the note-off is scheduled before the envelope has run: ALWAYS in the offline
 * bounce (everything is scheduled up front — this is also why the mix hits full scale, GMD-42),
 * ALWAYS in a hidden tab's 2s window, and in normal playback for any note short enough that its
 * note-off lands in the same ~100ms scheduling window as its note-on. A palm mute is 45% of an
 * already short note, so palm mutes are the first thing to break.
 *
 * So a voice records the envelope it scheduled and releases from the level that envelope has at
 * the release time. (`cancelAndHoldAtTime` would do this natively, but Firefox does not implement
 * it, and one deterministic path keeps the offline bounce identical across browsers.)
 *
 * `kind` describes how the value gets FROM the previous point TO this one:
 *   'set'    — holds the previous value, then jumps to v at t (setValueAtTime)
 *   'lin'    — linear ramp (linearRampToValueAtTime)
 *   'exp'    — exponential ramp (exponentialRampToValueAtTime)
 *   'target' — exponential approach to v with time constant tau, starting at t (setTargetAtTime)
 */
interface EnvPoint { t: number; v: number; kind: 'set' | 'lin' | 'exp' | 'target'; tau?: number }

const MIN_GAIN = 0.0001;

function envelopeLevelAt(points: EnvPoint[], t: number): number {
  if (!points || !points.length) return MIN_GAIN;
  let prevT = points[0].t;
  let prevV = points[0].v;
  if (t <= prevT) return Math.max(MIN_GAIN, prevV);

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.kind === 'target') {
      // In force from p.t until the next point (or forever). Before p.t the value simply holds.
      if (t < p.t) return Math.max(MIN_GAIN, prevV);
      const tau = Math.max(1e-6, p.tau || 0.01);
      const next = points[i + 1];
      const until = next ? next.t : Infinity;
      const decayed = (u: number) => p.v + (prevV - p.v) * Math.exp(-(u - p.t) / tau);
      if (t <= until) return Math.max(MIN_GAIN, decayed(t));
      prevV = decayed(until);
      prevT = until;
      continue;
    }
    if (t <= p.t) {
      if (p.kind === 'set') return Math.max(MIN_GAIN, prevV);   // holds until the jump AT p.t
      const span = p.t - prevT;
      const f = span > 0 ? (t - prevT) / span : 1;
      const v = p.kind === 'lin'
        ? prevV + (p.v - prevV) * f
        : Math.max(MIN_GAIN, prevV) * Math.pow(Math.max(MIN_GAIN, p.v) / Math.max(MIN_GAIN, prevV), f);
      return Math.max(MIN_GAIN, v);
    }
    prevT = p.t;
    prevV = p.v;
  }
  return Math.max(MIN_GAIN, prevV);
}

/** §6.1 — the seam SFZ (GMD-34) and TSF-WASM (GMD-36) plug into. */
interface Instrument {
  noteOn(key: number, velocity: number, when: number): void;
  noteOff(key: number, when: number): void;
  pitchBend(value: number, when: number): void;   // 0..16383, 8192 = centre
  cc(num: number, value: number, when: number): void;
  allNotesOff(): void;
  output: AudioNode;
}

/**
 * Placeholder instrument: a two-oscillator tone with a plucked envelope, plus a noise burst for
 * percussion. Exists so timing, mixer and EQ are audible NOW; GMD-34 swaps in the SFZ sampler
 * behind this same interface. It is not meant to sound good.
 */
function createToneInstrument(ctx: AudioContext, percussion: boolean): Instrument {
  const output = ctx.createGain();
  output.gain.value = 1;

  // One shared noise buffer for every drum hit — allocating per hit would churn the heap.
  let noiseBuffer: AudioBuffer | null = null;
  function noise(): AudioBuffer {
    if (!noiseBuffer) {
      const len = Math.floor(ctx.sampleRate * 0.4);
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      // Deterministic (no Math.random): a fixed LCG keeps renders reproducible.
      let seed = 22222;
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x3fffffff) - 1;
      }
    }
    return noiseBuffer;
  }

  // Voices are keyed by MIDI key; a key can legitimately retrigger before its own note-off
  // (repeated notes, overlapping voices), so each key holds a stack.
  const voices = new Map<number, Array<{ stop: (t: number) => void; nodes: AudioNode[] }>>();
  const bend = createBendTimeline();

  function noteOn(key: number, velocity: number, when: number): void {
    const vel = Math.max(0, Math.min(1, velocity));
    if (vel <= 0) return;
    const gain = ctx.createGain();
    gain.connect(output);
    const nodes: AudioNode[] = [gain];
    let stopFn: (t: number) => void;

    if (percussion) {
      const src = ctx.createBufferSource();
      src.buffer = noise();
      // Rough pitch mapping so a kick and a hat are at least distinguishable.
      src.playbackRate.value = Math.max(0.25, Math.min(4, Math.pow(2, (key - 50) / 24)));
      const bp = ctx.createBiquadFilter();
      bp.type = key <= 45 ? 'lowpass' : 'highpass';
      bp.frequency.value = key <= 45 ? 220 : 3000;
      src.connect(bp); bp.connect(gain);
      nodes.push(src, bp);
      const decay = key <= 45 ? 0.22 : 0.09;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vel), when + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      src.start(when);
      src.stop(when + decay + 0.02);
      stopFn = () => { /* percussion is one-shot; note-off is meaningless */ };
    } else {
      const freq = 440 * Math.pow(2, (key - 69) / 12);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.detune.value = 6;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = Math.min(ctx.sampleRate / 2 - 1000, freq * 8);
      const ratio = Math.pow(2, bend.at(when) / 12);   // bend in force at THIS note's start
      osc.frequency.setValueAtTime(freq * ratio, when);
      osc2.frequency.setValueAtTime(freq * ratio, when);
      osc.connect(tone); osc2.connect(tone); tone.connect(gain);
      nodes.push(osc, osc2, tone);
      const attackTo = Math.max(0.001, vel * 0.35);
      const decayTo = Math.max(0.0005, vel * 0.22);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(attackTo, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(decayTo, when + 0.25);
      const env: EnvPoint[] = [{ t: when, v: MIN_GAIN, kind: 'set' },
                               { t: when + 0.008, v: attackTo, kind: 'exp' },
                               { t: when + 0.25, v: decayTo, kind: 'exp' }];
      osc.start(when); osc2.start(when);
      stopFn = (t: number) => {
        const at = Math.max(t, ctx.currentTime);
        try {
          gain.gain.cancelScheduledValues(at);
          gain.gain.setValueAtTime(envelopeLevelAt(env, at), at);
          gain.gain.exponentialRampToValueAtTime(MIN_GAIN, at + 0.06);
          osc.stop(at + 0.08); osc2.stop(at + 0.08);
        } catch (e) { /* already stopped */ }
      };
    }

    const list = voices.get(key) || [];
    list.push({ stop: stopFn, nodes });
    voices.set(key, list);
    // Self-cleanup so the map does not grow for the length of the song.
    setTimeout(() => {
      const l = voices.get(key);
      if (!l || !l.length) return;
      l.shift();
      if (!l.length) voices.delete(key);
    }, Math.max(0, (when - ctx.currentTime + 8)) * 1000);
  }

  function noteOff(key: number, when: number): void {
    const list = voices.get(key);
    if (!list || !list.length) return;
    // FIFO: the oldest sounding instance of this key is the one being released.
    const v = list[0];
    v.stop(when);
  }

  return {
    noteOn,
    noteOff,
    pitchBend(value: number, when: number) {
      // +/-12 semitones, matching the native bend range (AudioEngine). Recorded on the timeline
      // so notes scheduled later start at the right pitch; this placeholder does not retune
      // already-sounding voices (GMD-34 replaced it for anything that matters).
      bend.add(value, when, 12);
    },
    cc() { /* GMD-35 */ },
    allNotesOff() {
      const now = ctx.currentTime;
      for (const list of voices.values()) for (const v of list) v.stop(now);
      voices.clear();
    },
    output
  };
}

/**
 * SFZ sample instrument (GMD-34). Same Instrument interface as the tone placeholder, so the
 * channel does not know or care which it got.
 *
 * Browsers decode FLAC natively via decodeAudioData, so there is no WASM, no worklet and no
 * build step — the entire "sampler" is an AudioBufferSourceNode per note with playbackRate set
 * from the region's pitch centre, plus a GainNode for the ampeg envelope.
 */
function createSfzInstrument(ctx: AudioContext, regions: any[], buffers: Map<string, AudioBuffer>): Instrument {
  const SFZ = (window as any).GomidasSfz;
  const output = ctx.createGain();
  const voices = new Map<number, any[]>();
  const bend = createBendTimeline();

  function noteOn(key: number, velocity: number, when: number): void {
    const region = SFZ.findRegion(regions, key, Math.round(Math.max(0, Math.min(1, velocity)) * 127));
    // No region: stay SILENT rather than play a wrong-pitched neighbour. A missing note is a
    // reportable gap; a wrong note sounds like a broken instrument.
    if (!region) return;
    const buf = buffers.get(region.sample);
    if (!buf) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Bend in force AT THIS NOTE'S START (see createBendTimeline).
    const baseRate = SFZ.playbackRateFor(region, key);
    src.playbackRate.setValueAtTime(baseRate * Math.pow(2, bend.at(when) / 12), when);
    if (region.loopMode && /loop_continuous|loop_sustain/.test(region.loopMode)) src.loop = true;

    const gain = ctx.createGain();
    const peak = Math.max(0.0001, Math.min(1, velocity) * Math.pow(10, (region.volume || 0) / 20));
    gain.gain.setValueAtTime(peak, when);
    const env: EnvPoint[] = [{ t: when, v: peak, kind: 'set' }];
    // ampeg_decay here is the SFZ decay-to-sustain; the bundled sets use it as a gentle fade.
    if (region.ampegDecay > 0) {
      const tau = Math.max(0.01, region.ampegDecay);
      gain.gain.setTargetAtTime(peak * 0.7, when, tau);
      env.push({ t: when, v: peak * 0.7, kind: 'target', tau });
    }
    src.connect(gain); gain.connect(output);
    src.start(when);

    const list = voices.get(key) || [];
    list.push({ src, gain, release: region.ampegRelease, env, baseRate,
                lastRate: baseRate * Math.pow(2, bend.at(when) / 12) });
    voices.set(key, list);
  }

  function noteOff(key: number, when: number): void {
    const list = voices.get(key);
    if (!list || !list.length) return;
    const v = list.shift()!;
    if (!list.length) voices.delete(key);
    const at = Math.max(when, ctx.currentTime);
    const rel = Math.max(0.02, v.release || 0.3);
    try {
      // The level the envelope HAS at `at`, never gain.value — see envelopeLevelAt.
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(envelopeLevelAt(v.env || [], at), at);
      v.gain.gain.exponentialRampToValueAtTime(MIN_GAIN, at + rel);
      v.src.stop(at + rel + 0.02);
    } catch (e) { /* already stopped */ }
  }

  return {
    noteOn,
    noteOff,
    pitchBend(value: number, when: number) {
      // Region bend range in cents (the bundled sets carry +/-1200 = an octave).
      const r = regions[0];
      const span = value >= 8192 ? (r && r.bendUp ? r.bendUp : 200) : Math.abs(r && r.bendDown ? r.bendDown : 200);
      const semis = bend.add(value, when, span / 100);
      const at = Math.max(when, ctx.currentTime);
      for (const list of voices.values()) {
        for (const v of list as any[]) {
          if (!v.baseRate) continue;
          try {
            // Anchor from the rate the LAST bend point scheduled, not playbackRate.value:
            // .value is read now, before any of these ramps have run, so every step would
            // restart from the base rate and the curve would come out as a sawtooth rather
            // than a rise. Track it per voice instead.
            const target = v.baseRate * Math.pow(2, semis / 12);
            v.src.playbackRate.setValueAtTime(v.lastRate != null ? v.lastRate : v.baseRate, at);
            v.src.playbackRate.linearRampToValueAtTime(target, at + 0.012);
            v.lastRate = target;
          } catch (e) { /* voice ended */ }
        }
      }
    },
    cc() { /* GMD-35 */ },
    allNotesOff() {
      const now = ctx.currentTime;
      for (const list of voices.values()) {
        for (const v of list) {
          try {
            v.gain.gain.cancelScheduledValues(now);
            v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
            v.src.stop(now + 0.08);
          } catch (e) { /* already stopped */ }
        }
      }
      voices.clear();
    },
    output
  };
}

/**
 * Deterministic impulse response. No Math.random (renders must be reproducible) and no shipped
 * asset — the `ir` identifier resolves to one of these for now. Swapping in real recorded IRs
 * later is a CONTENT change, not a code change, which is the point of `ir` being an identifier
 * rather than a path (§5.1).
 */
function makeImpulse(ctx: AudioContext, seconds: number, decay: number, lowpassHz: number, seed: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let rnd = seed >>> 0;
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let lp = 0;
    const coeff = Math.min(1, (2 * Math.PI * lowpassHz) / ctx.sampleRate);
    for (let i = 0; i < len; i++) {
      rnd = (rnd * 1664525 + 1013904223) >>> 0;
      const white = (rnd / 0x7fffffff) - 1;
      lp += coeff * (white - lp);                       // one-pole lowpass = darker tail
      data[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** Resolve an `ir` identifier to a generated impulse. Unknown ids fall back rather than fail. */
function irFor(ctx: AudioContext, id: string, kind: 'cab' | 'reverb'): AudioBuffer {
  if (kind === 'cab') {
    // Short, dark, and the single most important part of the tone (§5): a dry DI through a
    // waveshaper sounds like a bee in a jar; through a 4x12 it sounds like an amp.
    const presets: Record<string, [number, number, number]> = {
      '4x12-v30':      [0.045, 7, 4200],
      '2x12-alnico':   [0.055, 6, 5200],
      '1x12-combo':    [0.040, 8, 6000],
      'greenback-1960':[0.050, 7, 3800]
    };
    const [sec, decay, lp] = presets[id] || presets['4x12-v30'];
    return makeImpulse(ctx, sec, decay, lp, 0x5eed);
  }
  const presets: Record<string, [number, number, number]> = {
    'room-small':   [0.6, 3.0, 8000],
    'hall-medium':  [1.8, 2.2, 6000],
    'hall-large':   [3.2, 1.8, 5000],
    'plate':        [1.2, 2.6, 9000]
  };
  const [sec, decay, lp] = presets[id] || presets['hall-medium'];
  return makeImpulse(ctx, sec, decay, lp, 0xbeef);
}

/**
 * Build an insert chain from the schema. Returns an input/output pair so the caller can splice
 * it in; unknown and bypassed entries are skipped (but were already preserved by normalizeChain).
 */
function makeEqNodes(c: AudioContext, low: number, mid: number, high: number): BiquadFilterNode[] {
  const l = c.createBiquadFilter(); l.type = 'lowshelf'; l.frequency.value = 200; l.gain.value = low;
  const m = c.createBiquadFilter(); m.type = 'peaking'; m.frequency.value = 1000; m.Q.value = 0.9; m.gain.value = mid;
  const h = c.createBiquadFilter(); h.type = 'highshelf'; h.frequency.value = 4000; h.gain.value = high;
  l.connect(m); m.connect(h);
  return [l, m, h];
}

function buildFxChain(ctx: AudioContext, chainSpec: any): { input: AudioNode; output: AudioNode; nodes: AudioNode[] } {
  const FX = (window as any).GomidasFx;
  const spec = FX.normalizeChain(chainSpec);
  const input = ctx.createGain();
  const nodes: AudioNode[] = [input];
  let tail: AudioNode = input;

  const connect = (n: AudioNode) => { tail.connect(n); tail = n; nodes.push(n); };
  // Wet/dry helper: many of these are mix effects, and a 100% wet chorus is not a chorus.
  const wetDry = (make: () => { input: AudioNode; output: AudioNode }, mix: number) => {
    const split = ctx.createGain();
    const dry = ctx.createGain(); dry.gain.value = 1 - mix;
    const wet = ctx.createGain(); wet.gain.value = mix;
    const merge = ctx.createGain();
    const unit = make();
    tail.connect(split);
    split.connect(dry); dry.connect(merge);
    split.connect(unit.input); unit.output.connect(wet); wet.connect(merge);
    nodes.push(split, dry, wet, merge, unit.input, unit.output);
    tail = merge;
  };

  for (const fx of spec.chain) {
    if (fx.bypass || fx._unknown) continue;
    const p = fx.params;
    switch (fx.type) {
      case 'compressor': {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = p.threshold; comp.ratio.value = p.ratio;
        comp.attack.value = p.attack; comp.release.value = p.release; comp.knee.value = p.knee;
        connect(comp);
        break;
      }
      case 'drive': {
        const ws = ctx.createWaveShaper();
        ws.curve = FX.makeDriveCurve(p.mode, p.drive);
        ws.oversample = '4x';           // mitigates aliasing; does not eliminate it (§8)
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 800 + p.tone * 7000;
        const level = ctx.createGain(); level.gain.value = p.level;
        connect(ws); connect(tone); connect(level);
        break;
      }
      case 'eq3': {
        const eq = makeEqNodes(ctx, p.low, p.mid, p.high);
        for (const n of eq) connect(n);
        break;
      }
      case 'tremolo': {
        const amp = ctx.createGain(); amp.gain.value = 1 - p.depth / 2;
        const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate;
        const lfoGain = ctx.createGain(); lfoGain.gain.value = p.depth / 2;
        lfo.connect(lfoGain); lfoGain.connect(amp.gain); lfo.start();
        nodes.push(lfo, lfoGain);
        connect(amp);
        break;
      }
      case 'wah': {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = p.freq; bp.Q.value = p.q;
        wetDry(() => ({ input: bp, output: bp }), p.mix);
        break;
      }
      case 'chorus':
      case 'flanger': {
        const d = ctx.createDelay(0.1);
        d.delayTime.value = p.delayMs / 1000;
        const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate;
        const depth = ctx.createGain(); depth.gain.value = (p.depth * p.delayMs) / 2000;
        lfo.connect(depth); depth.connect(d.delayTime); lfo.start();
        nodes.push(lfo, depth);
        let head: AudioNode = d;
        if (fx.type === 'flanger' && p.feedback > 0) {
          const fb = ctx.createGain(); fb.gain.value = p.feedback;
          d.connect(fb); fb.connect(d);
          nodes.push(fb);
        }
        wetDry(() => ({ input: head, output: d }), p.mix);
        break;
      }
      case 'phaser': {
        const stages: BiquadFilterNode[] = [];
        for (let i = 0; i < 4; i++) {
          const ap = ctx.createBiquadFilter();
          ap.type = 'allpass';
          ap.frequency.value = 300 * Math.pow(2, i);
          stages.push(ap);
          if (i > 0) stages[i - 1].connect(ap);
        }
        const lfo = ctx.createOscillator(); lfo.frequency.value = p.rate;
        const depth = ctx.createGain(); depth.gain.value = 800 * p.depth;
        lfo.connect(depth);
        for (const st of stages) depth.connect(st.frequency);
        lfo.start();
        nodes.push(lfo, depth, ...stages);
        wetDry(() => ({ input: stages[0], output: stages[stages.length - 1] }), p.mix);
        break;
      }
      case 'delay': {
        const d = ctx.createDelay(2.1);
        d.delayTime.value = p.timeMs / 1000;
        const fb = ctx.createGain(); fb.gain.value = p.feedback;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.tone;
        d.connect(lp); lp.connect(fb); fb.connect(d);       // filter INSIDE the feedback loop
        nodes.push(fb, lp);
        wetDry(() => ({ input: d, output: d }), p.mix);
        break;
      }
      case 'cab':
      case 'reverb': {
        const conv = ctx.createConvolver();
        conv.normalize = true;
        conv.buffer = irFor(ctx, String(p.ir || ''), fx.type === 'cab' ? 'cab' : 'reverb');
        nodes.push(conv);
        wetDry(() => ({ input: conv, output: conv }), fx.type === 'cab' ? 1 : p.mix);
        break;
      }
      default: break;
    }
  }
  return { input, output: tail, nodes };
}

/**
 * General MIDI instrument backed by the bundled SoundFont (GMD-36). This is what makes an
 * arbitrary imported .gp — piano, strings, organ — actually play.
 *
 * One AudioBuffer per SF2 sample, decoded lazily from the shared PCM block and cached across
 * every channel: a GM bank has hundreds of samples and converting all of them up front would
 * stall the page for seconds.
 */
function createSf2Instrument(ctx: AudioContext, bank: any, program: number, percussion: boolean,
                             bufferCache: Map<number, AudioBuffer>): Instrument {
  const SF2 = (window as any).GomidasSf2;
  const output = ctx.createGain();
  // Drums: the GM program selects the KIT, so resolve it inside bank 128 (see findDrumPreset).
  // This used to take the first bank-128 preset in file order, which ignored the kit picker
  // outright — invisible on sonivox, where Standard happens to come first.
  const preset = percussion
    ? (bank.findDrumPreset ? bank.findDrumPreset(program) : bank.presets.find((p: any) => p.bank === 128))
    : bank.findPreset(0, program);
  const voices = new Map<number, any[]>();
  const bend = createBendTimeline();
  // Every sounding voice, flat, for exclusive-class choking (SF2 gen 57). Kept alongside the
  // per-key map rather than derived from it: a choke searches by class, not by key.
  const sounding = new Set<any>();
  let nextNoteId = 1;

  function bufferFor(index: number): AudioBuffer | null {
    // A pack (the FluidR3 drum kit, GMD-50) ships already-decoded buffers instead of a raw PCM
    // block, and holds them itself — so it bypasses this instrument's cache entirely, and its
    // sample indices can never collide with the GM bank's. Everything downstream — zone
    // selection, rates, envelopes — is identical.
    if (bank.makeBuffer) return bank.makeBuffer(index);
    let buf = bufferCache.get(index);
    if (buf) return buf;
    const s = bank.samples[index];
    if (!s || s.end <= s.start) return null;
    const len = s.end - s.start;
    buf = ctx.createBuffer(1, len, s.sampleRate > 0 ? s.sampleRate : 44100);
    const out = buf.getChannelData(0);
    const pcm = bank.pcm;
    for (let i = 0; i < len; i++) out[i] = pcm[s.start + i] / 32768;
    bufferCache.set(index, buf);
    return buf;
  }

  /** Drop a voice from the bookkeeping. Idempotent — stop() and a natural end both land here. */
  function forget(v: any): void {
    sounding.delete(v);
    const list = voices.get(v.key);
    if (!list) return;
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) voices.delete(v.key);
  }

  /**
   * SF2 exclusive class (gen 57): starting a voice of class N silences every other sounding voice
   * of class N — this is what makes a closed hi-hat cut the open one, and a mute triangle cut the
   * open triangle. Without it the two ring together and a hat pattern turns to mush.
   *
   * The cut is a short fade, not an instant stop: killing a sample mid-cycle clicks.
   */
  const CHOKE_S = 0.012;
  function chokeClass(cls: number, at: number): void {
    for (const v of Array.from(sounding)) {
      if (v.exclusiveClass !== cls) continue;
      try {
        v.gain.gain.cancelScheduledValues(at);
        v.gain.gain.setValueAtTime(envelopeLevelAt(v.env || [], at), at);
        v.gain.gain.exponentialRampToValueAtTime(MIN_GAIN, at + CHOKE_S);
        v.src.stop(at + CHOKE_S + 0.005);
      } catch (e) { /* already stopped */ }
      forget(v);
    }
  }

  function noteOn(key: number, velocity: number, when: number): void {
    if (!preset) return;
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    const zones = SF2.zonesFor(preset, key, vel);
    if (!zones.length) return;
    // Choke BEFORE registering this note's own voices, so a hat never chokes itself.
    for (const z of zones) if (z.exclusiveClass) chokeClass(z.exclusiveClass, when);
    // Every voice this note-on spawns shares one id, so a layered note releases as a unit while a
    // retrigger of the same key stays independent of it (GMD-49).
    const noteId = nextNoteId++;
    // Layered presets legitimately stack zones (piano + string pad). Cap it: a pathological
    // bank could otherwise spawn dozens of voices per note.
    for (const z of zones.slice(0, 4)) {
      const buf = bufferFor(z.sampleIndex);
      if (!buf) continue;
      const s = bank.samples[z.sampleIndex];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // Bend in force AT THIS NOTE'S START, not whatever it happens to be right now.
      const baseRate = SF2.rateFor(z, s, key, buf.sampleRate);
      src.playbackRate.setValueAtTime(baseRate * Math.pow(2, bend.at(when) / 12), when);
      if (z.loopMode === 1 || z.loopMode === 3) {
        const loopStart = (s.startLoop - s.start) / buf.sampleRate;
        const loopEnd = (s.endLoop - s.start) / buf.sampleRate;
        if (loopEnd > loopStart && loopEnd <= buf.duration) {
          src.loop = true; src.loopStart = loopStart; src.loopEnd = loopEnd;
        }
      }
      const gain = ctx.createGain();
      // Both curves are the bank's, not ours: the EMU attenuation factor every SF2 was authored
      // against, and SF2's default velocity->attenuation modulator. See core/sf2.ts.
      //
      // The make-up is ours, and only for drums: FluidR3 authors an acoustic kit balance in which
      // the kick and hats sit several dB under the snare (GMD-73). This is the ONE place a voice's
      // peak is born, and everything below — sustain, the recorded envelope, the release and the
      // choke level — derives from it, so nothing else needs to know. It reaches the offline bounce
      // for free because both graphs build their instrument through makeInstrument.
      const makeup = percussion ? SF2.percussionMakeupGain(key, z.attenuationDb || 0) : 1;
      const peak = Math.max(0.0001,
        SF2.velocityGain(velocity) * SF2.attenuationGain(z.attenuationDb || 0) * makeup);
      const sustainAt = Math.max(0.0001, peak * (z.sustain != null ? z.sustain : 1));
      // Approximate the SF2 volume envelope: attack -> hold -> decay to sustain.
      const a = Math.max(0.001, z.attack || 0.001);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(peak, when + a);
      // Record what was scheduled so the release can start from the level the note actually has.
      const env: EnvPoint[] = [{ t: when, v: MIN_GAIN, kind: 'set' },
                               { t: when + a, v: peak, kind: 'lin' }];
      if (z.decay > 0.001) {
        const tau = Math.max(0.01, z.decay / 3);
        const decayAt = when + a + (z.hold || 0);
        gain.gain.setTargetAtTime(sustainAt, decayAt, tau);
        env.push({ t: decayAt, v: sustainAt, kind: 'target', tau });
      }
      let node: AudioNode = gain;
      if (z.pan) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-1, Math.min(1, z.pan * 2));
        gain.connect(pan); node = pan;
      }
      // The zone's own lowpass (SF2 gens 8/9), between the sample and its envelope so the filter
      // shapes the source and the envelope still owns the level. Most zones have none and get the
      // direct connection they always had. See SF2.zoneFilter: without this, FluidR3's guitars —
      // a dry layer plus a low-passed layer of the same sample — play as two dry copies, +6dB
      // (GMD-80). Static: the cutoff never moves after note-on (GMD-81).
      const filt = SF2.zoneFilter(z, ctx.sampleRate);
      if (filt) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = filt.hz;
        lp.Q.value = filt.qDb;
        src.connect(lp); lp.connect(gain);
      } else {
        src.connect(gain);
      }
      node.connect(output);
      src.start(when);
      // A percussion sample that does not loop is a ONE-SHOT: it has no sustain to hold, so a
      // note-off must not touch it. Gating a crash with the 16th note it was written on is what
      // makes a kit sound like cardboard. A LOOPED drum zone (sonivox hats are loopMode 1) is the
      // opposite case — it rings forever unless released, so those still honour note-off.
      const looping = z.loopMode === 1 || z.loopMode === 3;
      const v = { key, src, gain, release: Math.max(0.05, z.release || 0.3), env, baseRate,
                  lastRate: baseRate * Math.pow(2, bend.at(when) / 12),
                  exclusiveClass: z.exclusiveClass || 0,
                  noteId,
                  oneShot: percussion && !looping };
      const list = voices.get(key) || [];
      list.push(v);
      voices.set(key, list);
      sounding.add(v);
      // One-shots are never released, so nothing else would ever drop them from the bookkeeping.
      src.onended = () => forget(v);
    }
  }

  function releaseVoice(v: { src: AudioBufferSourceNode; gain: GainNode; release: number; env?: EnvPoint[] },
                        at: number, maxRelease?: number): void {
    try {
      const rel = maxRelease != null ? Math.min(v.release, maxRelease) : v.release;
      // The level the envelope HAS at `at` — never gain.value, which is 1.0 for a note whose
      // automation has not run yet. See envelopeLevelAt.
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(envelopeLevelAt(v.env || [], at), at);
      v.gain.gain.exponentialRampToValueAtTime(MIN_GAIN, at + rel);
      v.src.stop(at + rel + 0.02);
    } catch (e) { /* already stopped */ }
  }

  return {
    noteOn,
    noteOff(key: number, when: number) {
      const list = voices.get(key);
      if (!list || !list.length) return;
      const at = Math.max(when, ctx.currentTime);
      // Only the OLDEST note instance under this key — see voicesToRelease. Releasing the whole
      // list cut short any note that retriggered the key while an earlier one rang (GMD-49).
      for (const v of voicesToRelease(list)) {
        releaseVoice(v, at);
        forget(v);
      }
    },
    pitchBend(value: number, when: number) {
      const semis = bend.add(value, when, 12);   // +/-12, matching the native engine
      const at = Math.max(when, ctx.currentTime);
      for (const list of voices.values()) {
        for (const v of list as any[]) {
          if (!v.baseRate) continue;
          try {
            // Anchor from the rate the LAST bend point scheduled, not playbackRate.value:
            // .value is read now, before any of these ramps have run, so every step would
            // restart from the base rate and the curve would come out as a sawtooth rather
            // than a rise. Track it per voice instead.
            const target = v.baseRate * Math.pow(2, semis / 12);
            v.src.playbackRate.setValueAtTime(v.lastRate != null ? v.lastRate : v.baseRate, at);
            v.src.playbackRate.linearRampToValueAtTime(target, at + 0.012);
            v.lastRate = target;
          } catch (e) { /* voice ended */ }
        }
      }
    },
    cc() { /* modulators are deliberately not implemented — see core/sf2.ts */ },
    allNotesOff() {
      const now = ctx.currentTime;
      // Panic / stop / seek / instrument swap: a short fade, NOT the zone's own release. Drum
      // one-shots have releases up to 9s in FluidR3, and Stop must stop.
      for (const v of Array.from(sounding)) releaseVoice(v, now, 0.08);
      voices.clear();
      sounding.clear();
    },
    output
  };
}

/**
 * MASTER GAIN STAGING (GMD-42) — headroom, then a soft ceiling.
 *
 * MEASURED on the sample score, via the offline bounce (the deterministic path; the automation
 * tab is always document.hidden, so the meter and rAF are dead — see CLAUDE.md):
 *
 *   one note, full velocity ......  +2.88 dBFS
 *   three-note chord ............   +7.52 dBFS
 *   six-note chord ..............   +9.38 dBFS
 *   the two-track sample score ...  +5.77 dBFS   (410 hard-clipped samples, 52 runs)
 *
 * A SINGLE note already exceeds full scale, so this was never a "too many tracks" problem and no
 * amount of mixing discipline fixes it: a voice's peak gain is velocity² × the zone attenuation,
 * both of which top out at 1.0, and the sample itself is normalised near full scale. Nothing in
 * the chain ever budgeted for a second voice.
 *
 * Two parts, because one alone is wrong:
 *  - HEADROOM, a fixed trim, so ordinary material never reaches the ceiling at all. -6 dB puts a
 *    single note at -3.1 dBFS, just under the knee.
 *  - a CEILING, so dense chords saturate smoothly instead of hard-clipping. A fixed trim sized
 *    for the +9.4 dB worst case would make single notes inaudibly quiet; a ceiling costs nothing
 *    until it is needed.
 *
 * Deliberately a WaveShaper and not a DynamicsCompressorNode: zero latency, no attack/release to
 * pump or to smear a transient, and bit-identical between live playback and the offline bounce —
 * which is the property this file keeps getting wrong (GMD-57, GMD-62, GMD-66).
 */
const HEADROOM_DB = -6;
const HEADROOM_GAIN = Math.pow(10, HEADROOM_DB / 20);
/** Below this the curve is exactly y = x, so normal material passes through untouched. */
const CEILING_KNEE = 0.708;          // -3 dBFS
/** Input range the curve covers, in linear gain. WaveShaper indexes its curve over ±1, so the
 *  signal is scaled by 1/CEILING_RANGE going in — without this, anything above unity would land
 *  on the last curve entry and be HARD-clipped there, which is the bug we are removing. */
const CEILING_RANGE = 4;             // +12 dBFS
/**
 * The asymptote, and deliberately NOT 1.0. tanh saturates to 1 fast enough that in float32
 * `knee + (1 - knee) * tanh(x)` rounds to exactly 1.0 well inside the curve's range — which the
 * int16 encode then turns back into the clipped sample this whole stage exists to prevent.
 * Caught by tests/ceiling.test.js. -0.02 dB, i.e. inaudible, but strictly below full scale.
 */
const CEILING_MAX = 0.998;

/**
 * y = x below the knee; above it, a tanh shoulder asymptotic to 1.0. Continuous in value AND in
 * slope at the knee (tanh'(0) = 1), so there is no audible corner where the ceiling engages.
 *
 * `curve[i]` is the output for an input of `(i/(n-1) * 2 - 1) * CEILING_RANGE`.
 * Pure and exported so the shape is unit-tested rather than eyeballed.
 */
/**
 * Which of the voices stored under one key a note-off should release (GMD-49).
 *
 * The per-key list conflates two different things, and releasing all of it is wrong for one of
 * them:
 *   1. LAYERED ZONES — one note-on legitimately spawns several voices (a piano + string-pad
 *      preset stacks up to four). Those must release together, as one note.
 *   2. A RETRIGGER — the same key struck again while an earlier instance is still ringing (ties,
 *      let ring, a fast repeated note on one string). Releasing all of them means the first
 *      note's note-off kills the second note, which has only just started.
 *
 * So: FIFO by note INSTANCE, not by key. Voices from one note-on share a noteId; the oldest
 * surviving noteId is the note being released. One-shots are excluded entirely — a drum sample
 * that does not loop has no sustain to end, and is only ever cut by an exclusive-class choke.
 *
 * Pure, so the selection is unit-tested rather than inferred from a waveform.
 */
function voicesToRelease<T extends { noteId?: number; oneShot?: boolean }>(list: T[]): T[] {
  if (!list || !list.length) return [];
  let oldest = Infinity;
  for (const v of list) {
    if (v.oneShot) continue;
    const id = v.noteId != null ? v.noteId : 0;
    if (id < oldest) oldest = id;
  }
  if (oldest === Infinity) return [];
  return list.filter((v) => !v.oneShot && (v.noteId != null ? v.noteId : 0) === oldest);
}

function ceilingCurve(n = 8192, knee = CEILING_KNEE, range = CEILING_RANGE): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    const a = Math.abs(x);
    const span = CEILING_MAX - knee;
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

interface ChannelStrip {
  input: GainNode;
  fxIn: GainNode;
  sends: Record<string, GainNode>;
  fx: { input: AudioNode; output: AudioNode; nodes: AudioNode[] } | null;
  // The spec the insert chain was built from. Kept because the offline bounce has to REBUILD the
  // chain in its own context and cannot clone live nodes (GMD-66).
  fxSpec: any;
  gain: GainNode;
  pan: StereoPannerNode;
  eq: BiquadFilterNode[];
  instrument: Instrument | null;
  program: number;
  percussion: boolean;
}

/**
 * The pack schema this runtime expects. Bumped whenever a pack gains a field the player READS,
 * because the two are cached on completely different terms: the JS is content-hashed and
 * immutable, while `/drumkits/*` and `/instruments-gm/*` are served `max-age=2592000` and fetched
 * by name (apps/web/build.mjs). GMD-80 is the case that makes this load-bearing — it added
 * `filterFc`, whose ABSENCE legitimately means "old pack, do not filter", so a returning visitor
 * pairing new JS with a 30-day-cached manifest would get two dry guitar layers at +6dB again,
 * silently, still logging "FluidR3 pack". The `.bin`s are byte-identical, so GMD-58's blobBytes
 * check cannot see it either.
 */
const PACK_VERSION = 2;

function createWebAudioBackend(BackendLib: any): any {
  const TB = typeof GomidasTimebase !== 'undefined' ? GomidasTimebase : (window as any).GomidasTimebase;
  const bus = BackendLib.createEventBus();

  let ctx: AudioContext | null = null;
  let master: { eq: BiquadFilterNode[]; gain: GainNode; pan: StereoPannerNode;
                headroom: GainNode; preScale: GainNode; ceiling: WaveShaperNode;
                analyser: AnalyserNode } | null = null;
  const channels: (ChannelStrip | null)[] = new Array(16).fill(null);

  let sequence: { lengthTicks: number; events: number[][] } = { lengthTicks: 0, events: [] };
  let bpm = 120;
  let rate = 1;
  let loop: { start: number; end: number } | null = null;

  let playing = false;
  let positionTick = 0;          // where the transport is when stopped
  let schedCursorTick = 0;       // next un-scheduled sequence tick
  let schedTime = 0;             // context time that cursor corresponds to
  let cursorIndex = 0;
  let timer: any = null;
  let rafId = 0;
  // (contextTime -> sequenceTick) anchors, so the playhead can be derived from currentTime
  // rather than counted from scheduled events (§7.2).
  let anchors: Array<{ time: number; tick: number }> = [];
  let meterData: Uint8Array | null = null;

  // ---- graph ------------------------------------------------------------------------------
  function ensureContext(): AudioContext {
    if (ctx) return ctx;
    // latencyHint 'interactive' for the fretboard audition path (§7.2).
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ latencyHint: 'interactive' });
    const eq = makeEq(ctx);
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const { headroom, preScale, ceiling } = makeOutputStage(ctx);
    // eq[2] -> gain is spliced by applyFx('master', ...) when a master chain is set.
    // The meter sits AFTER the ceiling so it shows what actually left the app, not what would
    // have left it if nothing were clipping.
    chain([...eq, gain, pan, headroom, preScale, ceiling, analyser]);
    analyser.connect(ctx.destination);
    master = { eq, gain, pan, headroom, preScale, ceiling, analyser };
    meterData = new Uint8Array(analyser.fftSize);
    loadGmBank();
    return ctx;
  }

  function makeEq(c: AudioContext): BiquadFilterNode[] {
    const low = c.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 200; low.gain.value = 0;
    const mid = c.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.9; mid.gain.value = 0;
    const high = c.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 4000; high.gain.value = 0;
    return [low, mid, high];
  }

  function chain(nodes: AudioNode[]): void {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  }

  /**
   * The master output stage (GMD-42): headroom trim -> 1/range pre-scale -> soft ceiling.
   *
   * The pre-scale is not cosmetic. A WaveShaperNode indexes its curve over an input of ±1 and
   * CLAMPS anything outside that to the end entries — so feeding it a +9 dB peak directly would
   * flatten every sample above unity onto one value, which is hard clipping wearing a different
   * hat. Scaling by 1/CEILING_RANGE first puts a +12 dB peak at the last curve entry instead.
   *
   * Built here, in ONE place, so the live graph and the offline bounce cannot drift apart —
   * the exact failure this file has now shipped three times (GMD-57, GMD-62, GMD-66).
   */
  function makeOutputStage(c: BaseAudioContext): { headroom: GainNode; preScale: GainNode; ceiling: WaveShaperNode } {
    const headroom = c.createGain();
    headroom.gain.value = HEADROOM_GAIN;
    const preScale = c.createGain();
    preScale.gain.value = 1 / CEILING_RANGE;
    const ceiling = c.createWaveShaper();
    ceiling.curve = ceilingCurve();
    // 'none' on purpose: the curve is exactly y = x below the knee, so ordinary material must be
    // passed through untouched. Any oversampling would run it through resampling filters first.
    ceiling.oversample = 'none';
    return { headroom, preScale, ceiling };
  }

  function strip(ch: number): ChannelStrip {
    const c = ensureContext();
    let s = channels[ch];
    if (s) return s;
    const input = c.createGain();
    const fxIn = c.createGain();     // insert point: inserts live between input and the fader
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    const eq = makeEq(c);
    // instrument -> input -> [inserts] -> gain -> pan -> EQ -> master (AudioEngine's order).
    // Inserts are PRE-fader (§4.1) so moving the volume slider does not change how hard the
    // drive is being pushed.
    chain([input, fxIn, gain, pan, ...eq]);
    eq[2].connect(master!.eq[0]);
    // Sends are POST-fader (§4.1) so muting a track also mutes its reverb tail. Standard
    // console behaviour; do not deviate.
    const sends: Record<string, GainNode> = {};
    for (const name of ['delay', 'reverb']) {
      const g = c.createGain(); g.gain.value = 0;
      eq[2].connect(g);
      g.connect(sendBus(name).input);
      sends[name] = g;
    }
    s = { input, fxIn, gain, pan, eq, sends, fx: null, fxSpec: null,
          instrument: null, program: 24, percussion: ch === 9 };
    channels[ch] = s;
    return s;
  }

  // Channels holding a loaded SFZ. Without this, the first note-on after a preset load would
  // see a program mismatch and swap the sampler back out for the placeholder tone.
  //
  // It maps to the parsed preset (NOT just the channel number) because the offline bounce has to
  // build its OWN sampler in its own context — an AudioNode cannot cross contexts, but the
  // regions and the decoded AudioBuffers can. Before this, the bounce had no SFZ branch at all
  // and silently recorded those tracks as GM (GMD-62).
  const sfzChannels = new Map<number, { regions: any[]; buffers: Map<string, AudioBuffer> }>();

  // The bundled GM bank (GMD-36). Loaded once, lazily, and shared by every channel; the sample
  // buffer cache is shared too, since a piano and a string pad often reference the same sample.
  let gmBank: any = null;
  let gmLoading: Promise<any> | null = null;
  const gmBuffers = new Map<number, AudioBuffer>();

  /**
   * Cache-first fetch for every lazily-loaded audio payload (GMD-58). `expectedBytes` is the
   * `blobBytes` from the pack head when there is one, which is what invalidates a cached blob
   * after a re-extract. Falls back to a plain fetch if the cache module is absent, so the
   * loaders below have exactly one code path either way.
   */
  function packFetch(url: string, expectedBytes?: number | null): Promise<ArrayBuffer> {
    const pc = (window as any).GomidasPackCache;
    if (pc) return pc.fetchBuffer(url, expectedBytes);
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.arrayBuffer();
    });
  }

  function loadGmBank(): Promise<any> {
    if (gmBank) return Promise.resolve(gmBank);
    if (gmLoading) return gmLoading;
    // 1.35MB. FluidR3 (144MB) is emphatically not going over the wire (§8).
    // No head to size-check against, so this one is keyed by CACHE_VERSION alone (GMD-58).
    gmLoading = packFetch('soundfont/sonivox.sf2')
      .then(buf => {
        gmBank = (window as any).GomidasSf2.parseSf2(buf);
        // Re-create instruments built from the placeholder tone before the bank arrived, so the
        // first seconds of playback are not permanently stuck on oscillators.
        for (let ch = 0; ch < channels.length; ch++) {
          const st = channels[ch];
          if (st && st.instrument && !sfzChannels.has(ch)) { st.instrument.allNotesOff(); st.instrument = null; }
        }
        return gmBank;
      })
      .catch(() => { gmLoading = null; return null; });   // fall back to the tone
    return gmLoading;
  }

  /**
   * A pack is a bank. Both the drum kit (GMD-50) and the melodic packs (GMD-57) ship the SAME
   * zone shape core/sf2.ts produces, so everything downstream — zone selection, rates, envelopes,
   * exclusive-class choking — is the shared code path and never learns a pack exists.
   *
   * Decoding does NOT need the live context, and must not wait for one: packs are preloaded when
   * a score is set, typically long before the user gesture that creates the AudioContext. Buffers
   * carry their own sample rate, so a buffer decoded here plays correctly in whatever context
   * ends up using it.
   */
  function packContext(): any {
    return ctx || new (window as any).OfflineAudioContext(1, 1, 44100);
  }

  /**
   * Decode one pack blob into `into`, and return the sample table rebased onto the decoded
   * buffers. Each sample is its own complete audio file inside the blob, so each slice decodes
   * independently — no sprite offsets to drift.
   */
  function decodePackBlob(c: any, head: any, blob: ArrayBuffer, into: Map<number, AudioBuffer>,
                          base: number, what: string): Promise<any[]> {
    // A JSON read against a stale blob would decode garbage; refuse instead.
    if (head.blobBytes != null && blob.byteLength !== head.blobBytes)
      throw new Error(what + ' blob is ' + blob.byteLength + ' bytes, header says ' + head.blobBytes);
    return Promise.all(head.samples.map((s: any, i: number) =>
      c.decodeAudioData(blob.slice(s.offset, s.offset + s.length))
        .then((buf: AudioBuffer) => { into.set(base + i, buf); return buf; })))
      .then((buffers: AudioBuffer[]) =>
        // decodeAudioData resamples to the context rate. Report that rate as the sample's own so
        // rateFor's sampleRate/outputRate term stays 1 and only the pitch factor remains; loop
        // points move with it.
        head.samples.map((s: any, i: number) => {
          const buf = buffers[i];
          const ratio = s.sampleRate > 0 ? buf.sampleRate / s.sampleRate : 1;
          return { ...s, sampleRate: buf.sampleRate,
                   start: 0, end: buf.length,
                   startLoop: Math.round(s.startLoop * ratio), endLoop: Math.round(s.endLoop * ratio) };
        }));
  }


  /**
   * Fetch a pack head, and if it predates what this build reads, go around the HTTP cache once.
   * Cheap: the common case is one ordinary (cached) fetch, and the reload only ever happens to a
   * visitor holding a stale copy.
   */
  function fetchPackHead(url: string, what: string): Promise<any> {
    const parse = (r: Response) => {
      if (!r.ok) throw new Error(what + ' ' + r.status);
      return r.json();
    };
    return fetch(url).then(parse).then(head => {
      if ((head.version | 0) >= PACK_VERSION) return head;
      console.warn('[Gomidas] ' + what + ' is v' + head.version + ', this build reads v' +
                   PACK_VERSION + ' — refetching past the cache');
      return fetch(url, { cache: 'reload' }).then(parse).then(fresh => {
        if ((fresh.version | 0) < PACK_VERSION) {
          // The SERVER is old, not the cache. Say so: the alternative is playing a pack whose
          // missing fields read as deliberate defaults.
          console.warn('[Gomidas] ' + what + ' is still v' + fresh.version +
                       ' after a reload — the deployed pack predates this build');
        }
        return fresh;
      }, (e: any) => {
        // The forced-network refetch failed — offline, or a flaky host. Keep the stale head we
        // already have: an out-of-date pack still plays FluidR3, while rejecting here drops all
        // the way to sonivox's 20ms kick. Never let a cache-freshness check cost the good samples.
        console.warn('[Gomidas] ' + what + ' refetch failed, using the cached v' + head.version +
                     ' pack:', e);
        return head;
      });
    });
  }

  /**
   * The real drum kit (GMD-50): FluidR3's bank 128, extracted to assets/drumkits/ by
   * tools/extract-sf2-pack.mjs. sonivox's kit is a 20ms kick at 20kHz with one velocity layer, so
   * it is the fallback, not the plan.
   *
   * Fetched lazily on the first percussion note — 5.4MB must not land on someone who opened a
   * guitar tab — and, like the GM bank, it swaps itself in by dropping the instruments built
   * before it arrived. Until then drums play from sonivox rather than silence.
   */
  const DRUMKIT_URL = 'drumkits/gm-standard';
  let drumKit: any = null;
  let drumKitLoading: Promise<any> | null = null;
  const drumKitBuffers = new Map<number, AudioBuffer>();

  function loadDrumKit(): Promise<any> {
    if (drumKit) return Promise.resolve(drumKit);
    if (drumKitLoading) return drumKitLoading;
    const c: any = packContext();
    drumKitLoading = fetchPackHead(DRUMKIT_URL + '.json', 'drum kit')
      .then(head => packFetch(DRUMKIT_URL + '.bin', head.blobBytes)
        .then(blob => decodePackBlob(c, head, blob, drumKitBuffers, 0, 'kit'))
        .then((samples: any[]) => {
          const presets = head.kits.map((k: any) => ({ bank: 128, program: k.program, name: k.name, zones: k.zones }));
          return {
            presets, samples, pcm: new Int16Array(0),
            makeBuffer: (i: number) => drumKitBuffers.get(i) || null,
            findPreset: (_bank: number, program: number) =>
              presets.find((p: any) => p.program === program) || presets[0] || null,
            findDrumPreset: (program: number) =>
              presets.find((p: any) => p.program === program) || presets[0] || null
          };
        }))
      .then(kit => {
        drumKit = kit;
        // Say which kit is actually playing. Without this the only way to tell the real kit from
        // the sonivox fallback is by ear, which is precisely the thing under dispute.
        try {
          console.info('[Gomidas] drum kit: ' + kit.presets[0].name + ' (' + kit.samples.length +
                       ' samples) — FluidR3 pack');
        } catch (e) { /* logging must never break playback */ }
        for (let ch = 0; ch < channels.length; ch++) {
          const st = channels[ch];
          if (st && st.instrument && st.percussion && !sfzChannels.has(ch)) {
            st.instrument.allNotesOff();
            st.instrument = null;
          }
        }
        return kit;
      })
      .catch((e) => {
        console.warn('[Gomidas] drum pack unavailable, falling back to the sonivox kit:', e);
        drumKitLoading = null;
        return null;
      });
    return drumKitLoading;
  }

  /**
   * Melodic instruments (GMD-57). GMD-50 fixed percussion and left guitars and basses on the
   * sonivox bank — the same Android EAS bank whose 20ms kick we rejected. These are FluidR3's
   * bank 0, extracted per program by tools/extract-sf2-pack.mjs.
   *
   * ONE BLOB PER PROGRAM, not per family, because melodic presets share almost no samples
   * (measured on FluidR3: guitars 24-31 are 83 samples summed per-program and 82 unique). So the
   * split costs nothing in total size and a score using one guitar fetches ~1MB instead of the
   * 5.89MB family. The manifest carries every program's zone table — 482KB raw but 7.5KB brotli,
   * so it is one cheap fetch that also tells us WHICH programs are packed, and therefore when to
   * stay on sonivox instead of firing a 404.
   */
  const MELODIC_DIR = 'instruments-gm/';
  const MELODIC_URL = MELODIC_DIR + 'gm-melodic';
  let melodicManifest: any = null;
  let melodicManifestLoading: Promise<any> | null = null;
  const melodicPacks = new Map<number, any>();
  const melodicLoading = new Map<number, Promise<any>>();

  function loadMelodicManifest(): Promise<any> {
    if (melodicManifest) return Promise.resolve(melodicManifest);
    if (melodicManifestLoading) return melodicManifestLoading;
    melodicManifestLoading = fetchPackHead(MELODIC_URL + '.json', 'melodic manifest')
      .then(m => { melodicManifest = m; return m; })
      .catch((e) => {
        console.warn('[Gomidas] melodic pack manifest unavailable, staying on the sonivox bank:', e);
        melodicManifestLoading = null;
        return null;
      });
    return melodicManifestLoading;
  }

  function loadMelodicPack(program: number): Promise<any> {
    const have = melodicPacks.get(program);
    if (have) return Promise.resolve(have);
    const inflight = melodicLoading.get(program);
    if (inflight) return inflight;

    const c: any = packContext();
    const job = loadMelodicManifest().then((m: any) => {
      if (!m || !m.programs) return null;
      const entry = m.programs.find((x: any) => x.program === program);
      // Not packed is NOT an error: only guitars and basses ship today, and sonivox covers the
      // other ~100 GM programs. Recording the miss keeps us from re-fetching the manifest per note.
      if (!entry) { melodicPacks.set(program, null); return null; }
      const buffers = new Map<number, AudioBuffer>();
      return packFetch(MELODIC_DIR + entry.blob, entry.blobBytes)
        .then(blob => decodePackBlob(c, entry, blob, buffers, 0, 'program ' + program))
        .then((samples: any[]) => {
          const preset = { bank: 0, program, name: entry.name, zones: entry.zones };
          const pack = {
            presets: [preset], samples, pcm: new Int16Array(0),
            makeBuffer: (i: number) => buffers.get(i) || null,
            // The pack IS this one program, so the lookup cannot miss.
            findPreset: () => preset
          };
          melodicPacks.set(program, pack);
          try {
            console.info('[Gomidas] instrument ' + program + ': ' + entry.name + ' (' +
                         samples.length + ' samples) — FluidR3 pack');
          } catch (e) { /* logging must never break playback */ }
          // Swap it in by dropping instruments built from sonivox before it arrived, exactly as
          // the drum kit does — otherwise the first playthrough is permanently the bad bank.
          for (let ch = 0; ch < channels.length; ch++) {
            const st = channels[ch];
            if (st && st.instrument && !st.percussion && st.program === program && !sfzChannels.has(ch)) {
              st.instrument.allNotesOff();
              st.instrument = null;
            }
          }
          return pack;
        });
    }).catch((e) => {
      console.warn('[Gomidas] melodic pack for program ' + program + ' unavailable, ' +
                   'falling back to the sonivox bank:', e);
      melodicLoading.delete(program);
      return null;
    });

    melodicLoading.set(program, job);
    return job;
  }

  /**
   * THE ONE PLACE a channel's bank is chosen. Live playback and the offline bounce must agree, or
   * the bounce is not what you heard — and they silently disagreed until GMD-57: renderOffline
   * had its own copy of this expression, commented "Same bank choice as live playback", which
   * stopped being true the moment melodic packs existed. Same failure shape as GMD-44's three
   * instrument factories. Keep it single-sourced.
   *
   * Prefer a FluidR3 pack — the drum kit for percussion, the per-program melodic pack otherwise —
   * then the sonivox GM bank. melodicPacks holds null for a program we know is not packed, so
   * `|| gmBank` is the intended path for those, not a fallback.
   */
  function bankFor(program: number, perc: boolean): any {
    return perc ? (drumKit || gmBank) : (melodicPacks.get(program) || gmBank);
  }

  /**
   * THE ONE PLACE an instrument is built, for the same reason bankFor is the one place a bank is
   * chosen. Live playback and the offline bounce both call this, so a track that plays through an
   * SFZ sampler also RECORDS through one — it did not, and bounced as GM instead (GMD-62).
   *
   * `c` and `buffers` are parameters precisely so the offline context can build its own copy:
   * AudioNodes are bound to their context, the regions and decoded buffers behind them are not.
   */
  function makeInstrument(c: BaseAudioContext, ch: number, program: number,
                          perc: boolean, buffers: Map<number, AudioBuffer>): Instrument {
    const sfz = sfzChannels.get(ch);
    if (sfz) return createSfzInstrument(c as AudioContext, sfz.regions, sfz.buffers);
    // Falls back to the placeholder tone only while a bank is still loading, or if it failed.
    const bank = bankFor(program, perc);
    return bank
      ? createSf2Instrument(c as AudioContext, bank, program | 0, perc, buffers)
      : createToneInstrument(c as AudioContext, perc);
  }

  function instrumentFor(ch: number, program: number, percussion: boolean): Instrument {
    const s = strip(ch);
    if (sfzChannels.has(ch) && s.instrument) return s.instrument;
    const perc = percussion || ch === 9;
    if (perc && !drumKit) loadDrumKit();
    if (!perc && !melodicPacks.has(program)) loadMelodicPack(program);
    if (!s.instrument || s.program !== program || s.percussion !== perc) {
      if (s.instrument) s.instrument.allNotesOff();
      s.instrument = makeInstrument(ctx!, ch, program, perc, gmBuffers);
      s.instrument.output.connect(s.input);
      s.program = program;
      s.percussion = perc;
    }
    return s.instrument;
  }

  // ---- scheduling (§7.1) --------------------------------------------------------------------
  const spt = () => TB.secondsPerTick(bpm, rate);

  function applyEvent(e: number[], when: number): void {
    const [, channel, key, velocity, on, program, percussion] = e;
    const kind = e.length >= 9 ? e[7] : 0;
    const inst = instrumentFor(channel, program | 0, !!percussion);
    if (kind === 1) inst.pitchBend(e[8], when);
    else if (kind === 2) inst.cc(key, e[8], when);
    else if (on) inst.noteOn(key, velocity, when);
    else inst.noteOff(key, when);
  }

  function pump(): void {
    if (!playing || !ctx) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const horizon = ctx.currentTime + (hidden ? LOOKAHEAD_HIDDEN_S : LOOKAHEAD_S);
    let guard = 0;
    while (schedTime < horizon && guard++ < 128) {
      const secPerTick = spt();
      const ticksAvailable = (horizon - schedTime) / secPerTick;
      const segmentEnd = TB.loopActive(loop) ? loop!.end : Math.max(sequence.lengthTicks, 0);
      const windowEnd = Math.min(schedCursorTick + ticksAvailable, segmentEnd);

      if (windowEnd > schedCursorTick) {
        const sel = TB.selectWindow(sequence.events, schedCursorTick, windowEnd, cursorIndex);
        for (const e of sel.events) applyEvent(e, schedTime + (e[0] - schedCursorTick) * secPerTick);
        cursorIndex = sel.nextIndex;
        schedTime += (windowEnd - schedCursorTick) * secPerTick;
        schedCursorTick = windowEnd;
      }

      if (schedCursorTick >= segmentEnd) {
        if (TB.loopActive(loop)) {
          schedCursorTick = loop!.start;
          cursorIndex = TB.indexAtOrAfter(sequence.events, loop!.start);
          anchors.push({ time: schedTime, tick: schedCursorTick });
        } else {
          // End of the song: let the tail ring, then stop.
          const endAt = schedTime;
          setTimeout(() => { if (playing && ctx && ctx.currentTime >= endAt - 0.05) stop(); },
                     Math.max(0, (endAt - ctx.currentTime) * 1000) + 250);
          break;
        }
      }
    }
  }

  function currentTick(): number {
    if (!playing || !ctx) return positionTick;
    const now = ctx.currentTime;
    let anchor = anchors[0];
    for (const a of anchors) if (a.time <= now) anchor = a; else break;
    if (!anchor) return positionTick;
    // Drop anchors we are safely past, keeping the active one.
    if (anchors.length > 2 && anchors[1] && anchors[1].time <= now) anchors = anchors.slice(anchors.indexOf(anchor));
    // Clamp: for the first SCHEDULE_LEAD_S the anchor is still in the FUTURE, and the raw
    // formula returns a tick BEFORE the start position — the cursor visibly jumps backwards
    // before playback begins.
    if (now <= anchor.time) return anchor.tick;
    return anchor.tick + (now - anchor.time) / spt();
  }

  function startCursorLoop(): void {
    const step = () => {
      if (!playing) return;
      bus.emit('tick', { tick: currentTick() });
      if (master && meterData) {
        master.analyser.getByteTimeDomainData(meterData as any);
        let peak = 0;
        for (let i = 0; i < meterData.length; i++) {
          const v = Math.abs(meterData[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        bus.emit('meter', { peak });
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function anchorAt(tick: number): void {
    const c = ensureContext();
    schedCursorTick = tick;
    cursorIndex = TB.indexAtOrAfter(sequence.events, tick);
    schedTime = c.currentTime + SCHEDULE_LEAD_S;
    anchors = [{ time: schedTime, tick }];
  }

  function allNotesOff(): void {
    for (const s of channels) if (s && s.instrument) s.instrument.allNotesOff();
  }

  // Re-pump on visibility change so switching tabs resizes the scheduling window at once
  // instead of after the next (possibly 1s-clamped) timer tick.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (playing) pump(); });
  }

  function startTransport(): void {
    if (playing) return;
    playing = true;
    anchorAt(positionTick);
    pump();
    timer = setInterval(pump, TICK_INTERVAL_MS);
    startCursorLoop();
  }

  /**
   * Autoplay policy (§7.2): an AudioContext only starts inside a user gesture. Calling resume()
   * from a script that is not gesture-driven leaves it 'suspended' — and if we optimistically
   * mark the transport playing, the UI shows a running transport with a FROZEN cursor and no
   * sound, which looks like a broken engine rather than a blocked context.
   *
   * So: only start the transport once the context is actually running, otherwise arm a one-shot
   * listener and start on the user's next real interaction.
   */
  let pendingGesture = false;
  function play(): void {
    const c = ensureContext();
    if (playing) return;
    if (c.state === 'running') { startTransport(); return; }

    const tryStart = () => {
      c.resume().then(() => {
        if (c.state === 'running' && !playing) startTransport();
      }).catch(() => { /* still blocked; the gesture listener below will retry */ });
    };
    tryStart();
    if (!pendingGesture) {
      pendingGesture = true;
      const onGesture = () => {
        pendingGesture = false;
        window.removeEventListener('pointerdown', onGesture, true);
        window.removeEventListener('keydown', onGesture, true);
        tryStart();
      };
      window.addEventListener('pointerdown', onGesture, true);
      window.addEventListener('keydown', onGesture, true);
    }
  }

  function stop(): void {
    if (!playing) { positionTick = positionTick; return; }
    positionTick = currentTick();
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    allNotesOff();
    bus.emit('tick', { tick: positionTick });
    bus.emit('meter', { peak: 0 });
  }

  function seek(tick: number): void {
    positionTick = Math.max(0, tick || 0);
    if (playing) {
      // Everything already scheduled is now wrong: silence it and re-anchor.
      allNotesOff();
      anchorAt(positionTick);
      pump();
    }
    bus.emit('tick', { tick: positionTick });
  }

  // Parsed instruments are cached by preset id: switching a track back and forth must not
  // re-download several MB of FLAC. GMD-37 adds the IndexedDB layer under this.
  const presetCache = new Map<string, { regions: any[]; buffers: Map<string, AudioBuffer> }>();

  async function loadPreset(ch: number, preset: any): Promise<void> {
    const c = ensureContext();
    const id = preset && (preset.id || preset.file || preset.name);
    if (!id) return;
    try {
      let entry = presetCache.get(id);
      if (!entry) {
        const url = 'instruments/' + preset.file;
        // Bundled presets are immutable per deploy and there is no head declaring their size, so
        // these ride on CACHE_VERSION (GMD-58). A guitar is ~40 files and 5.2MB — easily the
        // longest wait in the app, and the one most worth not repeating.
        const sfzText = await packFetch(url).then(b => new TextDecoder().decode(new Uint8Array(b)));
        const regions = (window as any).GomidasSfz.parseSfz(sfzText);
        const base = url.slice(0, url.lastIndexOf('/') + 1);
        const names = (window as any).GomidasSfz.sampleList(regions);
        const buffers = new Map<string, AudioBuffer>();
        // Sequential rather than Promise.all: a guitar is ~40 files and firing them all at once
        // just queues them in the browser anyway, while making failures harder to attribute.
        for (const name of names) {
          try {
            buffers.set(name, await c.decodeAudioData(await packFetch(base + name)));
          } catch (e) { /* skip this sample; findRegion will simply produce no voice */ }
        }
        if (!buffers.size) throw new Error('no samples decoded');
        entry = { regions, buffers };
        presetCache.set(id, entry);
      }
      const st = strip(ch);
      if (st.instrument) st.instrument.allNotesOff();
      st.instrument = createSfzInstrument(c, entry.regions, entry.buffers);
      st.instrument.output.connect(st.input);
      sfzChannels.set(ch, entry);
      bus.emit('instrumentLoaded', { channel: ch, ok: true, name: preset.name || id });
    } catch (e) {
      bus.emit('instrumentLoaded', { channel: ch, ok: false, name: preset.name || String(id) });
    }
  }

  // ONE shared bus per send effect (§4.2). ConvolverNode is the expensive node here: sixteen
  // per-channel reverbs will hurt, one shared reverb with per-channel sends will not. This is
  // the entire reason sends exist in the design.
  const buses = new Map<string, { input: GainNode; nodes: AudioNode[] }>();

  // The send buses' own definitions, named once so the offline bounce rebuilds the SAME delay and
  // the SAME reverb rather than a second opinion about what "reverb" means (GMD-66).
  const SEND_SPECS: Record<string, any> = {
    reverb: { chain: [{ type: 'reverb', params: { mix: 1, ir: 'hall-medium' } }] },
    delay: { chain: [{ type: 'delay', params: { mix: 1, timeMs: 375, feedback: 0.35, tone: 3000 } }] }
  };

  /** Build one send bus into `c`, returning to `dest`. Context-parameterised so both graphs use it. */
  function makeSendBus(c: AudioContext, name: string, dest: AudioNode): { input: GainNode; nodes: AudioNode[] } {
    const input = c.createGain();
    const built = buildFxChain(c, SEND_SPECS[name] || SEND_SPECS.delay);
    input.connect(built.input);
    built.output.connect(dest);
    return { input, nodes: built.nodes };
  }

  function sendBus(name: string): { input: GainNode; nodes: AudioNode[] } {
    const c = ensureContext();
    let b = buses.get(name);
    if (b) return b;
    b = makeSendBus(c, name, master!.eq[0]);
    buses.set(name, b);
    return b;
  }

  function applyFx(target: 'track' | 'master', ch: number, chainSpec: any): void {
    const c = ensureContext();
    const FX = (window as any).GomidasFx;
    if (target === 'master') {
      if (masterFx) { try { masterFx.output.disconnect(); masterFx.input.disconnect(); } catch (e) {} }
      masterFx = null;
      masterFxSpec = FX.chainIsEmpty(chainSpec) ? null : chainSpec;
      try { master!.eq[2].disconnect(); } catch (e) {}
      if (FX.chainIsEmpty(chainSpec)) { master!.eq[2].connect(master!.gain); return; }
      const built = buildFxChain(c, chainSpec);
      master!.eq[2].connect(built.input);
      built.output.connect(master!.gain);
      masterFx = built;
      return;
    }
    const st = strip(ch);
    if (st.fx) { try { st.fx.output.disconnect(); st.fx.input.disconnect(); } catch (e) {} }
    st.fx = null;
    st.fxSpec = FX.chainIsEmpty(chainSpec) ? null : chainSpec;
    try { st.fxIn.disconnect(); } catch (e) {}
    if (FX.chainIsEmpty(chainSpec)) { st.fxIn.connect(st.gain); return; }
    const built = buildFxChain(c, chainSpec);
    st.fxIn.connect(built.input);
    built.output.connect(st.gain);
    st.fx = built;
  }

  let masterFx: { input: AudioNode; output: AudioNode; nodes: AudioNode[] } | null = null;
  let masterFxSpec: any = null;

  let rendering = false;

  /**
   * EVERYTHING the mixer consists of, as plain values — the single enumeration the offline bounce
   * builds from.
   *
   * This exists because "mirror the live mixer" kept being written out by hand in renderOffline,
   * one field at a time, and kept falling behind: the per-channel strip was mirrored but the
   * master gain, master pan, master EQ, master inserts, track inserts and sends were all silently
   * dropped, so the master fader did nothing to the recorded file (GMD-66). Add a mixer control,
   * add it here, and the bounce gets it for free. `tests/mixsnapshot.test.js` pins the field list
   * so a new control cannot quietly skip this.
   */
  function snapshotMix(): any {
    const chans: any[] = [];
    for (let ch = 0; ch < channels.length; ch++) {
      const s = channels[ch];
      if (!s) continue;
      const sends: Record<string, number> = {};
      for (const name of Object.keys(s.sends)) sends[name] = s.sends[name].gain.value;
      chans.push({
        ch,
        gain: s.gain.gain.value,
        pan: s.pan.pan.value,
        eq: [s.eq[0].gain.value, s.eq[1].gain.value, s.eq[2].gain.value],
        fx: s.fxSpec,
        sends
      });
    }
    return {
      master: master
        ? { gain: master.gain.gain.value, pan: master.pan.pan.value,
            eq: [master.eq[0].gain.value, master.eq[1].gain.value, master.eq[2].gain.value],
            fx: masterFxSpec }
        : { gain: 1, pan: 0, eq: [0, 0, 0], fx: null },
      channels: chans
    };
  }

  /** Render the current sequence offline and return WAV bytes. */
  async function renderOffline(): Promise<ArrayBuffer | null> {
    const Files = (window as any).GomidasFiles;
    if (!Files || !sequence.events.length) return null;
    const sampleRate = ctx ? ctx.sampleRate : 44100;
    const seconds = TB.tickToSeconds(sequence.lengthTicks || 0, bpm, rate) + 2;  // +tail
    const off = new (window as any).OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);

    // Rebuild the graph in the offline context from ONE description of the mixer (snapshotMix),
    // rather than re-deriving it field by field here — that hand-copying is what silently dropped
    // the whole master section from every recording (GMD-66). The instrument and output-stage
    // factories take a context precisely so they can be reused here rather than duplicated.
    const snap = snapshotMix();
    const mEq = makeEqNodes(off, snap.master.eq[0], snap.master.eq[1], snap.master.eq[2]);
    const mGain = off.createGain();
    mGain.gain.value = snap.master.gain;
    const mPan = off.createStereoPanner();
    mPan.pan.value = snap.master.pan;
    const outStage = makeOutputStage(off);
    // master EQ -> [master inserts] -> gain -> pan -> headroom -> ceiling -> out, the live order.
    if (snap.master.fx) {
      const built = buildFxChain(off as any, snap.master.fx);
      mEq[2].connect(built.input);
      built.output.connect(mGain);
    } else {
      mEq[2].connect(mGain);
    }
    mGain.connect(mPan);
    mPan.connect(outStage.headroom);
    outStage.headroom.connect(outStage.preScale);
    outStage.preScale.connect(outStage.ceiling);
    outStage.ceiling.connect(off.destination);

    const offBuses = new Map<string, { input: GainNode; nodes: AudioNode[] }>();
    const offSendBus = (name: string) => {
      let b = offBuses.get(name);
      if (!b) { b = makeSendBus(off as any, name, mEq[0]); offBuses.set(name, b); }
      return b;
    };

    const strips = new Map<number, { input: GainNode; inst: Instrument }>();
    const offBuffers = new Map<number, AudioBuffer>();
    const mixOf = (ch: number) => snap.channels.find((c: any) => c.ch === ch);
    const instFor = (ch: number, program: number, percussion: boolean) => {
      let st = strips.get(ch);
      if (st) return st.inst;
      const mix = mixOf(ch);
      const input = off.createGain();
      const fxIn = off.createGain();
      const gain = off.createGain();
      gain.gain.value = mix ? mix.gain : 1;
      const pan = off.createStereoPanner();
      pan.pan.value = mix ? mix.pan : 0;
      const eq = makeEqNodes(off, mix ? mix.eq[0] : 0, mix ? mix.eq[1] : 0, mix ? mix.eq[2] : 0);
      // instrument -> input -> [inserts] -> gain -> pan -> EQ -> master, the live order (§4.1):
      // inserts PRE-fader, sends POST-fader.
      input.connect(fxIn);
      if (mix && mix.fx) {
        const built = buildFxChain(off as any, mix.fx);
        fxIn.connect(built.input);
        built.output.connect(gain);
      } else {
        fxIn.connect(gain);
      }
      gain.connect(pan); pan.connect(eq[0]);
      eq[2].connect(mEq[0]);
      for (const name of Object.keys(mix ? mix.sends : {})) {
        const level = mix.sends[name];
        if (!(level > 0)) continue;
        const g = off.createGain();
        g.gain.value = level;
        eq[2].connect(g);
        g.connect(offSendBus(name).input);
      }
      const perc = percussion || ch === 9;
      // Same instrument choice as live playback — via makeInstrument, NOT a second copy of the
      // expression. A pack's decoded AudioBuffers carry their own sample rate, so they play
      // correctly in this context too.
      const inst = makeInstrument(off as any, ch, program | 0, perc, offBuffers);
      inst.output.connect(input);
      st = { input, inst };
      strips.set(ch, st);
      return inst;
    };

    // No lookahead offline: schedule every event up front against its exact time.
    for (const e of sequence.events) {
      const when = TB.tickToSeconds(e[0], bpm, rate);
      const [, channel, key, velocity, on, program, percussion] = e;
      const kind = e.length >= 9 ? e[7] : 0;
      const inst = instFor(channel, program | 0, !!percussion);
      if (kind === 1) inst.pitchBend(e[8], when);
      else if (kind === 2) inst.cc(key, e[8], when);
      else if (on) inst.noteOn(key, velocity, when);
      else inst.noteOff(key, when);
    }

    const buffer = await off.startRendering();
    const chans: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    return Files.encodeWav(chans, buffer.sampleRate);
  }

  const backend: any = {
    caps: BackendLib.WEB_CAPS,
    on: bus.on,
    emit: bus.emit,
    listenerCount: bus.listenerCount,
    invoke: () => { /* no raw wire on web */ },

    setSequence(seq: any) {
      sequence = seq && seq.events ? seq : { lengthTicks: 0, events: [] };
      // Start fetching packs as soon as a score NEEDS them, not when the first note is
      // scheduled: waiting for the note means the whole first playthrough comes out of the
      // sonivox fallback, so the first thing anyone hears is the bad bank.
      // Event tuple: [tick, channel, key, velocity, on, program, percussion, ...].
      if (!drumKit && sequence.events.some((e: number[]) => e[1] === 9 || e[6])) loadDrumKit();
      const wanted = new Set<number>();
      for (const e of sequence.events as number[][]) if (!(e[1] === 9 || e[6])) wanted.add(e[5] | 0);
      for (const program of wanted) if (!melodicPacks.has(program)) loadMelodicPack(program);
      // Re-anchoring mid-playback keeps an edit from desynchronising the transport.
      if (playing) { allNotesOff(); anchorAt(currentTick()); pump(); }
    },
    play,
    stop,
    seek,
    panic() { allNotesOff(); },
    setLoop(on: boolean, startTick?: number, endTick?: number) {
      loop = on && startTick != null && endTick != null ? { start: startTick, end: endTick } : null;
      if (playing) { anchorAt(currentTick()); pump(); }
    },
    setTempo(v: number) {
      if (!(v > 0)) return;
      if (playing && ctx) { const t = currentTick(); bpm = v; allNotesOff(); anchorAt(t); pump(); }
      else bpm = v;
    },
    setPlaybackRate(v: number) {
      if (!(v > 0)) return;
      if (playing && ctx) { const t = currentTick(); rate = v; allNotesOff(); anchorAt(t); pump(); }
      else rate = v;
    },

    setChannelMix(ch: number, gain: number, pan: number) {
      const s = strip(ch);
      s.gain.gain.value = Math.max(0, gain);
      // Native pan is 0..1 with 0.5 centre; StereoPannerNode is -1..1.
      s.pan.pan.value = Math.max(-1, Math.min(1, (pan - 0.5) * 2));
    },
    setMasterMix(gain: number, pan: number) {
      ensureContext();
      master!.gain.gain.value = Math.max(0, gain);
      master!.pan.pan.value = Math.max(-1, Math.min(1, (pan - 0.5) * 2));
    },
    setTrackEq(ch: number, low: number, mid: number, high: number) {
      const s = strip(ch);
      s.eq[0].gain.value = low; s.eq[1].gain.value = mid; s.eq[2].gain.value = high;
    },
    setMasterEq(low: number, mid: number, high: number) {
      ensureContext();
      master!.eq[0].gain.value = low; master!.eq[1].gain.value = mid; master!.eq[2].gain.value = high;
    },

    loadTrackPreset(ch: number, preset: any) {
      loadPreset(ch, preset).catch(() => { /* reported via the instrumentLoaded event */ });
    },
    loadTrackInstrumentFile() {
      // A custom .sfz means reading a whole sample folder, which a file input cannot give us.
      // Needs the File System Access directory picker — GMD-37, and unavailable in Safari.
      bus.emit('instrumentLoaded', { channel: -1, ok: false, name: 'custom SFZ needs a folder picker' });
    },
    clearTrackInstrument(ch: number) {
      const s = channels[ch];
      sfzChannels.delete(ch);
      if (s && s.instrument) { s.instrument.allNotesOff(); s.instrument = null; }
    },
    preview(channel: number, program: number, percussion: boolean, keys: number[]) {
      const c = ensureContext();
      if (c.state === 'suspended') c.resume();
      const inst = instrumentFor(channel, program | 0, !!percussion);
      if (!keys || !keys.length) { inst.allNotesOff(); return; }
      const when = c.currentTime + 0.005;
      for (const k of keys) { inst.noteOn(k, 0.85, when); inst.noteOff(k, when + 0.6); }
    },

    setTrackFx(ch: number, chainSpec: any) { applyFx('track', ch, chainSpec); },
    setMasterFx(chainSpec: any) { applyFx('master', 0, chainSpec); },
    setTrackSends(ch: number, sends: Record<string, number>) {
      const st = strip(ch);
      for (const name of Object.keys(st.sends)) {
        const v = Number(sends && sends[name]);
        st.sends[name].gain.value = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
      }
    },

    /**
     * Recording is an OFFLINE BOUNCE (§7.3), not a realtime capture: render the whole song
     * through an OfflineAudioContext faster than wall-clock, then encode to WAV. Cleaner than
     * the desktop ThreadedWriter path and deterministic — the same project always produces the
     * same file.
     *
     * Consequence worth knowing: unlike the desktop recorder this captures the SEQUENCE, not
     * whatever is currently audible. There is no live input on web to capture anyway
     * (caps.liveInput is false), so nothing is lost.
     */
    startRecording() {
      if (rendering) return;
      rendering = true;
      bus.emit('recordingState', { recording: true, name: 'rendering…' });
      renderOffline()
        .then((wav) => {
          rendering = false;
          bus.emit('recordingState', { recording: false, name: 'mix.wav' });
          const Files = (window as any).GomidasFiles;
          if (Files && wav) Files.saveData('mix.wav', wav, 'audio/wav');
        })
        .catch(() => {
          rendering = false;
          bus.emit('recordingState', { recording: false, name: '' });
        });
    },
    stopRecording() { /* an offline render cannot be usefully interrupted; it is near-instant */ },

    // Exposed for tests and for the shell's "click to start audio" affordance.
    _snapshotMix: snapshotMix,
    _context: () => ctx,
    _isPlaying: () => playing,
    _currentTick: currentTick
  };

  return backend;
}

  // createSf2Instrument is exported for the same reason createToneInstrument is: the voice graph
  // it builds is only observable from outside. tests/sf2-filter.test.js drives it with a fake
  // context to prove the zone's lowpass is actually WIRED — the parser tests alone would stay
  // green if the biquad were deleted from this file.
  // PACK_VERSION is exported so a test can assert the COMMITTED PACKS against the runtime's own
  // number rather than against a literal it repeats. Two literals agreeing proves nothing: bump
  // the runtime, forget to commit the regenerated packs, and every visitor burns a second
  // cache-bypassing fetch of a 517KB manifest on every session while the suite stays green.
  const api = { createWebAudioBackend, createToneInstrument, createSf2Instrument, PACK_VERSION,
                envelopeLevelAt, voicesToRelease,
                ceilingCurve, HEADROOM_GAIN, HEADROOM_DB, CEILING_KNEE, CEILING_RANGE,
                LOOKAHEAD_S, TICK_INTERVAL_MS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasWebAudio = api;
}());
