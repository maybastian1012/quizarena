// Spielleiter-Ansicht (Laptop/TV): steuert den ganzen Abend.
import { kvGet, kvSet, kvDel } from './store.js';
import { createHost } from './net.js';
import {
  correctText, formatNumber, uid, orderIndices, JOKERS, isBuzzType, isTextType, textMatches, hiloHigher,
  filledHints, QUESTION_TYPES, TYPE_ICONS, questionLabel,
} from './model.js';
import { $, $$, esc, toast, confetti, avatar, fitText, PLAYER_COLORS, OPTION_COLORS, OPTION_LETTERS } from './ui.js';
import { hydrateMedia } from './media.js';
import { sfx, isMuted, toggleMute, unlockAudio } from './sfx.js';

/* global QRCode */

let S = null;           // Zustand des Abends (wird gespeichert)
let net = null;
let netStatus = 'connecting';
let saveTimer = null;
let intervals = [];
let editScores = false;
let manualSel = new Set();
let fx = null;          // einmaliger Effekt beim nächsten Rendern
let keyHandler = null;
let lastTick = null;
let manualEndPlayed = false;
let lastHints = -1;     // zuletzt angezeigte Zahl an Hinweisen
let previewMode = false;

const EXTRA_MS = 10000;  // Zusatzzeit-Joker
const GRACE_MS = 400;    // Toleranz für Antworten kurz vor Schluss
const SUSPENSE_S = 1.9;  // Dauer des 3-2-1 vor der Auflösung (nur Optik)
const GM_PASSWORD = '12345'; // Schutz vor versehentlichem Spielleiter-Login (kein echter Zugriffsschutz)
const UNDO_MAX = 25;
let undoStack = [];      // Schnappschüsse für „Rückgängig“ (nur im Speicher)
let barTimer = null;
let barPinned = false;

// ---------------------------------------------------------------- Start / Ende

export function createSession(quiz, mode, jokers = {}) {
  return {
    v: 3,
    id: uid(),
    code: null,
    quiz: JSON.parse(JSON.stringify(quiz)),
    mode,                       // 'single' | 'team'
    createdAt: Date.now(),
    players: {}, order: [], kicked: {},
    totals: {},                 // Spielpunkte aus den Vorrunden
    results: quiz.games.map(() => null),
    jokerCfg: { double: jokers.double || 0, fifty: jokers.fifty || 0, time: jokers.time || 0 },
    jl: {},                     // verbleibende Joker je Spieler
    phase: 'lobby', showStep: 0, ready: {},
    game: null, q: null, tie: null, final: null, manualTimer: null,
    usedTie: [], champion: null, stats: {},
  };
}

export async function startHost(root, makeCode) {
  S = await kvGet('session');
  if (!S) { location.hash = ''; return; }
  if (!S.code) { S.code = makeCode(); save(); }
  S.jokerCfg = S.jokerCfg || { double: 0, fifty: 0, time: 0 };
  S.jl = S.jl || {};
  S.ready = S.ready || {};
  S.stats = S.stats || {};
  S.gms = {}; // Spielleiter-Handys melden sich nach dem Neuladen mit Passwort neu an
  undoStack = [];
  document.body.classList.add('stage-mode');
  root.innerHTML = '<div class="stage" id="stage"></div><div class="controls" id="controls"></div>';

  net = createHost(S.code, { onMessage, onLeave, onStatus });
  intervals.push(setInterval(() => [...S.order, ...Object.keys(S.gms || {})].forEach(pid => net.send(pid, { t: 'ping' })), 4000));
  intervals.push(setInterval(onTick, 200));

  keyHandler = e => {
    unlockAudio();
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      const b = $('#primary');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    } else if (k === 'f') toggleFullscreen();
    else if (k === 'm') command('mute');
    else if (k === 'h') { barPinned = !barPinned; showBar(); }
    else if (k === 'z' && (e.ctrlKey || e.metaKey)) command('undo');
    else if (k === 'r' && buzzPending()) command('buzzRight');
    else if (k === 'x' && buzzPending()) command('buzzWrong');
  };
  document.addEventListener('keydown', keyHandler);
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('mousemove', showBar);
  window.addEventListener('resize', onResize);
  render();
}

export function stopHost() {
  intervals.forEach(clearInterval);
  intervals = [];
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  document.removeEventListener('mousemove', showBar);
  window.removeEventListener('resize', onResize);
  if (net) net.destroy();
  net = null;
  const ov = $('#qr-ov'); if (ov) ov.remove();
  document.body.classList.remove('stage-mode', 'gm-on', 'show-bar');
}

function onResize() { const st = $('#stage'); if (st) fitText(st); }

// Steuerleiste am Laptop: ausgeblendet, solange ein Spielleiter-Handy steuert; Maus oder H holt sie zurück.
function showBar() {
  document.body.classList.add('show-bar');
  clearTimeout(barTimer);
  if (!barPinned) barTimer = setTimeout(() => document.body.classList.remove('show-bar'), 3000);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('session', S).catch(e => toast('Speichern fehlgeschlagen: ' + e.message)), 250);
}

function update() { if (previewMode) return; save(); render(); broadcast(); }

// ---------------------------------------------------------------- Rückgängig

