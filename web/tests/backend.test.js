// GMD-30 — the backend seam (web/core/backend.js).
//
// The whole point of Phase 0 is that desktop behaviour does not change, so these tests pin the
// JUCE wire format: every method must emit the SAME call name and payload shape the old
// nativeInvoke() call sites used. If one of these fails, the Mac app has silently changed.
import { describe, it, expect, beforeEach } from 'vitest';
import { createEventBus, createJuceBackends, JUCE_CAPS } from '../core/backend.js';

/** Fake JUCE host that records every emitEvent call. */
function fakeWindow() {
  const calls = [];
  return {
    calls,
    __JUCE__: { backend: { emitEvent: (eventId, payload) => calls.push({ eventId, payload }) } }
  };
}

/** The (name, payload) pair a call site put on the wire. */
function wire(win, i = 0) {
  const c = win.calls[i];
  return { eventId: c.eventId, name: c.payload.name, payload: c.payload.params[0] };
}

describe('event bus', () => {
  let bus;
  beforeEach(() => { bus = createEventBus(); });

  it('delivers payloads to subscribers', () => {
    const seen = [];
    bus.on('tick', (p) => seen.push(p.tick));
    bus.emit('tick', { tick: 960 });
    bus.emit('tick', { tick: 1920 });
    expect(seen).toEqual([960, 1920]);
  });

  it('supports multiple subscribers and unsubscribe', () => {
    const a = [], b = [];
    const offA = bus.on('meter', (p) => a.push(p.peak));
    bus.on('meter', (p) => b.push(p.peak));
    bus.emit('meter', { peak: 0.5 });
    offA();
    bus.emit('meter', { peak: 0.9 });
    expect(a).toEqual([0.5]);
    expect(b).toEqual([0.5, 0.9]);
  });

  it('emitting an event with no listeners is a no-op', () => {
    expect(() => bus.emit('nobody-home', { x: 1 })).not.toThrow();
  });

  it('one throwing listener does not stop the others', () => {
    const seen = [];
    bus.on('tick', () => { throw new Error('boom'); });
    bus.on('tick', (p) => seen.push(p.tick));
    expect(() => bus.emit('tick', { tick: 1 })).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it('a listener that unsubscribes itself mid-dispatch does not skip the next one', () => {
    const seen = [];
    const off = bus.on('tick', () => { off(); seen.push('first'); });
    bus.on('tick', () => seen.push('second'));
    bus.emit('tick', { tick: 0 });
    expect(seen).toEqual(['first', 'second']);   // the dispatch copy protects this
    expect(bus.listenerCount('tick')).toBe(1);
  });
});

describe('JUCE audio backend — wire format', () => {
  let win, audio;
  beforeEach(() => { win = fakeWindow(); audio = createJuceBackends(win).audio; });

  it('uses the __juce__invoke envelope with an incrementing resultId', () => {
    audio.play();
    audio.stop();
    expect(win.calls[0].eventId).toBe('__juce__invoke');
    expect(win.calls[0].payload.resultId).toBe(0);
    expect(win.calls[1].payload.resultId).toBe(1);
  });

  it('transport calls match the pre-refactor names and payloads', () => {
    audio.play();                        expect(wire(win, 0)).toMatchObject({ name: 'play', payload: 1 });
    audio.stop();                        expect(wire(win, 1)).toMatchObject({ name: 'stop', payload: 1 });
    audio.seek(4800);                    expect(wire(win, 2)).toMatchObject({ name: 'seek', payload: 4800 });
    audio.panic();                       expect(wire(win, 3)).toMatchObject({ name: 'panic', payload: 1 });
    audio.setTempo(144);                 expect(wire(win, 4)).toMatchObject({ name: 'setTempo', payload: 144 });
    audio.setPlaybackRate(0.75);         expect(wire(win, 5)).toMatchObject({ name: 'setPlaybackRate', payload: 0.75 });
  });

  it('setSequence passes the sequence through untouched', () => {
    const seq = { lengthTicks: 3840, events: [[0, 9, 36, 100, 240, 0, 0]] };
    audio.setSequence(seq);
    expect(wire(win).name).toBe('setSequence');
    expect(wire(win).payload).toEqual(seq);   // buildSequence output must not be reshaped
  });

  it('setLoop(true, …) and setLoop(false) map onto the start/end sentinel', () => {
    audio.setLoop(true, 960, 3840);
    expect(wire(win, 0).payload).toEqual({ start: 960, end: 3840 });
    audio.setLoop(false);
    expect(wire(win, 1).payload).toEqual({ start: -1, end: -1 });   // -1/-1 = clear
  });

  it('mixer calls keep their object payloads', () => {
    audio.setChannelMix(3, 0.8, 0.25);
    expect(wire(win, 0)).toMatchObject({ name: 'setChannelMix', payload: { channel: 3, gain: 0.8, pan: 0.25 } });
    audio.setMasterMix(1.0, 0.5);
    expect(wire(win, 1)).toMatchObject({ name: 'setMasterMix', payload: { gain: 1.0, pan: 0.5 } });
    audio.setTrackEq(2, -3, 0, 6);
    expect(wire(win, 2)).toMatchObject({ name: 'setTrackEq', payload: { channel: 2, low: -3, mid: 0, high: 6 } });
    audio.setMasterEq(1, 2, 3);
    expect(wire(win, 3)).toMatchObject({ name: 'setMasterEq', payload: { low: 1, mid: 2, high: 3 } });
  });

  it('generalised instrument methods still speak the native Sfz names', () => {
    // The editor says "preset"; the JUCE backend translates. A web backend will not use
    // these names at all — that is the entire point of the generalisation.
    audio.loadTrackPreset(4, { file: 'guitar.sfz', name: 'Classical Guitar' });
    expect(wire(win, 0)).toMatchObject({
      name: 'loadTrackSfzPreset',
      payload: { channel: 4, file: 'guitar.sfz', name: 'Classical Guitar' }
    });
    audio.clearTrackInstrument(4);
    expect(wire(win, 1)).toMatchObject({ name: 'clearTrackSfz', payload: { channel: 4 } });
    audio.loadTrackInstrumentFile(4);
    expect(wire(win, 2)).toMatchObject({ name: 'loadTrackSfz', payload: { channel: 4 } });
  });

  it('preview keeps positional args in the old payload shape', () => {
    audio.preview(9, 0, true, [36, 42]);
    expect(wire(win)).toMatchObject({
      name: 'preview',
      payload: { channel: 9, program: 0, percussion: true, keys: [36, 42] }
    });
  });

  it('desktop-only calls are present on the JUCE backend', () => {
    audio.setLiveInput(true, 0.7);
    expect(wire(win, 0)).toMatchObject({ name: 'setLiveInput', payload: { enabled: true, gain: 0.7 } });
    audio.loadInputPlugin();   expect(wire(win, 1).name).toBe('loadInputPlugin');
    audio.showPluginEditor();  expect(wire(win, 2).name).toBe('showPluginEditor');
    audio.clearInputPlugin();  expect(wire(win, 3).name).toBe('clearInputPlugin');
  });

  it('recording calls pass the legacy `1` payload', () => {
    audio.startRecording(); expect(wire(win, 0)).toMatchObject({ name: 'startRecording', payload: 1 });
    audio.stopRecording();  expect(wire(win, 1)).toMatchObject({ name: 'stopRecording', payload: 1 });
  });

  it('declares desktop capabilities', () => {
    expect(audio.caps).toEqual(JUCE_CAPS);
    expect(audio.caps.pluginHost).toBe(true);
    expect(audio.caps.liveInput).toBe(true);
    expect(audio.caps.fileSystem).toBe('native');
  });

  it('survives a missing JUCE bridge instead of throwing', () => {
    // The editor must run in a plain browser tab (and under test) with no native host.
    const bare = createJuceBackends({}).audio;
    expect(() => { bare.play(); bare.setTempo(120); bare.preview(0, 24, false, [60]); }).not.toThrow();
  });
});

describe('JUCE host backend — wire format', () => {
  let win, host;
  beforeEach(() => { win = fakeWindow(); host = createJuceBackends(win).host; });

  it('file and shell calls match the pre-refactor names', () => {
    host.openFile();            expect(wire(win, 0)).toMatchObject({ name: 'openFile', payload: undefined });
    host.openProject();         expect(wire(win, 1)).toMatchObject({ name: 'openProject', payload: 1 });
    host.openRecent(2);         expect(wire(win, 2)).toMatchObject({ name: 'openRecent', payload: 2 });
    host.saveProject('{"a":1}');expect(wire(win, 3)).toMatchObject({ name: 'saveProject', payload: '{"a":1}' });
    host.saveBinary('gp', 'QUJD');
    expect(wire(win, 4)).toMatchObject({ name: 'saveBinary', payload: { ext: 'gp', b64: 'QUJD' } });
    host.minimizeWindow();      expect(wire(win, 5).name).toBe('minimizeWindow');
    host.showAbout();           expect(wire(win, 6).name).toBe('showAbout');
  });

  it('log stringifies its argument (the old nlog contract)', () => {
    host.log(42);
    expect(wire(win).payload).toBe('42');
  });

  it('audio and host share one resultId counter on the same bridge', () => {
    const { audio, host: h } = createJuceBackends(win);
    audio.play();
    h.log('x');
    expect(win.calls[0].payload.resultId).toBe(0);
    expect(win.calls[1].payload.resultId).toBe(1);
  });
});
