// GMD-58 — IndexedDB pack cache. The IndexedDB plumbing itself is verified in Chrome (there is
// no fake-indexeddb here); what is tested is the POLICY, which is where the bugs would be:
// freshness, the blobBytes integrity check, and the rule that no cache problem may ever turn
// into silence — every failure path must fall through to the network.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PackCache = require('../dist/core/packcache.js');

/** A plain in-memory stand-in for the IndexedDB store. */
function fakeStore() {
  const map = new Map();
  return {
    map,
    get: (url) => Promise.resolve(map.get(url) || null),
    put: (rec) => { map.set(rec.url, rec); return Promise.resolve(); },
    clear: () => { map.clear(); return Promise.resolve(); },
    list: () => Promise.resolve([...map.values()])
  };
}

const buf = (n, fill = 7) => new Uint8Array(n).fill(fill).buffer;

function mockFetch(bodyByUrl, contentType) {
  return vi.fn((url) => {
    const body = bodyByUrl[url];
    if (body === undefined) return Promise.resolve({ ok: false, status: 404 });
    if (body instanceof Error) return Promise.reject(body);
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (contentType || null) : null) },
      arrayBuffer: () => Promise.resolve(body)
    });
  });
}

describe('packcache freshness policy', () => {
  const V = PackCache.CACHE_VERSION;

  it('accepts a record whose declared length matches its payload', () => {
    expect(PackCache.isFresh({ v: V, len: 4, bytes: buf(4) })).toBe(true);
  });

  it('rejects a missing record', () => {
    expect(PackCache.isFresh(null)).toBe(false);
  });

  it('rejects a record written by an older cache version', () => {
    expect(PackCache.isFresh({ v: V - 1, len: 4, bytes: buf(4) })).toBe(false);
  });

  // A half-finished transaction or a detached buffer would look like this.
  it('rejects a record whose declared length disagrees with its own payload', () => {
    expect(PackCache.isFresh({ v: V, len: 8, bytes: buf(4) })).toBe(false);
  });

  // This is the invalidation path that matters: the head is re-fetched every visit, so a
  // re-extract that changes a blob makes the cached copy unusable with no version bump.
  it('rejects a cached blob whose size disagrees with the head blobBytes', () => {
    expect(PackCache.isFresh({ v: V, len: 4, bytes: buf(4) }, 5)).toBe(false);
  });

  it('accepts a cached blob whose size matches the head blobBytes', () => {
    expect(PackCache.isFresh({ v: V, len: 4, bytes: buf(4) }, 4)).toBe(true);
  });

  it('accepts a record with no expected size (headless payloads ride on CACHE_VERSION)', () => {
    expect(PackCache.isFresh({ v: V, len: 4, bytes: buf(4) }, null)).toBe(true);
  });
});