function pushUndo(label) {
  undoStack.push({ label, at: Date.now(), state: JSON.stringify(S) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) { toast('Nichts zum Rückgängigmachen'); return; }
  const gms = S.gms;
  S = JSON.parse(snap.state);
  S.gms = gms;
  if (S.phase === 'q' && S.q && S.q.start && !S.q.pausedAt) S.q.start += Date.now() - snap.at;
  lastStageKey = null;
  manualSel = new Set();
  toast('↶ Rückgängig gemacht');
  update();
}

// ---------------------------------------------------------------- Hilfen

const T = () => S.mode === 'team' ? { one: 'Team', many: 'Teams' } : { one: 'Spieler', many: 'Spieler' };
const pids = () => S.order.filter(id => S.players[id] && !S.kicked[id]);
const P = pid => S.players[pid] || { name: '?', color: '#888' };
const nameOf = pid => P(pid).name;
const curGame = () => (S.game ? S.quiz.games[S.game.idx] : null);
const connected = pid => !!(net && net.isConnected(pid));
const listNames = ids => ids.map(nameOf).join(' und ').replace(/ und (?=.* und )/g, ', ');
const pointsLabel = n => `${n} ${Number(n) === 1 ? 'Punkt' : 'Punkte'}`;
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const hero = (inner, cls = '') => `<div class="hero ${cls}"><div class="hero-ring"></div><div class="hero-in">${inner}</div></div>`;

function chip(pid, extra = '', suffix = '') {
  return `<span class="chip ${extra}">${avatar(P(pid), 'sm')}<span class="cn">${esc(nameOf(pid))}</span>${suffix}</span>`;
}

function nextUnplayed() { return S.results.findIndex(r => !r); }
function rankedByTotals() { return pids().slice().sort((a, b) => (S.totals[b] || 0) - (S.totals[a] || 0)); }

// Zeitfenster einer Frage (mit Zusatzzeit-Joker und Pause)
const nowQ = () => (S.q && S.q.pausedAt) || Date.now();
const qEnd = () => S.q.start + S.q.dur;
const endFor = pid => qEnd() + ((S.q.extra && S.q.extra[pid]) || 0);
const openFor = pid => !!(S.q && S.q.start && !S.q.locked && nowQ() <= endFor(pid) + GRACE_MS);
const buzzPending = () => !!(S && S.phase === 'q' && S.q && S.q.buzz && !S.q.buzzResult);

function hintsShown() {
  const q = S.q;
  if (!q || q.question.type !== 'hint') return 0;
  const n = filledHints(q.question).length;
  if (S.phase === 'reveal') return n;
  if (!q.start) return Math.min(n, 1 + (q.hintBonus || 0));
  const every = (Number(q.question.hintEvery) || 0) * 1000;
  const auto = every > 0 ? 1 + Math.floor((nowQ() - q.start) / every) : 1;
  return Math.min(n, auto + (q.hintBonus || 0));
}

function stat(pid) {
  S.stats[pid] = S.stats[pid] || { answered: 0, correct: 0, ms: [], est: 0, buzzRight: 0, buzzWrong: 0 };
  return S.stats[pid];
}

function banner(text, color = 'var(--accent)') {
  if (previewMode) return;
  const el = document.createElement('div');
  el.className = 'banner';
  el.style.color = color;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

function stopMedia() {
  $$('#stage video, #stage audio').forEach(m => { try { m.pause(); } catch (e) { /* egal */ } });
  const yt = $('#yt');
  if (yt && yt.contentWindow) yt.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
}

// ---------------------------------------------------------------- Netzwerk

function onStatus(st) { netStatus = st; renderControls(); }
function onLeave() { renderSoft(); }

function onMessage(pid, msg) {
  if (msg.t === 'hello' && msg.role === 'gm') {
    if (String(msg.pw || '') !== GM_PASSWORD) {
      net.send(pid, { t: 'gmDenied' });
      setTimeout(() => net.drop(pid), 300);
      return;
    }
    S.gms[pid] = { id: pid, since: Date.now() };
    toast('🎙 Spielleiter-Handy verbunden');
    update();
    return;
  }
  if (msg.t === 'cmd') {
    if (S.gms[pid]) gmCommand(msg.c, msg.arg);
    return;
  }
  if (msg.t === 'hello') {
    if (S.kicked[pid]) { net.send(pid, { t: 'kicked' }); setTimeout(() => net.drop(pid), 300); return; }
    const photo = typeof msg.photo === 'string' && msg.photo.startsWith('data:image/') && msg.photo.length < 120000 ? msg.photo : null;
    if (!S.players[pid]) {
      let name = String(msg.name || '').trim().slice(0, 24) || `${T().one} ${S.order.length + 1}`;
      const taken = new Set(pids().map(nameOf));
      let n = 2; const base = name;
      while (taken.has(name)) name = `${base} ${n++}`;
      const color = PLAYER_COLORS[S.order.length % PLAYER_COLORS.length];
      S.players[pid] = { id: pid, name, color, photo };
      S.order.push(pid);
      S.totals[pid] = S.totals[pid] || 0;
      S.jl[pid] = { ...S.jokerCfg };
      if (S.final) initFinalPlayer(pid);
      if (S.phase === 'lobby') { toast(`${name} ist beigetreten`); sfx('join'); }
    } else if (photo && !S.players[pid].photo) {
      S.players[pid].photo = photo;
    }
    if (!S.jl[pid]) S.jl[pid] = { ...S.jokerCfg };
    update();
    return;
  }
  if (msg.t === 'answer') handleAnswer(pid, msg.qid, msg.value);
  if (msg.t === 'buzz') handleBuzz(pid, msg.qid);
  if (msg.t === 'joker') handleJoker(pid, msg.kind, msg.qid);
  if (msg.t === 'ready' && S.phase === 'rehearsal' && S.players[pid]) { S.ready[pid] = true; sfx('join'); update(); }
  if (msg.t === 'photo' && S.players[pid] && typeof msg.photo === 'string' && msg.photo.startsWith('data:image/') && msg.photo.length < 120000) {
    S.players[pid].photo = msg.photo; update();
  }
}

function broadcast() {
  if (!net) return;
  pids().forEach(pid => net.send(pid, { t: 'view', v: viewFor(pid) }));
  const gmIds = Object.keys(S.gms || {});
  if (gmIds.length) {
    const gv = gmView();
    gmIds.forEach(pid => net.send(pid, { t: 'gm', v: gv }));
  }
}

// ---------------------------------------------------------------- Show-Intro & Generalprobe

function startShow() { S.phase = 'show'; S.showStep = 0; update(); }

function showNext() {
  if (S.showStep < pids().length) { S.showStep++; sfx('join'); return update(); }
  S.phase = 'rehearsal';
  S.ready = {};
  update();
}

// ---------------------------------------------------------------- Fragen

function openQuestion(src, question, eligible) {
  const waiting = !!(question.media && question.mediaFirst);
  S.q = {
    src, question, eligible, answers: {}, start: waiting ? null : Date.now(),
    dur: (Number(question.time) || 20) * 1000, locked: false, result: null,
    fifty: {}, extra: {}, buzz: null, buzzResult: null, lockedOut: [], marks: {}, hintBonus: 0, pausedAt: null,
    shuffle: question.type === 'order' ? shuffle(orderIndices(question)) : null,
  };
  lastTick = null;
  lastHints = -1;
  S.phase = 'q';
  if (!waiting) sfx('start');
  update();
}

function releaseAnswers() {
  if (S.phase !== 'q' || !S.q || S.q.start) return;
  S.q.start = Date.now();
  sfx('start');
  update();
}

function lockQuestion(sound = true) {
  if (S.q.locked) return;
  S.q.locked = true;
  S.q.pausedAt = null;
  if (sound) sfx('end');
  update();
}

function resumeClock() {
  if (S.q && S.q.pausedAt) { S.q.start += Date.now() - S.q.pausedAt; S.q.pausedAt = null; }
}

function handleAnswer(pid, qid, value) {
  const q = S.q;
  if (S.phase !== 'q' || !q || q.question.id !== qid || isBuzzType(q.question)) return;
  if (!q.eligible.includes(pid) || q.answers[pid] || !openFor(pid)) return;
  const qu = q.question;
  let v = value;
  if (isTextType(qu)) {
    v = String(v || '').trim().slice(0, 80);
    if (!v) return;
    q.marks[pid] = textMatches(qu, v); // Vorschlag – der Spielleiter kann ändern
  } else if (qu.type === 'mc') { v = Number(v); if (!Number.isInteger(v) || !String(qu.options[v] || '').trim()) return; }
  else if (qu.type === 'tf' || qu.type === 'hilo') { if (typeof v !== 'boolean') return; }
  else if (qu.type === 'order') {
    const valid = orderIndices(qu);
    if (!Array.isArray(v) || v.length !== valid.length || [...v].sort((a, b) => a - b).join() !== valid.join()) return;
    v = v.map(Number);
  } else { v = Number(v); if (!Number.isFinite(v)) return; }
  q.answers[pid] = { v, ms: Date.now() - q.start };
  const waiting = q.eligible.filter(id => connected(id) && !q.answers[id]);
  if (!waiting.length) { q.locked = true; q.pausedAt = null; }
  update();
}

function handleBuzz(pid, qid) {
  const q = S.q;
  if (S.phase !== 'q' || !q || q.question.id !== qid || !isBuzzType(q.question)) return;
  if (!q.start || q.locked || q.buzz || q.pausedAt || !q.eligible.includes(pid) || q.lockedOut.includes(pid)) return;
  q.buzz = pid;
  q.buzzAt = Date.now() - q.start;
  if (q.question.type === 'buzzer') q.locked = true;
  else q.pausedAt = Date.now(); // Hinweis/Bild: Uhr und Aufdecken anhalten, bis gewertet ist
  stopMedia();
  sfx('buzz');
  banner(`🔔 ${nameOf(pid)}`, P(pid).color);
  update();
}

function judgeBuzz(right) {
  if (!buzzPending()) return;
  const q = S.q, pid = q.buzz;
  sfx(right ? 'right' : 'wrong');
  if (q.question.type === 'buzzer') {
    q.buzzResult = right ? 'right' : 'wrong';
    if (!right) stat(pid).buzzWrong++;
    return reveal();
  }
  if (right) {
    q.buzzResult = 'right';
    resumeClock();
    return reveal();
  }
  // Hinweis/Bild: falsch geraten -> für diese Frage raus, die anderen raten weiter
  stat(pid).buzzWrong++;
  q.lockedOut.push(pid);
  q.buzz = null;
  resumeClock();
  banner(`✗ ${nameOf(pid)} ist raus`, 'var(--bad)');
  if (!q.eligible.some(id => !q.lockedOut.includes(id))) q.locked = true;
  update();
}

function handleJoker(pid, kind, qid) {
  const left = S.jl[pid];
  if (!left || !(left[kind] > 0) || !JOKERS[kind]) return;
  if (kind === 'double') {
    if (S.phase !== 'intro' || !S.game) return;
    S.game.doubled = S.game.doubled || {};
    if (S.game.doubled[pid]) return;
    S.game.doubled[pid] = true;
    banner(`⚡ ${nameOf(pid)} verdoppelt!`, P(pid).color);
  } else {
    const q = S.q;
    if (S.phase !== 'q' || !q || q.question.id !== qid || q.src === 'tie') return;
    if (!q.eligible.includes(pid) || q.answers[pid] || !openFor(pid)) return;
    if (kind === 'fifty') {
      if (q.question.type !== 'mc' || q.fifty[pid]) return;
      const wrong = q.question.options.map((t, i) => ({ t, i })).filter(o => String(o.t).trim() && o.i !== q.question.correct).map(o => o.i);
      const k = Math.floor((wrong.length + 1) / 2);
      if (k < 1) return;
      q.fifty[pid] = shuffle(wrong).slice(0, k);
      banner(`½ ${nameOf(pid)}: 50:50`, P(pid).color);
    }
    if (kind === 'time') {
      if (isBuzzType(q.question) || q.extra[pid]) return;
      q.extra[pid] = EXTRA_MS;
      banner(`⏱ ${nameOf(pid)}: +10 Sekunden`, P(pid).color);
    }
  }
  left[kind]--;
  sfx('joker');
  update();
}

function pauseTimer() {
  if (S.phase !== 'q' || !S.q || !S.q.start || S.q.locked || S.q.pausedAt) return;
  S.q.pausedAt = Date.now();
  $$('#stage video, #stage audio').forEach(m => { try { m.pause(); } catch (e) { /* egal */ } });
  update();
}

function resumeTimer() {
  if (!S.q || !S.q.pausedAt || S.q.buzz) return;
  resumeClock();
  update();
}

function addTime(ms = 10000) {
  if (S.phase !== 'q' || !S.q || !S.q.start || S.q.locked) return;
  S.q.dur += ms;
  lastTick = null;
  banner('⏱ +10 Sekunden für alle');
  update();
}

function nextHint() {
  if (S.phase !== 'q' || !S.q || S.q.question.type !== 'hint') return;
  if (hintsShown() >= filledHints(S.q.question).length) return;
  S.q.hintBonus = (S.q.hintBonus || 0) + 1;
  update();
}

// Frage ohne Wertung überspringen
function skipQuestion() {
  if (!S.q || (S.phase !== 'q' && S.phase !== 'reveal')) return;
  stopMedia();
  const src = S.q.src;
  if (S.phase === 'reveal') return afterReveal();
  if (src === 'game') return nextGameQuestion();
  if (src === 'final') return nextFinalQuestion();
  if (src === 'tie') { S.phase = 'tie'; S.q = null; update(); }
}

function onTick() {
  if (!S || previewMode) return;
  if (S.phase === 'q' && S.q) {
    const q = S.q;
    if (q.question.type === 'reveal') drawPix();
    if (q.question.type === 'hint') {
      const n = hintsShown();
      if (n !== lastHints) { lastHints = n; if (q.start) update(); return; }
    }
    if (q.start && !q.locked && q.pausedAt) {
      const num = $('#tnum'); if (num) num.textContent = q.buzz ? '🔔' : '⏸';
      return;
    }
    if (q.start && !q.locked) {
      const now = Date.now();
      const main = qEnd() - now;
      if (main <= 0) {
        const extraPending = q.eligible.some(id => q.extra[id] && !q.answers[id] && now <= endFor(id));
        if (!extraPending) { lockQuestion(true); return; }
        const restExtra = Math.max(...q.eligible.filter(id => q.extra[id] && !q.answers[id]).map(id => endFor(id) - now));
        const num = $('#tnum'); if (num) num.textContent = '+' + Math.ceil(restExtra / 1000);
        const bar = $('#tbar'); if (bar) bar.style.transform = 'scaleX(0)';
        return;
      }
      const sec = Math.ceil(main / 1000);
      if (sec <= 5 && sec !== lastTick) { lastTick = sec; sfx('tick'); }
      const bar = $('#tbar'); const num = $('#tnum');
      if (bar) bar.style.transform = `scaleX(${Math.max(0, main / q.dur)})`;
      if (num) num.textContent = sec;
    }
  }
  if (S.phase === 'manual' && S.manualTimer) {
    const rest = S.manualTimer.end - Date.now();
    const el = $('#mtimer');
    const s = Math.max(0, Math.ceil(rest / 1000));
    if (el) {
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      el.classList.toggle('low', s <= 5 && s > 0);
    }
    if (s <= 5 && s > 0 && s !== lastTick) { lastTick = s; sfx('tick'); }
    if (s === 0 && !manualEndPlayed) { manualEndPlayed = true; sfx('end'); }
  }
}

// Bild aufdecken: Pixelgröße nimmt mit der Zeit ab
const pixImgs = new Map();
function pixLevel() {
  const q = S.q;
  if (!q || S.phase === 'reveal') return 1;
  if (!q.start) return 60;
  const p = Math.min(1, Math.max(0, (nowQ() - q.start) / q.dur));
  return Math.max(1, Math.round(60 * Math.pow(1 - p, 1.6)));
}

function drawPix(force = false) {
  const cv = $('#pix');
  if (!cv || !S.q) return;
  const qu = S.q.question;
  let img = pixImgs.get(qu.id);
  if (!img) {
    img = new Image();
    img.onload = () => drawPix(true);
    img.src = qu.image;
    pixImgs.set(qu.id, img);
    return;
  }
  if (!img.complete || !img.naturalWidth) return;
  const level = pixLevel();
  if (!force && cv.dataset.level === String(level)) return;
  cv.dataset.level = level;
  const sc = Math.min(1, 1200 / img.naturalWidth);
  const cw = Math.round(img.naturalWidth * sc), ch = Math.round(img.naturalHeight * sc);
  if (cv.width !== cw) { cv.width = cw; cv.height = ch; }
  const ctx = cv.getContext('2d');
  if (level <= 1) { ctx.imageSmoothingEnabled = true; ctx.drawImage(img, 0, 0, cw, ch); return; }
  const sw = Math.max(1, Math.round(cw / level)), sh = Math.max(1, Math.round(ch / level));
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  tmp.getContext('2d').drawImage(img, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, cw, ch);
}

function isRight(qu, v) {
  if (qu.type === 'order') return Array.isArray(v) && v.join() === orderIndices(qu).join();
  if (qu.type === 'hilo') return v === hiloHigher(qu);
  return v === qu.correct;
}

function reveal() {
  const q = S.q, qu = q.question;
  q.locked = true;
  q.pausedAt = null;
  stopMedia();
  let winners = [];
  if (isBuzzType(qu)) {
    if (q.buzz && q.buzzResult === 'right') winners = [q.buzz];
  } else if (isTextType(qu)) {
    winners = Object.keys(q.answers).filter(pid => q.marks[pid]);
  } else if (qu.type === 'estimate') {
    const arr = Object.entries(q.answers)
      .map(([pid, a]) => ({ pid, v: a.v, d: Math.abs(a.v - Number(qu.correct)), ms: a.ms }))
      .sort((a, b) => a.d - b.d || a.ms - b.ms);
    q.ranking = arr;
    if (arr.length) winners = arr.filter(x => x.d === arr[0].d).map(x => x.pid);
  } else {
    winners = Object.entries(q.answers).filter(([, a]) => isRight(qu, a.v)).map(([pid]) => pid);
  }
  q.result = { winners, penalty: qu.type === 'buzzer' && q.buzzResult === 'wrong' ? [q.buzz] : [] };
  // Statistik
  Object.keys(q.answers).forEach(pid => { stat(pid).answered++; });
  winners.forEach(pid => {
    const s = stat(pid);
    s.correct++;
    if (q.answers[pid] && q.answers[pid].ms != null) s.ms.push(q.answers[pid].ms);
    if (qu.type === 'estimate') s.est++;
    if (isBuzzType(qu)) s.buzzRight++;
  });
  if (q.src === 'game') {
    winners.forEach(pid => { S.game.correct[pid] = (S.game.correct[pid] || 0) + 1; });
    q.result.penalty.forEach(pid => { S.game.correct[pid] = (S.game.correct[pid] || 0) - 1; });
  }
  if (q.src === 'final') applyFinal(q, winners);
  S.phase = 'reveal';
  update();
}

function afterReveal() {
  const src = S.q.src;
  if (src === 'game') return nextGameQuestion();
  if (src === 'tie') return resolveTie();
  if (src === 'final') return afterFinalQuestion();
}

// ---------------------------------------------------------------- Vorrundenspiele

function revokeResult(idx) {
  const r = S.results[idx];
  if (!r) return;
  r.winners.forEach(pid => { S.totals[pid] = Math.max(0, (S.totals[pid] || 0) - (r.pts ? r.pts[pid] : r.points)); });
  S.results[idx] = null;
  S.finished = false;
  S.champion = null;
}

function startGame(idx) {
  if (!S.quiz.games[idx]) return;
  if (S.results[idx]) revokeResult(idx);
  S.prevTotals = { ...S.totals };
  S.game = { idx, qi: -1, correct: {}, standings: null, doubled: {} };
  S.tie = null; S.q = null; S.manualTimer = null;
  manualSel = new Set();
  S.phase = 'intro';
  update();
}

function beginGame() {
  const g = curGame();
  if (g.type === 'manual') { S.phase = 'manual'; update(); return; }
  nextGameQuestion();
}

function nextGameQuestion() {
  const g = curGame();
  S.game.qi++;
  if (S.game.qi < g.questions.length) return openQuestion('game', g.questions[S.game.qi], pids());
  finishGameQuestions();
}

// Direkt zu einer bestimmten Frage springen (Spielleiter-Handy „Ablauf“)
function gotoQuestion(g, qi) {
  stopMedia();
  if (g === 'final') {
    if (!S.quiz.final.enabled || !S.quiz.final.questions[qi]) return;
    if (!S.final) initFinalState();
    S.game = null; S.tie = null;
    S.final.qi = qi - 1;
    return nextFinalQuestion();
  }
  const game = S.quiz.games[g];
  if (!game || game.type !== 'quiz' || !game.questions[qi]) return;
  if (!S.game || S.game.idx !== g) {
    if (S.results[g]) revokeResult(g);
    S.prevTotals = { ...S.totals };
    S.game = { idx: g, qi: -1, correct: {}, standings: null, doubled: {} };
  }
  S.tie = null;
  S.game.qi = qi - 1;
  nextGameQuestion();
}

function finishGameQuestions() {
  const st = pids().map(pid => ({ pid, n: S.game.correct[pid] || 0 })).sort((a, b) => b.n - a.n);
  S.game.standings = st;
  if (!st.length) { S.phase = 'board'; update(); return; }
  const top = st.filter(x => x.n === st[0].n).map(x => x.pid);
  if (top.length === 1) awardGame(top);
  else { S.tie = { context: 'game', pids: top }; S.phase = 'tie'; update(); }
}

function awardGame(winners) {
  const g = curGame();
  const base = Number(g.points) || 0;
  const dbl = S.game.doubled || {};
  const pts = {};
  winners.forEach(pid => { pts[pid] = base * (dbl[pid] ? 2 : 1); S.totals[pid] = (S.totals[pid] || 0) + pts[pid]; });
  S.results[S.game.idx] = { winners, points: base, pts, doubled: Object.keys(dbl) };
  S.lastWinners = winners;
  S.tie = null;
  S.phase = 'gameEnd';
  fx = 'confetti';
  sfx('win');
  update();
}

// ---------------------------------------------------------------- Stechfrage

function pickTieQuestion() {
  const g = curGame();
  if (S.tie.context === 'game' && g && g.tiebreaker && !S.usedTie.includes(g.tiebreaker.id)) return g.tiebreaker;
  return S.quiz.tiebreakers.find(t => !S.usedTie.includes(t.id)) || null;
}

function startTie() {
  const q = pickTieQuestion();
  if (!q) { toast('Keine Stechfrage mehr vorhanden. Bitte den Sieger direkt auswählen.', 4000); return; }
  S.usedTie.push(q.id);
  openQuestion('tie', q, S.tie.pids.slice());
}

function resolveTie() {
  const w = S.q.result.winners;
  if (w.length === 1) return finishTie(w[0]);
  if (w.length > 1) S.tie.pids = w;
  S.phase = 'tie';
  update();
}

function finishTie(pid) {
  const ctx = S.tie.context;
  S.tie = null;
  if (ctx === 'game') awardGame([pid]);
  else setChampion(pid);
}

// ---------------------------------------------------------------- Finale

function initFinalPlayer(pid) {
  const f = S.quiz.final, F = S.final;
  if (F.scores[pid] !== undefined) return;
  const head = f.headStart ? (S.totals[pid] || 0) : 0;
  F.scores[pid] = f.winMode === 'elimination' ? 0 : head;
  F.lives[pid] = f.winMode === 'elimination' ? (Number(f.baseLives) || 0) + head : 0;
}

function initFinalState() {
  const f = S.quiz.final;
  S.final = { qi: -1, scores: {}, lives: {}, target: Number(f.target) || 10, targetRaised: false };
  pids().forEach(initFinalPlayer);
  if (f.winMode === 'target') {
    const maxStart = Math.max(0, ...pids().map(pid => S.final.scores[pid]));
    if (maxStart >= S.final.target) { S.final.target = maxStart + 1; S.final.targetRaised = true; }
  }
}

function startFinal() {
  if (!S.final) initFinalState(); // nach einem Sprung zurück bleibt der Finalstand erhalten
  S.game = null; S.tie = null; S.q = null;
  S.phase = 'finalIntro';
  update();
}

const alive = () => pids().filter(pid => (S.final.lives[pid] || 0) > 0);
const finalLimit = () => {
  const f = S.quiz.final;
  return f.winMode === 'count' ? Math.min(Number(f.count) || 0, f.questions.length) : f.questions.length;
};

function nextFinalQuestion() {
  const f = S.quiz.final;
  S.final.qi++;
  if (S.final.qi >= finalLimit()) return finalOutOfQuestions();
  const eligible = f.winMode === 'elimination' ? alive() : pids();
  openQuestion('final', f.questions[S.final.qi], eligible);
}

function applyFinal(q, winners) {
  const f = S.quiz.final, F = S.final;
  const elim = f.winMode === 'elimination';
  if (q.question.type === 'buzzer') {
    const wrong = q.result.penalty;
    if (elim) wrong.forEach(pid => { F.lives[pid] = Math.max(0, (F.lives[pid] || 0) - 1); });
    else {
      winners.forEach(pid => { F.scores[pid] = (F.scores[pid] || 0) + 1; });
      wrong.forEach(pid => { F.scores[pid] = Math.max(0, (F.scores[pid] || 0) - 1); });
    }
    q.result.lost = wrong;
    return;
  }
  if (!elim) {
    winners.forEach(pid => { F.scores[pid] = (F.scores[pid] || 0) + 1; });
    q.result.lost = [];
    return;
  }
  // Leben-Modus: falsch oder keine Antwort kostet ein Leben (Schätzfrage: wer am weitesten weg liegt).
  let losers;
  if (q.question.type === 'estimate') {
    const answered = q.ranking || [];
    const noAnswer = q.eligible.filter(pid => !q.answers[pid]);
    const maxD = answered.length ? answered[answered.length - 1].d : null;
    const far = answered.length > 1 ? answered.filter(x => x.d === maxD && !winners.includes(x.pid)).map(x => x.pid) : [];
    losers = [...new Set([...noAnswer, ...far])];
  } else if (isBuzzType(q.question)) {
    losers = q.lockedOut.slice(); // nur wer falsch gebuzzert hat
  } else {
    losers = q.eligible.filter(pid => !winners.includes(pid));
  }
  const survivors = q.eligible.filter(pid => !losers.includes(pid) || (F.lives[pid] || 0) > 1);
  if (!survivors.length) { q.result.lost = []; q.result.saved = true; return; }
  losers.forEach(pid => { F.lives[pid] = Math.max(0, (F.lives[pid] || 0) - 1); });
  q.result.lost = losers;
}

function afterFinalQuestion() {
  const f = S.quiz.final, F = S.final;
  if (f.winMode === 'elimination') {
    const a = alive();
    if (a.length === 1) return setChampion(a[0]);
  }
  if (f.winMode === 'target') {
    const reached = pids().filter(pid => F.scores[pid] >= F.target);
    if (reached.length) {
      const max = Math.max(...reached.map(pid => F.scores[pid]));
      const top = reached.filter(pid => F.scores[pid] === max);
      if (top.length === 1) return setChampion(top[0]);
      S.tie = { context: 'final', pids: top }; S.phase = 'tie'; return update();
    }
  }
  nextFinalQuestion();
}

function finalOutOfQuestions() {
  const f = S.quiz.final, F = S.final;
  const val = pid => (f.winMode === 'elimination' ? F.lives[pid] : F.scores[pid]) || 0;
  const list = pids();
  if (!list.length) return setChampion(null);
  const max = Math.max(...list.map(val));
  const top = list.filter(pid => val(pid) === max);
  if (top.length === 1) return setChampion(top[0]);
  S.tie = { context: 'final', pids: top };
  S.phase = 'tie';
  update();
}

// ---------------------------------------------------------------- Ende

function toFinish() {
  if (S.quiz.final.enabled && S.quiz.final.questions.length) return startFinal();
  const list = pids();
  if (!list.length) return setChampion(null);
  const max = Math.max(...list.map(pid => S.totals[pid] || 0));
  const top = list.filter(pid => (S.totals[pid] || 0) === max);
  if (top.length === 1) return setChampion(top[0]);
  S.tie = { context: 'overall', pids: top };
  S.phase = 'tie';
  update();
}

function setChampion(pid) {
  S.champion = pid;
  S.finished = true;
  S.phase = 'stats';
  update();
}

function toEnd() {
  S.phase = 'end';
  fx = 'confetti-long';
  sfx('win');
  update();
}

function finalRanking() {
  const F = S.final, f = S.quiz.final;
  const score = pid => F ? (f.winMode === 'elimination' ? F.lives[pid] : F.scores[pid]) || 0 : S.totals[pid] || 0;
  return pids().slice().sort((a, b) => (b === S.champion) - (a === S.champion) || score(b) - score(a) || (S.totals[b] || 0) - (S.totals[a] || 0));
}

// Auszeichnungen für die Statistik-Seite
function awards() {
  const list = pids();
  const st = pid => S.stats[pid] || { answered: 0, correct: 0, ms: [], est: 0, buzzRight: 0, buzzWrong: 0 };
  const best = (fn, filter = () => true, lowIsBetter = false) => {
    const c = list.filter(filter).map(pid => ({ pid, v: fn(pid) })).filter(x => Number.isFinite(x.v));
    if (!c.length) return null;
    c.sort((a, b) => lowIsBetter ? a.v - b.v : b.v - a.v);
    return c[0];
  };
  const out = [];
  const fast = best(pid => { const m = st(pid).ms; return m.length ? m.reduce((a, b) => a + b, 0) / m.length : NaN; }, pid => st(pid).ms.length >= 2, true);
  if (fast) out.push({ icon: '⚡', title: 'Blitzmerker', pid: fast.pid, value: `Ø ${(fast.v / 1000).toFixed(1)} s pro richtiger Antwort` });
  const acc = best(pid => st(pid).correct / st(pid).answered, pid => st(pid).answered >= 3);
  if (acc) out.push({ icon: '🎯', title: 'Treffsicher', pid: acc.pid, value: `${Math.round(acc.v * 100)} % richtig` });
  const most = best(pid => st(pid).correct, pid => st(pid).correct > 0);
  if (most) out.push({ icon: '🧠', title: 'Wissensriese', pid: most.pid, value: `${most.v} richtige Antworten` });
  const est = best(pid => st(pid).est, pid => st(pid).est > 0);
  if (est) out.push({ icon: '📏', title: 'Schätzkönig', pid: est.pid, value: `${est.v}× am nächsten dran` });
  const buzz = best(pid => st(pid).buzzRight, pid => st(pid).buzzRight > 0);
  if (buzz) out.push({ icon: '🔔', title: 'Buzzer-Ass', pid: buzz.pid, value: `${buzz.v}× richtig gebuzzert` });
  const jok = best(pid => Object.keys(S.jokerCfg).reduce((s, k) => s + (S.jokerCfg[k] - ((S.jl[pid] || {})[k] || 0)), 0), pid => !!S.jl[pid]);
  if (jok && jok.v > 0) out.push({ icon: '🃏', title: 'Joker-Fan', pid: jok.pid, value: `${jok.v} Joker eingesetzt` });
  const bad = best(pid => (st(pid).answered - st(pid).correct) + st(pid).buzzWrong, pid => st(pid).answered > 0);
  if (bad && bad.v > 0) out.push({ icon: '🍀', title: 'Pechvogel', pid: bad.pid, value: `${bad.v}× knapp daneben` });
  return out.slice(0, 6);
}

// ---------------------------------------------------------------- Ansicht für Handys

function viewFor(pid) {
  const p = P(pid);
  const ranked = rankedByTotals();
  const mine = S.totals[pid] || 0;
  const v = {
    phase: S.phase, mode: S.mode,
    me: { name: p.name, color: p.color, hasPhoto: !!p.photo, total: mine, rank: 1 + ranked.filter(o => (S.totals[o] || 0) > mine).length, of: ranked.length, jokers: S.jl[pid] || {} },
    icon: '🎲', title: '', sub: '',
  };
  const inFinal = S.final && (S.phase === 'finalIntro' || S.phase === 'end' || S.phase === 'stats'
    || (S.phase === 'tie' && S.tie && S.tie.context === 'final')
    || ((S.phase === 'q' || S.phase === 'reveal') && S.q && S.q.src === 'final'));
  if (inFinal) {
    v.final = S.quiz.final.winMode === 'elimination'
      ? { lives: S.final.lives[pid] || 0 }
      : { score: S.final.scores[pid] || 0, target: S.quiz.final.winMode === 'target' ? S.final.target : null };
  }
  const g = curGame();
  switch (S.phase) {
    case 'lobby':
      Object.assign(v, { icon: '🎉', title: 'Du bist dabei!', sub: 'Gleich geht es los.' }); break;
    case 'show': {
      const cur = pids()[S.showStep - 1];
      Object.assign(v, S.showStep === 0
        ? { icon: '✨', title: S.quiz.title, sub: 'Schau auf den großen Bildschirm.' }
        : cur === pid ? { icon: '👋', title: 'Das bist du!', sub: 'Winke mal in die Runde.' } : { icon: '👀', title: `${nameOf(cur)} wird vorgestellt`, sub: '' });
      break;
    }
    case 'rehearsal':
      Object.assign(v, { icon: '🧪', title: 'Generalprobe', sub: S.ready[pid] ? 'Alles klar – du bist bereit.' : 'Tippe auf „Bereit“, damit wir sehen, dass alles klappt.' });
      v.rehearsal = { ready: !!S.ready[pid] };
      break;
    case 'board':
      Object.assign(v, { icon: '🎲', title: 'Spieltafel', sub: 'Gleich geht es weiter.' }); break;
    case 'intro':
      Object.assign(v, { icon: '🎬', title: `Spiel ${S.game.idx + 1}: ${g.title}`, sub: `${g.description || ''}${g.description ? ' · ' : ''}Sieg: ${pointsLabel(g.points)}` });
      if (S.jokerCfg.double > 0) v.double = { left: (S.jl[pid] || {}).double || 0, used: !!(S.game.doubled && S.game.doubled[pid]) };
      break;
    case 'manual':
      Object.assign(v, { icon: '🏁', title: g.title, sub: g.description || 'Der Spielleiter trägt den Sieger ein.' }); break;
    case 'tie':
      Object.assign(v, { icon: '⚔️', title: 'Gleichstand!', sub: `Stechen zwischen ${listNames(S.tie.pids)}` }); break;
    case 'gameEnd': {
      const r = S.results[S.game.idx];
      const won = r && r.winners.includes(pid);
      const got = r && r.pts ? r.pts[pid] : r && r.points;
      Object.assign(v, won
        ? { icon: '🏆', title: 'Spiel gewonnen!', sub: `+${pointsLabel(got)}${r.doubled && r.doubled.includes(pid) ? ' (verdoppelt ⚡)' : ''}` }
        : { icon: '👏', title: r ? `${listNames(r.winners)} gewinnt` : 'Spiel beendet', sub: g.title });
      break;
    }
    case 'standings':
      Object.assign(v, { icon: '📊', title: 'Zwischenstand', sub: `Du bist auf Platz ${v.me.rank} von ${v.me.of}.` }); break;
    case 'finalIntro':
      Object.assign(v, { icon: '🔥', title: S.quiz.final.title || 'Finale', sub: v.final && v.final.lives !== undefined ? `Deine Leben: ${v.final.lives}` : `Dein Startwert: ${v.final ? v.final.score : 0}` }); break;
    case 'stats':
      Object.assign(v, { icon: '🏅', title: 'Statistik des Abends', sub: 'Gleich folgt die Siegerehrung …' }); break;
    case 'q': {
      const q = S.q, qu = q.question;
      if (q.eligible.includes(pid)) {
        const left = S.jl[pid] || {};
        const open = openFor(pid);
        const removed = q.fifty[pid] || [];
        const buzzT = isBuzzType(qu);
        v.q = {
          id: qu.id, type: qu.type, text: qu.text, unit: qu.unit || '',
          input: isTextType(qu) ? 'text' : buzzT ? 'buzz' : qu.type,
          options: qu.type === 'mc' ? qu.options.map((t, i) => ({ i, t })).filter(o => String(o.t).trim() && !removed.includes(o.i)) : null,
          items: qu.type === 'order' ? q.shuffle.map(i => ({ i, t: qu.items[i] })) : null,
          hilo: qu.type === 'hilo' ? { ref: qu.refLabel, refValue: formatNumber(qu.refValue), item: qu.itemLabel, unit: qu.unit || '' } : null,
          hints: qu.type === 'hint' ? filledHints(qu).slice(0, hintsShown()) : null,
          hintTotal: qu.type === 'hint' ? filledHints(qu).length : 0,
          waiting: !q.start,
          paused: !!q.pausedAt,
          remaining: q.start ? Math.max(0, endFor(pid) - nowQ()) : 0,
          dur: q.dur + (q.extra[pid] || 0),
          answered: !!q.answers[pid],
          locked: !!q.start && !open,
          out: q.lockedOut.includes(pid),
          buzz: buzzT && q.buzz ? { me: q.buzz === pid, name: nameOf(q.buzz) } : null,
          usedFifty: !!q.fifty[pid], usedTime: !!q.extra[pid],
          jokers: q.src !== 'tie' && open && !q.answers[pid] ? {
            fifty: qu.type === 'mc' && !q.fifty[pid] ? left.fifty || 0 : 0,
            time: !buzzT && !q.extra[pid] ? left.time || 0 : 0,
          } : null,
        };
      } else if (q.src === 'tie') {
        Object.assign(v, { icon: '⏳', title: 'Stechen läuft', sub: `zwischen ${listNames(q.eligible)}` });
      } else if (q.src === 'final' && S.quiz.final.winMode === 'elimination' && !(S.final.lives[pid] > 0)) {
        Object.assign(v, { icon: '💀', title: 'Ausgeschieden', sub: 'Du schaust jetzt zu.' });
      } else {
        Object.assign(v, { icon: '⏳', title: 'Gleich bist du dabei', sub: 'Ab der nächsten Frage spielst du mit.' });
      }
      break;
    }
    case 'reveal': {
      const q = S.q, qu = q.question;
      const a = q.answers[pid];
      v.r = {
        id: qu.id, type: qu.type, buzz: isBuzzType(qu),
        eligible: q.eligible.includes(pid),
        answered: isBuzzType(qu) ? (q.buzz === pid || q.lockedOut.includes(pid)) : !!a,
        good: q.result.winners.includes(pid),
        solution: correctText(qu),
        mine: a ? answerText(qu, a.v) : null,
        lostLife: (q.result.lost || []).includes(pid) && S.quiz.final.winMode === 'elimination' && q.src === 'final',
        penalty: (q.result.penalty || []).includes(pid),
        buzzName: q.buzz ? nameOf(q.buzz) : null,
      };
      break;
    }
    case 'end': {
      const isMe = S.champion === pid;
      const rank = finalRanking().indexOf(pid) + 1;
      Object.assign(v, isMe
        ? { icon: '👑', title: 'Du hast gewonnen!', sub: 'Glückwunsch zum Gesamtsieg!' }
        : { icon: '🎉', title: S.champion ? `${nameOf(S.champion)} gewinnt!` : 'Spiel vorbei', sub: `Dein Platz: ${rank}` });
      break;
    }
  }
  return v;
}

function answerText(qu, v) {
  if (qu.type === 'mc') return qu.options[v];
  if (qu.type === 'tf') return v ? 'Wahr' : 'Falsch';
  if (qu.type === 'hilo') return v ? '▲ Mehr' : '▼ Weniger';
  if (qu.type === 'order') return v.map(i => qu.items[i]).join(' → ');
  if (isTextType(qu)) return String(v);
  return formatNumber(v) + (qu.unit ? ' ' + qu.unit : '');
}

// ---------------------------------------------------------------- Rendern

let lastStageKey = null;

// Gleiche Bühne wie zuvor? Dann nur Teile aktualisieren, damit Animationen und Videos nicht neu starten.
function stageKey() {
  switch (S.phase) {
    case 'q': return `q|${S.q.question.id}|${S.q.src}`;
    case 'reveal': return `reveal|${S.q.question.id}|${S.q.src}`;
    case 'intro': return `intro|${S.game.idx}`;
    case 'show': return `show|${S.showStep}`;
    case 'lobby': case 'rehearsal': case 'standings': case 'stats': case 'end': case 'finalIntro': return S.phase;
    case 'gameEnd': return `gameEnd|${S.game.idx}`;
    default: return null;
  }
}

// QR-Code als Einblendung über der Show (zum Nachzügler-Beitritt)
function syncQrOverlay() {
  let ov = $('#qr-ov');
  if (S.qrOverlay && S.phase !== 'lobby') {
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'qr-ov';
      ov.innerHTML = `<div class="qr-ov-in"><div class="qrbox" id="qr2"></div><div class="joincode">${S.code}</div><div class="muted">Scannen zum Mitspielen</div></div>`;
      document.body.appendChild(ov);
      ov.onclick = () => command('lobby');
      if (typeof QRCode !== 'undefined') new QRCode($('#qr2'), { text: joinUrl(), width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
    }
  } else if (ov) ov.remove();
}

function render() {
  const stage = $('#stage');
  if (!stage) return;
  syncQrOverlay();
  const key = stageKey();
  if (key && key === lastStageKey) {
    if (S.phase === 'q') {
      const d = $('#q-dyn'); if (d) d.innerHTML = qDynamic();
      const n = $('#answered-count'); if (n) n.textContent = countLabel();
      const h = $('#hints'); if (h) h.innerHTML = hintsHtml();
    }
    if (S.phase === 'intro') { const j = $('#joker-row'); if (j) j.innerHTML = doubledRow(); }
    if (S.phase === 'lobby') {
      const c = $('#lobby-chips'); if (c) c.innerHTML = lobbyChips();
      const n = $('#lobby-count'); if (n) n.textContent = `(${pids().length})`;
    }
    if (S.phase === 'rehearsal') { const r = $('#ready-grid'); if (r) r.innerHTML = readyGrid(); const c = $('#ready-count'); if (c) c.textContent = readyCount(); }
    if (S.phase === 'finalIntro') { const fb = $('#final-bar'); if (fb) fb.innerHTML = finalBar(null); }
    bindStage();
    renderControls();
    onTick();
    return;
  }
  lastStageKey = key;
  const fn = {
    lobby: renderLobby, show: renderShow, rehearsal: renderRehearsal, board: renderBoard, intro: renderIntro, q: renderQuestion,
    reveal: renderReveal, manual: renderManual, tie: renderTie, gameEnd: renderGameEnd, standings: renderStandings,
    finalIntro: renderFinalIntro, stats: renderStats, end: renderEnd,
  }[S.phase];
  stage.innerHTML = fn ? fn() : '';
  stage.dataset.phase = S.phase;
  bindStage();
  renderControls();
  if (S.phase === 'lobby') drawQR();
  if (S.phase === 'q') attachMedia(stage);
  if (S.phase === 'standings') animateStandings();
  requestAnimationFrame(() => fitText(stage));
  onTick();
  if (fx) { confetti(fx === 'confetti-long' ? 5000 : 2500); fx = null; }
}

function attachMedia(stage) {
  hydrateMedia(stage).then(() => {
    $$('video, audio', stage).forEach(m => {
      const start = Number(m.dataset.start) || 0;
      const end = Number(m.dataset.end) || 0;
      const play = () => {
        if (start && m.currentTime < start - 0.3) m.currentTime = start;
        const p = m.play();
        if (p && p.catch) p.catch(() => toast('Zum Abspielen auf ▶ klicken (Browser blockiert Autoplay).', 3500));
      };
      m.onended = () => releaseAnswers();
      m.ontimeupdate = () => { if (end && m.currentTime >= end) { m.pause(); m.currentTime = end; releaseAnswers(); } };
      if (m.readyState >= 1) play(); else m.addEventListener('loadedmetadata', play, { once: true });
    });
  });
  drawPix(true);
}

function renderSoft() {
  if (S.phase === 'lobby') { const c = $('#lobby-chips'); if (c) c.innerHTML = lobbyChips(); bindStage(); }
  if (S.phase === 'rehearsal') { const r = $('#ready-grid'); if (r) r.innerHTML = readyGrid(); }
  renderControls();
}

function top(left, right = '') {
  return `<div class="stage-top"><div class="st-left">${left}</div><div class="st-right">${right}</div></div>`;
}

function joinUrl() { return new URL('play.html?r=' + S.code, location.href).href; }

function lobbyChips() {
  const list = pids();
  if (!list.length) return `<span class="muted mid">Noch niemand da …</span>`;
  return list.map(pid => `<span class="chip lg ${connected(pid) ? '' : 'off'}">${avatar(P(pid), 'sm')}<span class="cn">${esc(nameOf(pid))}</span><button data-kick="${pid}" title="Entfernen">✕</button></span>`).join('');
}

function jokerSummary() {
  const parts = Object.entries(JOKERS).filter(([k]) => S.jokerCfg[k] > 0).map(([k, j]) => `${j.icon} ${j.label} ×${S.jokerCfg[k]}`);
  return parts.length ? `Joker: ${parts.join(' · ')}` : '';
}

function renderLobby() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return `${top(`<b>${esc(S.quiz.title)}</b> · ${S.mode === 'team' ? 'Teammodus' : 'Einzelmodus'}`, esc(jokerSummary()))}
  <div class="lobby">
    <div class="lobby-qr">
      <div class="qrbox" id="qr"></div>
      <div class="lobby-code-label">Code</div>
      <div class="joincode">${S.code}</div>
      <div class="joinurl">${esc(joinUrl())}</div>
      ${local ? `<div class="notice small">Lokaler Test: Handys erreichen „localhost“ nicht. Spieler-Tabs über die Leiste unten öffnen.</div>` : ''}
    </div>
    <div class="lobby-side">
      <div class="big">${S.mode === 'team' ? 'Teams' : 'Spieler'} <span class="muted" id="lobby-count">(${pids().length})</span></div>
      <p class="mid muted">QR-Code scannen, Namen eingeben – mit Selfie, wer mag.</p>
      <div class="chips" id="lobby-chips">${lobbyChips()}</div>
      <p class="muted lobby-gm">🎙 Spielleiter: denselben QR-Code scannen und „Spielleiter“ wählen.</p>
    </div>
  </div>`;
}

function drawQR() {
  const el = $('#qr');
  if (!el || typeof QRCode === 'undefined') { if (el) el.innerHTML = '<p style="color:#000">QR-Code nicht verfügbar</p>'; return; }
  el.innerHTML = '';
  new QRCode(el, { text: joinUrl(), width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
}

function renderShow() {
  const list = pids();
  if (S.showStep === 0) {
    return `${top('', `${list.length} ${T().many}`)}
    <div class="center">${hero(`
      <div class="h-kicker">Willkommen zu</div>
      <div class="h-title" data-fit="20">${esc(S.quiz.title)}</div>
      ${S.quiz.tagline ? `<div class="h-sub">${esc(S.quiz.tagline)}</div>` : ''}
      <div class="h-pill">${S.quiz.games.length} Spiele${S.quiz.final.enabled ? ' + Finale' : ''}</div>`, 'intro-hero')}</div>`;
  }
  const pid = list[S.showStep - 1];
  const p = P(pid);
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `${T().one} ${S.showStep} von ${list.length}`)}
  <div class="center">
    <div class="player-card" style="--c:${p.color}">
      <div class="pc-av">${avatar(p, 'xl')}</div>
      <div class="pc-kicker">Heute dabei</div>
      <div class="pc-name" data-fit="24">${esc(p.name)}</div>
      <div class="pc-sub">${esc(jokerSummary())}</div>
    </div>
  </div>`;
}

const readyCount = () => `${pids().filter(pid => S.ready[pid]).length} / ${pids().length} bereit`;

function readyGrid() {
  return pids().map(pid => {
    const ok = !!S.ready[pid], on = connected(pid);
    return `<div class="ready-card ${ok ? 'ok' : ''} ${on ? '' : 'off'}">${avatar(P(pid), 'lg')}<div class="rc-name">${esc(nameOf(pid))}</div>
      <div class="rc-state">${ok ? '✓ bereit' : on ? '… wartet' : '⚠ offline'}</div></div>`;
  }).join('');
}

function renderRehearsal() {
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `<span id="ready-count">${readyCount()}</span>`)}
  <div class="center">
    <div class="section-kicker">Generalprobe</div>
    <div class="big">Alle tippen auf ihrem Handy auf „Bereit“</div>
    <p class="mid muted">So sehen wir, dass jedes Handy verbunden ist.</p>
    <div class="ready-grid" id="ready-grid">${readyGrid()}</div>
  </div>`;
}

function jokerIcons(pid) {
  const l = S.jl[pid];
  if (!l) return '';
  const s = Object.entries(JOKERS).filter(([k]) => S.jokerCfg[k] > 0).map(([k, j]) => `<span class="jk ${l[k] > 0 ? '' : 'used'}">${j.icon}${l[k] > 1 ? l[k] : ''}</span>`).join('');
  return s ? `<span class="jks">${s}</span>` : '';
}

function scoresPanel(title = 'Gesamtstand') {
  const ranked = rankedByTotals();
  const max = ranked.length ? S.totals[ranked[0]] || 0 : 0;
  return `<div class="scores ${editScores ? 'editing' : ''}"><h3>${title}</h3>
    ${ranked.map((pid, i) => `<div class="srow ${max > 0 && (S.totals[pid] || 0) === max ? 'lead' : ''} ${(S.lastWinners || []).includes(pid) ? 'bump' : ''}">
      <span class="rk">${i + 1}.</span>
      <span class="nm">${avatar(P(pid), 'sm')}<span class="cn">${esc(nameOf(pid))}</span>${jokerIcons(pid)}</span>
      <span class="sv"><span class="adj"><button data-adj="${pid}" data-d="-1">−</button><button data-adj="${pid}" data-d="1">+</button></span><span class="val">${S.totals[pid] || 0}</span></span>
    </div>`).join('') || '<span class="muted">Keine Mitspieler</span>'}</div>`;
}

function renderBoard() {
  const next = nextUnplayed();
  const f = S.quiz.final;
  const cols = S.quiz.games.length <= 4 ? S.quiz.games.length : S.quiz.games.length <= 8 ? 4 : 5;
  const tiles = S.quiz.games.map((g, i) => {
    const r = S.results[i];
    if (r) {
      const p = P(r.winners[0]);
      const got = r.pts ? r.pts[r.winners[0]] : r.points;
      return `<div class="tile done" style="--c:${p.color}">
        <span class="pts">${got} P${r.doubled && r.doubled.includes(r.winners[0]) ? ' ⚡' : ''}</span>
        <span class="t-av">${avatar(p, 'md')}</span>
        <span class="w" data-fit="10">${esc(g.title)}</span><span class="w2">${esc(listNames(r.winners))}</span></div>`;
    }
    return `<div class="tile ${i === next ? 'next' : ''}" data-game="${i}"><span class="pts">${g.points} P</span><span class="n">${i + 1}</span></div>`;
  }).join('');
  const finalTile = f.enabled ? `<div class="tile final ${next === -1 ? 'next' : ''}" ${next === -1 ? 'data-final="1"' : ''}><span class="n">🔥 ${esc(f.title || 'Finale')}</span></div>` : '';
  const played = S.results.filter(Boolean).length;
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `${played} / ${S.quiz.games.length} Spiele gespielt`)}
    <div class="board"><div class="tiles" style="--cols:${cols}">${tiles}${finalTile}</div>${scoresPanel()}</div>`;
}

function doubledRow() {
  const d = Object.keys((S.game && S.game.doubled) || {});
  if (!d.length) return S.jokerCfg.double > 0 ? '<span class="muted">⚡ Verdoppeln-Joker kann jetzt am Handy gesetzt werden.</span>' : '';
  return d.map(pid => chip(pid, 'doubled', ' ⚡ ×2')).join('');
}

function renderIntro() {
  const g = curGame();
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `Spiel ${S.game.idx + 1} / ${S.quiz.games.length}`)}
  <div class="center col">
    ${hero(`
      <div class="h-kicker">Spiel ${S.game.idx + 1}</div>
      <div class="h-title" data-fit="18">${esc(g.title)}</div>
      ${g.description ? `<div class="h-desc" data-fit="11">${esc(g.description)}</div>` : ''}
      <div class="h-pill">Sieg: ${pointsLabel(g.points)}${g.type === 'quiz' ? ` · ${g.questions.length} Fragen` : ''}</div>`)}
    <div class="chips under-hero" id="joker-row">${doubledRow()}</div>
  </div>`;
}

