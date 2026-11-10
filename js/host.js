// Spielleiter-Ansicht (Laptop/TV): steuert den ganzen Abend.
import { kvGet, kvSet, kvDel } from './store.js';
import { createHost } from './net.js';
import { correctText, formatNumber, uid } from './model.js';
import { $, $$, esc, toast, confetti, PLAYER_COLORS, OPTION_COLORS, OPTION_LETTERS } from './ui.js';

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

// ---------------------------------------------------------------- Start / Ende

export function createSession(quiz, mode) {
  return {
    v: 1,
    id: uid(),
    code: null,
    quiz: JSON.parse(JSON.stringify(quiz)),
    mode,                       // 'single' | 'team'
    createdAt: Date.now(),
    players: {}, order: [], kicked: {},
    totals: {},                 // Spielpunkte aus den Vorrunden
    results: quiz.games.map(() => null),
    phase: 'lobby',
    game: null, q: null, tie: null, final: null, manualTimer: null,
    usedTie: [], champion: null,
  };
}

export async function startHost(root, makeCode) {
  S = await kvGet('session');
  if (!S) { location.hash = ''; return; }
  if (!S.code) { S.code = makeCode(); save(); }
  document.body.classList.add('stage-mode');
  root.innerHTML = '<div class="stage" id="stage"></div><div class="controls" id="controls"></div>';

  net = createHost(S.code, { onMessage, onLeave, onStatus });
  intervals.push(setInterval(() => S.order.forEach(pid => net.send(pid, { t: 'ping' })), 4000));
  intervals.push(setInterval(onTick, 200));

  keyHandler = e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      const b = $('#primary');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  };
  document.addEventListener('keydown', keyHandler);
  render();
}

export function stopHost() {
  intervals.forEach(clearInterval);
  intervals = [];
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  if (net) net.destroy();
  net = null;
  document.body.classList.remove('stage-mode');
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('session', S).catch(e => toast('Speichern fehlgeschlagen: ' + e.message)), 250);
}

function update() { save(); render(); broadcast(); }

// ---------------------------------------------------------------- Hilfen

const T = () => S.mode === 'team'
  ? { one: 'Team', many: 'Teams' }
  : { one: 'Spieler', many: 'Spieler' };
const pids = () => S.order.filter(id => S.players[id] && !S.kicked[id]);
const P = pid => S.players[pid] || { name: '?', color: '#888' };
const nameOf = pid => P(pid).name;
const curGame = () => (S.game ? S.quiz.games[S.game.idx] : null);
const connected = pid => !!(net && net.isConnected(pid));
const listNames = ids => ids.map(nameOf).join(' und ').replace(/ und (?=.* und )/g, ', ');

function chip(pid, extra = '') {
  const p = P(pid);
  return `<span class="chip ${extra}"><span class="sw" style="background:${p.color}"></span>${esc(p.name)}</span>`;
}

function nextUnplayed() { return S.results.findIndex(r => !r); }

function rankedByTotals() {
  return pids().slice().sort((a, b) => (S.totals[b] || 0) - (S.totals[a] || 0));
}

// ---------------------------------------------------------------- Netzwerk

function onStatus(st) { netStatus = st; renderControls(); }

function onLeave() { renderSoft(); }

function onMessage(pid, msg) {
  if (msg.t === 'hello') {
    if (S.kicked[pid]) { net.send(pid, { t: 'kicked' }); setTimeout(() => net.drop(pid), 300); return; }
    if (!S.players[pid]) {
      let name = String(msg.name || '').trim().slice(0, 24) || `${T().one} ${S.order.length + 1}`;
      const taken = new Set(pids().map(nameOf));
      let n = 2, base = name;
      while (taken.has(name)) name = `${base} ${n++}`;
      const color = PLAYER_COLORS[S.order.length % PLAYER_COLORS.length];
      S.players[pid] = { id: pid, name, color };
      S.order.push(pid);
      S.totals[pid] = S.totals[pid] || 0;
      if (S.final) initFinalPlayer(pid);
      if (S.phase === 'lobby') toast(`${name} ist beigetreten`);
    }
    update();
    return;
  }
  if (msg.t === 'answer') handleAnswer(pid, msg.qid, msg.value);
}

function broadcast() {
  if (!net) return;
  pids().forEach(pid => net.send(pid, { t: 'view', v: viewFor(pid) }));
}

