// Gomidas — backend seam (GMD-30/31, docs/WEB_PORT.md §2).
//
// ONE door between the editor and whatever is hosting it. The desktop app supplies the JUCE
// implementation below; the browser build (GMD-33) supplies a Web Audio one behind the SAME
// two interfaces, so nothing above this file knows which product it is running in.
//
// Split in two on purpose: the file/shell group differs most between platforms and has nothing
// to do with audio.
//
// Emitted by tsc as a plain script (module: "none") — it assigns window.GomidasBackend rather
// than exporting, exactly like the .js it replaced. Under Node/Vitest the same object is reached
// through module.exports. Do NOT add a top-level import/export: that would make this a module
// and the global would stop being global. See web/tsconfig.json.

// Ambient bindings — this file runs both in the WebView and under Node, and has no @types/node.
declare const module: { exports: unknown } | undefined;

interface JuceBridgeWindow {
  __JUCE__?: {
    backend?: {
      emitEvent?: (eventId: string, payload: { name: string; params: unknown[]; resultId: number }) => void;
    };
  };
}

/** What a host can and cannot do. The UI must hide what it cannot, not call it and fail. */
interface BackendCaps {
  /** desktop: true. Browser round-trip latency (~20-40ms) rules out "play on top". */
  liveInput: boolean;
  /** desktop: true (VST/AU). NEVER true on web — plugin hosting does not exist in a browser. */
  pluginHost: boolean;
  /** desktop: true (juce::MenuBarModel). */
  nativeMenus: boolean;
  /** web: 'picker' with File System Access, 'download' as the Safari fallback. */
  fileSystem: 'native' | 'picker' | 'download';
  /** web: true — OfflineAudioContext bounce (§7.3). */
  offlineRender: boolean;
}

/** A flat, tick-sorted event list. Produced by buildSequence; consumed unchanged (§7.1). */
interface Sequence {
  lengthTicks: number;
  events: number[][];
}

interface InstrumentPreset {
  file: string;
  name: string;
}

/** Backend -> editor. Replaces the window.gomidas* callback globals (§2.4). */
interface BackendEvents {
  tick: { tick: number };
  meter: { peak: number };
  instrumentLoaded: { channel: number; ok: boolean; name: string };
  recordingState: { recording: boolean; name?: string };
  pluginLoaded: { ok: boolean; name: string };
}

type Unsubscribe = () => void;

interface EventBus {
  on<K extends keyof BackendEvents>(event: K, handler: (payload: BackendEvents[K]) => void): Unsubscribe;
  emit<K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]): void;
  listenerCount(event: keyof BackendEvents): number;
}

interface AudioBackend extends EventBus {
  caps: BackendCaps;
  /** Escape hatch onto the raw wire. Prefer a named method. */
  invoke(name: string, payload?: unknown): void;

  // ---- transport ----
  setSequence(seq: Sequence): void;
  play(): void;
  stop(): void;
  seek(tick: number): void;
  panic(): void;
  setLoop(on: boolean, startTick?: number, endTick?: number): void;
  setTempo(bpm: number): void;
  setPlaybackRate(rate: number): void;

  // ---- mixer ----
  setChannelMix(channel: number, gain: number, pan: number): void;
  setMasterMix(gain: number, pan: number): void;
  setTrackEq(channel: number, low: number, mid: number, high: number): void;
  setMasterEq(low: number, mid: number, high: number): void;

  // ---- instruments ----
  loadTrackPreset(channel: number, preset: InstrumentPreset): void;
  loadTrackInstrumentFile(channel: number): void;
  clearTrackInstrument(channel: number): void;
  preview(channel: number, program: number, percussion: boolean, keys: number[]): void;

  // ---- recording ----
  startRecording(): void;
  stopRecording(): void;

  // ---- desktop-only; guard with caps before calling ----
  setLiveInput?(enabled: boolean, gain: number): void;
  loadInputPlugin?(): void;
  clearInputPlugin?(): void;
  showPluginEditor?(): void;
}

interface HostBackend {
  caps: BackendCaps;
  openFile(): void;
  openProject(): void;
  openRecent(index: number): void;
  saveProject(json: string): void;
  saveBinary(ext: string, b64: string): void;
  log(msg: unknown): void;
  minimizeWindow?(): void;
  showAbout?(): void;
}

