// Gomidas — browser file handling (GMD-37, docs/WEB_PORT.md §6 + §7.3).
//
// Decided 2026-08-13: PURE CLIENT-SIDE. No server, no accounts, no upload. Everything here is
// local-file plumbing.
//
// SAFARI HAS NO FILE SYSTEM ACCESS API (§8), so there is no save-in-place there. Two paths:
//   caps.fileSystem === 'picker'   -> showOpenFilePicker / showSaveFilePicker, real save-in-place
//   caps.fileSystem === 'download' -> <input type=file> + a Blob download
// Do not ship a Chromium-only app: the download path is a first-class fallback, not a stub.
//
// The pure parts (WAV encoding, recent-list maintenance) live here so §9 can test them without
// a browser.

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

const DB_NAME = 'gomidas';
const DB_VERSION = 1;
const STORE_ASSETS = 'assets';     // cached instrument samples (§8: lazy-load, cache in IndexedDB)
const STORE_STATE = 'state';       // recent files, preferences

function pickerSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showOpenFilePicker === 'function';
}

// ---- WAV encoding (pure) --------------------------------------------------------------------
/**
 * Encode interleaved-from-planar Float32 channels as a 16-bit PCM WAV.
 *
 * Used by the offline bounce (§7.3), which renders the whole song faster than realtime instead
 * of capturing it live — cleaner than the desktop ThreadedWriter path and deterministic.
 *
 * Samples are CLAMPED, not wrapped: a value over 1.0 must clip, because wrapping turns a loud
 * mix into white noise.
 */
function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = Math.max(1, channels.length);
  const numFrames = channels[0] ? channels[0].length : 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM chunk size
  view.setUint16(20, 1, true);             // format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  let at = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const src = channels[c] || channels[0];
      let v = src ? src[i] : 0;
      v = v > 1 ? 1 : (v < -1 ? -1 : v);            // clamp, never wrap
      view.setInt16(at, Math.round(v * 32767), true);
      at += 2;
    }
  }
  return buffer;
}

// ---- recent files (pure) --------------------------------------------------------------------
/**
 * Most-recent-first, de-duplicated by name, capped. Mirrors the desktop recent.txt behaviour so
 * the two products feel the same.
 */
function recentAdd(list: any[], entry: { name: string; [k: string]: any }, max: number = 10): any[] {
  if (!entry || !entry.name) return Array.isArray(list) ? list.slice(0, max) : [];
  const rest = (Array.isArray(list) ? list : []).filter(e => e && e.name !== entry.name);
  return [entry, ...rest].slice(0, Math.max(1, max));
}

/** Extension without the dot, lowercased. '' when there is none. */
function extensionOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

const OPEN_TYPES = [
  { description: 'Guitar Pro / Gomidas', accept: { 'application/octet-stream':
      ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.gomidas', '.musicxml', '.xml', '.cap'] } }
];

// ---- IndexedDB (browser) --------------------------------------------------------------------
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS);
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);       // caching is an optimisation, never a hard failure
    } catch (e) { resolve(null); }
  });
}

function idbGet(store: string, key: string): Promise<any> {
  return openDb().then(db => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result != null ? req.result : null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  }));
}

function idbPut(store: string, key: string, value: any): Promise<boolean> {
  return openDb().then(db => new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  }));
}

// ---- open / save ----------------------------------------------------------------------------
/** Read a File into the shape the shared load path wants: text for .gomidas, base64 otherwise. */
function readFile(file: File): Promise<{ name: string; kind: 'project' | 'binary'; data: string }> {
  return new Promise((resolve, reject) => {
    const isProject = extensionOf(file.name) === 'gomidas';
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const raw = String(reader.result);
      resolve({
        name: file.name,
        kind: isProject ? 'project' : 'binary',
        data: isProject ? raw : raw.replace(/^data:[^;]*;base64,/, '')
      });
    };
    if (isProject) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

function pickAndRead(): Promise<{ name: string; kind: string; data: string; handle?: any } | null> {
  if (pickerSupported()) {
    return (window as any).showOpenFilePicker({ types: OPEN_TYPES, multiple: false })
      .then(([handle]: any[]) => handle.getFile().then((f: File) => readFile(f).then(r => ({ ...r, handle }))))
      .catch(() => null);       // user cancelled
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gp,.gp3,.gp4,.gp5,.gpx,.gomidas,.musicxml,.xml,.cap';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      readFile(f).then(resolve).catch(() => resolve(null));
    });
    // A cancelled file input fires nothing at all in some browsers, so nothing to clean up here
    // beyond the element itself; it is removed on the next open.
    document.body.appendChild(input);
    input.click();
  });
}

function download(name: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save-in-place through the picker when available, otherwise a download. */
function saveData(suggestedName: string, data: BlobPart, mime: string, handle?: any): Promise<boolean> {
  const writeTo = (h: any) => h.createWritable().then((w: any) => w.write(data).then(() => w.close()).then(() => true));
  if (handle && handle.createWritable) return writeTo(handle).catch(() => { download(suggestedName, data, mime); return true; });
  if (pickerSupported()) {
    const ext = extensionOf(suggestedName);
    return (window as any).showSaveFilePicker({
      suggestedName,
      types: [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }]
    }).then(writeTo).catch((e: any) => {
      // AbortError = the user cancelled; anything else means fall back rather than lose the file.
      if (e && e.name === 'AbortError') return false;
      download(suggestedName, data, mime);
      return true;
    });
  }
  download(suggestedName, data, mime);
  return Promise.resolve(true);
}

  const api = { pickerSupported, encodeWav, recentAdd, extensionOf, readFile, pickAndRead,
                saveData, download, idbGet, idbPut, STORE_ASSETS, STORE_STATE };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasFiles = api;
}());
