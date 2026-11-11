// Spielleiter-Ansicht (Laptop/TV): steuert den ganzen Abend.
import { kvGet, kvSet, kvDel } from './store.js';
import { createHost } from './net.js';
import { correctText, formatNumber, uid, orderIndices, JOKERS } from './model.js';
import { $, $$, esc, toast, confetti, PLAYER_COLORS, OPTION_COLORS, OPTION_LETTERS } from './ui.js';
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

const EXTRA_MS = 10000;  // Zusatzzeit-Joker
const GRACE_MS = 400;    // Toleranz für Antworten kurz vor Schluss
const GM_PASSWORD = '12345'; // Schutz vor versehentlichem Spielleiter-Login (kein echter Zugriffsschutz)
const UNDO_MAX = 25;
let undoStack = [];      // Schnappschüsse für „Rückgängig“ (nur im Speicher)
let barTimer = null;
let barPinned = false;

// ---------------------------------------------------------------- Start / Ende

export function createSession(quiz, mode, jokers = {}) {
  return {
    v: 2,
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
    phase: 'lobby',
    game: null, q: null, tie: null, final: null, manualTimer: null,
    usedTie: [], champion: null,
  };
}

export async function startHost(root, makeCode) {
  S = await kvGet('session');
  if (!S) { location.hash = ''; return; }
  if (!S.code) { S.code = makeCode(); save(); }
  S.jokerCfg = S.jokerCfg || { double: 0, fifty: 0, time: 0 };
  S.jl = S.jl || {};
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
  render();
}

export function stopHost() {
  intervals.forEach(clearInterval);
  intervals = [];
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  document.removeEventListener('mousemove', showBar);
  if (net) net.destroy();
  net = null;
  document.body.classList.remove('stage-mode', 'gm-on', 'show-bar');
}

// Steuerleiste am Laptop: ausgeblendet, solange ein Spielleiter-Handy steuert; Maus oder H holt sie zurück.
const gmConnected = () => Object.keys(S.gms || {}).some(connected);
function showBar() {
  document.body.classList.add('show-bar');
  clearTimeout(barTimer);
  if (!barPinned) barTimer = setTimeout(() => document.body.classList.remove('show-bar'), 3000);
}

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
  // Laufende Frage: verstrichene Zeit seit dem Schnappschuss nicht anrechnen
  if (S.phase === 'q' && S.q && S.q.start && !S.q.pausedAt) S.q.start += Date.now() - snap.at;
  lastStageKey = null;
  manualSel = new Set();
  toast('↶ Rückgängig gemacht');
  update();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('session', S).catch(e => toast('Speichern fehlgeschlagen: ' + e.message)), 250);
}

function update() { save(); render(); broadcast(); }

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

function chip(pid, extra = '', suffix = '') {
  const p = P(pid);
  return `<span class="chip ${extra}"><span class="sw" style="background:${p.color}"></span>${esc(p.name)}${suffix}</span>`;
}

function nextUnplayed() { return S.results.findIndex(r => !r); }
function rankedByTotals() { return pids().slice().sort((a, b) => (S.totals[b] || 0) - (S.totals[a] || 0)); }

// Zeitfenster einer Frage (mit Zusatzzeit-Joker)
const nowQ = () => (S.q && S.q.pausedAt) || Date.now(); // bei Pause steht die Uhr
const qEnd = () => S.q.start + S.q.dur;
const endFor = pid => qEnd() + ((S.q.extra && S.q.extra[pid]) || 0);
const openFor = pid => !!(S.q && S.q.start && !S.q.locked && nowQ() <= endFor(pid) + GRACE_MS);
const buzzPending = () => S && S.phase === 'q' && S.q && S.q.question.type === 'buzzer' && S.q.buzz && !S.q.buzzResult;

function banner(text, color = 'var(--accent)') {
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
    if (!S.players[pid]) {
      let name = String(msg.name || '').trim().slice(0, 24) || `${T().one} ${S.order.length + 1}`;
      const taken = new Set(pids().map(nameOf));
      let n = 2; const base = name;
      while (taken.has(name)) name = `${base} ${n++}`;
      const color = PLAYER_COLORS[S.order.length % PLAYER_COLORS.length];
      S.players[pid] = { id: pid, name, color };
      S.order.push(pid);
      S.totals[pid] = S.totals[pid] || 0;
      S.jl[pid] = { ...S.jokerCfg };
      if (S.final) initFinalPlayer(pid);
      if (S.phase === 'lobby') { toast(`${name} ist beigetreten`); sfx('join'); }
    }
    if (!S.jl[pid]) S.jl[pid] = { ...S.jokerCfg };
    update();
    return;
  }
  if (msg.t === 'answer') handleAnswer(pid, msg.qid, msg.value);
  if (msg.t === 'buzz') handleBuzz(pid, msg.qid);
  if (msg.t === 'joker') handleJoker(pid, msg.kind, msg.qid);
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

// ---------------------------------------------------------------- Fragen

function openQuestion(src, question, eligible) {
  const waiting = !!(question.media && question.mediaFirst);
  S.q = {
    src, question, eligible, answers: {}, start: waiting ? null : Date.now(),
    dur: (Number(question.time) || 20) * 1000, locked: false, result: null,
    fifty: {}, extra: {}, buzz: null, buzzResult: null,
    shuffle: question.type === 'order' ? shuffle(orderIndices(question)) : null,
  };
  lastTick = null;
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
  if (sound) sfx('end');
  update();
}

function handleAnswer(pid, qid, value) {
  const q = S.q;
  if (S.phase !== 'q' || !q || q.question.id !== qid || q.question.type === 'buzzer') return;
  if (!q.eligible.includes(pid) || q.answers[pid] || !openFor(pid)) return;
  const qu = q.question;
  let v = value;
  if (qu.type === 'mc') { v = Number(v); if (!Number.isInteger(v) || !String(qu.options[v] || '').trim()) return; }
  else if (qu.type === 'tf') { if (typeof v !== 'boolean') return; }
  else if (qu.type === 'order') {
    const valid = orderIndices(qu);
    if (!Array.isArray(v) || v.length !== valid.length || [...v].sort((a, b) => a - b).join() !== valid.join()) return;
    v = v.map(Number);
  } else { v = Number(v); if (!Number.isFinite(v)) return; }
  q.answers[pid] = { v, ms: Date.now() - q.start };
  const waiting = q.eligible.filter(id => connected(id) && !q.answers[id]);
  if (!waiting.length) { q.locked = true; }
  update();
}

