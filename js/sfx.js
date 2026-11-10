// Soundeffekte, im Browser erzeugt (keine Audiodateien nötig).
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('qa-mute') === '1'; } catch (e) { /* egal */ }

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, type = 'sine', vol = 0.2, slideTo = null) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

const SOUNDS = {
  start: () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.2, 'triangle', 0.18)),
  tick: () => tone(1000, 0, 0.05, 'square', 0.05),
  end: () => tone(330, 0, 0.6, 'sawtooth', 0.12, 110),
  reveal: () => { tone(392, 0, 0.12, 'triangle', 0.18); tone(523, 0.12, 0.3, 'triangle', 0.2); },
  buzz: () => { tone(140, 0, 0.5, 'square', 0.22); tone(146, 0, 0.5, 'sawtooth', 0.14); },
  right: () => [659, 880, 1175].forEach((f, i) => tone(f, i * 0.08, 0.25, 'triangle', 0.2)),
  wrong: () => { tone(311, 0, 0.22, 'square', 0.14); tone(207, 0.22, 0.45, 'square', 0.14); },
  joker: () => { tone(300, 0, 0.35, 'sine', 0.2, 1400); tone(600, 0.1, 0.3, 'triangle', 0.1, 2000); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3, 'triangle', 0.2)); tone(1047, 0.5, 0.8, 'triangle', 0.18); },
  join: () => tone(880, 0, 0.14, 'sine', 0.1, 1320),
};

export function sfx(name) {
  if (muted) return;
  try { if (SOUNDS[name]) SOUNDS[name](); } catch (e) { /* Ton ist nicht kritisch */ }
}

export const isMuted = () => muted;
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('qa-mute', muted ? '1' : '0'); } catch (e) { /* egal */ }
  return muted;
}

// Browser erlauben Ton erst nach einer Nutzeraktion.
export function unlockAudio() { try { ac(); } catch (e) { /* egal */ } }
