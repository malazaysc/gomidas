// Gomidas — backend seam (GMD-30, docs/WEB_PORT.md §2).
//
// ONE door between the editor and whatever is hosting it. The desktop app supplies the JUCE
// implementation below; the browser build (GMD-33) supplies a Web Audio one behind the SAME
// two interfaces, so nothing above this file knows which product it is running in.
//
// Split in two on purpose: the file/shell group differs most between platforms and has nothing
// to do with audio.
//
// Dual-mode like core/gomidas-core.js: `window.GomidasBackend` in the browser, `module.exports`
// under Node/Vitest.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;      // Node / Vitest
  if (typeof window !== 'undefined') window.GomidasBackend = api;                 // browser global
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @typedef {Object} BackendCaps
   * @property {boolean} liveInput      desktop: true. Browser round-trip latency rules it out.
   * @property {boolean} pluginHost     desktop: true (VST/AU). NEVER true on web.
   * @property {boolean} nativeMenus    desktop: true (juce::MenuBarModel).
   * @property {'native'|'picker'|'download'} fileSystem
   * @property {boolean} offlineRender  web: true (OfflineAudioContext bounce).
   */

  /**
   * @typedef {Object} AudioBackend
   * // ---- transport ----
   * @property {(seq: {lengthTicks: number, events: Array}) => void} setSequence
   * @property {() => void} play
   * @property {() => void} stop
   * @property {(tick: number) => void} seek
   * @property {() => void} panic
   * @property {(on: boolean, startTick?: number, endTick?: number) => void} setLoop
   * @property {(bpm: number) => void} setTempo
   * @property {(rate: number) => void} setPlaybackRate
   * // ---- mixer ----
   * @property {(ch: number, gain: number, pan: number) => void} setChannelMix
   * @property {(gain: number, pan: number) => void} setMasterMix
   * @property {(ch: number, low: number, mid: number, high: number) => void} setTrackEq
   * @property {(low: number, mid: number, high: number) => void} setMasterEq
   * // ---- instruments ----
   * @property {(ch: number, preset: {file: string, name: string}) => void} loadTrackPreset
   * @property {(ch: number) => void} loadTrackInstrumentFile   // opens a host file chooser
   * @property {(ch: number) => void} clearTrackInstrument
   * @property {(ch: number, program: number, percussion: boolean, keys: number[]) => void} preview
   * // ---- recording ----
   * @property {() => void} startRecording
   * @property {() => void} stopRecording
   * // ---- desktop-only; guard with caps ----
   * @property {(on: boolean, gain: number) => void} [setLiveInput]
   * @property {() => void} [loadInputPlugin]
   * @property {() => void} [clearInputPlugin]
   * @property {() => void} [showPluginEditor]
   * @property {BackendCaps} caps
   * @property {(event: string, handler: Function) => Function} on   // returns an unsubscribe fn
   */

  /**
   * @typedef {Object} HostBackend
   * @property {() => void} openFile
   * @property {() => void} openProject
   * @property {(index: number) => void} openRecent
   * @property {(json: string) => void} saveProject
   * @property {(ext: string, b64: string) => void} saveBinary
   * @property {(msg: string) => void} log
   * @property {() => void} [minimizeWindow]
   * @property {() => void} [showAbout]
   * @property {BackendCaps} caps
   */

  // ---- event bus (backend -> editor) -----------------------------------------------------
  // Replaces the window.gomidas* callback globals as the thing the EDITOR subscribes to. The
  // globals themselves must survive: MainComponent.cpp calls them by literal name through
  // evaluateJavascript (see src/ui/MainComponent.cpp:879 etc.), so they stay as thin adapters
  // that emit into this bus.
  function createEventBus() {
    const handlers = Object.create(null);
    return {
      on(event, handler) {
        (handlers[event] || (handlers[event] = [])).push(handler);
        return function off() {
          const list = handlers[event];
          if (!list) return;
          const i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
        };
      },
      emit(event, payload) {
        const list = handlers[event];
        if (!list) return;
        // Copy first: a handler may unsubscribe itself mid-dispatch.
        for (const h of list.slice()) {
          try { h(payload); } catch (e) { /* one bad listener must not stop the rest */ }
        }
      },
      listenerCount(event) { return (handlers[event] || []).length; }
    };
  }

  /** @type {BackendCaps} */
  const JUCE_CAPS = {
    liveInput: true,
    pluginHost: true,
    nativeMenus: true,
    fileSystem: 'native',
    offlineRender: false
  };

  // ---- JUCE implementation ---------------------------------------------------------------
  // Wraps the existing wire format VERBATIM — same 29 call names, same payload shapes — so
  // Phase 0 cannot change desktop behaviour. See docs/WEB_PORT.md §3.
  //
  // Wire format (juce_native_interop.js Backend.emitEvent):
  //   postMessage {eventId:"__juce__invoke", payload:{name, params:[payload], resultId}}
  function createJuceBackends(win) {
    const w = win || (typeof window !== 'undefined' ? window : {});
    let resultId = 0;

    function invoke(name, payload) {
      try {
        const j = w.__JUCE__;
        if (j && j.backend && j.backend.emitEvent) {
          j.backend.emitEvent('__juce__invoke',
            { name: name, params: [payload], resultId: resultId++ });
        }
      } catch (e) { /* swallow: this is on the error-reporting path, don't recurse */ }
    }

    const bus = createEventBus();

    /** @type {AudioBackend} */
    const audio = {
      caps: JUCE_CAPS,
      on: bus.on,
      emit: bus.emit,          // used by the window.gomidas* adapters in app.js
      invoke,                  // escape hatch; prefer a named method

      // transport
      setSequence: (seq) => invoke('setSequence', seq),
      play: () => invoke('play', 1),
      stop: () => invoke('stop', 1),
      seek: (tick) => invoke('seek', tick),
      panic: () => invoke('panic', 1),
      setLoop: (on, startTick, endTick) => invoke('setLoop',
        on ? { start: startTick, end: endTick } : { start: -1, end: -1 }),
      setTempo: (bpm) => invoke('setTempo', bpm),
      setPlaybackRate: (rate) => invoke('setPlaybackRate', rate),

      // mixer
      setChannelMix: (channel, gain, pan) => invoke('setChannelMix', { channel, gain, pan }),
      setMasterMix: (gain, pan) => invoke('setMasterMix', { gain, pan }),
      setTrackEq: (channel, low, mid, high) => invoke('setTrackEq', { channel, low, mid, high }),
      setMasterEq: (low, mid, high) => invoke('setMasterEq', { low, mid, high }),

      // instruments — deliberately generalised away from "Sfz": the editor must not know
      // whether a preset is SFZ, SoundFont or something else. That is the backend's business.
      loadTrackPreset: (channel, preset) =>
        invoke('loadTrackSfzPreset', { channel, file: preset.file, name: preset.name }),
      loadTrackInstrumentFile: (channel) => invoke('loadTrackSfz', { channel }),
      clearTrackInstrument: (channel) => invoke('clearTrackSfz', { channel }),
      preview: (channel, program, percussion, keys) =>
        invoke('preview', { channel, program, percussion, keys }),

      // recording
      startRecording: () => invoke('startRecording', 1),
      stopRecording: () => invoke('stopRecording', 1),

      // desktop-only (caps.liveInput / caps.pluginHost)
      setLiveInput: (enabled, gain) => invoke('setLiveInput', { enabled, gain }),
      loadInputPlugin: () => invoke('loadInputPlugin', 1),
      clearInputPlugin: () => invoke('clearInputPlugin', 1),
      showPluginEditor: () => invoke('showPluginEditor', 1)
    };

    /** @type {HostBackend} */
    const host = {
      caps: JUCE_CAPS,
      openFile: () => invoke('openFile'),
      openProject: () => invoke('openProject', 1),
      openRecent: (index) => invoke('openRecent', index),
      saveProject: (json) => invoke('saveProject', json),
      saveBinary: (ext, b64) => invoke('saveBinary', { ext, b64 }),
      log: (msg) => invoke('log', String(msg)),
      minimizeWindow: () => invoke('minimizeWindow', 1),
      showAbout: () => invoke('showAbout', 1)
    };

    return { audio, host };
  }

  return { createEventBus, createJuceBackends, JUCE_CAPS };
}));
