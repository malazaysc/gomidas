// Mixer gain/pan resolution — solo-overrides-mute and the volume/pan precedence chain.
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const { anyTrackSoloed, computeChannelMix } = C;

describe('anyTrackSoloed', () => {
  const tracks = [{}, {}, {}];
  it('false when no track is soloed', () => {
    expect(anyTrackSoloed(tracks, {})).toBe(false);
    expect(anyTrackSoloed(tracks, { 1: { muted: true } })).toBe(false);
  });
  it('true when any track is soloed', () => {
    expect(anyTrackSoloed(tracks, { 2: { soloed: true } })).toBe(true);
  });
});

describe('computeChannelMix', () => {
  const track = (pb) => ({ playbackInfo: pb || {} });

  it('derives base volume from the file when no flag override', () => {
    const { gain, pan } = computeChannelMix(track({ volume: 12, balance: 8 }), {}, false);
    expect(gain).toBe(0.75);   // 12/16
    expect(pan).toBe(0.5);     // 8/16 centre
  });

  it('defaults volume to 12/16 and pan to centre with no info', () => {
    const { gain, pan } = computeChannelMix(track({}), {}, false);
    expect(gain).toBe(0.75);
    expect(pan).toBe(0.5);
  });

  it('an explicit flag volume wins over the file', () => {
    expect(computeChannelMix(track({ volume: 4 }), { vol: 1.0 }, false).gain).toBe(1.0);
  });

  it('mute silences the channel', () => {
    expect(computeChannelMix(track({ volume: 12 }), { muted: true }, false).gain).toBe(0);
  });

  it('solo overrides mute: a soloed+muted track is audible', () => {
    const flag = { muted: true, soloed: true };
    expect(computeChannelMix(track({ volume: 12 }), flag, true).gain).toBe(0.75);
  });

  it('with any solo active, a non-soloed track is silenced', () => {
    expect(computeChannelMix(track({ volume: 12 }), {}, true).gain).toBe(0);
  });

  it('clamps gain to [0, 1.5]', () => {
    expect(computeChannelMix(track({}), { vol: 9 }, false).gain).toBe(1.5);
    expect(computeChannelMix(track({}), { vol: -3 }, false).gain).toBe(0);
  });

  it('pan precedence: flag > file balance > centre, clamped to [0,1]', () => {
    expect(computeChannelMix(track({ balance: 16 }), { pan: 0.2 }, false).pan).toBe(0.2);
    expect(computeChannelMix(track({ balance: 4 }), {}, false).pan).toBe(0.25);
    expect(computeChannelMix(track({ balance: 99 }), {}, false).pan).toBe(1);
    expect(computeChannelMix(track({}), { pan: -1 }, false).pan).toBe(0);
  });
});
