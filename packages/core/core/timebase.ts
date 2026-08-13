// Gomidas — timebase + scheduler window selection (GMD-33, docs/WEB_PORT.md §7).
//
// Pure logic, no AudioContext, no DOM — per §9 the audio-graph layer stays thin and everything
// worth getting right lives here where Vitest can reach it. Off-by-one errors in this file are
// audible as dropped or doubled notes.
//
// No top-level import/export: this must emit as a plain <script> global. See web/tsconfig.json.

// SCOPE NOTE: the whole file body is wrapped in an IIFE. These emit as plain <script> files, so
// every top-level `const`/`function` would otherwise be a GLOBAL and collide across files —
// app.js:7 already declares a global `const PPQ`, which is exactly the collision this avoids.
// Nothing escapes except the published object below.
(function () {
/** Matches alphaTab and the native engine. Do not change without changing both. */
const PPQ = 960;

/**
 * Seconds per tick at a given tempo and practice rate.
 *
 * `rate` is the practice-speed multiplier (0.25..1.5): 0.5 = half speed. It scales TEMPO, not
 * sample playback, which is why slow-down is pitch-independent for free — the same reason the
 * native engine gets it free (§7.2).
 */
function secondsPerTick(bpm: number, rate: number = 1, ppq: number = PPQ): number {
  const safeBpm = bpm > 0 ? bpm : 120;
  const safeRate = rate > 0 ? rate : 1;
  return 60 / (safeBpm * ppq * safeRate);
}

function tickToSeconds(tick: number, bpm: number, rate: number = 1, ppq: number = PPQ): number {
  return tick * secondsPerTick(bpm, rate, ppq);
}

function secondsToTick(seconds: number, bpm: number, rate: number = 1, ppq: number = PPQ): number {
  return seconds / secondsPerTick(bpm, rate, ppq);
}

interface WindowSelection {
  /** Indices into the sequence, in order. */
  events: number[][];
  /** Where the next scan resumes. */
  nextIndex: number;
}

/**
 * Events whose tick falls in the HALF-OPEN range [fromTick, toTick).
 *
 * Half-open matters: consecutive scheduler windows must not overlap at the boundary or a note
 * landing exactly on it plays twice. `startIndex` is the running cursor — the list is sorted by
 * tick, so scanning never restarts from 0.
 *
 * Events at a fractional tick are included normally; buildSequence uses fractional ticks
 * deliberately (a pitch-bend reset at `tick - 0.25` sorts before the next note-on).
 */
function selectWindow(events: number[][], fromTick: number, toTick: number, startIndex: number = 0): WindowSelection {
  const out: number[][] = [];
  let i = Math.max(0, startIndex);
  // Skip anything already behind the window (a seek can jump the cursor backwards).
  while (i < events.length && events[i][0] < fromTick) i++;
  while (i < events.length && events[i][0] < toTick) { out.push(events[i]); i++; }
  return { events: out, nextIndex: i };
}

/** First index whose tick is >= tick. Used after a seek to reposition the cursor. */
function indexAtOrAfter(events: number[][], tick: number): number {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid][0] < tick) lo = mid + 1; else hi = mid;
  }
  return lo;
}

interface LoopRange { start: number; end: number }

/** A loop is active only when both ends are set and the range is non-empty (native uses -1/-1 to clear). */
function loopActive(loop: LoopRange | null): boolean {
  return !!loop && loop.start >= 0 && loop.end > loop.start;
}

/**
 * Map a play-position tick onto the loop, for positions at or past the loop end.
 *
 * Uses modulo rather than a single subtraction so a long scheduling window, or a stall that
 * skips past a whole repetition, still lands in the right place instead of drifting.
 */
function wrapTick(tick: number, loop: LoopRange | null): number {
  if (!loopActive(loop) || tick < loop!.end) return tick;
  const span = loop!.end - loop!.start;
  return loop!.start + ((tick - loop!.start) % span);
}

/**
 * Split a scheduling window at the loop boundary.
 *
 * Returns the segments to schedule in play order, each already expressed in SEQUENCE ticks plus
 * the tick offset to add when converting to a context time. Without this, notes in the bar after
 * the loop end get scheduled and you hear past the loop point.
 */
function windowSegments(fromTick: number, toTick: number, loop: LoopRange | null):
    Array<{ from: number; to: number; offset: number }> {
  if (!loopActive(loop)) return [{ from: fromTick, to: toTick, offset: 0 }];
  const { start, end } = loop!;
  const span = end - start;
  const segments: Array<{ from: number; to: number; offset: number }> = [];
  let cursor = fromTick;
  let offset = 0;
  // Guard the iteration: a window longer than several loop spans means something is badly wrong
  // (a stalled tab, a pathological loop), and an unbounded loop here would hang the page.
  let guard = 0;
  while (cursor < toTick && guard++ < 64) {
    const segEnd = Math.min(toTick, end);
    if (segEnd > cursor) segments.push({ from: cursor, to: segEnd, offset });
    if (segEnd >= end) { cursor = start; offset += span; } else break;
    // toTick is on the un-wrapped timeline; pull it back by the span we just consumed.
    toTick -= span;
  }
  return segments;
}

  const api = { PPQ, secondsPerTick, tickToSeconds, secondsToTick, selectWindow, indexAtOrAfter,
    loopActive, wrapTick, windowSegments };
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') (window as any).GomidasTimebase = api;
}());
