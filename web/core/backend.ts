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

// Dual-mode publication, matching core/gomidas-core.js: a browser global for the <script> tags,
// module.exports for Node/Vitest. Assigned (not `export`ed) so the emitted file stays a script.
(function publish(api: unknown) {
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasBackend = api;
}({ createEventBus, createJuceBackends, JUCE_CAPS }));