function handleBuzz(pid, qid) {
  const q = S.q;
  if (S.phase !== 'q' || !q || q.question.id !== qid || q.question.type !== 'buzzer') return;
  if (!q.start || q.locked || q.buzz || !q.eligible.includes(pid)) return;
  q.buzz = pid;
  q.buzzAt = Date.now() - q.start;
  q.locked = true;
  stopMedia();
  sfx('buzz');
  banner(`🔔 ${nameOf(pid)}`, P(pid).color);
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
      if (q.question.type === 'buzzer' || q.extra[pid]) return;
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
  if (!S.q || !S.q.pausedAt) return;
  S.q.start += Date.now() - S.q.pausedAt;
  S.q.pausedAt = null;
  update();
}

function addTime(ms = 10000) {
  if (S.phase !== 'q' || !S.q || !S.q.start || S.q.locked) return;
  S.q.dur += ms;
  lastTick = null;
  banner('⏱ +10 Sekunden für alle');
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
  if (!S) return;
  if (S.phase === 'q' && S.q && S.q.start && !S.q.locked && S.q.pausedAt) {
    const num = $('#tnum'); if (num) num.textContent = '⏸';
    return;
  }
  if (S.phase === 'q' && S.q && S.q.start && !S.q.locked) {
    const now = Date.now();
    const main = qEnd() - now;
    if (main <= 0) {
      const extraPending = S.q.eligible.some(id => S.q.extra[id] && !S.q.answers[id] && now <= endFor(id));
      if (!extraPending) { lockQuestion(true); return; }
      const restExtra = Math.max(...S.q.eligible.filter(id => S.q.extra[id] && !S.q.answers[id]).map(id => endFor(id) - now));
      const num = $('#tnum'); if (num) num.textContent = '+' + Math.ceil(restExtra / 1000);
      const bar = $('#tbar'); if (bar) bar.style.transform = 'scaleX(0)';
      return;
    }
    const sec = Math.ceil(main / 1000);
    if (sec <= 5 && sec !== lastTick) { lastTick = sec; sfx('tick'); }
    const bar = $('#tbar'); const num = $('#tnum');
    if (bar) bar.style.transform = `scaleX(${Math.max(0, main / S.q.dur)})`;
    if (num) num.textContent = sec;
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

function isRight(qu, v) {
  if (qu.type === 'order') return Array.isArray(v) && v.join() === orderIndices(qu).join();
  return v === qu.correct;
}

function reveal() {
  const q = S.q, qu = q.question;
  q.locked = true;
  stopMedia();
  let winners = [];
  if (qu.type === 'buzzer') {
    if (q.buzz && q.buzzResult === 'right') winners = [q.buzz];
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
  if (q.src === 'game') {
    winners.forEach(pid => { S.game.correct[pid] = (S.game.correct[pid] || 0) + 1; });
    q.result.penalty.forEach(pid => { S.game.correct[pid] = (S.game.correct[pid] || 0) - 1; });
  }
  if (q.src === 'final') applyFinal(q, winners);
  S.phase = 'reveal';
  if (qu.type !== 'buzzer') sfx('reveal');
  update();
}

function judgeBuzz(right) {
  if (!buzzPending()) return;
  S.q.buzzResult = right ? 'right' : 'wrong';
  sfx(right ? 'right' : 'wrong');
  reveal();
}

function afterReveal() {
  const src = S.q.src;
  if (src === 'game') return nextGameQuestion();
  if (src === 'tie') return resolveTie();
  if (src === 'final') return afterFinalQuestion();
}

// ---------------------------------------------------------------- Vorrundenspiele

function startGame(idx) {
  if (S.results[idx]) return;
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

function startFinal() {
  const f = S.quiz.final;
  S.final = { qi: -1, scores: {}, lives: {}, target: Number(f.target) || 10, targetRaised: false };
  pids().forEach(initFinalPlayer);
  if (f.winMode === 'target') {
    const maxStart = Math.max(0, ...pids().map(pid => S.final.scores[pid]));
    if (maxStart >= S.final.target) { S.final.target = maxStart + 1; S.final.targetRaised = true; }
  }
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
  } else {
    losers = q.eligible.filter(pid => !winners.includes(pid));
  }
  // Würden alle Verbliebenen rausfliegen, verliert in dieser Runde niemand ein Leben.
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

// ---------------------------------------------------------------- Ansicht für Handys

function viewFor(pid) {
  const p = P(pid);
  const ranked = rankedByTotals();
  const mine = S.totals[pid] || 0;
  const v = {
    phase: S.phase, mode: S.mode,
    me: { name: p.name, color: p.color, total: mine, rank: 1 + ranked.filter(o => (S.totals[o] || 0) > mine).length, of: ranked.length, jokers: S.jl[pid] || {} },
    icon: '🎲', title: '', sub: '',
  };
  const inFinal = S.final && (S.phase === 'finalIntro' || S.phase === 'end'
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
      Object.assign(v, { icon: '🎉', title: 'Du bist dabei!', sub: 'Warte, bis der Spielleiter startet.' }); break;
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
    case 'finalIntro':
      Object.assign(v, { icon: '🔥', title: S.quiz.final.title || 'Finale', sub: v.final && v.final.lives !== undefined ? `Deine Leben: ${v.final.lives}` : `Dein Startwert: ${v.final ? v.final.score : 0}` }); break;
    case 'q': {
      const q = S.q, qu = q.question;
      if (q.eligible.includes(pid)) {
        const now = Date.now();
        const left = S.jl[pid] || {};
        const open = openFor(pid);
        const removed = q.fifty[pid] || [];
        v.q = {
          id: qu.id, type: qu.type, text: qu.text, unit: qu.unit || '',
          options: qu.type === 'mc' ? qu.options.map((t, i) => ({ i, t })).filter(o => String(o.t).trim() && !removed.includes(o.i)) : null,
          items: qu.type === 'order' ? q.shuffle.map(i => ({ i, t: qu.items[i] })) : null,
          waiting: !q.start,
          paused: !!q.pausedAt,
          remaining: q.start ? Math.max(0, endFor(pid) - nowQ()) : 0,
          dur: q.dur + (q.extra[pid] || 0),
          answered: !!q.answers[pid],
          locked: !!q.start && !open,
          buzz: qu.type === 'buzzer' && q.buzz ? { me: q.buzz === pid, name: nameOf(q.buzz) } : null,
          usedFifty: !!q.fifty[pid], usedTime: !!q.extra[pid],
          jokers: q.src !== 'tie' && open && !q.answers[pid] ? {
            fifty: qu.type === 'mc' && !q.fifty[pid] ? left.fifty || 0 : 0,
            time: qu.type !== 'buzzer' && !q.extra[pid] ? left.time || 0 : 0,
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
        type: qu.type,
        eligible: q.eligible.includes(pid),
        answered: qu.type === 'buzzer' ? q.buzz === pid : !!a,
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
  if (qu.type === 'order') return v.map(i => qu.items[i]).join(' → ');
  return formatNumber(v) + (qu.unit ? ' ' + qu.unit : '');
}

// ---------------------------------------------------------------- Rendern

let lastStageKey = null;

// Gleiche Bühne wie zuvor? Dann nur Teile aktualisieren, damit Animationen und Videos nicht neu starten.
function stageKey() {
  if (S.phase === 'q') return `q|${S.q.question.id}|${S.q.src}`;
  if (S.phase === 'intro') return `intro|${S.game.idx}`;
  if (S.phase === 'lobby') return 'lobby';
  return null;
}

function render() {
  const stage = $('#stage');
  if (!stage) return;
  const key = stageKey();
  if (key && key === lastStageKey) {
    if (S.phase === 'q') {
      const d = $('#q-dyn'); if (d) d.innerHTML = qDynamic();
      const n = $('#answered-count'); if (n) n.textContent = countLabel();
    }
    if (S.phase === 'intro') { const j = $('#joker-row'); if (j) j.innerHTML = doubledRow(); }
    if (S.phase === 'lobby') {
      const c = $('#lobby-chips'); if (c) c.innerHTML = lobbyChips();
      const n = $('#lobby-count'); if (n) n.textContent = `(${pids().length})`;
    }
    bindStage();
    renderControls();
    onTick();
    return;
  }
  lastStageKey = key;
  const fn = {
    lobby: renderLobby, board: renderBoard, intro: renderIntro, q: renderQuestion, reveal: renderReveal,
    manual: renderManual, tie: renderTie, gameEnd: renderGameEnd, finalIntro: renderFinalIntro, end: renderEnd,
  }[S.phase];
  stage.innerHTML = fn ? fn() : '';
  bindStage();
  renderControls();
  if (S.phase === 'lobby') drawQR();
  if (S.phase === 'q') attachMedia(stage);
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
      // Nur den eingestellten Ausschnitt spielen
      m.ontimeupdate = () => { if (end && m.currentTime >= end) { m.pause(); m.currentTime = end; releaseAnswers(); } };
      if (m.readyState >= 1) play(); else m.addEventListener('loadedmetadata', play, { once: true });
    });
  });
}

function renderSoft() {
  if (S.phase === 'lobby') { const c = $('#lobby-chips'); if (c) c.innerHTML = lobbyChips(); bindStage(); }
  renderControls();
}

function top(left, right = '') {
  return `<div class="stage-top"><div>${left}</div><div>${right}</div></div>`;
}

function joinUrl() { return new URL('play.html?r=' + S.code, location.href).href; }

function lobbyChips() {
  const list = pids();
  if (!list.length) return `<span class="muted mid">Noch niemand da …</span>`;
  return list.map(pid => `<span class="chip ${connected(pid) ? '' : 'off'}"><span class="sw" style="background:${P(pid).color}"></span>${esc(nameOf(pid))}<button data-kick="${pid}" title="Entfernen">✕</button></span>`).join('');
}

function jokerSummary() {
  const parts = Object.entries(JOKERS).filter(([k]) => S.jokerCfg[k] > 0).map(([k, j]) => `${j.icon} ${j.label} ×${S.jokerCfg[k]}`);
  return parts.length ? `Joker pro ${T().one}: ${parts.join(' · ')}` : '';
}

function renderLobby() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return `${top(`<b>${esc(S.quiz.title)}</b> · ${S.mode === 'team' ? 'Teammodus' : 'Einzelmodus'}`, esc(jokerSummary()))}
  <div class="lobby">
    <div style="text-align:center">
      <div class="qrbox" id="qr"></div>
      <div class="mid" style="margin-top:2vh">Code</div>
      <div class="joincode">${S.code}</div>
      <div class="joinurl">${esc(joinUrl())}</div>
      ${local ? `<div class="notice" style="margin-top:2vh;text-align:left;font-size:.9rem">Lokaler Test: Handys erreichen „localhost“ nicht. Öffne zum Testen Spieler-Tabs über den Button unten.</div>` : ''}
    </div>
    <div>
      <div class="big">${S.mode === 'team' ? 'Teams' : 'Spieler'} <span class="muted" id="lobby-count">(${pids().length})</span></div>
      <p class="mid muted">Scannt den QR-Code mit dem Handy und gebt ${S.mode === 'team' ? 'euren Teamnamen' : 'euren Namen'} ein.</p>
      <div class="chips" id="lobby-chips">${lobbyChips()}</div>
      <p class="muted" style="margin-top:4vh">🎙 Spielleiter: denselben QR-Code scannen und „Spielleiter“ wählen.</p>
    </div>
  </div>`;
}

function drawQR() {
  const el = $('#qr');
  if (!el || typeof QRCode === 'undefined') { if (el) el.innerHTML = '<p style="color:#000">QR-Code nicht verfügbar</p>'; return; }
  el.innerHTML = '';
  new QRCode(el, { text: joinUrl(), width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
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
      <span class="nm"><span class="sw dot" style="background:${P(pid).color}"></span>${esc(nameOf(pid))}${jokerIcons(pid)}</span>
      <span class="row" style="gap:6px;align-items:center"><span class="adj"><button data-adj="${pid}" data-d="-1">−</button><button data-adj="${pid}" data-d="1">+</button></span><span class="val">${S.totals[pid] || 0}</span></span>
    </div>`).join('') || '<span class="muted">Keine Mitspieler</span>'}</div>`;
}

function renderBoard() {
  const next = nextUnplayed();
  const f = S.quiz.final;
  const tiles = S.quiz.games.map((g, i) => {
    const r = S.results[i];
    if (r) {
      const p = P(r.winners[0]);
      const got = r.pts ? r.pts[r.winners[0]] : r.points;
      return `<div class="tile done" style="border-color:${p.color};background:${p.color}22">
        <span class="pts">${got} P${r.doubled && r.doubled.includes(r.winners[0]) ? ' ⚡' : ''}</span><span class="n" style="color:${p.color}">${i + 1}</span>
        <span class="w">${esc(g.title)}</span><span class="w" style="color:${p.color}">${esc(listNames(r.winners))}</span></div>`;
    }
    return `<div class="tile ${i === next ? 'next' : ''}" data-game="${i}"><span class="pts">${g.points} P</span><span class="n">${i + 1}</span><span class="w muted">?</span></div>`;
  }).join('');
  const finalTile = f.enabled ? `<div class="tile final ${next === -1 ? 'next' : ''}" ${next === -1 ? 'data-final="1"' : ''}><span class="n">🔥 ${esc(f.title || 'Finale')}</span></div>` : '';
  const played = S.results.filter(Boolean).length;
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `${played} / ${S.quiz.games.length} Spiele gespielt`)}
    <div class="board"><div class="tiles">${tiles}${finalTile}</div>${scoresPanel()}</div>`;
}

function doubledRow() {
  const d = Object.keys((S.game && S.game.doubled) || {});
  if (!d.length) return S.jokerCfg.double > 0 ? '<span class="muted">Jetzt kann der Verdoppeln-Joker am Handy gesetzt werden.</span>' : '';
  return d.map(pid => chip(pid, 'doubled', ' ⚡ ×2')).join('');
}

function renderIntro() {
  const g = curGame();
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `Spiel ${S.game.idx + 1} / ${S.quiz.games.length}`)}
  <div class="center ringed">
    <div class="ring"></div>
    <div class="intro-num">Spiel ${S.game.idx + 1}</div>
    <div class="huge intro-title">${esc(g.title)}</div>
    ${g.description ? `<div class="mid intro-desc">${esc(g.description)}</div>` : ''}
    <div class="mid intro-pts">Sieg: ${pointsLabel(g.points)}${g.type === 'quiz' ? ` · ${g.questions.length} Fragen` : ''}</div>
    <div class="chips" id="joker-row" style="justify-content:center;margin-top:3vh">${doubledRow()}</div>
  </div>`;
}

function qLabel() {
  const q = S.q;
  if (q.src === 'game') return `<b>${esc(curGame().title)}</b> · Frage ${S.game.qi + 1} / ${curGame().questions.length}`;
  if (q.src === 'tie') return `<b>Stechfrage</b> · ${esc(listNames(q.eligible))}`;
  return `<b>${esc(S.quiz.final.title || 'Finale')}</b> · Frage ${S.final.qi + 1}`;
}

function countLabel() {
  const q = S.q;
  if (q.question.type === 'buzzer') return 'Buzzer-Frage';
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
  if (qu.image) return `<div class="qimg"><img src="${qu.image}" alt=""></div>`;
  return '<div style="flex:1"></div>';
}

function optionTiles(reveal) {
  const q = S.q, qu = q.question;
  const opts = qu.type === 'tf'
    ? [{ i: true, t: 'Wahr', c: '#22a06b', l: '✓' }, { i: false, t: 'Falsch', c: '#e63e5c', l: '✗' }]
    : qu.options.map((t, i) => ({ i, t, c: OPTION_COLORS[i], l: OPTION_LETTERS[i] })).filter(o => String(o.t).trim());
  return `<div class="answers-grid">${opts.map((o, k) => {
    const who = reveal ? Object.entries(q.answers).filter(([, a]) => a.v === o.i).map(([pid]) => `<span>${esc(nameOf(pid))}</span>`).join('') : '';
    const cls = reveal ? (o.i === qu.correct ? 'right' : 'dim') : '';
    return `<div class="ans ${cls}" style="background:${o.c};animation-delay:${k * 0.08}s"><span class="l">${o.l}</span><span class="txt">${esc(o.t)}</span>${reveal ? `<span class="who">${who}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

function typeBlock(qu) {
  if (qu.type === 'mc' || qu.type === 'tf') return optionTiles(false);
  if (qu.type === 'estimate') return `<div class="center" style="flex:none"><div class="big muted">Schätzt! ${qu.unit ? `(in ${esc(qu.unit)})` : ''}</div></div>`;
  if (qu.type === 'order') {
    return `<div class="order-list">${S.q.shuffle.map((i, k) => `<div class="order-item" style="animation-delay:${k * 0.08}s">${esc(qu.items[i])}</div>`).join('')}</div>
      <div class="muted" style="text-align:center">Bringt die Einträge am Handy in die richtige Reihenfolge.</div>`;
  }
  return '';
}

function qDynamic() {
  const q = S.q, qu = q.question;
  if (!q.start) {
    return `<div class="wait-msg mid">${qu.media && qu.media.kind === 'youtube' ? '▶ Schaut genau hin …' : '👀 Gut aufpassen …'} Die Antworten werden gleich freigegeben.</div>`;
  }
  const timer = `<div class="timer-row"><div class="timer"><i id="tbar" ${q.locked ? 'style="transform:scaleX(0)"' : ''}></i></div><div class="timer-num" id="tnum">${q.locked ? '0' : ''}</div></div>`;
  if (qu.type === 'buzzer') {
    if (q.buzz) {
      const p = P(q.buzz);
      return `<div class="buzz-box" style="border-color:${p.color}"><div class="huge" style="color:${p.color}">🔔 ${esc(p.name)}</div>
        <div class="mid muted">hat gebuzzert – Antwort bitte laut!</div></div>`;
    }
    return `${timer}<div class="buzz-ready ${q.locked ? 'off' : ''}">${q.locked ? 'Niemand hat gebuzzert' : '🔔 Buzzer frei!'}</div>`;
  }
  const extra = Object.keys(q.extra || {});
  const fifty = Object.keys(q.fifty || {});
  const chips = q.eligible.map(pid => chip(pid, `${q.answers[pid] ? 'answered' : ''} ${connected(pid) ? '' : 'off'}`,
    `${fifty.includes(pid) ? ' ½' : ''}${extra.includes(pid) ? ' ⏱' : ''}`)).join('');
  return `${timer}<div class="chips answered-row" id="answered-chips">${chips}</div>
    ${q.locked ? '<div class="center" style="flex:none"><div class="mid" style="color:var(--accent)">Antworten geschlossen – bereit zur Auflösung</div></div>' : ''}`;
}

function renderQuestion() {
  const qu = S.q.question;
  return `${top(qLabel(), `<span id="answered-count">${countLabel()}</span>`)}
  <div class="qwrap">
    <div class="qtext">${esc(qu.text)}</div>
    ${mediaBlock(qu)}
    ${typeBlock(qu)}
    <div id="q-dyn" class="q-dyn">${qDynamic()}</div>
  </div>`;
}

function renderReveal() {
  const q = S.q, qu = q.question;
  let body;
  if (qu.type === 'estimate') {
    const rows = (q.ranking || []).map((x, k) => `<div class="est-row ${q.result.winners.includes(x.pid) ? 'win' : ''}" style="animation-delay:${0.3 + k * 0.08}s">
      <span>${chip(x.pid)}</span><span>${formatNumber(x.v)} ${esc(qu.unit || '')}</span><span class="diff">±${formatNumber(x.d)}</span></div>`).join('');
    body = `<div class="estimate-box"><div class="big">Lösung: <span class="solution">${esc(correctText(qu))}</span></div></div>
      <div class="est-list">${rows || '<div class="muted mid" style="text-align:center">Keine Antworten</div>'}</div>`;
  } else if (qu.type === 'order') {
    body = `<div class="order-list solution-list">${orderIndices(qu).map((i, k) => `<div class="order-item right" style="animation-delay:${k * 0.15}s"><b>${k + 1}.</b> ${esc(qu.items[i])}</div>`).join('')}</div>`;
  } else if (qu.type === 'buzzer') {
    const verdict = q.buzz
      ? (q.buzzResult === 'right'
        ? `<div class="big" style="color:var(--good)">✓ ${esc(nameOf(q.buzz))} lag richtig!</div>`
        : `<div class="big" style="color:var(--bad)">✗ ${esc(nameOf(q.buzz))} lag falsch – Minuspunkt</div>`)
      : '<div class="big muted">Niemand hat gebuzzert</div>';
    body = `<div class="estimate-box"><div class="big">Lösung: <span class="solution">${esc(correctText(qu))}</span></div></div><div class="center" style="flex:none">${verdict}</div>`;
  } else {
    body = optionTiles(true);
  }
  return `${top(qLabel(), 'Auflösung')}
  <div class="qwrap">
    <div class="qtext">${esc(qu.text)}</div>
    ${qu.image && !qu.media && (qu.type === 'mc' || qu.type === 'tf') ? `<div class="qimg"><img src="${qu.image}" alt=""></div>` : ''}
    ${body}
    ${revealFooter()}
  </div>`;
}

function revealFooter() {
  const q = S.q;
  if (q.src === 'game') {
    const g = curGame();
    return `<div class="chips answered-row">${pids().map(pid => {
      const cls = q.result.winners.includes(pid) ? 'answered' : (q.result.penalty || []).includes(pid) ? 'penalty' : '';
      return `<span class="chip ${cls}"><span class="sw" style="background:${P(pid).color}"></span>${esc(nameOf(pid))} <b>${S.game.correct[pid] || 0}</b></span>`;
    }).join('')}</div>
      <div class="muted" style="text-align:center">Richtige Antworten in „${esc(g.title)}“</div>`;
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
    return `<span class="chip ${cls}" ${elim && hit ? 'style="outline:3px solid var(--bad)"' : ''}><span class="sw" style="background:${P(pid).color}"></span>${esc(nameOf(pid))} <b class="${elim ? 'hearts' : ''}">${val}</b></span>`;
  }).join('');
  const goal = f.winMode === 'target' ? `Ziel: ${F.target} Punkte` : f.winMode === 'count' ? `Frage ${Math.min(F.qi + 1, finalLimit())} von ${finalLimit()}` : 'Wer zuletzt noch Leben hat, gewinnt';
  const saved = result && result.saved ? ' · Alle lagen falsch – niemand verliert ein Leben' : '';
  return `<div class="chips answered-row">${chips}</div><div class="muted" style="text-align:center">${goal}${saved}</div>`;
}

function renderManual() {
  const g = curGame();
  const t = Number(g.timer) || 0;
  const timerHtml = t ? `<div class="big-timer" id="mtimer">${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</div>` : '';
  const dbl = Object.keys(S.game.doubled || {});
  return `${top(`<b>${esc(g.title)}</b> · Spiel ${S.game.idx + 1}`, `Sieg: ${pointsLabel(g.points)}`)}
  <div class="center">
    <div class="big">${esc(g.title)}</div>
    ${g.description ? `<div class="mid muted" style="max-width:70vw;margin-top:1vh">${esc(g.description)}</div>` : ''}
    <div style="margin:3vh 0">${timerHtml}</div>
    <div class="mid muted">Sieger antippen:</div>
    <div class="pick-grid">${pids().map(pid => `<button class="pick ${manualSel.has(pid) ? 'sel' : ''}" data-pick="${pid}" style="box-shadow:inset 0 -5px 0 ${P(pid).color}">${esc(nameOf(pid))}${dbl.includes(pid) ? ' ⚡' : ''}</button>`).join('')}</div>
  </div>`;
}

function renderTie() {
  const ctx = S.tie.context;
  const label = ctx === 'game' ? curGame().title : ctx === 'final' ? (S.quiz.final.title || 'Finale') : 'Gesamtwertung';
  const standings = ctx === 'game' && S.game.standings
    ? `<div class="result-list">${S.game.standings.map(x => `<div class="srow ${S.tie.pids.includes(x.pid) ? 'lead' : ''}"><span class="rk"></span><span class="nm">${chip(x.pid)}</span><span class="val">${x.n}</span></div>`).join('')}</div>`
    : (ctx === 'final' ? `<div style="margin-top:3vh;width:100%">${finalBar(null)}</div>` : '');
  const hasQ = !!pickTieQuestion();
  return `${top(`<b>${esc(label)}</b>`, 'Gleichstand')}
  <div class="center">
    <div class="huge winner-name">⚔️ Gleichstand!</div>
    <div class="big" style="margin-top:2vh">${esc(listNames(S.tie.pids))}</div>
    <div class="mid muted" style="margin-top:1vh">${hasQ ? 'Eine Schätzfrage entscheidet: Wer am nächsten dran ist, gewinnt.' : 'Keine Stechfrage mehr übrig – bitte Sieger direkt wählen.'}</div>
    ${standings}
    <div class="mid muted" style="margin-top:3vh">oder Sieger direkt festlegen:</div>
    <div class="pick-grid">${S.tie.pids.map(pid => `<button class="pick" data-tiewin="${pid}" style="box-shadow:inset 0 -5px 0 ${P(pid).color}">${esc(nameOf(pid))}</button>`).join('')}</div>
  </div>`;
}

function renderGameEnd() {
  const g = curGame();
  const r = S.results[S.game.idx];
  const standings = S.game.standings
    ? `<div class="result-list">${S.game.standings.map(x => `<div class="srow ${r.winners.includes(x.pid) ? 'lead' : ''}"><span class="rk"></span><span class="nm">${chip(x.pid)}</span><span class="val">${x.n} richtig</span></div>`).join('')}</div>`
    : '';
  const p = P(r.winners[0]);
  const got = r.pts ? r.pts[r.winners[0]] : r.points;
  const doubled = r.doubled && r.doubled.includes(r.winners[0]);
  return `${top(`<b>${esc(g.title)}</b> · Spiel ${S.game.idx + 1}`, 'Ergebnis')}
  <div class="center ringed">
    <div class="ring"></div>
    <div class="crown">🏆</div>
    <div class="huge winner-name" style="color:${p.color}">${esc(listNames(r.winners))}</div>
    <div class="big">gewinnt „${esc(g.title)}“ · +${pointsLabel(got)}</div>
    ${doubled ? '<div class="mid doubled-note">⚡ Verdoppeln-Joker hat gezündet!</div>' : ''}
    ${standings}
  </div>`;
}

function renderFinalIntro() {
  const f = S.quiz.final, F = S.final;
  const rule = {
    target: `Wer zuerst <b>${F.target} Punkte</b> hat, gewinnt. Jede richtige Antwort bringt einen Punkt.`,
    count: `<b>${finalLimit()} Fragen</b>. Wer danach die meisten Punkte hat, gewinnt.`,
    elimination: `Jede falsche Antwort kostet ein Leben. Wer zuletzt noch Leben hat, gewinnt.`,
  }[f.winMode];
  return `${top(`<b>${esc(S.quiz.title)}</b>`, 'Finale')}
  <div class="center ringed">
    <div class="ring"></div>
    <div class="intro-num">Das große Finale</div>
    <div class="huge intro-title">🔥 ${esc(f.title || 'Finale')}</div>
    <div class="mid intro-desc">${f.description ? esc(f.description) + '<br>' : ''}${rule}${f.headStart && !f.description ? ' Die Vorrundenpunkte sind euer Vorsprung.' : ''}${F.targetRaised ? '<br><span style="color:var(--accent)">Ziel wurde angehoben, weil jemand schon zu viele Punkte hatte.</span>' : ''}</div>
    <div style="margin-top:4vh;width:100%">${finalBar(null)}</div>
  </div>`;
}

function renderEnd() {
  const ranking = finalRanking();
  const podium = ranking.slice(0, 3);
  const order = [podium[1], podium[0], podium[2]].filter(Boolean);
  const heights = { 0: '34vh', 1: '24vh', 2: '16vh' };
  const champ = S.champion ? P(S.champion) : null;
  return `${top(`<b>${esc(S.quiz.title)}</b>`, 'Siegerehrung')}
  <div class="center ringed">
    <div class="ring"></div>
    <div class="crown">👑</div>
    <div class="huge winner-name" style="color:${champ ? champ.color : 'inherit'}">${champ ? esc(champ.name) : 'Kein Sieger'}</div>
    <div class="big">${champ ? 'gewinnt den Abend!' : ''}</div>
    <div class="podium">${order.map(pid => {
      const i = podium.indexOf(pid);
      return `<div class="pod"><span class="nm">${esc(nameOf(pid))}</span><div class="bar" style="height:${heights[i]};background:${P(pid).color}">${i + 1}</div></div>`;
    }).join('')}</div>
  </div>`;
}

function bindStage() {
  $$('[data-kick]').forEach(b => b.onclick = () => {
    const pid = b.dataset.kick;
    if (!confirm(`${nameOf(pid)} entfernen?`)) return;
    S.kicked[pid] = true;
    net.send(pid, { t: 'kicked' });
    setTimeout(() => net.drop(pid), 300);
    update();
  });
  $$('[data-game]').forEach(t => t.onclick = () => startGame(Number(t.dataset.game)));
  $$('[data-final]').forEach(t => t.onclick = () => { if (S.finished) { S.phase = 'end'; update(); } else toFinish(); });
  $$('[data-adj]').forEach(b => b.onclick = () => gmCommand('adjTotal', { pid: b.dataset.adj, d: Number(b.dataset.d) }));
  $$('[data-pick]').forEach(b => b.onclick = () => gmCommand('manualToggle', b.dataset.pick));
  $$('[data-tiewin]').forEach(b => b.onclick = () => {
    if (confirm(`${nameOf(b.dataset.tiewin)} als Sieger festlegen?`)) gmCommand('tieWin', b.dataset.tiewin);
  });
}

// ---------------------------------------------------------------- Spielleiter-Handy

// Befehle mit Parameter (vom Handy oder vom Laptop)
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
    case 'startGame':
      if (S.phase !== 'board' || S.finished) return;
      pushUndo(c);
      return startGame(Number(arg));
    case 'manualToggle':
      if (S.phase !== 'manual' || !S.players[pid]) return;
      manualSel.has(pid) ? manualSel.delete(pid) : manualSel.add(pid);
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
      // einfache Befehle wie am Laptop (ohne Vollbild/Beenden/Test-Spieler)
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
  return qu ? { label, text: qu.text, type: qu.type, solution: correctText(qu), notes: qu.notes || '' } : null;
}

function gmAnswers(q) {
  const qu = q.question;
  if (qu.type === 'mc' || qu.type === 'tf') {
    const opts = qu.type === 'tf'
      ? [{ i: true, t: 'Wahr', l: '✓' }, { i: false, t: 'Falsch', l: '✗' }]
      : qu.options.map((t, i) => ({ i, t, l: OPTION_LETTERS[i] })).filter(o => String(o.t).trim());
    return {
      kind: 'options',
      options: opts.map(o => ({
        letter: o.l, text: o.t, correct: o.i === qu.correct,
        color: qu.type === 'tf' ? (o.i ? '#1f8a5b' : '#b8323f') : OPTION_COLORS[o.i],
        names: Object.entries(q.answers).filter(([, a]) => a.v === o.i).map(([pid]) => nameOf(pid)),
      })),
    };
  }
  if (qu.type === 'estimate') {
    const list = Object.entries(q.answers).map(([pid, a]) => ({ name: nameOf(pid), value: formatNumber(a.v), d: Math.abs(a.v - Number(qu.correct)) }))
      .sort((a, b) => a.d - b.d).map(x => ({ ...x, d: formatNumber(x.d) }));
    return { kind: 'list', items: list.map(x => ({ name: x.name, text: `${x.value} ${qu.unit || ''}`, extra: `±${x.d}` })) };
  }
  if (qu.type === 'order') {
    return { kind: 'list', items: Object.entries(q.answers).map(([pid, a]) => ({ name: nameOf(pid), text: answerText(qu, a.v), ok: isRight(qu, a.v) })) };
  }
  return { kind: 'buzz' };
}

function gmView() {
  const g = curGame();
  const q = S.q;
  const ctrl = controlsModel();
  const inFinal = !!S.final && !S.game;
  const elim = S.quiz.final.winMode === 'elimination';
  const v = {
    phase: S.phase, code: S.code, quiz: S.quiz.title, mode: S.mode,
    controls: { primary: ctrl.primary, buttons: ctrl.buttons.filter(b => !b.laptopOnly) },
    undo: undoStack.length ? undoStack[undoStack.length - 1].label : null,
    muted: isMuted(),
    context: g ? `Spiel ${S.game.idx + 1}: ${g.title}` : (S.final ? (S.quiz.final.title || 'Finale') : ''),
    players: rankedByTotals().map(pid => ({
      id: pid, name: nameOf(pid), color: P(pid).color, online: connected(pid),
      total: S.totals[pid] || 0,
      correct: S.game ? (S.game.correct[pid] || 0) : null,
      final: inFinal ? (elim ? S.final.lives[pid] || 0 : S.final.scores[pid] || 0) : null,
      jokers: S.jl[pid] || {},
      doubled: !!(S.game && S.game.doubled && S.game.doubled[pid]),
    })),
    finalLabel: inFinal ? (elim ? 'Leben' : 'Finalpunkte') : null,
    next: nextQuestionPreview(),
  };
  if (S.phase === 'board') {
    v.games = S.quiz.games.map((gg, i) => ({ idx: i, title: gg.title, type: gg.type, points: gg.points, done: !!S.results[i], winner: S.results[i] ? listNames(S.results[i].winners) : null }));
  }
  if (S.phase === 'intro' || S.phase === 'manual') {
    v.game = { title: g.title, description: g.description, points: g.points, type: g.type, questions: g.questions.length };
  }
  if (S.phase === 'manual') v.manualSel = [...manualSel];
  if (S.phase === 'tie') v.tie = { ids: S.tie.pids.slice(), label: S.tie.context === 'game' ? g.title : 'Finale/Gesamt', hasQuestion: !!pickTieQuestion() };
  if ((S.phase === 'q' || S.phase === 'reveal') && q) {
    const qu = q.question;
    v.q = {
      id: qu.id, src: q.src, type: qu.type, typeLabel: { mc: 'Multiple Choice', tf: 'Wahr/Falsch', estimate: 'Schätzfrage', order: 'Reihenfolge', buzzer: 'Buzzer' }[qu.type],
      text: qu.text, solution: correctText(qu), notes: qu.notes || '',
      hasMedia: !!qu.media, waiting: !q.start, locked: q.locked, paused: !!q.pausedAt,
      remaining: q.start && !q.locked ? Math.max(0, qEnd() - nowQ()) : 0,
      answered: Object.keys(q.answers).length, eligible: q.eligible.length,
      missing: q.eligible.filter(pid => !q.answers[pid]).map(nameOf),
      buzz: q.buzz ? { name: nameOf(q.buzz), result: q.buzzResult } : null,
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
  if (S.phase === 'end') v.champion = S.champion ? nameOf(S.champion) : null;
  return v;
}

// ---------------------------------------------------------------- Steuerleiste

// Aktionen der aktuellen Phase – genutzt von der Laptop-Leiste und vom Spielleiter-Handy.
function controlsModel() {
  const buttons = [];
  let primary = null;
  const g = curGame();
  const q = S.q;
  switch (S.phase) {
    case 'lobby':
      buttons.push({ c: 'testplayer', label: `+ Test-${T().one} öffnen`, laptopOnly: true });
      primary = { label: 'Spieltafel öffnen', c: 'toBoard', disabled: !pids().length };
      break;
    case 'board': {
      buttons.push({ c: 'lobby', label: 'QR-Code zeigen', cls: 'ghost' });
      buttons.push({ c: 'editScores', label: editScores ? 'Korrektur fertig' : 'Punkte korrigieren', cls: 'ghost', laptopOnly: true });
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
      if (!q.start) { primary = { label: 'Antworten freigeben', c: 'release' }; buttons.push({ c: 'skip', label: '⏭ Überspringen', cls: 'ghost' }); break; }
      if (buzzPending()) {
        buttons.push({ c: 'buzzRight', label: '✓ Richtig', cls: 'judge good', key: 'R' });
        buttons.push({ c: 'buzzWrong', label: '✗ Falsch', cls: 'judge bad', key: 'X' });
        break;
      }
      if (!q.locked) {
        buttons.push(q.pausedAt ? { c: 'resume', label: '▶ Weiter', cls: '' } : { c: 'pause', label: '⏸ Pause', cls: 'ghost' });
        buttons.push({ c: 'addTime', label: '+10 s', cls: 'ghost' });
        buttons.push({ c: 'lock', label: q.question.type === 'buzzer' ? 'Buzzer schließen' : 'Antworten schließen', cls: 'ghost' });
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
      if (Number(g.timer)) buttons.push({ c: 'mtimer', label: S.manualTimer ? 'Timer neu starten' : 'Timer starten', cls: '' });
      buttons.push({ c: 'toBoard', label: 'Abbrechen', cls: 'ghost' });
      if (manualSel.size >= 2) buttons.push({ c: 'manualTie', label: 'Stechfrage zwischen Auswahl', cls: '' });
      primary = { label: 'Sieger bestätigen', c: 'manualWin', disabled: manualSel.size !== 1 };
      break;
    case 'tie':
      primary = { label: 'Stechfrage starten', c: 'startTie', disabled: !pickTieQuestion() };
      break;
    case 'gameEnd':
      primary = { label: 'Zur Spieltafel', c: 'toBoard' };
      break;
    case 'finalIntro':
      buttons.push({ c: 'toBoard', label: 'Zurück zur Tafel', cls: 'ghost' });
      primary = { label: 'Finale starten', c: 'nextFinal' };
      break;
    case 'end':
      buttons.push({ c: 'toBoardFromEnd', label: 'Spieltafel ansehen', cls: 'ghost' });
      break;
  }
  return { primary, buttons };
}

function renderControls() {
  const el = $('#controls');
  if (!el) return;
  const n = pids().filter(connected).length;
  const gmN = Object.keys(S.gms || {}).filter(connected).length;
  document.body.classList.toggle('gm-on', gmN > 0);
  const dot = { online: 'on', reconnecting: 'warn', 'waiting-id': 'warn', connecting: 'warn', error: 'off' }[netStatus] || 'warn';
  const stLabel = { online: 'Online', reconnecting: 'Verbinde neu …', 'waiting-id': 'Raum wird wiederhergestellt …', connecting: 'Verbinde …', error: 'Verbindungsfehler' }[netStatus] || netStatus;
  const { primary, buttons } = controlsModel();
  const btns = buttons.map(b => `<button class="btn ${b.cls && b.cls.includes('judge') ? '' : 'small'} ${b.cls || ''}" data-c="${b.c}">${b.label}${b.key ? ` <span class="kbd">${b.key}</span>` : ''}</button>`);

  el.innerHTML = `
    <span class="status"><span class="dot ${dot}"></span>${stLabel} · ${n} verbunden${gmN ? ' · 🎙 Spielleiter' : ''} · Code <b>${S.code}</b></span>
    ${btns.join('')}
    <span class="spacer"></span>
    <button class="btn small ghost" data-c="undo" title="Rückgängig (Strg+Z)" ${undoStack.length ? '' : 'disabled'}>↶</button>
    <button class="btn small ghost" data-c="mute" title="Ton an/aus (M)">${isMuted() ? '🔇' : '🔊'}</button>
    <button class="btn small ghost" data-c="fullscreen" title="Vollbild (F)">⛶</button>
    <button class="btn small danger" data-c="quit">Abend beenden</button>
    ${primary ? `<button class="btn primary" id="primary" data-c="${primary.c}" ${primary.disabled ? 'disabled' : ''}>${primary.label}<span class="kbd">Leertaste</span></button>` : ''}`;

  $$('[data-c]', el).forEach(b => b.onclick = () => command(b.dataset.c));
}

const UNDOABLE = new Set(['toBoard', 'toEnd', 'nextGame', 'finish', 'beginGame', 'release', 'lock', 'reveal', 'buzzRight', 'buzzWrong',
  'afterReveal', 'manualWin', 'manualTie', 'startTie', 'nextFinal', 'skip', 'addTime', 'toBoardFromEnd', 'lobby']);

function command(c) {
  if (UNDOABLE.has(c)) pushUndo(c);
  switch (c) {
    case 'undo': undo(); break;
    case 'pause': pauseTimer(); break;
    case 'resume': resumeTimer(); break;
    case 'addTime': addTime(); break;
    case 'skip': skipQuestion(); break;
    case 'testplayer': window.open('play.html?r=' + S.code + '&test=' + Date.now(), '_blank'); break;
    case 'toBoard': stopMedia(); S.phase = 'board'; S.q = null; update(); break;
    case 'toBoardFromEnd': S.phase = 'board'; update(); break;
    case 'toEnd': S.phase = 'end'; update(); break;
    case 'lobby': S.phase = 'lobby'; update(); break;
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
    case 'mute': toggleMute(); renderControls(); break;
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
