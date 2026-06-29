// Gomidas — built-in drum groove library + helpers.
// A groove is a set of 16-step (one 4/4 bar) lanes. Lane keys map to GM percussion keys.
// Step flag: 0 = silent, 1 = normal hit, 2 = accent, 3 = ghost.
(function () {
  const LANE_MIDI = {
    crash: 49, china: 52, ride: 51, hhopen: 46, hihat: 42,
    tom1: 48, tom2: 47, floor: 43, snare: 38, kick: 36
  };
  // Display order (top→bottom) for the step-grid editor + card previews.
  const LANE_ORDER = ['crash', 'ride', 'hihat', 'hhopen', 'tom1', 'tom2', 'snare', 'floor', 'kick'];
  const LANE_LABEL = {
    crash: 'Crash', china: 'China', ride: 'Ride', hhopen: 'HH Open', hihat: 'Hi-Hat',
    tom1: 'Tom 1', tom2: 'Tom 2', floor: 'Floor', snare: 'Snare', kick: 'Kick'
  };

  // Shorthand: build a 16-step lane from step indices (with optional accents/ghosts).
  function L(on, accents, ghosts) {
    const a = new Array(16).fill(0);
    (on || []).forEach(i => { a[i] = 1; });
    (accents || []).forEach(i => { a[i] = 2; });
    (ghosts || []).forEach(i => { a[i] = 3; });
    return a;
  }
  const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14];
  const SIXTEENTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

  // Each groove: { name, category, lanes:{lane:[16]} } (single 4/4 bar).
  const GROOVES = [
    { name: 'Straight 8ths', category: 'Pop Punk', lanes: {
      hihat: L(EIGHTHS), snare: L([4, 12]), kick: L([0, 8]) } },
    { name: 'Half-Time Feel', category: 'Pop Punk', lanes: {
      hihat: L(EIGHTHS), snare: L([8]), kick: L([0, 10]) } },
    { name: 'Punk Rock', category: 'Pop Punk', lanes: {
      hihat: L(EIGHTHS, [0, 8]), snare: L([4, 12]), kick: L([0, 2, 8, 10]) } },
    { name: 'Double Kick 16ths', category: 'Metal', lanes: {
      crash: L([0]), ride: L(EIGHTHS), snare: L([4, 12], [4, 12]), kick: L(SIXTEENTHS) } },
    { name: 'Skank Beat', category: 'Metal', lanes: {
      hihat: L(EIGHTHS), snare: L([2, 6, 10, 14]), kick: L([0, 4, 8, 12]) } },
    { name: 'Blast Beat', category: 'Blast Beats', lanes: {
      hihat: L([0, 2, 4, 6, 8, 10, 12, 14]),
      snare: L([0, 2, 4, 6, 8, 10, 12, 14]),
      kick: L([1, 3, 5, 7, 9, 11, 13, 15]) } },
    { name: 'Bomb Blast', category: 'Blast Beats', lanes: {
      ride: L(SIXTEENTHS), snare: L([0, 4, 8, 12], [0, 8]), kick: L([2, 6, 10, 14]) } },
    { name: 'Godlike Gravity', category: 'Godlike', lanes: {
      ride: L(SIXTEENTHS, [0, 8]),
      snare: L([1, 3, 5, 7, 9, 11, 13, 15], null, [1, 5, 9, 13]),
      kick: L([0, 2, 4, 6, 8, 10, 12, 14]) } },
    { name: 'Tom Fill 1', category: 'Fills', lanes: {
      tom1: L([0, 1]), tom2: L([4, 5]), floor: L([8, 9, 12, 13]), snare: L([2, 3, 6, 7]),
      crash: L([14]), kick: L([14]) } },
    { name: 'Snare Roll Fill', category: 'Fills', lanes: {
      snare: L([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [0, 4, 8, 12]),
      crash: L([15]), kick: L([0]) } }
  ];

  const CATEGORIES = ['User Grooves', 'Pop Punk', 'Metal', 'Godlike', 'Blast Beats', 'Fills'];

  // A tiny dot-grid preview model (3 lanes × 16) for the cards: hihat/ride, snare, kick.
  function previewLanes(g) {
    const top = g.lanes.hihat || g.lanes.ride || g.lanes.crash || new Array(16).fill(0);
    return { top, snare: g.lanes.snare || new Array(16).fill(0), kick: g.lanes.kick || new Array(16).fill(0) };
  }

  // Load any user-saved grooves (captured via "Add Pattern") from localStorage.
  try {
    const saved = JSON.parse(localStorage.getItem('gomidasUserGrooves') || '[]');
    saved.forEach(g => { if (g && g.name && g.lanes) GROOVES.push({ name: g.name, category: 'User Grooves', lanes: g.lanes }); });
  } catch (e) {}

  function addUserGroove(name, lanes) {
    // keep only non-empty lanes, trimmed to 16 steps
    const clean = {};
    for (const k in lanes) if (LANE_MIDI[k] && lanes[k].some(v => v)) clean[k] = lanes[k].slice(0, 16);
    const existing = GROOVES.find(g => g.name === name && g.category === 'User Grooves');
    if (existing) existing.lanes = clean;
    else GROOVES.push({ name, category: 'User Grooves', lanes: clean });
    try {
      const all = GROOVES.filter(g => g.category === 'User Grooves').map(g => ({ name: g.name, lanes: g.lanes }));
      localStorage.setItem('gomidasUserGrooves', JSON.stringify(all));
    } catch (e) {}
  }

  window.GomidasGrooves = {
    LANE_MIDI, LANE_ORDER, LANE_LABEL, GROOVES, CATEGORIES, previewLanes, addUserGroove,
    byCategory(cat) { return GROOVES.filter(g => g.category === cat); },
    find(name) { return GROOVES.find(g => g.name === name) || null; }
  };
})();