// ---- event bus ------------------------------------------------------------------------------
// Replaces the window.gomidas* callback globals as the thing the EDITOR subscribes to. The
// globals themselves must survive: MainComponent.cpp calls them by literal name through
// evaluateJavascript (src/ui/MainComponent.cpp:879 etc.), so they stay as thin adapters that
// emit into this bus.
function createEventBus(): EventBus {
  const handlers: Record<string, Array<(payload: any) => void>> = Object.create(null);
  return {
    on(event, handler) {
      (handlers[event] || (handlers[event] = [])).push(handler as (p: any) => void);
      return function off() {
        const list = handlers[event];
        if (!list) return;
        const i = list.indexOf(handler as (p: any) => void);
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

const JUCE_CAPS: BackendCaps = {
  liveInput: true,
  pluginHost: true,
  nativeMenus: true,
  fileSystem: 'native',
  offlineRender: false
};

// ---- JUCE implementation --------------------------------------------------------------------
// Wraps the existing wire format VERBATIM — same call names, same payload shapes — so Phase 0
// could not change desktop behaviour. web/tests/backend.test.js pins every one of them.
//
// Wire format (juce_native_interop.js Backend.emitEvent):
//   postMessage {eventId:"__juce__invoke", payload:{name, params:[payload], resultId}}
function createJuceBackends(win?: JuceBridgeWindow): { audio: AudioBackend; host: HostBackend } {
  const w: JuceBridgeWindow = win || (typeof window !== 'undefined' ? (window as unknown as JuceBridgeWindow) : {});
  let resultId = 0;

  function invoke(name: string, payload?: unknown): void {
    try {
      const bridge = w.__JUCE__ && w.__JUCE__.backend;
      if (bridge && bridge.emitEvent) {
        bridge.emitEvent('__juce__invoke', { name, params: [payload], resultId: resultId++ });
      }
    } catch (e) { /* swallow: this is on the error-reporting path, don't recurse */ }
  }

  const bus = createEventBus();

  const audio: AudioBackend = {
    caps: JUCE_CAPS,
    on: bus.on,
    emit: bus.emit,                 // used by the window.gomidas* adapters in app.js
    listenerCount: bus.listenerCount,
    invoke,

    // transport
    setSequence: (seq) => invoke('setSequence', seq),
    play: () => invoke('play', 1),
    stop: () => invoke('stop', 1),
    seek: (tick) => invoke('seek', tick),
    panic: () => invoke('panic', 1),
    setLoop: (on, startTick, endTick) =>
      invoke('setLoop', on ? { start: startTick, end: endTick } : { start: -1, end: -1 }),
    setTempo: (bpm) => invoke('setTempo', bpm),
    setPlaybackRate: (rate) => invoke('setPlaybackRate', rate),

    // mixer
    setChannelMix: (channel, gain, pan) => invoke('setChannelMix', { channel, gain, pan }),
    setMasterMix: (gain, pan) => invoke('setMasterMix', { gain, pan }),
    setTrackEq: (channel, low, mid, high) => invoke('setTrackEq', { channel, low, mid, high }),
    setMasterEq: (low, mid, high) => invoke('setMasterEq', { low, mid, high }),

    // instruments — deliberately generalised away from "Sfz": the editor must not know whether
    // a preset is SFZ, SoundFont or something else. That is the backend's business.
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

  const host: HostBackend = {
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

// ---- host detection -------------------------------------------------------------------------
// juce_native_interop.js is DEFENSIVE: loaded in a plain browser it warns and installs a
// placeholder window.__JUCE__ with a no-op postMessage. So "does window.__JUCE__ exist" is NOT a
// valid test — it is always true once that file has run, and a JUCE backend would happily post
// messages into the void.
//
// The placeholder sets initialisationData.__juce__platform to an EMPTY array; a real host fills
// it in. That is the discriminator, and it is what lets one index.html serve both products.
function hasJuceBridge(win?: any): boolean {
  try {
    const j = (win || window).__JUCE__;
    const platform = j && j.initialisationData && j.initialisationData.__juce__platform;
    return Array.isArray(platform) && platform.length > 0;
  } catch (e) { return false; }
}

const WEB_CAPS: BackendCaps = {
  liveInput: false,     // getUserMedia works, but ~20-40ms round trip kills "play on top"
  pluginHost: false,    // VST/AU does not exist in a browser. Never true.
  nativeMenus: false,   // the web shell supplies its own
  fileSystem: typeof window !== 'undefined' && 'showOpenFilePicker' in window ? 'picker' : 'download',
  offlineRender: true   // OfflineAudioContext bounce (§7.3)
};

// ---- web implementation ---------------------------------------------------------------------
// GMD-32 ships the HOST half (open/save) and a SILENT audio backend: the shell must render a
// score in a browser before any audio exists. GMD-33 replaces the silent one with the Web Audio
// scheduler + channel strip. Everything above this file is already written against the
// interface, so that is a swap, not a rewrite.
function createWebBackends(): { audio: AudioBackend; host: HostBackend } {
  const bus = createEventBus();
  const noop = () => { /* not available on web */ };

  // GMD-33: the real Web Audio engine when it is loaded (index.html includes it), and a silent
  // stand-in otherwise so the editor still runs headless (tests, a shell without audio).
  // setLiveInput / loadInputPlugin / clearInputPlugin / showPluginEditor stay ABSENT either way:
  // caps.liveInput and caps.pluginHost are false, and UI must check those rather than call a
  // method that silently does nothing.
  const wa = typeof window !== 'undefined' ? (window as any).GomidasWebAudio : null;
  const audio: AudioBackend = wa
    ? wa.createWebAudioBackend({ createEventBus, WEB_CAPS })
    : {
      caps: WEB_CAPS,
      on: bus.on,
      emit: bus.emit,
      listenerCount: bus.listenerCount,
      invoke: noop,
      setSequence: noop, play: noop, stop: noop, seek: noop, panic: noop,
      setLoop: noop, setTempo: noop, setPlaybackRate: noop,
      setChannelMix: noop, setMasterMix: noop, setTrackEq: noop, setMasterEq: noop,
      loadTrackPreset: noop, loadTrackInstrumentFile: noop, clearTrackInstrument: noop,
      preview: noop,
      startRecording: noop, stopRecording: noop
    };

  // File handling delegates to core/webfiles.ts (GMD-37): File System Access where it exists,
  // <input type=file> + Blob download in Safari. caps.fileSystem says which is in play.
  const Files = typeof window !== 'undefined' ? (window as any).GomidasFiles : null;
  let currentHandle: any = null;      // the picker handle, so Save overwrites instead of re-asking

  function loadPicked(picked: any): void {
    if (!picked) return;
    const w = window as any;
    currentHandle = picked.handle || null;
    if (picked.kind === 'project') { if (w.gomidasLoadProject) w.gomidasLoadProject(picked.data); }
    else if (w.gomidasLoadBinary) w.gomidasLoadBinary(picked.data);
    if (Files) {
      Files.idbGet(Files.STORE_STATE, 'recent')
        .then((list: any) => Files.idbPut(Files.STORE_STATE, 'recent',
          Files.recentAdd(list, { name: picked.name, at: picked.name })));
    }
  }

  function openViaPicker(): void {
    if (!Files) return;
    Files.pickAndRead().then(loadPicked).catch(() => { /* cancelled */ });
  }

  const host: HostBackend = {
    caps: WEB_CAPS,
    openFile: openViaPicker,
    openProject: openViaPicker,
    openRecent: () => {
      // A recent NAME is not a file handle: without a stored FileSystemFileHandle (and the
      // permission that goes with it) the browser cannot reopen it, so this deliberately falls
      // back to the picker rather than pretending to have a recent-files list.
      openViaPicker();
    },
    saveProject: (json) => {
      if (!Files) return;
      Files.saveData('score.gomidas', json, 'application/json', currentHandle);
    },
    saveBinary: (ext, b64) => {
      if (!Files) return;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      Files.saveData('score.' + ext, bytes, 'application/octet-stream');
    },
    log: (msg) => { try { console.log('[gomidas]', String(msg)); } catch (e) { /* ignore */ } }
    // minimizeWindow / showAbout absent — caps.nativeMenus is false.
  };

  return { audio, host };
}

/** Pick the backend for whatever is hosting us. The one call site is app.js. */
function createBackends(win?: any): { audio: AudioBackend; host: HostBackend } {
  return hasJuceBridge(win) ? createJuceBackends(win) : createWebBackends();
}

// Dual-mode publication, matching core/gomidas-core.js: a browser global for the <script> tags,
// module.exports for Node/Vitest. Assigned (not `export`ed) so the emitted file stays a script.
(function publish(api: unknown) {
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasBackend = api;
}({ createEventBus, createJuceBackends, createWebBackends, createBackends, hasJuceBridge, JUCE_CAPS, WEB_CAPS }));
