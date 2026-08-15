// Gomidas — IndexedDB byte cache for lazily-fetched audio payloads (GMD-58,
// docs/WEB_PORT.md §8 "lazy-load per track, cache in IndexedDB").
//
// Every lazily-fetched asset used to be re-downloaded on each visit: the drum pack alone is
// 5.4MB, the GMD-57 melodic packs are ~1MB per program, sonivox is 1.35MB, and a bundled SFZ
// preset is ~40 sample files. A returning visitor should pay for the shell only.
//
// WHAT IS CACHED: binary payloads, and only those. The JSON heads stay on the network on
// purpose — the manifest is 482KB raw but 7.5KB brotli, so re-fetching it is nearly free, and
// it is precisely the thing that tells us what the blobs should be. That gives invalidation for
// free: every blob is read back with the `blobBytes` its freshly-fetched head declares, so a
// re-extract that changes a blob invalidates the cached copy automatically. There is no
// hand-maintained version number to forget to bump — CACHE_VERSION below exists only for
// payloads with no head to check against (sonivox.sf2, SFZ samples) and for changing the record
// shape itself.
//
// NOT a service worker: these are big immutable blobs fetched by our own code, so IndexedDB is
// the right store and it avoids the SW update/versioning trap on an app whose JS is not
// content-hashed (see GMD-60).
//
// THE RULE: a cache problem must never become silence. Every failure path here — no IndexedDB,
// private mode, quota exceeded, a corrupt record, a rejected transaction — falls through to the
// network, and the callers already fall through from the network to the sonivox bank. Nothing in
// this file is allowed to reject.

// SCOPE NOTE: body wrapped in an IIFE — these emit as plain <script> files sharing one global scope.
(function () {

/** Bump only when the RECORD SHAPE changes, or a headless payload (sonivox.sf2) is replaced. */
const CACHE_VERSION = 1;
const DB_NAME = 'gomidas-packs';
const STORE = 'blobs';

interface PackRecord {
  url: string;
  v: number;
  len: number;
  bytes: ArrayBuffer;
  at: number;
}

/**
 * The storage seam. The real one is IndexedDB; tests inject a plain-object fake so the policy
 * below (freshness, size validation, fall-through) is verifiable without a browser.
 */
interface PackStore {
  get(url: string): Promise<PackRecord | null>;
  put(rec: PackRecord): Promise<void>;
  clear(): Promise<void>;
  list(): Promise<PackRecord[]>;
}

/**
 * Is a stored record usable for this request?
 *
 * `expectedBytes` is the size the caller's freshly-read head declares. When we have it, it is a
 * far better check than any version counter: it catches a re-extract, a truncated write and a
 * half-finished transaction alike. When we do not (sonivox.sf2, SFZ samples), CACHE_VERSION is
 * all we have, and those payloads only change when the app itself is redeployed.
 */
function isFresh(rec: PackRecord | null, expectedBytes?: number | null): boolean {
  if (!rec || !rec.bytes) return false;
  if (rec.v !== CACHE_VERSION) return false;
  // A record whose declared length disagrees with its own payload was written badly; distrust it.
  if (rec.len !== rec.bytes.byteLength) return false;
  if (expectedBytes != null && rec.len !== expectedBytes) return false;
  return true;
}

// ---- IndexedDB store ---------------------------------------------------------------------

let dbPromise: Promise<any> | null = null;
let disabled = false;   // set once IndexedDB proves unusable; we stop trying rather than retry per asset

/** How long to wait for the database to open before giving up on the cache entirely. */
const OPEN_TIMEOUT_MS = 3000;
/** How long to wait for a single cached read before just going to the network. */
const READ_TIMEOUT_MS = 4000;

function openDb(): Promise<any> {
  if (disabled) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let settled = false;
    const done = (db: any) => { if (settled) return; settled = true; if (!db) disabled = true; resolve(db); };

    // An open() request can hang with NO event at all — a pending deleteDatabase from another
    // tab blocks it indefinitely, and observed for real: it left every fetchBuffer awaiting
    // forever, which is a cache problem turning into silence. Time out into "no cache".
    setTimeout(() => done(null), OPEN_TIMEOUT_MS);

    let req: any;
    try {
      const idb = (typeof indexedDB !== 'undefined') ? indexedDB : null;
      if (!idb) { done(null); return; }
      req = idb.open(DB_NAME, CACHE_VERSION);
    } catch (e) {
      // Firefox in private mode throws from open() rather than erroring the request.
      done(null); return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // Drop wholesale on a version change: these are re-downloadable caches, not data.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: 'url' });
    };
    req.onsuccess = () => done(req.result);
    req.onerror = () => done(null);
    req.onblocked = () => done(null);
  });
  return dbPromise;
}

function tx(db: any, mode: string): any {
  return db.transaction(STORE, mode).objectStore(STORE);
}