// ---------------------------------------------------------------- Fragen

function openQuestion(src, question, eligible) {
  S.q = { src, question, eligible, answers: {}, start: Date.now(), dur: (Number(question.time) || 20) * 1000, locked: false, result: null };
  S.phase = 'q';
  update();
}

function handleAnswer(pid, qid, value) {
  const q = S.q;
  if (S.phase !== 'q' || !q || q.locked || q.question.id !== qid) return;
  if (!q.eligible.includes(pid) || q.answers[pid]) return;
  const qu = q.question;
  let v = value;
  if (qu.type === 'mc') { v = Number(v); if (!Number.isInteger(v) || !String(qu.options[v] || '').trim()) return; }
  else if (qu.type === 'tf') { if (typeof v !== 'boolean') return; }
  else { v = Number(v); if (!Number.isFinite(v)) return; }
  q.answers[pid] = { v, ms: Date.now() - q.start };
  const waiting = q.eligible.filter(id => connected(id) && !q.answers[id]);
  if (!waiting.length) q.locked = true;
  update();
}

function onTick() {
  if (S.phase === 'q' && S.q && !S.q.locked) {
    const rest = S.q.start + S.q.dur - Date.now();
    if (rest <= 0) { S.q.locked = true; update(); return; }
    const bar = $('#tbar'); const num = $('#tnum');
    if (bar) bar.style.transform = `scaleX(${Math.max(0, rest / S.q.dur)})`;
    if (num) num.textContent = Math.ceil(rest / 1000);
  }
  if (S.phase === 'manual' && S.manualTimer) {
    const rest = S.manualTimer.end - Date.now();
    const el = $('#mtimer');
    if (el) {
      const s = Math.max(0, Math.ceil(rest / 1000));
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      el.classList.toggle('low', s <= 5 && s > 0);
    }
  }
}

