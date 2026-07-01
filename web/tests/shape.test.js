// shapeNote — articulation -> played velocity/duration. These multipliers are what make
// dead/palm-mute/ghost/accent notes actually sound different; easy to silently regress.
import { describe, it, expect } from 'vitest';
import C from '../core/gomidas-core.js';

const VEL = 0.8, DUR = 960;   // a quarter note at mf
const shape = (note) => C.shapeNote(note, VEL, DUR);

describe('shapeNote', () => {
  it('a plain note is unchanged', () => {
    expect(shape({})).toEqual({ vel: 0.8, dur: 960 });
  });

  it('dead note: quiet + very short thunk', () => {
    const { vel, dur } = shape({ isDead: true });
    expect(vel).toBeCloseTo(0.48, 10);   // 0.8 * 0.6
    expect(dur).toBe(115);               // round(960 * 0.12)
  });

  it('palm mute: softer + shorter', () => {
    const { vel, dur } = shape({ isPalmMute: true });
    expect(vel).toBeCloseTo(0.68, 10);   // 0.8 * 0.85
    expect(dur).toBe(432);               // round(960 * 0.45)
  });

  it('dead wins over palm mute (mutually exclusive branch)', () => {
    expect(shape({ isDead: true, isPalmMute: true }).dur).toBe(115);
  });

  it('staccato halves the (already-shaped) duration', () => {
    expect(shape({ isStaccato: true }).dur).toBe(480);
    // dead(115) then staccato -> round(57.5) = 58
    expect(shape({ isDead: true, isStaccato: true }).dur).toBe(58);
  });

  it('ghost note is much quieter', () => {
    expect(shape({ isGhost: true }).vel).toBeCloseTo(0.44, 10);   // 0.8 * 0.55
  });

  it('accents boost velocity, clamped to 1.0', () => {
    expect(shape({ accentuated: 1 }).vel).toBeCloseTo(0.92, 10);  // 0.8 * 1.15
    expect(shape({ accentuated: 2 }).vel).toBe(1);                // 0.8 * 1.3 -> clamp
  });

  it('legato (hammer/pull destination) is softer, not picked', () => {
    expect(shape({ isHammerPullDestination: true }).vel).toBeCloseTo(0.56, 10);  // 0.8 * 0.7
  });

  it('composes ghost then accent in order', () => {
    // ghost first (0.44), then heavy accent (*1.3, clamped): 0.44 * 1.3 = 0.572
    expect(shape({ isGhost: true, accentuated: 2 }).vel).toBeCloseTo(0.572, 10);
  });

  it('duration never drops below 1 tick', () => {
    expect(C.shapeNote({ isDead: true }, 0.8, 2).dur).toBe(1);   // round(0.24)=0 -> clamped
  });
});
