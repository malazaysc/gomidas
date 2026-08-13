// GMD-37 — the pure half of browser file handling: WAV encoding and the recent-files list.
import { describe, it, expect } from 'vitest';
import W from '../core/webfiles.ts';

const { encodeWav, recentAdd, extensionOf } = W;

const readAscii = (view, at, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(at + i));
  return s;
};

describe('WAV encoding (offline bounce, §7.3)', () => {
  it('writes a valid 44-byte RIFF/WAVE header', () => {
    const frames = 100, rate = 44100;
    const buf = encodeWav([new Float32Array(frames), new Float32Array(frames)], rate);
    const v = new DataView(buf);
    expect(readAscii(v, 0, 4)).toBe('RIFF');
    expect(readAscii(v, 8, 4)).toBe('WAVE');
    expect(readAscii(v, 12, 4)).toBe('fmt ');
    expect(readAscii(v, 36, 4)).toBe('data');
    expect(v.getUint16(20, true)).toBe(1);          // PCM
    expect(v.getUint16(22, true)).toBe(2);          // stereo
    expect(v.getUint32(24, true)).toBe(rate);
    expect(v.getUint16(34, true)).toBe(16);         // bit depth
    expect(v.getUint32(28, true)).toBe(rate * 4);   // byte rate = rate * channels * 2
    expect(v.getUint16(32, true)).toBe(4);          // block align
  });

  it('declares sizes that match the actual buffer', () => {
    const frames = 250;
    const buf = encodeWav([new Float32Array(frames), new Float32Array(frames)], 48000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + frames * 4);
    expect(v.getUint32(4, true)).toBe(36 + frames * 4);    // RIFF size
    expect(v.getUint32(40, true)).toBe(frames * 4);        // data size
  });

  it('interleaves channels rather than concatenating them', () => {
    const left = new Float32Array([1, 1, 1]);
    const right = new Float32Array([-1, -1, -1]);
    const v = new DataView(encodeWav([left, right], 44100));
    expect(v.getInt16(44, true)).toBe(32767);      // L
    expect(v.getInt16(46, true)).toBe(-32767);     // R
    expect(v.getInt16(48, true)).toBe(32767);      // L
  });

  it('CLAMPS out-of-range samples instead of wrapping them', () => {
    // Wrapping turns a loud mix into white noise — the single nastiest bug in a WAV writer.
    const v = new DataView(encodeWav([new Float32Array([2, -2, 0.5])], 44100));
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32767);
    expect(v.getInt16(48, true)).toBeCloseTo(16384, -2);
  });

  it('handles mono and an empty render without throwing', () => {
    expect(encodeWav([new Float32Array([0, 0.25])], 44100).byteLength).toBe(44 + 2 * 2);
    expect(encodeWav([new Float32Array(0)], 44100).byteLength).toBe(44);
    expect(encodeWav([], 44100).byteLength).toBe(44);
  });

  it('round-trips a recognisable waveform', () => {
    const n = 64;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * i) / n);
    const v = new DataView(encodeWav([sine], 44100));
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(v.getInt16(44 + i * 2, true)));
    expect(peak).toBeGreaterThan(32000);          // full-scale sine survives
    expect(v.getInt16(44, true)).toBe(0);         // starts at zero crossing
  });
});

describe('recent files', () => {
  it('puts the newest first', () => {
    const list = recentAdd(recentAdd([], { name: 'a.gp' }), { name: 'b.gp' });
    expect(list.map(e => e.name)).toEqual(['b.gp', 'a.gp']);
  });

  it('de-duplicates by name, promoting the existing entry', () => {
    let list = recentAdd([], { name: 'a.gp' });
    list = recentAdd(list, { name: 'b.gp' });
    list = recentAdd(list, { name: 'a.gp' });
    expect(list.map(e => e.name)).toEqual(['a.gp', 'b.gp']);
    expect(list.length).toBe(2);
  });

  it('caps the list', () => {
    let list = [];
    for (let i = 0; i < 25; i++) list = recentAdd(list, { name: 'f' + i + '.gp' }, 10);
    expect(list.length).toBe(10);
    expect(list[0].name).toBe('f24.gp');
  });

  it('ignores a nameless entry instead of storing junk', () => {
    expect(recentAdd([{ name: 'a.gp' }], null).map(e => e.name)).toEqual(['a.gp']);
    expect(recentAdd([{ name: 'a.gp' }], {}).map(e => e.name)).toEqual(['a.gp']);
  });

  it('survives a corrupt stored list', () => {
    expect(recentAdd('not an array', { name: 'a.gp' })).toEqual([{ name: 'a.gp' }]);
  });
});

describe('extensions', () => {
  it('extracts the extension, lowercased', () => {
    expect(extensionOf('song.GP5')).toBe('gp5');
    expect(extensionOf('my.band/song.gomidas')).toBe('gomidas');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('')).toBe('');
  });
});