function reveal() {
  const q = S.q, qu = q.question;
  q.locked = true;
  let winners = [];
  if (qu.type === 'estimate') {
    const arr = Object.entries(q.answers)
      .map(([pid, a]) => ({ pid, v: a.v, d: Math.abs(a.v - Number(qu.correct)), ms: a.ms }))
      .sort((a, b) => a.d - b.d || a.ms - b.ms);
    q.ranking = arr;
    if (arr.length) winners = arr.filter(x => x.d === arr[0].d).map(x => x.pid);
  } else {
    winners = Object.entries(q.answers).filter(([, a]) => a.v === qu.correct).map(([pid]) => pid);
  }
  q.result = { winners };
  if (q.src === 'game') winners.forEach(pid => { S.game.correct[pid] = (S.game.correct[pid] || 0) + 1; });
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

function startGame(idx) {
  if (S.results[idx]) return;
  S.game = { idx, qi: -1, correct: {}, standings: null };
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
  const pts = Number(g.points) || 0;
  S.results[S.game.idx] = { winners, points: pts };
  winners.forEach(pid => { S.totals[pid] = (S.totals[pid] || 0) + pts; });
  S.tie = null;
  S.phase = 'gameEnd';
  fx = 'confetti';
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
  if (f.winMode !== 'elimination') {
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
  const v = {
    phase: S.phase, mode: S.mode,
    me: { name: p.name, color: p.color, total: S.totals[pid] || 0, rank: 1 + ranked.filter(o => (S.totals[o] || 0) > (S.totals[pid] || 0)).length, of: ranked.length },
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
      Object.assign(v, { icon: '🎬', title: `Spiel ${S.game.idx + 1}: ${g.title}`, sub: `${g.description || ''}${g.description ? ' · ' : ''}Sieg: ${pointsLabel(g.points)}` }); break;
    case 'manual':
      Object.assign(v, { icon: '🏁', title: g.title, sub: g.description || 'Der Spielleiter trägt den Sieger ein.' }); break;
    case 'tie':
      Object.assign(v, { icon: '⚔️', title: 'Gleichstand!', sub: `Stechen zwischen ${listNames(S.tie.pids)}` }); break;
    case 'gameEnd': {
      const r = S.results[S.game.idx];
      const won = r && r.winners.includes(pid);
      Object.assign(v, won
        ? { icon: '🏆', title: 'Spiel gewonnen!', sub: `+${pointsLabel(r.points)}` }
        : { icon: '👏', title: r ? `${listNames(r.winners)} gewinnt` : 'Spiel beendet', sub: g.title });
      break;
    }
    case 'finalIntro':
      Object.assign(v, { icon: '🔥', title: S.quiz.final.title || 'Finale', sub: v.final && v.final.lives !== undefined ? `Deine Leben: ${v.final.lives}` : `Dein Startwert: ${v.final ? v.final.score : 0}` }); break;
    case 'q': {
      const q = S.q;
      if (q.eligible.includes(pid)) {
        const qu = q.question;
        v.q = {
          id: qu.id, type: qu.type, text: qu.text, unit: qu.unit || '',
          options: qu.type === 'mc' ? qu.options.map((t, i) => ({ i, t })).filter(o => String(o.t).trim()) : null,
          remaining: q.locked ? 0 : Math.max(0, q.start + q.dur - Date.now()), dur: q.dur,
          answered: !!q.answers[pid], locked: q.locked,
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
        eligible: q.eligible.includes(pid),
        answered: !!a,
        good: q.result.winners.includes(pid),
        solution: correctText(qu),
        mine: a ? answerText(qu, a.v) : null,
        lostLife: (q.result.lost || []).includes(pid),
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
  return formatNumber(v) + (qu.unit ? ' ' + qu.unit : '');
}

const pointsLabel = n => `${n} ${Number(n) === 1 ? 'Punkt' : 'Punkte'}`;

// ---------------------------------------------------------------- Rendern

let lastStageKey = null;

// Gleiche Bühne wie zuvor? Dann nur Teile aktualisieren, damit Animationen nicht neu starten.
function stageKey() {
  if (S.phase === 'q') return `q|${S.q.question.id}|${S.q.start}|${S.q.locked}`;
  if (S.phase === 'lobby') return 'lobby';
  return null;
}

function render() {
  const stage = $('#stage');
  if (!stage) return;
  const key = stageKey();
  if (key && key === lastStageKey) {
    if (S.phase === 'q') {
      const c = $('#answered-chips'); if (c) c.outerHTML = answeredChips();
      const n = $('#answered-count'); if (n) n.textContent = `${Object.keys(S.q.answers).length} / ${S.q.eligible.length} geantwortet`;
    }
    if (S.phase === 'lobby') {
      const c = $('#lobby-chips'); if (c) c.innerHTML = lobbyChips();
      const n = $('#lobby-count'); if (n) n.textContent = `(${pids().length})`;
      bindStage();
    }
    renderControls();
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
  onTick();
  if (fx) { confetti(fx === 'confetti-long' ? 5000 : 2500); fx = null; }
}

// Nur kleine Teile neu zeichnen (z. B. Verbindungsstatus), ohne Animationen neu zu starten.
function renderSoft() {
  if (S.phase === 'lobby') { const c = $('#lobby-chips'); if (c) c.innerHTML = lobbyChips(); bindStage(); }
  renderControls();
}

function top(left, right = '') {
  return `<div class="stage-top"><div>${left}</div><div>${right}</div></div>`;
}

function joinUrl() {
  return new URL('play.html?r=' + S.code, location.href).href;
}

function lobbyChips() {
  const list = pids();
  if (!list.length) return `<span class="muted mid">Noch niemand da …</span>`;
  return list.map(pid => `<span class="chip ${connected(pid) ? '' : 'off'}"><span class="sw" style="background:${P(pid).color}"></span>${esc(nameOf(pid))}<button data-kick="${pid}" title="Entfernen">✕</button></span>`).join('');
}

function renderLobby() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return `${top(`<b>${esc(S.quiz.title)}</b> · ${S.mode === 'team' ? 'Teammodus' : 'Einzelmodus'}`)}
  <div class="lobby">
    <div style="text-align:center">
      <div class="qrbox" id="qr"></div>
      <div class="mid" style="margin-top:2vh">Code</div>
      <div class="joincode">${S.code}</div>
      <div class="joinurl">${esc(joinUrl())}</div>
      ${local ? `<div class="notice" style="margin-top:2vh;text-align:left;font-size:.9rem">Lokaler Test: Handys erreichen „localhost“ nicht. Öffne zum Testen Spieler-Tabs über den Button unten. Am Spieleabend läuft die App über die Internetadresse.</div>` : ''}
    </div>
    <div>
      <div class="big">${S.mode === 'team' ? 'Teams' : 'Spieler'} <span class="muted" id="lobby-count">(${pids().length})</span></div>
      <p class="mid muted">Scannt den QR-Code mit dem Handy und gebt ${S.mode === 'team' ? 'euren Teamnamen' : 'euren Namen'} ein.</p>
      <div class="chips" id="lobby-chips">${lobbyChips()}</div>
    </div>
  </div>`;
}

function drawQR() {
  const el = $('#qr');
  if (!el || typeof QRCode === 'undefined') { if (el) el.innerHTML = '<p style="color:#000">QR-Code nicht verfügbar</p>'; return; }
  el.innerHTML = '';
  new QRCode(el, { text: joinUrl(), width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
}

function scoresPanel(title = 'Gesamtstand') {
  const ranked = rankedByTotals();
  const max = ranked.length ? S.totals[ranked[0]] || 0 : 0;
  return `<div class="scores ${editScores ? 'editing' : ''}"><h3>${title}</h3>
    ${ranked.map((pid, i) => `<div class="srow ${max > 0 && (S.totals[pid] || 0) === max ? 'lead' : ''}">
      <span class="rk">${i + 1}.</span>
      <span class="nm"><span class="sw dot" style="background:${P(pid).color}"></span>${esc(nameOf(pid))}</span>
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
      return `<div class="tile done" style="border-color:${p.color};background:${p.color}22">
        <span class="pts">${r.points} P</span><span class="n" style="color:${p.color}">${i + 1}</span>
        <span class="w">${esc(g.title)}</span><span class="w" style="color:${p.color}">${esc(listNames(r.winners))}</span></div>`;
    }
    return `<div class="tile ${i === next ? 'next' : ''}" data-game="${i}"><span class="pts">${g.points} P</span><span class="n">${i + 1}</span><span class="w muted">?</span></div>`;
  }).join('');
  const finalTile = f.enabled ? `<div class="tile final ${next === -1 ? 'next' : ''}" ${next === -1 ? 'data-final="1"' : ''}><span class="n">🔥 ${esc(f.title || 'Finale')}</span></div>` : '';
  const played = S.results.filter(Boolean).length;
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `${played} / ${S.quiz.games.length} Spiele gespielt`)}
    <div class="board"><div class="tiles">${tiles}${finalTile}</div>${scoresPanel()}</div>`;
}

function renderIntro() {
  const g = curGame();
  return `${top(`<b>${esc(S.quiz.title)}</b>`, `Spiel ${S.game.idx + 1} / ${S.quiz.games.length}`)}
  <div class="center">
    <div class="intro-num">Spiel ${S.game.idx + 1}</div>
    <div class="huge intro-title">${esc(g.title)}</div>
    ${g.description ? `<div class="mid intro-desc">${esc(g.description)}</div>` : ''}
    <div class="mid intro-pts">Sieg: ${pointsLabel(g.points)}${g.type === 'quiz' ? ` · ${g.questions.length} Fragen` : ''}</div>
  </div>`;
}

function qLabel() {
  const q = S.q;
  if (q.src === 'game') return `<b>${esc(curGame().title)}</b> · Frage ${S.game.qi + 1} / ${curGame().questions.length}`;
  if (q.src === 'tie') return `<b>Stechfrage</b> · ${esc(listNames(q.eligible))}`;
  return `<b>${esc(S.quiz.final.title || 'Finale')}</b> · Frage ${S.final.qi + 1}`;
}

function questionHead() {
  const qu = S.q.question;
  return `<div class="qtext">${esc(qu.text)}</div>
    ${qu.image ? `<div class="qimg"><img src="${qu.image}" alt=""></div>` : '<div style="flex:1"></div>'}`;
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

function answeredChips() {
  const q = S.q;
  return `<div class="chips answered-row" id="answered-chips">${q.eligible.map(pid => chip(pid, `${q.answers[pid] ? 'answered' : ''} ${connected(pid) ? '' : 'off'}`)).join('')}</div>`;
}

function renderQuestion() {
  const q = S.q, qu = q.question;
  const n = Object.keys(q.answers).length;
  return `${top(qLabel(), `<span id="answered-count">${n} / ${q.eligible.length} geantwortet</span>`)}
  <div class="qwrap">
    ${questionHead()}
    ${qu.type === 'estimate' ? `<div class="center" style="flex:none"><div class="big muted">Schätzt! ${qu.unit ? `(in ${esc(qu.unit)})` : ''}</div></div>` : optionTiles(false)}
    <div class="timer-row"><div class="timer"><i id="tbar" ${q.locked ? 'style="transform:scaleX(0)"' : ''}></i></div><div class="timer-num" id="tnum">${q.locked ? '0' : ''}</div></div>
    ${answeredChips()}
    ${q.locked ? '<div class="center" style="flex:none"><div class="mid" style="color:var(--accent)">Antworten geschlossen – bereit zur Auflösung</div></div>' : ''}
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
  } else {
    body = optionTiles(true);
  }
  return `${top(qLabel(), 'Auflösung')}
  <div class="qwrap">
    <div class="qtext">${esc(qu.text)}</div>
    ${qu.image && qu.type !== 'estimate' ? `<div class="qimg"><img src="${qu.image}" alt=""></div>` : ''}
    ${body}
    ${revealFooter()}
  </div>`;
}

function revealFooter() {
  const q = S.q;
  if (q.src === 'game') {
    const g = curGame();
    return `<div class="chips answered-row">${pids().map(pid => `<span class="chip ${q.result.winners.includes(pid) ? 'answered' : ''}"><span class="sw" style="background:${P(pid).color}"></span>${esc(nameOf(pid))} <b>${S.game.correct[pid] || 0}</b></span>`).join('')}</div>
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
  return `${top(`<b>${esc(g.title)}</b> · Spiel ${S.game.idx + 1}`, `Sieg: ${pointsLabel(g.points)}`)}
  <div class="center">
    <div class="big">${esc(g.title)}</div>
    ${g.description ? `<div class="mid muted" style="max-width:70vw;margin-top:1vh">${esc(g.description)}</div>` : ''}
    <div style="margin:3vh 0">${timerHtml}</div>
    <div class="mid muted">Sieger antippen:</div>
    <div class="pick-grid">${pids().map(pid => `<button class="pick ${manualSel.has(pid) ? 'sel' : ''}" data-pick="${pid}" style="box-shadow:inset 0 -5px 0 ${P(pid).color}">${esc(nameOf(pid))}</button>`).join('')}</div>
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
  return `${top(`<b>${esc(g.title)}</b> · Spiel ${S.game.idx + 1}`, 'Ergebnis')}
  <div class="center">
    <div class="crown">🏆</div>
    <div class="huge winner-name" style="color:${p.color}">${esc(listNames(r.winners))}</div>
    <div class="big">gewinnt „${esc(g.title)}“ · +${pointsLabel(r.points)}</div>
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
  <div class="center">
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
  <div class="center">
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
  $$('[data-adj]').forEach(b => b.onclick = () => {
    const pid = b.dataset.adj;
    S.totals[pid] = Math.max(0, (S.totals[pid] || 0) + Number(b.dataset.d));
    update();
  });
  $$('[data-pick]').forEach(b => b.onclick = () => {
    const pid = b.dataset.pick;
    manualSel.has(pid) ? manualSel.delete(pid) : manualSel.add(pid);
    render();
  });
  $$('[data-tiewin]').forEach(b => b.onclick = () => {
    if (confirm(`${nameOf(b.dataset.tiewin)} als Sieger festlegen?`)) finishTie(b.dataset.tiewin);
  });
}

// ---------------------------------------------------------------- Steuerleiste

function renderControls() {
  const el = $('#controls');
  if (!el) return;
  const n = pids().filter(connected).length;
  const dot = { online: 'on', reconnecting: 'warn', 'waiting-id': 'warn', connecting: 'warn', error: 'off' }[netStatus] || 'warn';
  const stLabel = { online: 'Online', reconnecting: 'Verbinde neu …', 'waiting-id': 'Raum wird wiederhergestellt …', connecting: 'Verbinde …', error: 'Verbindungsfehler' }[netStatus] || netStatus;
  const btns = [];
  let primary = null;
  const g = curGame();

  switch (S.phase) {
    case 'lobby':
      btns.push(`<button class="btn small" data-c="testplayer">+ Test-${T().one} öffnen</button>`);
      primary = { label: 'Spieltafel öffnen', c: 'toBoard', disabled: !pids().length };
      break;
    case 'board': {
      btns.push(`<button class="btn small ghost" data-c="lobby">QR-Code zeigen</button>`);
      btns.push(`<button class="btn small ghost" data-c="editScores">${editScores ? 'Korrektur fertig' : 'Punkte korrigieren'}</button>`);
      const next = nextUnplayed();
      primary = S.finished ? { label: 'Zur Siegerehrung', c: 'toEnd' }
        : next >= 0
          ? { label: `Spiel ${next + 1} starten`, c: 'nextGame' }
          : { label: S.quiz.final.enabled ? 'Zum Finale' : 'Zur Siegerehrung', c: 'finish' };
      break;
    }
    case 'intro':
      btns.push(`<button class="btn small ghost" data-c="toBoard">Zurück zur Tafel</button>`);
      primary = { label: g.type === 'manual' ? 'Spiel beginnen' : 'Erste Frage', c: 'beginGame' };
      break;
    case 'q':
      if (!S.q.locked) btns.push(`<button class="btn small ghost" data-c="lock">Antworten schließen</button>`);
      primary = { label: 'Auflösen', c: 'reveal' };
      break;
    case 'reveal': {
      let label = 'Weiter';
      if (S.q.src === 'game') label = S.game.qi + 1 < g.questions.length ? 'Nächste Frage' : 'Spiel auswerten';
      if (S.q.src === 'tie') label = 'Stechen auswerten';
      primary = { label, c: 'afterReveal' };
      break;
    }
    case 'manual':
      if (Number(g.timer)) btns.push(`<button class="btn small" data-c="mtimer">${S.manualTimer ? 'Timer neu starten' : 'Timer starten'}</button>`);
      btns.push(`<button class="btn small ghost" data-c="toBoard">Abbrechen</button>`);
      if (manualSel.size >= 2) btns.push(`<button class="btn small" data-c="manualTie">Stechfrage zwischen Auswahl</button>`);
      primary = { label: 'Sieger bestätigen', c: 'manualWin', disabled: manualSel.size !== 1 };
      break;
    case 'tie':
      primary = { label: 'Stechfrage starten', c: 'startTie', disabled: !pickTieQuestion() };
      break;
    case 'gameEnd':
      primary = { label: 'Zur Spieltafel', c: 'toBoard' };
      break;
    case 'finalIntro':
      btns.push(`<button class="btn small ghost" data-c="toBoard">Zurück zur Tafel</button>`);
      primary = { label: 'Finale starten', c: 'nextFinal' };
      break;
    case 'end':
      btns.push(`<button class="btn small ghost" data-c="toBoardFromEnd">Spieltafel ansehen</button>`);
      break;
  }

  el.innerHTML = `
    <span class="status"><span class="dot ${dot}"></span>${stLabel} · ${n} verbunden · Code <b>${S.code}</b></span>
    ${btns.join('')}
    <span class="spacer"></span>
    <button class="btn small ghost" data-c="fullscreen" title="Vollbild (F)">⛶</button>
    <button class="btn small danger" data-c="quit">Abend beenden</button>
    ${primary ? `<button class="btn primary" id="primary" data-c="${primary.c}" ${primary.disabled ? 'disabled' : ''}>${primary.label}<span class="kbd">Leertaste</span></button>` : ''}`;

  $$('[data-c]', el).forEach(b => b.onclick = () => command(b.dataset.c));
}

function command(c) {
  switch (c) {
    case 'testplayer': window.open('play.html?r=' + S.code + '&test=' + Date.now(), '_blank'); break;
    case 'toBoard': S.phase = 'board'; S.q = null; update(); break;
    case 'toBoardFromEnd': S.phase = 'board'; update(); break;
    case 'toEnd': S.phase = 'end'; update(); break;
    case 'lobby': S.phase = 'lobby'; update(); break;
    case 'editScores': editScores = !editScores; render(); break;
    case 'nextGame': startGame(nextUnplayed()); break;
    case 'finish': toFinish(); break;
    case 'beginGame': beginGame(); break;
    case 'lock': S.q.locked = true; update(); break;
    case 'reveal': reveal(); break;
    case 'afterReveal': afterReveal(); break;
    case 'mtimer': S.manualTimer = { end: Date.now() + Number(curGame().timer) * 1000 }; update(); break;
    case 'manualWin': awardGame([...manualSel]); break;
    case 'manualTie': S.tie = { context: 'game', pids: [...manualSel] }; S.phase = 'tie'; update(); break;
    case 'startTie': startTie(); break;
    case 'nextFinal': nextFinalQuestion(); break;
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
