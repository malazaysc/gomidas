// snapshotMix — the single enumeration of what the mixer consists of (GMD-66).
//
// Why it exists: renderOffline used to re-derive the mixer by hand, field by field, and fell
// behind. It mirrored each channel's gain/pan/EQ and silently dropped the ENTIRE master section —
// gain, pan, EQ, inserts — plus track inserts and sends. Measured before the fix: bouncing with
// the master fader at 0.25 produced a byte-identical file to bouncing at 1.0.
//
// These tests pin the field list, so adding a mixer control without teaching the snapshot about
// it fails here rather than in someone's recording six months later.
import { describe, it, expect, beforeAll } from 'vitest';

let makeBackend;

/** An AudioParam that only has to remember what was written to it. */
const param = (v = 0) => ({
  value: v,
  setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
  setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {}
});

/**
 * A fake AudioContext: every create*() returns a node carrying every AudioParam any of them might
 * want. The graph shape is irrelevant here — only the VALUES the snapshot reads back.
 */
function fakeContext() {
  const mk = () => ({
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: param(1), pan: param(0), frequency: param(350), Q: param(1), detune: param(0),
    delayTime: param(0), playbackRate: param(1), threshold: param(-24), knee: param(30),
    ratio: param(12), attack: param(0.003), release: param(0.25),
    type: 'peaking', curve: null, oversample: 'none', buffer: null, loop: false,
    fftSize: 1024, getByteTimeDomainData() {}
  });
  return new Proxy({
    currentTime: 0, sampleRate: 44100, state: 'running', destination: mk(),
    resume() {}, suspend() {}, close() {},
    createBuffer: () => ({ length: 1, duration: 0.1, sampleRate: 44100,
                           numberOfChannels: 1, getChannelData: () => new Float32Array(1) }),
    decodeAudioData: async () => ({ duration: 0.1, sampleRate: 44100 })
  }, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k.startsWith('create') ? mk : undefined))
  });
}

beforeAll(async () => {
  const fs = await import('node:fs/promises');
  const load = async (name, win) => {
    const src = await fs.readFile(new URL(`../dist/core/${name}.js`, import.meta.url), 'utf8');
    new Function('window', 'module', src)(win, { exports: {} });
  };
  // Load the REAL fx/timebase/sf2 modules rather than stubbing them — the snapshot's fx handling
  // goes through GomidasFx.chainIsEmpty, and a stub of that would test the stub.
  makeBackend = async () => {
    const win = { AudioContext: fakeContext, OfflineAudioContext: fakeContext };
    win.window = win;
    for (const m of ['timebase', 'fx', 'sf2', 'sfz', 'packcache', 'webaudio']) await load(m, win);
    globalThis.window = win;
    const backend = win.GomidasWebAudio.createWebAudioBackend({
      createEventBus: () => {
        const ls = new Map();
        return {
          on: (e, f) => { (ls.get(e) || ls.set(e, []).get(e)).push(f); return () => {}; },
          emit: () => {}, listenerCount: () => 0
        };
      },
      WEB_CAPS: {}
    });
    return { backend, win };
  };
});

describe('snapshotMix', () => {
  it('captures every master field the graph can be told about', async () => {
    const { backend } = await makeBackend();
    backend.setMasterMix(0.4, 0.75);
    backend.setMasterEq(3, -2, 5);
    const snap = backend._snapshotMix();

    expect(Object.keys(snap).sort()).toEqual(['channels', 'master']);
    expect(Object.keys(snap.master).sort()).toEqual(['eq', 'fx', 'gain', 'pan']);
    expect(snap.master.gain).toBeCloseTo(0.4, 6);
    expect(snap.master.pan).toBeCloseTo(0.5, 6);     // 0.75 in 0..1 -> +0.5 in -1..1
    expect(snap.master.eq).toEqual([3, -2, 5]);
  });

  it('captures every per-channel field, including inserts and sends', async () => {
    const { backend } = await makeBackend();
    backend.setChannelMix(3, 0.6, 0.0);
    backend.setTrackEq(3, -4, 1, 2);
    backend.setTrackSends(3, { reverb: 0.3, delay: 0.1 });

    const snap = backend._snapshotMix();
    const ch = snap.channels.find((c) => c.ch === 3);
    expect(ch).toBeTruthy();
    expect(Object.keys(ch).sort()).toEqual(['ch', 'eq', 'fx', 'gain', 'pan', 'sends']);
    expect(ch.gain).toBeCloseTo(0.6, 6);
    expect(ch.pan).toBeCloseTo(-1, 6);
    expect(ch.eq).toEqual([-4, 1, 2]);
    expect(ch.sends.reverb).toBeCloseTo(0.3, 6);
    expect(ch.sends.delay).toBeCloseTo(0.1, 6);
  });

  it('records the insert SPEC, not the live nodes — the bounce rebuilds in its own context', async () => {
    const { backend } = await makeBackend();
    const spec = { chain: [{ type: 'drive', params: { mix: 1, drive: 0.5 } }] };
    backend.setTrackFx(2, spec);
    backend.setMasterFx(spec);

    const snap = backend._snapshotMix();
    expect(snap.channels.find((c) => c.ch === 2).fx).toEqual(spec);
    expect(snap.master.fx).toEqual(spec);
  });

  it('clearing an insert chain clears the spec, so the bounce stops rebuilding it', async () => {
    const { backend } = await makeBackend();
    backend.setTrackFx(2, { chain: [{ type: 'drive', params: { mix: 1, drive: 0.5 } }] });
    backend.setTrackFx(2, { chain: [] });
    backend.setMasterFx({ chain: [] });

    const snap = backend._snapshotMix();
    expect(snap.channels.find((c) => c.ch === 2).fx).toBe(null);
    expect(snap.master.fx).toBe(null);
  });

  it('reports only channels that exist, so an untouched mix bounces as an empty graph', async () => {
    const { backend } = await makeBackend();
    expect(backend._snapshotMix().channels).toEqual([]);
    backend.setChannelMix(9, 1, 0.5);
    expect(backend._snapshotMix().channels.map((c) => c.ch)).toEqual([9]);
  });
});