function qLabel() {
  const q = S.q;
  const t = `<span class="qtype">${TYPE_ICONS[q.question.type] || ''} ${QUESTION_TYPES[q.question.type] || ''}</span>`;
  if (q.src === 'game') return `<b>${esc(curGame().title)}</b> · Frage ${S.game.qi + 1} / ${curGame().questions.length} ${t}`;
  if (q.src === 'tie') return `<b>Stechfrage</b> · ${esc(listNames(q.eligible))} ${t}`;
  return `<b>${esc(S.quiz.final.title || 'Finale')}</b> · Frage ${S.final.qi + 1} ${t}`;
}

function countLabel() {
  const q = S.q;
  if (isBuzzType(q.question)) return q.lockedOut.length ? `${q.lockedOut.length} raus` : 'Buzzer';
  return `${Object.keys(q.answers).length} / ${q.eligible.length} geantwortet`;
}

function mediaBlock(qu) {
  const m = qu.media;
  if (m && m.kind === 'file') {
    const clip = `data-start="${Number(m.start) || 0}" data-end="${Number(m.end) || 0}"`;
    if ((m.mime || '').startsWith('audio')) {
      return `<div class="qmedia audio"><div class="speaker">🔊</div><audio data-media="${m.id}" ${clip} controls></audio></div>`;
    }
    return `<div class="qmedia"><video data-media="${m.id}" ${clip} controls playsinline></video></div>`;
  }
  if (m && m.kind === 'youtube' && m.vid) {
    const params = `autoplay=1&enablejsapi=1&rel=0&modestbranding=1&start=${Number(m.start) || 0}${Number(m.end) ? `&end=${Number(m.end)}` : ''}`;
    return `<div class="qmedia"><iframe id="yt" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.vid)}?${params}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe></div>`;
  }
  if (qu.image && qu.type !== 'reveal') return `<div class="qimg"><img src="${qu.image}" alt=""></div>`;
  return '';
}