const idbStore: PackStore = {
  get(url) {
    return openDb().then(db => new Promise<PackRecord | null>((resolve) => {
      if (!db) { resolve(null); return; }
      try {
        const req = tx(db, 'readonly').get(url);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    }));
  },
  put(rec) {
    return openDb().then(db => new Promise<void>((resolve) => {
      if (!db) { resolve(); return; }
      try {
        const req = tx(db, 'readwrite').put(rec);
        // A quota error lands here. Nothing to do but keep playing from the network copy we
        // already have in hand — evicting other packs to make room would just trade one
        // re-download for another.
        req.onsuccess = () => resolve();
        req.onerror = () => { try { req.transaction.abort(); } catch (e) {} resolve(); };
      } catch (e) { resolve(); }
    }));
  },
  clear() {
    return openDb().then(db => new Promise<void>((resolve) => {
      if (!db) { resolve(); return; }
      try {
        const req = tx(db, 'readwrite').clear();
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch (e) { resolve(); }
    }));
  },
  list() {
    return openDb().then(db => new Promise<PackRecord[]>((resolve) => {
      if (!db) { resolve([]); return; }
      try {
        const req = tx(db, 'readonly').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    }));
  }
};

let store: PackStore = idbStore;

// ---- public API --------------------------------------------------------------------------

const stats = { hits: 0, misses: 0, bytesServed: 0, bytesFetched: 0 };

/**
 * Cache-first fetch of a binary payload. Resolves with the bytes, or rejects exactly as the
 * underlying fetch would — callers keep their existing error handling and their sonivox fallback.
 *
 * `expectedBytes` is the `blobBytes` from the caller's head when it has one. Passing it turns the
 * head into the cache's invalidation signal; omitting it falls back to CACHE_VERSION.
 */
/** Resolve to null rather than hang: nothing on the read path may delay a pack load. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), ms))]);
}

function fetchBuffer(url: string, expectedBytes?: number | null): Promise<ArrayBuffer> {
  return withTimeout(store.get(url), READ_TIMEOUT_MS).catch(() => null).then(rec => {
    if (isFresh(rec, expectedBytes)) {
      stats.hits++;
      stats.bytesServed += rec!.len;
      return rec!.bytes;
    }
    return fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(url + ' ' + r.status);
        // A host with an SPA fallback answers a missing pack with 200 and index.html. Without
        // this the app would cache that HTML and keep "succeeding" with it on every later visit;
        // the payloads with no blobBytes to check (sonivox, SFZ) would never recover. Observed on
        // the dev server, which has exactly that fallback.
        const type = r.headers && r.headers.get && r.headers.get('content-type');
        if (type && /^text\/html/i.test(type)) throw new Error(url + ' returned HTML, not a payload');
        return r.arrayBuffer();
      })
      .then(buf => {
        stats.misses++;
        stats.bytesFetched += buf.byteLength;
        // Never cache a payload we can already tell is wrong — it would only be rejected on read.
        if (expectedBytes == null || buf.byteLength === expectedBytes) {
          // Store a COPY. Callers hand these buffers to decodeAudioData, which DETACHES its
          // input; the spec does not pin down whether IndexedDB has finished serialising by
          // then, and a detached buffer would be written as an empty one. A one-time copy on
          // the first visit is a cheap price for not having to reason about that race.
          store.put({ url, v: CACHE_VERSION, len: buf.byteLength, bytes: buf.slice(0), at: Date.now() })
            .catch(() => { /* a write failure costs a re-download, nothing more */ });
        }
        return buf;
      });
  });
}

/** Cache-first fetch of a text payload (SFZ definitions). Same contract as fetchBuffer. */
function fetchText(url: string, expectedBytes?: number | null): Promise<string> {
  return fetchBuffer(url, expectedBytes).then(buf => new TextDecoder().decode(new Uint8Array(buf)));
}

/** Drop everything. Exposed for the console and for a "clear cached sounds" action later. */
function clear(): Promise<void> {
  return store.clear().catch(() => undefined);
}

/** What is cached right now — count and total bytes. For diagnostics; never on a hot path. */
function usage(): Promise<{ count: number; bytes: number; urls: string[] }> {
  return store.list().catch(() => [] as PackRecord[]).then(recs => ({
    count: recs.length,
    bytes: recs.reduce((n, r) => n + (r.len || 0), 0),
    urls: recs.map(r => r.url)
  }));
}

/** Hit/miss counters for this session. */
function counters() { return { ...stats }; }

const api = {
  fetchBuffer, fetchText, clear, usage, counters,
  // test seam + internals
  isFresh, CACHE_VERSION,
  _setStore(s: PackStore | null) { store = s || idbStore; },
  _resetCounters() { stats.hits = 0; stats.misses = 0; stats.bytesServed = 0; stats.bytesFetched = 0; }
};
if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
if (typeof window !== 'undefined') (window as any).GomidasPackCache = api;
}());
