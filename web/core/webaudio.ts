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
  let bendRatio = 1;

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
      osc.frequency.setValueAtTime(freq * bendRatio, when);
      osc2.frequency.setValueAtTime(freq * bendRatio, when);
      osc.connect(tone); osc2.connect(tone); tone.connect(gain);
      nodes.push(osc, osc2, tone);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * 0.35), when + 0.008);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0005, vel * 0.22), when + 0.25);
      osc.start(when); osc2.start(when);
      stopFn = (t: number) => {
        const at = Math.max(t, ctx.currentTime);
        try {
          gain.gain.cancelScheduledValues(at);
          gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), at);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
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
    pitchBend(value: number) {
      // ±12 semitones, matching the native bend range (AudioEngine).
      bendRatio = Math.pow(2, ((value - 8192) / 8192 * 12) / 12);
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
  const voices = new Map<number, Array<{ src: AudioBufferSourceNode; gain: GainNode; release: number }>>();
  let bendSemis = 0;

  function noteOn(key: number, velocity: number, when: number): void {
    const region = SFZ.findRegion(regions, key, Math.round(Math.max(0, Math.min(1, velocity)) * 127));
    // No region: stay SILENT rather than play a wrong-pitched neighbour. A missing note is a
    // reportable gap; a wrong note sounds like a broken instrument.
    if (!region) return;
    const buf = buffers.get(region.sample);
    if (!buf) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = SFZ.playbackRateFor(region, key) * Math.pow(2, bendSemis / 12);
    src.playbackRate.setValueAtTime(rate, when);
    if (region.loopMode && /loop_continuous|loop_sustain/.test(region.loopMode)) src.loop = true;

    const gain = ctx.createGain();
    const peak = Math.max(0.0001, Math.min(1, velocity) * Math.pow(10, (region.volume || 0) / 20));
    gain.gain.setValueAtTime(peak, when);
    // ampeg_decay here is the SFZ decay-to-sustain; the bundled sets use it as a gentle fade.
    if (region.ampegDecay > 0) {
      gain.gain.setTargetAtTime(peak * 0.7, when, Math.max(0.01, region.ampegDecay));
    }
    src.connect(gain); gain.connect(output);
    src.start(when);

    const list = voices.get(key) || [];
    list.push({ src, gain, release: region.ampegRelease });
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
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), at);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, at + rel);
      v.src.stop(at + rel + 0.02);
    } catch (e) { /* already stopped */ }
  }

  return {
    noteOn,
    noteOff,
    pitchBend(value: number) {
      // Region bend range in cents (the bundled sets carry +/-1200 = an octave).
      const r = regions[0];
      const span = value >= 8192 ? (r && r.bendUp ? r.bendUp : 200) : Math.abs(r && r.bendDown ? r.bendDown : 200);
      bendSemis = ((value - 8192) / 8192) * (span / 100);
      const now = ctx.currentTime;
      for (const [key, list] of voices) {
        for (const v of list) {
          const region = SFZ.findRegion(regions, key, 100);
          if (!region) continue;
          try {
            v.src.playbackRate.setTargetAtTime(
              SFZ.playbackRateFor(region, key) * Math.pow(2, bendSemis / 12), now, 0.01);
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

interface ChannelStrip {
  input: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
  eq: BiquadFilterNode[];
  instrument: Instrument | null;
  program: number;
  percussion: boolean;
}

function createWebAudioBackend(BackendLib: any): any {
  const TB = typeof GomidasTimebase !== 'undefined' ? GomidasTimebase : (window as any).GomidasTimebase;
  const bus = BackendLib.createEventBus();

  let ctx: AudioContext | null = null;
  let master: { eq: BiquadFilterNode[]; gain: GainNode; pan: StereoPannerNode; analyser: AnalyserNode } | null = null;
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
    chain([...eq, gain, pan, analyser]);
    analyser.connect(ctx.destination);
    master = { eq, gain, pan, analyser };
    meterData = new Uint8Array(analyser.fftSize);
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

  function strip(ch: number): ChannelStrip {
    const c = ensureContext();
    let s = channels[ch];
    if (s) return s;
    const input = c.createGain();
    const gain = c.createGain();
    const pan = c.createStereoPanner();
    const eq = makeEq(c);
    // instrument -> input -> gain -> pan -> EQ -> master (matches AudioEngine's order)
    chain([input, gain, pan, ...eq]);
    eq[2].connect(master!.eq[0]);
    s = { input, gain, pan, eq, instrument: null, program: 24, percussion: ch === 9 };
    channels[ch] = s;
    return s;
  }

  // Channels holding a loaded SFZ. Without this, the first note-on after a preset load would
  // see a program mismatch and swap the sampler back out for the placeholder tone.
  const sfzChannels = new Set<number>();

  function instrumentFor(ch: number, program: number, percussion: boolean): Instrument {
    const s = strip(ch);
    if (sfzChannels.has(ch) && s.instrument) return s.instrument;
    if (!s.instrument || s.program !== program || s.percussion !== percussion) {
      if (s.instrument) s.instrument.allNotesOff();
      s.instrument = createToneInstrument(ctx!, percussion || ch === 9);
      s.instrument.output.connect(s.input);
      s.program = program;
      s.percussion = percussion || ch === 9;
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
        const res = await fetch(url);
        if (!res.ok) throw new Error('sfz ' + res.status);
        const regions = (window as any).GomidasSfz.parseSfz(await res.text());
        const base = url.slice(0, url.lastIndexOf('/') + 1);
        const names = (window as any).GomidasSfz.sampleList(regions);
        const buffers = new Map<string, AudioBuffer>();
        // Sequential rather than Promise.all: a guitar is ~40 files and firing them all at once
        // just queues them in the browser anyway, while making failures harder to attribute.
        for (const name of names) {
          try {
            const r = await fetch(base + name);
            if (!r.ok) continue;
            buffers.set(name, await c.decodeAudioData(await r.arrayBuffer()));
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
      sfzChannels.add(ch);
      bus.emit('instrumentLoaded', { channel: ch, ok: true, name: preset.name || id });
    } catch (e) {
      bus.emit('instrumentLoaded', { channel: ch, ok: false, name: preset.name || String(id) });
    }
  }

  const backend: any = {
    caps: BackendLib.WEB_CAPS,
    on: bus.on,
    emit: bus.emit,
    listenerCount: bus.listenerCount,
    invoke: () => { /* no raw wire on web */ },

    setSequence(seq: any) {
      sequence = seq && seq.events ? seq : { lengthTicks: 0, events: [] };
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

    startRecording() { /* offline bounce — GMD-37 */ },
    stopRecording() { /* offline bounce — GMD-37 */ },

    // Exposed for tests and for the shell's "click to start audio" affordance.
    _context: () => ctx,
    _isPlaying: () => playing,
    _currentTick: currentTick
  };

  return backend;
}

  const api = { createWebAudioBackend, createToneInstrument, LOOKAHEAD_S, TICK_INTERVAL_MS };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasWebAudio = api;
}());