function optionTiles(reveal) {
  const q = S.q, qu = q.question;
  let opts;
  if (qu.type === 'tf') opts = [{ i: true, t: 'Wahr', c: OPTION_COLORS[3], l: '✓' }, { i: false, t: 'Falsch', c: OPTION_COLORS[0], l: '✗' }];
  else if (qu.type === 'hilo') opts = [{ i: true, t: 'Mehr', c: OPTION_COLORS[3], l: '▲' }, { i: false, t: 'Weniger', c: OPTION_COLORS[0], l: '▼' }];
  else opts = qu.options.map((t, i) => ({ i, t, c: OPTION_COLORS[i], l: OPTION_LETTERS[i] })).filter(o => String(o.t).trim());
  const correct = qu.type === 'hilo' ? hiloHigher(qu) : qu.correct;
  const wrongOrder = shuffle(opts.filter(o => o.i !== correct).map(o => o.i));
  return `<div class="answers-grid ${opts.length <= 2 ? 'two' : ''}">${opts.map((o, k) => {
    let cls = '', style = `background:${o.c};--fd:${reveal ? 0 : k * 0.08}s`;
    let who = '';
    if (reveal) {
      who = Object.entries(q.answers).filter(([, a]) => a.v === o.i).map(([pid]) => `<span class="who-c" style="--c:${P(pid).color}">${esc(nameOf(pid))}</span>`).join('');
      if (o.i === correct) { cls = 'right'; style += `;--rd:${SUSPENSE_S + wrongOrder.length * 0.45}s`; }
      else { cls = 'wrong'; style += `;--rd:${SUSPENSE_S + wrongOrder.indexOf(o.i) * 0.45}s`; }
    }
    return `<div class="ans ${cls}" style="${style}"><span class="l">${o.l}</span><span class="txt">${esc(o.t)}</span>${reveal ? `<span class="who">${who}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

function hintsHtml() {
  const q = S.q, qu = q.question;
  const all = filledHints(qu);
  const n = hintsShown();
  return all.map((h, i) => i < n
    ? `<div class="hint on ${i === n - 1 && n !== q._lastRenderedHints ? 'fresh' : ''}"><b>${i + 1}</b><span>${esc(h)}</span></div>`
    : `<div class="hint off"><b>${i + 1}</b><span>…</span></div>`).join('') + (q._lastRenderedHints = n, '');
}

function typeBlock(qu) {
  if (qu.type === 'mc' || qu.type === 'tf') return optionTiles(false);
  if (qu.type === 'estimate') return `<div class="type-note">🎯 Schätzt! ${qu.unit ? `<span class="muted">(in ${esc(qu.unit)})</span>` : ''}</div>`;
  if (qu.type === 'order') {
    return `<div class="order-list">${S.q.shuffle.map((i, k) => `<div class="order-item" style="animation-delay:${k * 0.08}s">${esc(qu.items[i])}</div>`).join('')}</div>`;
  }
  if (qu.type === 'hint') return `<div class="hints" id="hints">${hintsHtml()}</div>`;
  if (qu.type === 'reveal') return `<div class="qmedia pix"><canvas id="pix"></canvas></div>`;
  if (qu.type === 'text') return `<div class="type-note">✍ Tippt eure Antwort ins Handy!</div>`;
  if (qu.type === 'hilo') {
    return `<div class="hilo">
      <div class="hilo-card"><div class="hl-lbl" data-fit="12">${esc(qu.refLabel)}</div><div class="hl-val">${formatNumber(qu.refValue)} <small>${esc(qu.unit || '')}</small></div></div>
      <div class="hilo-vs">▲<span>oder</span>▼</div>
      <div class="hilo-card ask"><div class="hl-lbl" data-fit="12">${esc(qu.itemLabel)}</div><div class="hl-val">?</div></div>
    </div>`;
  }
  return '';
}

function qDynamic() {
  const q = S.q, qu = q.question;
  if (!q.start) {
    return `<div class="wait-msg">${qu.media && qu.media.kind === 'youtube' ? '▶ Schaut genau hin …' : '👀 Gut aufpassen …'} Die Antworten werden gleich freigegeben.</div>`;
  }
  const timer = `<div class="timer-row"><div class="timer"><i id="tbar" ${q.locked ? 'style="transform:scaleX(0)"' : ''}></i></div><div class="timer-num" id="tnum">${q.locked ? '0' : ''}</div></div>`;
  if (isBuzzType(qu)) {
    const out = q.lockedOut.length ? `<div class="chips answered-row">${q.lockedOut.map(pid => chip(pid, 'out', ' ✗')).join('')}</div>` : '';
    if (q.buzz) {
      const p = P(q.buzz);
      return `<div class="buzz-box" style="--c:${p.color}">${avatar(p, 'lg')}<div><div class="bb-name">🔔 ${esc(p.name)}</div>
        <div class="mid muted">hat gebuzzert – Antwort bitte laut!</div></div></div>${out}`;
    }
    return `${timer}<div class="buzz-ready ${q.locked ? 'off' : ''}">${q.locked ? 'Zeit abgelaufen' : '🔔 Buzzer frei!'}</div>${out}`;
  }
  const chips = q.eligible.map(pid => chip(pid, `${q.answers[pid] ? 'answered' : ''} ${connected(pid) ? '' : 'off'}`,
    `${q.fifty[pid] ? ' ½' : ''}${q.extra[pid] ? ' ⏱' : ''}`)).join('');
  return `${timer}<div class="chips answered-row" id="answered-chips">${chips}</div>
    ${q.locked ? '<div class="lock-msg">Antworten geschlossen – gleich kommt die Auflösung</div>' : ''}`;
}

function renderQuestion() {
  const qu = S.q.question;
  return `${top(qLabel(), `<span id="answered-count">${countLabel()}</span>`)}
  <div class="qwrap qtype-${qu.type}">
    <div class="qtext" data-fit="18">${esc(qu.text)}</div>
    ${mediaBlock(qu)}
    ${typeBlock(qu)}
    <div id="q-dyn" class="q-dyn">${qDynamic()}</div>
  </div>`;
}

// Auflösung mit Spannungsaufbau (3-2-1, dann schrittweise aufdecken)
function suspense() {
  return `<div class="suspense" aria-hidden="true"><span>3</span><span>2</span><span>1</span></div>`;
}

function estimateLine(q, qu) {
  const arr = q.ranking || [];
  const sol = Number(qu.correct);
  const vals = [sol, ...arr.map(x => x.v)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const pos = v => ((v - lo) / (hi - lo)) * 100;
  const markers = arr.map((x, k) => `<div class="nl-mark ${q.result.winners.includes(x.pid) ? 'win' : ''}" style="--x:${pos(x.v)}%;--d:${SUSPENSE_S + k * 0.35}s;--c:${P(x.pid).color};--row:${k % 3}">
      ${avatar(P(x.pid), 'sm')}<span class="nl-v">${formatNumber(x.v)}</span></div>`).join('');
  return `<div class="numline">
    <div class="nl-axis"></div>
    ${markers}
    <div class="nl-sol" style="--x:${pos(sol)}%;--d:${SUSPENSE_S + arr.length * 0.35 + 0.3}s"><span>${esc(correctText(qu))}</span></div>
  </div>`;
}

function renderReveal() {
  const q = S.q, qu = q.question;
  const solDelay = `style="--d:${SUSPENSE_S}s"`;
  let body;
  if (qu.type === 'estimate') {
    body = estimateLine(q, qu)
      + (!(q.ranking || []).length ? '<div class="type-note muted">Keine Antworten</div>' : '');
  } else if (qu.type === 'order') {
    body = `<div class="order-list solution-list">${orderIndices(qu).map((i, k) => `<div class="order-item right" style="animation-delay:${SUSPENSE_S + k * 0.3}s"><b>${k + 1}.</b> ${esc(qu.items[i])}</div>`).join('')}</div>`;
  } else if (isBuzzType(qu) || isTextType(qu)) {
    const media = qu.type === 'reveal' ? `<div class="qimg sharp late" ${solDelay}><img src="${qu.image}" alt=""></div>` : '';
    let detail = '';
    if (isBuzzType(qu)) {
      detail = q.buzz && q.buzzResult === 'right'
        ? `<div class="verdict-line good late" style="--d:${SUSPENSE_S + 0.6}s">✓ ${esc(nameOf(q.buzz))} lag richtig!</div>`
        : q.buzz && q.buzzResult === 'wrong'
          ? `<div class="verdict-line bad late" style="--d:${SUSPENSE_S + 0.6}s">✗ ${esc(nameOf(q.buzz))} lag falsch – Minuspunkt</div>`
          : `<div class="verdict-line muted late" style="--d:${SUSPENSE_S + 0.6}s">Niemand hat es erraten</div>`;
    } else {
      const rows = Object.entries(q.answers).map(([pid, a], k) => `<div class="ta-row ${q.marks[pid] ? 'ok' : 'no'} late" style="--d:${SUSPENSE_S + 0.5 + k * 0.25}s">
        ${avatar(P(pid), 'sm')}<span class="ta-name">${esc(nameOf(pid))}</span><span class="ta-text">${esc(String(a.v))}</span><span class="ta-mark">${q.marks[pid] ? '✓' : '✗'}</span></div>`).join('');
      detail = `<div class="ta-list">${rows || '<div class="muted">Keine Antworten</div>'}</div>`;
    }
    body = `${media}<div class="solution-wrap late" ${solDelay}><span class="sol-label">Lösung</span><span class="solution">${esc(correctText(qu))}</span></div>${detail}`;
  } else if (qu.type === 'hilo') {
    const max = Math.max(Number(qu.refValue), Number(qu.itemValue)) || 1;
    const h = v => Math.max(6, (Number(v) / max) * 100);
    body = `<div class="hilo reveal">
      <div class="hilo-bar"><div class="hb-fill" style="--h:${h(qu.refValue)}%"></div><div class="hb-val">${formatNumber(qu.refValue)} ${esc(qu.unit || '')}</div><div class="hb-lbl">${esc(qu.refLabel)}</div></div>
      <div class="hilo-bar ask"><div class="hb-fill late-grow" style="--h:${h(qu.itemValue)}%;--d:${SUSPENSE_S}s"></div><div class="hb-val late" style="--d:${SUSPENSE_S + 0.9}s">${formatNumber(qu.itemValue)} ${esc(qu.unit || '')}</div><div class="hb-lbl">${esc(qu.itemLabel)}</div></div>
    </div>${optionTiles(true)}`;
  } else {
    body = optionTiles(true);
  }
  return `${top(qLabel(), 'Auflösung')}
  <div class="qwrap reveal-wrap qtype-${qu.type}">
    <div class="qtext" data-fit="18">${esc(qu.text)}</div>
    ${qu.image && !qu.media && (qu.type === 'mc' || qu.type === 'tf') ? `<div class="qimg"><img src="${qu.image}" alt=""></div>` : ''}
    ${body}
    <div class="late" style="--d:${SUSPENSE_S + 1.2}s">${revealFooter()}</div>
  </div>${suspense()}`;
}

function revealFooter() {
  const q = S.q;
  if (q.src === 'game') {
    const g = curGame();
    return `<div class="chips answered-row">${pids().map(pid => {
      const cls = q.result.winners.includes(pid) ? 'answered' : (q.result.penalty || []).includes(pid) ? 'penalty' : '';
      return `<span class="chip ${cls}">${avatar(P(pid), 'sm')}<span class="cn">${esc(nameOf(pid))}</span> <b>${S.game.correct[pid] || 0}</b></span>`;
    }).join('')}</div>
      <div class="muted footnote">Richtige Antworten in „${esc(g.title)}“</div>`;
  }
  if (q.src === 'final') return finalBar(q.result);
  return '';
}

function finalBar(result) {
  const f = S.quiz.final, F = S.final;
  const elim = f.winMode === 'elimination';
  const list = pids().slice().sort((a, b) => elim ? F.lives[b] - F.lives[a] : F.scores[b] - F.scores[a]);
  const chips = list.map(pid => {
    const val = elim ? (F.lives[pid] > 0 ? '❤'.repeat(Math.min(F.lives[pid], 10)) + (F.lives[pid] > 10 ? ` ${F.lives[pid]}` : '') : '💀') : F.scores[pid];
    const hit = result && (elim ? (result.lost || []).includes(pid) : result.winners.includes(pid));
    const cls = elim ? (F.lives[pid] > 0 ? '' : 'off') : (hit ? 'answered' : '');
    return `<span class="chip ${cls} ${elim && hit ? 'penalty' : ''}">${avatar(P(pid), 'sm')}<span class="cn">${esc(nameOf(pid))}</span> <b class="${elim ? 'hearts' : ''}">${val}</b></span>`;
  }).join('');
  const goal = f.winMode === 'target' ? `Ziel: ${F.target} Punkte` : f.winMode === 'count' ? `Frage ${Math.min(F.qi + 1, finalLimit())} von ${finalLimit()}` : 'Wer zuletzt noch Leben hat, gewinnt';
  const saved = result && result.saved ? ' · Alle lagen falsch – niemand verliert ein Leben' : '';
  return `<div class="chips answered-row">${chips}</div><div class="muted footnote">${goal}${saved}</div>`;
}

function renderManual() {
  const g = curGame();
  const t = Number(g.timer) || 0;
  const timerHtml = t ? `<div class="big-timer" id="mtimer">${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</div>` : '';
  const dbl = Object.keys(S.game.doubled || {});
  return `${top(`<b>${esc(g.title)}</b> · Spiel ${S.game.idx + 1}`, `Sieg: ${pointsLabel(g.points)}`)}
  <div class="center col">
    <div class="section-kicker">Spiel ${S.game.idx + 1}</div>
    <div class="big" data-fit="20">${esc(g.title)}</div>
    ${g.description ? `<div class="mid muted manual-desc">${esc(g.description)}</div>` : ''}
    ${timerHtml}
    <div class="muted">Sieger antippen:</div>
    <div class="pick-grid">${pids().map(pid => `<button class="pick ${manualSel.has(pid) ? 'sel' : ''}" data-pick="${pid}" style="--c:${P(pid).color}">${avatar(P(pid), 'sm')} ${esc(nameOf(pid))}${dbl.includes(pid) ? ' ⚡' : ''}</button>`).join('')}</div>
  </div>`;
}

function renderTie() {
  const ctx = S.tie.context;
  const label = ctx === 'game' ? curGame().title : ctx === 'final' ? (S.quiz.final.title || 'Finale') : 'Gesamtwertung';
  const hasQ = !!pickTieQuestion();
  return `${top(`<b>${esc(label)}</b>`, 'Gleichstand')}
  <div class="center col">
    <div class="section-kicker">Gleichstand</div>
    <div class="huge">⚔️</div>
    <div class="tie-row">${S.tie.pids.map(pid => `<div class="tie-p">${avatar(P(pid), 'lg')}<span>${esc(nameOf(pid))}</span></div>`).join('<span class="tie-vs">vs.</span>')}</div>
    <div class="mid muted">${hasQ ? 'Eine Schätzfrage entscheidet: Wer am nächsten dran ist, gewinnt.' : 'Keine Stechfrage mehr übrig – bitte Sieger direkt wählen.'}</div>
    ${ctx === 'final' ? `<div class="wide">${finalBar(null)}</div>` : ''}
    <div class="pick-grid small">${S.tie.pids.map(pid => `<button class="pick" data-tiewin="${pid}" style="--c:${P(pid).color}">🏆 ${esc(nameOf(pid))}</button>`).join('')}</div>
  </div>`;
}

function renderGameEnd() {
  const g = curGame();
  const r = S.results[S.game.idx];
  const p = P(r.winners[0]);
  const got = r.pts ? r.pts[r.winners[0]] : r.points;
  const doubled = r.doubled && r.doubled.includes(r.winners[0]);
  return `${top(`<b>${esc(g.title)}</b> · Spiel ${S.game.idx + 1}`, 'Ergebnis')}
  <div class="center col">
    ${hero(`
      <div class="h-av">${r.winners.map(pid => avatar(P(pid), 'lg')).join('')}</div>
      <div class="h-title" data-fit="16" style="color:${p.color}">${esc(listNames(r.winners))}</div>
      <div class="h-sub">gewinnt „${esc(g.title)}“</div>
      <div class="h-pill">+${pointsLabel(got)}${doubled ? ' · ⚡ verdoppelt' : ''}</div>`, 'win-hero')}
  </div>`;
}

function renderStandings() {
  const ranked = rankedByTotals();
  const prev = S.prevTotals || {};
  const prevRanked = pids().slice().sort((a, b) => (prev[b] || 0) - (prev[a] || 0));
  const max = Math.max(1, ...ranked.map(pid => S.totals[pid] || 0));
  const rows = ranked.map((pid, i) => {
    const from = Math.max(0, prevRanked.indexOf(pid));
    const gained = (S.totals[pid] || 0) - (prev[pid] || 0);
    return `<div class="st-row ${i === 0 ? 'first' : ''}" style="--from:${from};--to:${i};--c:${P(pid).color}" data-to="${i}">
      <span class="st-rank">${i + 1}</span>${avatar(P(pid), 'md')}
      <span class="st-name">${esc(nameOf(pid))}</span>
      <span class="st-bar"><i style="--w0:${((prev[pid] || 0) / max) * 100}%;--w1:${((S.totals[pid] || 0) / max) * 100}%"></i></span>
      <span class="st-val">${S.totals[pid] || 0}${gained > 0 ? `<em>+${gained}</em>` : ''}</span>
    </div>`;
  }).join('');
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `nach Spiel ${S.game ? S.game.idx + 1 : ''}`)}
  <div class="center col">
    <div class="section-kicker">Zwischenstand</div>
    <div class="standings" style="--n:${ranked.length}">${rows}</div>
  </div>`;
}

function animateStandings() {
  // Erst alte Reihenfolge zeigen, dann zur neuen gleiten (Positionswechsel sichtbar)
  setTimeout(() => $$('.st-row').forEach(r => r.classList.add('go')), 700);
}

function renderFinalIntro() {
  const f = S.quiz.final, F = S.final;
  const rule = {
    target: `Wer zuerst <b>${F.target} Punkte</b> hat, gewinnt.`,
    count: `<b>${finalLimit()} Fragen</b> – die meisten Punkte gewinnen.`,
    elimination: `Falsche Antwort kostet ein Leben.`,
  }[f.winMode];
  return `${top(`<b>${esc(S.quiz.title)}</b>`, 'Finale')}
  <div class="center col">
    ${hero(`
      <div class="h-kicker">Das große Finale</div>
      <div class="h-title" data-fit="18">🔥 ${esc(f.title || 'Finale')}</div>
      <div class="h-desc">${rule}${f.headStart ? ' Vorrundenpunkte = Vorsprung.' : ''}</div>
      ${F.targetRaised ? '<div class="h-desc gold">Ziel wurde angehoben.</div>' : ''}`)}
    <div class="wide under-hero" id="final-bar">${finalBar(null)}</div>
  </div>`;
}

function renderStats() {
  const list = awards();
  return `${top(`<b>${esc(S.quiz.title)}</b>`, 'Statistik')}
  <div class="center col">
    <div class="section-kicker">Statistik des Abends</div>
    <div class="awards">${list.map((a, k) => `<div class="award" style="animation-delay:${0.3 + k * 0.35}s;--c:${P(a.pid).color}">
      <div class="aw-icon">${a.icon}</div><div class="aw-title">${a.title}</div>
      ${avatar(P(a.pid), 'lg')}<div class="aw-name">${esc(nameOf(a.pid))}</div><div class="aw-val">${esc(a.value)}</div></div>`).join('')
      || '<div class="muted mid">Für eine Statistik wurde zu wenig gespielt.</div>'}</div>
  </div>`;
}

function renderEnd() {
  const ranking = finalRanking();
  const podium = ranking.slice(0, 3);
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  const heights = { 0: '30vh', 1: '21vh', 2: '14vh' };
  const champ = S.champion ? P(S.champion) : null;
  return `${top(`<b>${esc(S.quiz.title)}</b>`, 'Siegerehrung')}
  <div class="center col end">
    <div class="crown">👑</div>
    <div class="huge champ" data-fit="24" style="color:${champ ? champ.color : 'inherit'}">${champ ? esc(champ.name) : 'Kein Sieger'}</div>
    <div class="mid">${champ ? 'gewinnt den Abend!' : ''}</div>
    <div class="podium">${order.map(pid => {
      const i = podium.indexOf(pid);
      return `<div class="pod" style="--c:${P(pid).color}">${avatar(P(pid), i === 0 ? 'lg' : 'md')}<span class="nm">${esc(nameOf(pid))}</span><div class="bar" style="height:${heights[i]}">${i + 1}</div></div>`;
    }).join('')}</div>
  </div>`;
}

function bindStage() {
  $$('[data-kick]').forEach(b => b.onclick = () => {
    const pid = b.dataset.kick;
    if (!confirm(`${nameOf(pid)} entfernen?`)) return;
    gmCommand('kick', pid);
  });
  $$('[data-game]').forEach(t => t.onclick = () => gmCommand('startGame', Number(t.dataset.game)));
  $$('[data-final]').forEach(t => t.onclick = () => { if (S.finished) { S.phase = 'end'; update(); } else command('finish'); });
  $$('[data-adj]').forEach(b => b.onclick = () => gmCommand('adjTotal', { pid: b.dataset.adj, d: Number(b.dataset.d) }));
  $$('[data-pick]').forEach(b => b.onclick = () => gmCommand('manualToggle', b.dataset.pick));
  $$('[data-tiewin]').forEach(b => b.onclick = () => {
    if (confirm(`${nameOf(b.dataset.tiewin)} als Sieger festlegen?`)) gmCommand('tieWin', b.dataset.tiewin);
  });
}

// ---------------------------------------------------------------- Spielleiter-Handy

function gmCommand(c, arg) {
  const pid = arg && typeof arg === 'object' ? arg.pid : arg;
  const d = arg && typeof arg === 'object' ? Math.sign(Number(arg.d) || 0) : 0;
  switch (c) {
    case 'adjTotal':
      if (!S.players[pid] || !d) return;
      pushUndo(c);
      S.totals[pid] = Math.max(0, (S.totals[pid] || 0) + d);
      return update();
    case 'adjCorrect':
      if (!S.players[pid] || !d || !S.game) return;
      pushUndo(c);
      S.game.correct[pid] = (S.game.correct[pid] || 0) + d;
      return update();
    case 'adjFinal': {
      if (!S.players[pid] || !d || !S.final) return;
      pushUndo(c);
      const key = S.quiz.final.winMode === 'elimination' ? 'lives' : 'scores';
      S.final[key][pid] = Math.max(0, (S.final[key][pid] || 0) + d);
      return update();
    }
    case 'jokerAdj': {
      const kind = arg && arg.kind;
      if (!S.players[pid] || !d || !JOKERS[kind]) return;
      pushUndo(c);
      S.jl[pid] = S.jl[pid] || { ...S.jokerCfg };
      S.jl[pid][kind] = Math.max(0, (S.jl[pid][kind] || 0) + d);
      return update();
    }
    case 'startGame':
      if (!S.quiz.games[Number(arg)]) return;
      pushUndo(c);
      stopMedia();
      return startGame(Number(arg));
    case 'gotoQuestion':
      if (!arg) return;
      pushUndo(c);
      return gotoQuestion(arg.g === 'final' ? 'final' : Number(arg.g), Number(arg.qi));
    case 'manualToggle':
      if (S.phase !== 'manual' || !S.players[pid]) return;
      manualSel.has(pid) ? manualSel.delete(pid) : manualSel.add(pid);
      return update();
    case 'markText':
      if (S.phase !== 'q' || !S.q || !S.q.answers[pid]) return;
      S.q.marks[pid] = !S.q.marks[pid];
      return update();
    case 'tieWin':
      if (S.phase !== 'tie' || !S.tie || !S.tie.pids.includes(pid)) return;
      pushUndo(c);
      return finishTie(pid);
    case 'kick':
      if (!S.players[pid]) return;
      S.kicked[pid] = true;
      net.send(pid, { t: 'kicked' });
      setTimeout(() => net.drop(pid), 300);
      return update();
    default:
      if (['quit', 'fullscreen', 'testplayer', 'editScores'].includes(c)) return;
      return command(c);
  }
}

function nextQuestionPreview() {
  let qu = null, label = '';
  if (S.game && curGame() && curGame().type === 'quiz') {
    const g = curGame();
    const i = S.phase === 'intro' ? 0 : S.game.qi + 1;
    if (i < g.questions.length) { qu = g.questions[i]; label = `Frage ${i + 1} / ${g.questions.length}`; }
  } else if (S.final && ['finalIntro', 'q', 'reveal'].includes(S.phase)) {
    const i = S.phase === 'finalIntro' ? 0 : S.final.qi + 1;
    if (i < finalLimit()) { qu = S.quiz.final.questions[i]; label = `Finale · Frage ${i + 1}`; }
  }
  return qu ? { label, text: questionLabel(qu), type: qu.type, icon: TYPE_ICONS[qu.type], solution: correctText(qu), notes: qu.notes || '' } : null;
}

function gmAnswers(q) {
  const qu = q.question;
  if (qu.type === 'mc' || qu.type === 'tf' || qu.type === 'hilo') {
    let opts;
    if (qu.type === 'tf') opts = [{ i: true, t: 'Wahr', l: '✓' }, { i: false, t: 'Falsch', l: '✗' }];
    else if (qu.type === 'hilo') opts = [{ i: true, t: 'Mehr', l: '▲' }, { i: false, t: 'Weniger', l: '▼' }];
    else opts = qu.options.map((t, i) => ({ i, t, l: OPTION_LETTERS[i] })).filter(o => String(o.t).trim());
    const correct = qu.type === 'hilo' ? hiloHigher(qu) : qu.correct;
    return {
      kind: 'options',
      options: opts.map(o => ({
        letter: o.l, text: o.t, correct: o.i === correct,
        names: Object.entries(q.answers).filter(([, a]) => a.v === o.i).map(([pid]) => nameOf(pid)),
      })),
    };
  }
  if (qu.type === 'estimate') {
    const list = Object.entries(q.answers).map(([pid, a]) => ({ name: nameOf(pid), value: formatNumber(a.v), d: Math.abs(a.v - Number(qu.correct)) }))
      .sort((a, b) => a.d - b.d);
    return { kind: 'list', items: list.map(x => ({ name: x.name, text: `${x.value} ${qu.unit || ''}`, extra: `±${formatNumber(x.d)}` })) };
  }
  if (qu.type === 'order') {
    return { kind: 'list', items: Object.entries(q.answers).map(([pid, a]) => ({ name: nameOf(pid), text: answerText(qu, a.v), ok: isRight(qu, a.v) })) };
  }
  if (isTextType(qu)) {
    return { kind: 'text', items: Object.entries(q.answers).map(([pid, a]) => ({ pid, name: nameOf(pid), text: String(a.v), ok: !!q.marks[pid] })) };
  }
  return { kind: 'buzz', out: q.lockedOut.map(nameOf) };
}

function gmFlow() {
  const cur = S.q ? { g: S.q.src === 'final' ? 'final' : S.game ? S.game.idx : null, qi: S.q.src === 'final' ? S.final.qi : S.game ? S.game.qi : null } : { g: S.game ? S.game.idx : null, qi: null };
  return {
    current: cur,
    games: S.quiz.games.map((g, i) => ({
      idx: i, title: g.title, type: g.type, points: g.points, done: !!S.results[i],
      winner: S.results[i] ? listNames(S.results[i].winners) : null,
      questions: g.type === 'quiz' ? g.questions.map((q, qi) => ({ qi, label: questionLabel(q), icon: TYPE_ICONS[q.type] })) : [],
    })),
    final: S.quiz.final.enabled ? { title: S.quiz.final.title || 'Finale', started: !!S.final, questions: S.quiz.final.questions.map((q, qi) => ({ qi, label: questionLabel(q), icon: TYPE_ICONS[q.type] })) } : null,
  };
}

const PHASE_LABELS = {
  lobby: 'Lobby', show: 'Intro', rehearsal: 'Generalprobe', board: 'Spieltafel', intro: 'Ankündigung', q: 'Frage läuft', reveal: 'Auflösung',
  manual: 'Manuelles Spiel', tie: 'Gleichstand', gameEnd: 'Spielende', standings: 'Zwischenstand', finalIntro: 'Finale', stats: 'Statistik', end: 'Siegerehrung',
};

function gmView() {
  const g = curGame();
  const q = S.q;
  const ctrl = controlsModel();
  const inFinal = !!S.final && !S.game;
  const elim = S.quiz.final.winMode === 'elimination';
  const inQ = S.phase === 'q' && q;
  const v = {
    phase: S.phase, phaseLabel: PHASE_LABELS[S.phase] || S.phase, code: S.code, quiz: S.quiz.title, mode: S.mode,
    controls: { primary: ctrl.primary, buttons: ctrl.buttons.filter(b => b.live) },
    tools: {
      pause: !!(inQ && q.start && !q.locked && !q.pausedAt),
      resume: !!(inQ && q.pausedAt && !q.buzz),
      addTime: !!(inQ && q.start && !q.locked),
      lock: !!(inQ && q.start && !q.locked),
      skip: !!(S.q && (S.phase === 'q' || S.phase === 'reveal')),
      skipShow: S.phase === 'lobby' || S.phase === 'show' || S.phase === 'rehearsal',
      undo: undoStack.length ? undoStack[undoStack.length - 1].label : null,
      muted: isMuted(),
    },
    attention: buzzPending(),
    context: ['lobby', 'show', 'rehearsal', 'board', 'stats', 'end'].includes(S.phase) ? S.quiz.title
      : g ? `Spiel ${S.game.idx + 1}: ${g.title}` : (S.final ? (S.quiz.final.title || 'Finale') : S.quiz.title),
    jokerKinds: Object.keys(JOKERS).filter(k => S.jokerCfg[k] > 0),
    players: rankedByTotals().map(pid => ({
      id: pid, name: nameOf(pid), color: P(pid).color, online: connected(pid),
      total: S.totals[pid] || 0,
      correct: S.game ? (S.game.correct[pid] || 0) : null,
      final: inFinal ? (elim ? S.final.lives[pid] || 0 : S.final.scores[pid] || 0) : null,
      jokers: S.jl[pid] || {},
      doubled: !!(S.game && S.game.doubled && S.game.doubled[pid]),
      ready: !!S.ready[pid],
    })),
    finalLabel: inFinal ? (elim ? 'Leben' : 'Finale') : null,
    next: nextQuestionPreview(),
    flow: gmFlow(),
  };
  if (S.phase === 'show') v.show = { step: S.showStep, total: pids().length, name: S.showStep ? nameOf(pids()[S.showStep - 1]) : null };
  if (S.phase === 'intro' || S.phase === 'manual') {
    v.game = { title: g.title, description: g.description, points: g.points, type: g.type, questions: g.questions.length };
  }
  if (S.phase === 'manual') v.manualSel = [...manualSel];
  if (S.phase === 'tie') v.tie = { ids: S.tie.pids.slice(), label: S.tie.context === 'game' ? g.title : 'Finale/Gesamt', hasQuestion: !!pickTieQuestion() };
  if ((S.phase === 'q' || S.phase === 'reveal') && q) {
    const qu = q.question;
    v.q = {
      id: qu.id, src: q.src, type: qu.type, typeLabel: QUESTION_TYPES[qu.type], icon: TYPE_ICONS[qu.type],
      text: qu.text, solution: correctText(qu), notes: qu.notes || '',
      hasMedia: !!qu.media, waiting: !q.start, locked: q.locked, paused: !!q.pausedAt,
      remaining: q.start && !q.locked ? Math.max(0, qEnd() - nowQ()) : 0,
      answered: Object.keys(q.answers).length, eligible: q.eligible.length,
      missing: q.eligible.filter(pid => !q.answers[pid]).map(nameOf),
      buzz: q.buzz ? { name: nameOf(q.buzz), result: q.buzzResult } : null,
      buzzType: isBuzzType(qu), textType: isTextType(qu),
      hints: qu.type === 'hint' ? { shown: hintsShown(), list: filledHints(qu) } : null,
      answers: gmAnswers(q),
      revealed: S.phase === 'reveal',
      winners: q.result ? q.result.winners.map(nameOf) : null,
      label: q.src === 'game' ? `Frage ${S.game.qi + 1} / ${g.questions.length}` : q.src === 'tie' ? 'Stechfrage' : `Finale · Frage ${S.final.qi + 1}`,
    };
  }
  if (S.phase === 'gameEnd') {
    const r = S.results[S.game.idx];
    v.result = { winners: listNames(r.winners), pts: r.pts ? r.pts[r.winners[0]] : r.points };
  }
  if (S.phase === 'end' || S.phase === 'stats') v.champion = S.champion ? nameOf(S.champion) : null;
  return v;
}

// ---------------------------------------------------------------- Steuerleiste

// Aktionen der aktuellen Phase – genutzt von der Laptop-Leiste und vom Spielleiter-Handy (live = auch dort im Live-Reiter).
function controlsModel() {
  const buttons = [];
  let primary = null;
  const g = curGame();
  const q = S.q;
  switch (S.phase) {
    case 'lobby':
      buttons.push({ c: 'testplayer', label: `+ Test-${T().one} öffnen` });
      buttons.push({ c: 'skipShow', label: 'Intro überspringen', cls: 'ghost' });
      primary = { label: 'Intro starten', c: 'startShow', disabled: !pids().length };
      break;
    case 'show':
      buttons.push({ c: 'skipShow', label: 'Intro überspringen', cls: 'ghost' });
      primary = { label: S.showStep === 0 ? 'Spieler vorstellen' : S.showStep < pids().length ? 'Nächster Spieler' : 'Zur Generalprobe', c: 'showNext' };
      break;
    case 'rehearsal':
      buttons.push({ c: 'lobby', label: S.qrOverlay ? 'QR-Code ausblenden' : 'QR-Code zeigen', cls: 'ghost' });
      primary = { label: 'Los geht’s!', c: 'toBoard' };
      break;
    case 'board': {
      buttons.push({ c: 'lobby', label: S.qrOverlay ? 'QR-Code ausblenden' : 'QR-Code zeigen', cls: 'ghost' });
      buttons.push({ c: 'editScores', label: editScores ? 'Korrektur fertig' : 'Punkte korrigieren', cls: 'ghost' });
      const next = nextUnplayed();
      primary = S.finished ? { label: 'Zur Siegerehrung', c: 'toEnd' }
        : next >= 0 ? { label: `Spiel ${next + 1} starten`, c: 'nextGame' }
          : { label: S.quiz.final.enabled ? 'Zum Finale' : 'Zur Siegerehrung', c: 'finish' };
      break;
    }
    case 'intro':
      buttons.push({ c: 'toBoard', label: 'Zurück zur Tafel', cls: 'ghost' });
      primary = { label: g.type === 'manual' ? 'Spiel beginnen' : 'Erste Frage', c: 'beginGame' };
      break;
    case 'q':
      if (!q.start) { primary = { label: 'Antworten freigeben', c: 'release' }; break; }
      if (buzzPending()) {
        buttons.push({ c: 'buzzRight', label: '✓ Richtig', cls: 'judge good', key: 'R', live: true });
        buttons.push({ c: 'buzzWrong', label: '✗ Falsch', cls: 'judge bad', key: 'X', live: true });
        break;
      }
      if (q.question.type === 'hint' && !q.locked && hintsShown() < filledHints(q.question).length) buttons.push({ c: 'nextHint', label: '🧩 Nächster Hinweis', live: true });
      if (!q.locked) {
        buttons.push(q.pausedAt ? { c: 'resume', label: '▶ Weiter' } : { c: 'pause', label: '⏸ Pause', cls: 'ghost' });
        buttons.push({ c: 'addTime', label: '+10 s', cls: 'ghost' });
        buttons.push({ c: 'lock', label: isBuzzType(q.question) ? 'Buzzer schließen' : 'Antworten schließen', cls: 'ghost' });
      }
      buttons.push({ c: 'skip', label: '⏭ Überspringen', cls: 'ghost' });
      primary = { label: 'Auflösen', c: 'reveal' };
      break;
    case 'reveal': {
      let label = 'Weiter';
      if (q.src === 'game') label = S.game.qi + 1 < g.questions.length ? 'Nächste Frage' : 'Spiel auswerten';
      if (q.src === 'tie') label = 'Stechen auswerten';
      primary = { label, c: 'afterReveal' };
      break;
    }
    case 'manual':
      if (Number(g.timer)) buttons.push({ c: 'mtimer', label: S.manualTimer ? 'Timer neu starten' : 'Timer starten', live: true });
      buttons.push({ c: 'toBoard', label: 'Abbrechen', cls: 'ghost' });
      if (manualSel.size >= 2) buttons.push({ c: 'manualTie', label: 'Stechfrage zwischen Auswahl', live: true });
      primary = { label: 'Sieger bestätigen', c: 'manualWin', disabled: manualSel.size !== 1 };
      break;
    case 'tie':
      primary = { label: 'Stechfrage starten', c: 'startTie', disabled: !pickTieQuestion() };
      break;
    case 'gameEnd':
      primary = { label: 'Zwischenstand', c: 'standings' };
      break;
    case 'standings':
      primary = { label: 'Zur Spieltafel', c: 'toBoard' };
      break;
    case 'finalIntro':
      buttons.push({ c: 'toBoard', label: 'Zurück zur Tafel', cls: 'ghost' });
      primary = { label: 'Finale starten', c: 'nextFinal' };
      break;
    case 'stats':
      primary = { label: 'Zur Siegerehrung', c: 'toEnd' };
      break;
    case 'end':
      buttons.push({ c: 'toBoardFromEnd', label: 'Spieltafel ansehen', cls: 'ghost' });
      break;
  }
  return { primary, buttons };
}

function renderControls() {
  const el = $('#controls');
  if (!el || previewMode) return;
  const n = pids().filter(connected).length;
  const gmN = Object.keys(S.gms || {}).filter(connected).length;
  document.body.classList.toggle('gm-on', gmN > 0);
  const dot = { online: 'on', reconnecting: 'warn', 'waiting-id': 'warn', connecting: 'warn', error: 'off' }[netStatus] || 'warn';
  const stLabel = { online: 'Online', reconnecting: 'Verbinde neu …', 'waiting-id': 'Raum wird wiederhergestellt …', connecting: 'Verbinde …', error: 'Verbindungsfehler' }[netStatus] || netStatus;
  const { primary, buttons } = controlsModel();
  const btns = buttons.map(b => `<button class="btn ${b.cls && b.cls.includes('judge') ? '' : 'small'} ${b.cls || ''}" data-c="${b.c}">${b.label}${b.key ? ` <span class="kbd">${b.key}</span>` : ''}</button>`);

  el.innerHTML = `
    <span class="status"><span class="dot ${dot}"></span>${stLabel} · ${n} verbunden${gmN ? ' · 🎙' : ''} · <b>${S.code}</b></span>
    ${btns.join('')}
    <span class="spacer"></span>
    <button class="btn small ghost" data-c="undo" title="Rückgängig (Strg+Z)" ${undoStack.length ? '' : 'disabled'}>↶</button>
    <button class="btn small ghost" data-c="mute" title="Ton an/aus (M)">${isMuted() ? '🔇' : '🔊'}</button>
    <button class="btn small ghost" data-c="fullscreen" title="Vollbild (F)">⛶</button>
    <button class="btn small danger" data-c="quit">Beenden</button>
    ${primary ? `<button class="btn primary" id="primary" data-c="${primary.c}" ${primary.disabled ? 'disabled' : ''}>${primary.label}<span class="kbd">Leertaste</span></button>` : ''}`;

  $$('[data-c]', el).forEach(b => b.onclick = () => command(b.dataset.c));
}

const UNDOABLE = new Set(['toBoard', 'toEnd', 'nextGame', 'finish', 'beginGame', 'release', 'lock', 'reveal', 'buzzRight', 'buzzWrong',
  'afterReveal', 'manualWin', 'manualTie', 'startTie', 'nextFinal', 'skip', 'addTime', 'toBoardFromEnd', 'standings',
  'startShow', 'showNext', 'skipShow', 'nextHint']);

function command(c) {
  if (UNDOABLE.has(c)) pushUndo(c);
  switch (c) {
    case 'undo': undo(); break;
    case 'pause': pauseTimer(); break;
    case 'resume': resumeTimer(); break;
    case 'addTime': addTime(); break;
    case 'skip': skipQuestion(); break;
    case 'nextHint': nextHint(); break;
    case 'startShow': startShow(); break;
    case 'showNext': showNext(); break;
    case 'skipShow': S.phase = 'board'; update(); break;
    case 'standings': S.phase = 'standings'; update(); break;
    case 'testplayer': window.open('play.html?r=' + S.code + '&test=' + Date.now(), '_blank'); break;
    case 'toBoard': stopMedia(); S.phase = 'board'; S.q = null; update(); break;
    case 'toBoardFromEnd': S.phase = 'board'; update(); break;
    case 'toEnd': toEnd(); break;
    case 'lobby': S.qrOverlay = !S.qrOverlay; update(); break; // QR-Code einblenden, ohne den Spielstand zu verlassen
    case 'editScores': editScores = !editScores; render(); break;
    case 'nextGame': startGame(nextUnplayed()); break;
    case 'finish': toFinish(); break;
    case 'beginGame': beginGame(); break;
    case 'release': releaseAnswers(); break;
    case 'lock': lockQuestion(true); break;
    case 'reveal': reveal(); break;
    case 'buzzRight': judgeBuzz(true); break;
    case 'buzzWrong': judgeBuzz(false); break;
    case 'afterReveal': afterReveal(); break;
    case 'mtimer': S.manualTimer = { end: Date.now() + Number(curGame().timer) * 1000 }; manualEndPlayed = false; lastTick = null; sfx('start'); update(); break;
    case 'manualWin': awardGame([...manualSel]); break;
    case 'manualTie': S.tie = { context: 'game', pids: [...manualSel] }; S.phase = 'tie'; update(); break;
    case 'startTie': startTie(); break;
    case 'nextFinal': nextFinalQuestion(); break;
    case 'mute': toggleMute(); renderControls(); broadcast(); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'quit':
      if (!confirm('Abend wirklich beenden? Der Spielstand wird gelöscht.')) return;
      pids().forEach(pid => net.send(pid, { t: 'view', v: { phase: 'closed', icon: '👋', title: 'Der Abend ist beendet', sub: 'Danke fürs Mitspielen!', me: viewFor(pid).me } }));
      setTimeout(async () => { await kvDel('session'); S = null; location.hash = ''; }, 400);
      break;
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

// ---------------------------------------------------------------- Vorschau im Editor

// Zeigt eine einzelne Frage so, wie sie auf dem TV aussehen würde (ohne Netzwerk, ohne Speichern).
export function renderPreview(container, quiz, question, mode = 'q') {
  const saved = S;
  const savedKey = lastStageKey;
  previewMode = true;
  const demo = [
    { id: 'demo1', name: 'Anna', color: PLAYER_COLORS[0] },
    { id: 'demo2', name: 'Ben', color: PLAYER_COLORS[1] },
    { id: 'demo3', name: 'Clara', color: PLAYER_COLORS[2] },
  ];
  S = createSession({ ...quiz, games: [{ title: 'Vorschau', questions: [question], type: 'quiz', points: 1 }] }, 'single');
  demo.forEach(p => { S.players[p.id] = p; S.order.push(p.id); S.totals[p.id] = 0; });
  S.game = { idx: 0, qi: 0, correct: {}, doubled: {} };
  S.q = {
    src: 'game', question, eligible: demo.map(p => p.id), answers: {}, start: Date.now() - 3000, dur: (Number(question.time) || 20) * 1000,
    locked: false, result: null, fifty: {}, extra: {}, buzz: null, buzzResult: null, lockedOut: [], marks: {}, hintBonus: 1, pausedAt: Date.now(),
    shuffle: question.type === 'order' ? shuffle(orderIndices(question)) : null,
  };
  if (mode === 'reveal') {
    // Beispielantworten, damit die Auflösung etwas zeigt
    const q = S.q;
    demo.forEach((p, k) => {
      let v;
      if (question.type === 'mc') v = k === 0 ? question.correct : orderIndices({ items: question.options }).find(i => i !== question.correct) ?? question.correct;
      else if (question.type === 'tf') v = k === 0 ? question.correct : !question.correct;
      else if (question.type === 'hilo') v = k === 0 ? hiloHigher(question) : !hiloHigher(question);
      else if (question.type === 'estimate') v = Number(question.correct) * (1 + (k - 1) * 0.15) || k;
      else if (question.type === 'order') v = k === 0 ? orderIndices(question) : shuffle(orderIndices(question));
      else if (isTextType(question)) { v = k === 0 ? question.answer : 'Falsche Antwort'; q.marks[p.id] = k === 0; }
      if (v !== undefined) q.answers[p.id] = { v, ms: 3000 + k * 1000 };
    });
    if (isBuzzType(question)) { q.buzz = demo[0].id; q.buzzResult = 'right'; }
    S.phase = 'reveal';
    // Wertung wie im Spiel, aber ohne Nebenwirkungen
    reveal.call(null);
  } else {
    S.phase = 'q';
  }
  const html = S.phase === 'reveal' ? renderReveal() : renderQuestion();
  container.innerHTML = `<div class="stage preview-stage">${html}</div>`;
  const st = container.querySelector('.stage');
  hydrateMedia(st);
  const cv = st.querySelector('#pix');
  if (cv) {
    cv.id = 'pix';
    const img = new Image();
    img.onload = () => {
      const level = mode === 'reveal' ? 1 : 45;
      const sc = Math.min(1, 1200 / img.naturalWidth);
      cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
      const ctx = cv.getContext('2d');
      const sw = Math.max(1, Math.round(cv.width / level)), sh = Math.max(1, Math.round(cv.height / level));
      const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
      tmp.getContext('2d').drawImage(img, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = level <= 1; ctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, cv.width, cv.height);
    };
    img.src = question.image;
  }
  requestAnimationFrame(() => fitText(st));
  S = saved;
  lastStageKey = savedKey;
  previewMode = false;
}