describe('packcache fetchBuffer', () => {
  let store;
  beforeEach(() => {
    store = fakeStore();
    PackCache._setStore(store);
    PackCache._resetCounters();
  });

  it('fetches on a cold cache, then serves the second call from the store', async () => {
    const body = buf(64);
    global.fetch = mockFetch({ 'packs/a.bin': body });

    const first = await PackCache.fetchBuffer('packs/a.bin', 64);
    expect(first.byteLength).toBe(64);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const second = await PackCache.fetchBuffer('packs/a.bin', 64);
    expect(second.byteLength).toBe(64);
    expect(global.fetch).toHaveBeenCalledTimes(1);   // no second network hit
    expect(PackCache.counters()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('stores a COPY, so a caller detaching the buffer cannot corrupt the cached record', async () => {
    const body = buf(32);
    global.fetch = mockFetch({ 'packs/a.bin': body });
    const got = await PackCache.fetchBuffer('packs/a.bin', 32);
    expect(store.map.get('packs/a.bin').bytes).not.toBe(got);
    expect(store.map.get('packs/a.bin').bytes.byteLength).toBe(32);
  });

  it('re-fetches when the head declares a different size (a re-extract invalidates)', async () => {
    global.fetch = mockFetch({ 'packs/a.bin': buf(64) });
    await PackCache.fetchBuffer('packs/a.bin', 64);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Same URL, new head: the extractor rewrote the blob at a different size.
    global.fetch = mockFetch({ 'packs/a.bin': buf(99) });
    const again = await PackCache.fetchBuffer('packs/a.bin', 99);
    expect(again.byteLength).toBe(99);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(store.map.get('packs/a.bin').len).toBe(99);
  });

  it('does not cache a payload whose size already disagrees with the head', async () => {
    global.fetch = mockFetch({ 'packs/a.bin': buf(10) });
    const got = await PackCache.fetchBuffer('packs/a.bin', 64);   // server gave us the wrong thing
    expect(got.byteLength).toBe(10);                              // still returned; caller validates
    expect(store.map.has('packs/a.bin')).toBe(false);             // but never stored
  });

  // The rule from the ticket: a cache problem must never become silence.
  it('falls through to the network when the store read throws', async () => {
    PackCache._setStore({
      get: () => Promise.reject(new Error('idb exploded')),
      put: () => Promise.resolve(), clear: () => Promise.resolve(), list: () => Promise.resolve([])
    });
    global.fetch = mockFetch({ 'packs/a.bin': buf(8) });
    const got = await PackCache.fetchBuffer('packs/a.bin', 8);
    expect(got.byteLength).toBe(8);
  });

  it('still returns the bytes when the store write fails (quota exceeded)', async () => {
    PackCache._setStore({
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('QuotaExceededError')),
      clear: () => Promise.resolve(), list: () => Promise.resolve([])
    });
    global.fetch = mockFetch({ 'packs/a.bin': buf(8) });
    await expect(PackCache.fetchBuffer('packs/a.bin', 8)).resolves.toBeTruthy();
  });

  // Observed for real in Chrome: a pending deleteDatabase from another tab blocks open() with
  // NO event at all — not success, not error, not blocked — and every fetchBuffer awaited
  // forever. A hung cache must degrade to the network, never stall the pack load.
  it('goes to the network when the store read never settles', async () => {
    PackCache._setStore({
      get: () => new Promise(() => {}),                 // never settles
      put: () => Promise.resolve(), clear: () => Promise.resolve(), list: () => Promise.resolve([])
    });
    global.fetch = mockFetch({ 'packs/a.bin': buf(8) });
    const got = await PackCache.fetchBuffer('packs/a.bin', 8);
    expect(got.byteLength).toBe(8);
  }, 15000);

  // A host with an SPA fallback answers a missing pack with 200 index.html. Caching that would
  // make the app keep "succeeding" with HTML on every later visit.
  it('rejects and does not cache an HTML response served in place of a payload', async () => {
    global.fetch = mockFetch({ 'packs/a.bin': buf(120) }, 'text/html; charset=utf-8');
    await expect(PackCache.fetchBuffer('packs/a.bin')).rejects.toThrow(/HTML/);
    expect(store.map.size).toBe(0);
  });

  it('propagates a network failure so callers keep their sonivox fallback', async () => {
    global.fetch = mockFetch({});                                  // 404
    await expect(PackCache.fetchBuffer('packs/missing.bin')).rejects.toThrow('404');
  });

  it('does not cache a failed response', async () => {
    global.fetch = mockFetch({});
    await PackCache.fetchBuffer('packs/missing.bin').catch(() => {});
    expect(store.map.size).toBe(0);
  });

  it('fetchText decodes the cached bytes (SFZ definitions)', async () => {
    const text = '<region> sample=a.flac';
    global.fetch = mockFetch({ 'instruments/g.sfz': new TextEncoder().encode(text).buffer });
    expect(await PackCache.fetchText('instruments/g.sfz')).toBe(text);
    expect(await PackCache.fetchText('instruments/g.sfz')).toBe(text);   // served from cache
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports usage across stored payloads', async () => {
    global.fetch = mockFetch({ 'a.bin': buf(10), 'b.bin': buf(20) });
    await PackCache.fetchBuffer('a.bin');
    await PackCache.fetchBuffer('b.bin');
    expect(await PackCache.usage()).toMatchObject({ count: 2, bytes: 30 });
  });

  it('clear empties the store', async () => {
    global.fetch = mockFetch({ 'a.bin': buf(10) });
    await PackCache.fetchBuffer('a.bin');
    await PackCache.clear();
    expect(await PackCache.usage()).toMatchObject({ count: 0, bytes: 0 });
  });
});
