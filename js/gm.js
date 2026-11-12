// Spielleiter-Ansicht auf dem Handy: vier Reiter – Live, Ablauf, Punkte, Mehr.
import { esc } from './ui.js';

let tab = 'live';
try { tab = sessionStorage.getItem('qa-gm-tab') || 'live'; } catch (e) { /* egal */ }
let deadline = 0;
let raf = null;
let lastAttention = false;
let lastV = null;
let sendFn = null;
let appEl = null;
const openGames = new Set(); // im Reiter „Ablauf“ aufgeklappte Spiele (bleiben bei Aktualisierungen offen)
const closedGames = new Set();

const JK = { double: '⚡', fifty: '½', time: '⏱' };
const TABS = [['live', '🎬', 'Live'], ['flow', '🗂', 'Ablauf'], ['points', '🏆', 'Punkte'], ['more', '⚙', 'Mehr']];

const btn = (c, label, cls = '', arg = null, extra = '') =>
  `<button class="btn ${cls}" data-cmd="${c}" ${arg !== null ? `data-arg='${esc(JSON.stringify(arg))}'` : ''} ${extra}>${label}</button>`;

export function renderGm(app, v, send) {
  appEl = app; sendFn = send; lastV = v;
  // Bei einem Buzzer-Treffer automatisch zum Live-Reiter
  if (v.attention && !lastAttention) tab = 'live';
  lastAttention = v.attention;
  draw();
}

function setTab(t) {
  tab = t;
  try { sessionStorage.setItem('qa-gm-tab', t); } catch (e) { /* egal */ }
  draw(true);
}

function draw(scrollTop = false) {
  const v = lastV, app = appEl;
  if (!v || !app) return;
  const y = scrollTop ? 0 : window.scrollY;
  cancelAnimationFrame(raf);
  const body = { live: liveTab, flow: flowTab, points: pointsTab, more: moreTab }[tab](v);

  app.innerHTML = `<div class="gm2">
    <header class="gm-top">
      <div class="gm-ctx"><span class="gm-ctx-t">${esc(v.context || v.quiz)}</span><span class="gm-phase">${esc(v.phaseLabel)}</span></div>
      <div class="gm-code">🎙 ${esc(v.code)}</div>
    </header>
    <main class="gm-main">${body}</main>
    <nav class="gm-tabs">${TABS.map(([k, i, l]) => `<button class="gm-tab ${tab === k ? 'on' : ''}" data-tab="${k}">
      <span class="ti">${i}</span><span class="tl">${l}</span>${k === 'live' && v.attention && tab !== 'live' ? '<span class="tdot"></span>' : ''}</button>`).join('')}</nav>
  </div>`;

  window.scrollTo(0, y);
  app.querySelectorAll('details[data-g]').forEach(d => d.addEventListener('toggle', () => {
    const k = d.dataset.g;
    if (d.open) { openGames.add(k); closedGames.delete(k); } else { openGames.delete(k); closedGames.add(k); }
  }));
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  app.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => {
    if (b.disabled) return;
    const c = b.dataset.cmd;
    const arg = b.dataset.arg ? JSON.parse(b.dataset.arg) : undefined;
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    if (c === 'logout') { if (confirm('Als Spielleiter abmelden?')) app.dispatchEvent(new CustomEvent('gm-logout')); return; }
    sendFn({ t: 'cmd', c, arg });
    if (navigator.vibrate) navigator.vibrate(20);
  });

  const q = v.q;
  const el = app.querySelector('#gm-timer');
  if (el && q && !q.revealed && !q.locked && !q.waiting) {
    deadline = Date.now() + q.remaining;
    (function tick() {
      el.textContent = q.paused ? (q.buzz ? '🔔' : '⏸') : `${Math.ceil(Math.max(0, deadline - Date.now()) / 1000)} s`;
      if (!q.paused && deadline > Date.now()) raf = requestAnimationFrame(tick);
    })();
  }
}

// ---------------------------------------------------------------- Live

function liveTab(v) {
  const ctrl = v.controls || {};
  const judge = (ctrl.buttons || []).filter(b => (b.cls || '').includes('judge'));
  const extra = (ctrl.buttons || []).filter(b => !(b.cls || '').includes('judge'));
  const primary = ctrl.primary
    ? btn(ctrl.primary.c, ctrl.primary.label, 'primary gm-primary', null, ctrl.primary.disabled ? 'disabled' : '')
    : '';
  return `
    ${judge.length ? `<div class="gm-judge">${judge.map(b => btn(b.c, b.label, `big ${b.cls}`)).join('')}</div>` : ''}
    ${primary}
    ${extra.length ? `<div class="gm-row-btns">${extra.map(b => btn(b.c, b.label, 'small')).join('')}</div>` : ''}
    ${phaseCard(v)}
    ${v.next && v.phase !== 'board' ? `<details class="gm-card gm-next"><summary><span class="gm-label">Als Nächstes · ${esc(v.next.label)}</span></summary>
      <div class="gm-nq">${v.next.icon || ''} ${esc(v.next.text)}</div><div class="gm-sol sm">${esc(v.next.solution)}</div>
      ${v.next.notes ? `<div class="gm-notes">${esc(v.next.notes)}</div>` : ''}</details>` : ''}`;
}

function phaseCard(v) {
  switch (v.phase) {
    case 'lobby':
      return card('Lobby', `<div class="gm-big">${v.players.length}</div><div class="muted">Mitspieler verbunden</div>
        <div class="gm-names">${v.players.map(p => `<span class="gm-pn" style="--c:${p.color}">${esc(p.name)}</span>`).join('') || '–'}</div>`);
    case 'show':
      return card('Intro', v.show.step === 0
        ? '<div>Titel wird gezeigt. Weiter stellt die Spieler einzeln vor.</div>'
        : `<div class="gm-big">${esc(v.show.name || '')}</div><div class="muted">Spieler ${v.show.step} von ${v.show.total}</div>`);
    case 'rehearsal': {
      const ok = v.players.filter(p => p.ready).length;
      return card(`Generalprobe · ${ok}/${v.players.length} bereit`, `<div class="gm-names">${v.players.map(p =>
        `<span class="gm-pn ${p.ready ? 'ok' : ''} ${p.online ? '' : 'off'}" style="--c:${p.color}">${p.ready ? '✓' : p.online ? '…' : '⚠'} ${esc(p.name)}</span>`).join('')}</div>`);
    }
    case 'board': {
      const next = v.flow.games.find(g => !g.done);
      return card('Spieltafel', next ? `<div>Als Nächstes: <b>${next.idx + 1}. ${esc(next.title)}</b></div><div class="muted sm">Anderes Spiel wählen? Reiter <b>Ablauf</b>.</div>`
        : '<div>Alle Vorrunden gespielt.</div>');
    }
    case 'intro':
    case 'manual': {
      const g = v.game;
      let picks = '';
      if (v.phase === 'manual') {
        picks = `<div class="gm-label mt">Sieger antippen</div><div class="gm-picks">${v.players.map(p =>
          btn('manualToggle', esc(p.name) + (p.doubled ? ' ⚡' : ''), `pick ${v.manualSel.includes(p.id) ? 'sel' : ''}`, p.id, `style="--c:${p.color}"`)).join('')}</div>`;
      }
      const dbl = v.players.filter(p => p.doubled).map(p => esc(p.name));
      return card(esc(v.context), `${g.description ? `<div>${esc(g.description)}</div>` : ''}
        <div class="muted sm">Sieg: ${g.points} P${g.type === 'quiz' ? ` · ${g.questions} Fragen` : ''}</div>
        ${dbl.length ? `<div class="gm-gold">⚡ Verdoppelt: ${dbl.join(', ')}</div>` : ''}${picks}`);
    }
    case 'q':
    case 'reveal':
      return questionCard(v);
    case 'tie':
      return card(`Gleichstand · ${esc(v.tie.label)}`, `<div class="muted sm">${v.tie.hasQuestion ? 'Stechfrage starten oder Sieger direkt festlegen:' : 'Keine Stechfrage übrig – Sieger festlegen:'}</div>
        <div class="gm-picks">${v.tie.ids.map(id => {
          const p = v.players.find(x => x.id === id) || { name: '?' };
          return btn('tieWin', `🏆 ${esc(p.name)}`, 'pick', id, `data-confirm="${esc(p.name)} als Sieger festlegen?"`);
        }).join('')}</div>`);
    case 'gameEnd':
      return card('Spielende', `<div class="gm-big">🏆 ${esc(v.result.winners)}</div><div class="muted">+${v.result.pts} ${Number(v.result.pts) === 1 ? 'Punkt' : 'Punkte'}</div>`);
    case 'standings':
      return card('Zwischenstand', ranking(v));
    case 'finalIntro':
      return card('Finale', `<div class="muted sm">Startwerte:</div>${ranking(v, true)}`);
    case 'stats':
      return card('Statistik', `<div>Auszeichnungen werden gezeigt.</div><div class="muted sm">Sieger: <b>${esc(v.champion || '–')}</b></div>`);
    case 'end':
      return card('Siegerehrung', `<div class="gm-big">👑 ${esc(v.champion || '–')}</div>`);
  }
  return '';
}

const card = (label, inner, cls = '') => `<section class="gm-card ${cls}"><div class="gm-label">${label}</div>${inner}</section>`;

function ranking(v, final = false) {
  return `<ol class="gm-rank">${v.players.map(p => `<li><span class="gm-dot" style="--c:${p.color}"></span>${esc(p.name)}<b>${final && p.final !== null ? p.final : p.total}</b></li>`).join('')}</ol>`;
}

function questionCard(v) {
  const q = v.q, t = v.tools;
  let status;
  if (q.revealed) status = `<span class="gm-pill">Aufgelöst</span><span class="sm">${q.winners && q.winners.length ? `✓ ${esc(q.winners.join(', '))}` : 'Niemand richtig'}</span>`;
  else if (q.waiting) status = '<span class="gm-pill">Medium läuft – Antworten gesperrt</span>';
  else if (q.locked) status = '<span class="gm-pill">Geschlossen</span>';
  else status = `<span class="gm-pill gold" id="gm-timer"></span>`;
  if (!q.revealed && !q.buzzType) status += `<span class="sm muted">${q.answered}/${q.eligible} geantwortet</span>`;

  const tools = !q.revealed ? `<div class="gm-tools">
    ${t.resume ? btn('resume', '▶', 'icon', null, 'title="Weiter"') : btn('pause', '⏸', 'icon', null, `title="Pause" ${t.pause ? '' : 'disabled'}`)}
    ${btn('addTime', '+10 s', 'icon', null, t.addTime ? '' : 'disabled')}
    ${btn('lock', '🔒', 'icon', null, `title="Antworten schließen" ${t.lock ? '' : 'disabled'}`)}
    ${btn('skip', '⏭', 'icon', null, 'title="Überspringen" data-confirm="Frage ohne Wertung überspringen?"')}
  </div>` : '';

  let hints = '';
  if (q.hints) {
    hints = `<ol class="gm-hints">${q.hints.list.map((h, i) => `<li class="${i < q.hints.shown ? 'on' : ''}">${esc(h)}</li>`).join('')}</ol>`;
  }

  let answers = '';
  const a = q.answers;
  if (a.kind === 'options') {
    answers = a.options.map(o => `<div class="gm-opt ${o.correct ? 'ok' : ''}"><b>${esc(o.letter)}</b><span class="go-t">${esc(o.text)}</span>
      <span class="go-n">${o.names.length}</span>${o.names.length ? `<span class="go-names">${esc(o.names.join(', '))}</span>` : ''}</div>`).join('');
  } else if (a.kind === 'list') {
    answers = a.items.length ? a.items.map(x => `<div class="gm-opt ${x.ok === true ? 'ok' : x.ok === false ? 'bad' : ''}"><b>${esc(x.name)}</b><span class="go-t">${esc(x.text)}</span>
      ${x.extra ? `<span class="go-n">${esc(x.extra)}</span>` : ''}</div>`).join('') : '<div class="muted sm">Noch keine Antworten</div>';
  } else if (a.kind === 'text') {
    answers = a.items.length ? `<div class="muted sm">Tippe, um richtig/falsch umzuschalten (Vorschlag automatisch).</div>` + a.items.map(x =>
      `<button class="gm-mark ${x.ok ? 'ok' : ''}" data-cmd="markText" data-arg='${esc(JSON.stringify(x.pid))}' ${q.revealed ? 'disabled' : ''}>
        <span class="gm-mk">${x.ok ? '✓' : '✗'}</span><b>${esc(x.name)}</b><span>${esc(x.text)}</span></button>`).join('')
      : '<div class="muted sm">Noch keine Antworten</div>';
  } else if (a.kind === 'buzz') {
    answers = q.buzz
      ? `<div class="gm-big">🔔 ${esc(q.buzz.name)}</div>${q.buzz.result ? `<div>${q.buzz.result === 'right' ? '✓ richtig' : '✗ falsch'}</div>` : '<div class="muted sm">Antwort anhören und oben werten</div>'}`
      : '<div class="muted sm">Noch niemand gebuzzert</div>';
    if (a.out && a.out.length) answers += `<div class="muted sm">Raus: ${esc(a.out.join(', '))}</div>`;
  }

  return `<section class="gm-card">
    <div class="gm-label">${esc(q.label)} · ${q.icon || ''} ${esc(q.typeLabel)}${q.hasMedia ? ' · 🎬' : ''}</div>
    <div class="gm-q">${esc(q.text)}</div>
    <div class="gm-sol">${esc(q.solution)}</div>
    ${q.notes ? `<details class="gm-notes-d" open><summary>🎙 Notiz</summary><div class="gm-notes">${esc(q.notes)}</div></details>` : ''}
    ${hints}
    <div class="gm-status">${status}</div>
    ${tools}
    <div class="gm-answers">${answers}</div>
  </section>`;
}

// ---------------------------------------------------------------- Ablauf

function flowTab(v) {
  const f = v.flow;
  const cur = f.current || {};
  const games = f.games.map(g => {
    const isCur = cur.g === g.idx;
    const state = g.done ? `<span class="gm-st done">✓ ${esc(g.winner || '')}</span>` : isCur ? '<span class="gm-st live">▶ läuft</span>' : '<span class="gm-st">offen</span>';
    const startBtn = btn('startGame', g.done ? 'Neu starten' : 'Starten', 'small', g.idx,
      g.done ? `data-confirm="„${esc(g.title)}“ wurde schon gespielt. Ergebnis zurücksetzen und neu starten?"` : `data-confirm="Spiel „${esc(g.title)}“ starten?"`);
    const qs = g.questions.length ? `<ol class="gm-qlist">${g.questions.map(q => {
      const here = isCur && cur.qi === q.qi && (v.phase === 'q' || v.phase === 'reveal');
      return `<li class="${here ? 'here' : ''}"><span class="qi">${q.icon}</span><span class="qt">${esc(q.label)}</span>
        ${here ? '<span class="gm-st live">jetzt</span>' : btn('gotoQuestion', '▶', 'tiny', { g: g.idx, qi: q.qi }, `data-confirm="Zu Frage ${q.qi + 1} von „${esc(g.title)}“ springen?${g.done ? ' Das Spielergebnis wird zurückgesetzt.' : ''}"`)}</li>`;
    }).join('')}</ol>` : '<div class="muted sm">Manuelles Spiel – ohne Fragen</div>';
    const k = String(g.idx);
    const isOpen = openGames.has(k) || (isCur && !closedGames.has(k));
    return `<details class="gm-game ${isCur ? 'cur' : ''} ${g.done ? 'done' : ''}" data-g="${k}" ${isOpen ? 'open' : ''}>
      <summary><span class="gm-num">${g.idx + 1}</span><span class="gg-t">${esc(g.title)}</span>${state}</summary>
      <div class="gg-body">${qs}<div class="gg-actions">${startBtn}</div></div></details>`;
  }).join('');
  let fin = '';
  if (f.final) {
    const isCur = cur.g === 'final';
    const fOpen = openGames.has('final') || (isCur && !closedGames.has('final'));
    fin = `<details class="gm-game final ${isCur ? 'cur' : ''}" data-g="final" ${fOpen ? 'open' : ''}>
      <summary><span class="gm-num">🔥</span><span class="gg-t">${esc(f.final.title)}</span>${isCur ? '<span class="gm-st live">▶ läuft</span>' : f.final.started ? '<span class="gm-st">begonnen</span>' : ''}</summary>
      <div class="gg-body"><ol class="gm-qlist">${f.final.questions.map(q => {
        const here = isCur && cur.qi === q.qi && (v.phase === 'q' || v.phase === 'reveal');
        return `<li class="${here ? 'here' : ''}"><span class="qi">${q.icon}</span><span class="qt">${esc(q.label)}</span>
          ${here ? '<span class="gm-st live">jetzt</span>' : btn('gotoQuestion', '▶', 'tiny', { g: 'final', qi: q.qi }, `data-confirm="Zu Finalfrage ${q.qi + 1} springen?"`)}</li>`;
      }).join('')}</ol></div></details>`;
  }
  return `<div class="gm-hint">Antippen klappt ein Spiel auf. ▶ springt direkt zu einer Frage.</div>${games}${fin}`;
}

// ---------------------------------------------------------------- Punkte

function pointsTab(v) {
  if (!v.players.length) return card('Punkte', '<div class="muted">Noch keine Mitspieler.</div>');
  const adj = (c, p, val, label) => `<div class="gm-adj"><span class="ga-l">${label}</span>
    ${btn(c, '−', 'tiny', { pid: p.id, d: -1 })}<b>${val}</b>${btn(c, '+', 'tiny', { pid: p.id, d: 1 })}</div>`;
  const rows = v.players.map((p, i) => `<section class="gm-prow ${p.online ? '' : 'off'}">
    <div class="gp-head"><span class="gp-rank">${i + 1}</span><span class="gm-dot" style="--c:${p.color}"></span><span class="gp-name">${esc(p.name)}</span>
      ${p.online ? '' : '<span class="gm-st">offline</span>'}
      ${btn('kick', '✕', 'tiny ghost', p.id, `data-confirm="${esc(p.name)} aus dem Spiel entfernen?"`)}</div>
    <div class="gp-adjs">
      ${adj('adjTotal', p, p.total, 'Punkte')}
      ${p.correct !== null ? adj('adjCorrect', p, p.correct, 'Richtige') : ''}
      ${p.final !== null ? adj('adjFinal', p, p.final, esc(v.finalLabel)) : ''}
    </div>
    ${v.jokerKinds.length ? `<div class="gp-jokers">${v.jokerKinds.map(k => `<span class="gp-j">${JK[k]} ${p.jokers[k] || 0}
      ${btn('jokerAdj', '+', 'tiny', { pid: p.id, kind: k, d: 1 }, 'title="Joker zurückgeben"')}</span>`).join('')}</div>` : ''}
  </section>`).join('');
  return `<div class="gm-hint">Korrekturen lassen sich mit ↶ Rückgängig (Reiter Mehr) zurücknehmen.</div>${rows}`;
}

// ---------------------------------------------------------------- Mehr

function moreTab(v) {
  const t = v.tools;
  const tile = (c, icon, label, enabled = true, extra = '') =>
    `<button class="gm-tile" data-cmd="${c}" ${enabled ? '' : 'disabled'} ${extra}><span class="ti">${icon}</span><span>${label}</span></button>`;
  return `<div class="gm-tiles">
    ${t.resume ? tile('resume', '▶', 'Weiter') : tile('pause', '⏸', 'Pause', t.pause)}
    ${tile('addTime', '⏱', '+10 Sekunden', t.addTime)}
    ${tile('lock', '🔒', 'Antworten schließen', t.lock)}
    ${tile('skip', '⏭', 'Frage überspringen', t.skip, 'data-confirm="Frage ohne Wertung überspringen?"')}
    ${tile('undo', '↶', t.undo ? `Rückgängig<small>${esc(undoLabel(t.undo))}</small>` : 'Rückgängig', !!t.undo)}
    ${tile('mute', t.muted ? '🔇' : '🔊', t.muted ? 'Ton an' : 'Ton aus')}
    ${tile('skipShow', '⏩', 'Intro überspringen', t.skipShow, 'data-confirm="Intro und Generalprobe überspringen?"')}
    ${tile('lobby', '📱', 'QR-Code am TV ein/aus')}
    ${tile('logout', '⎋', 'Abmelden')}
  </div>`;
}

function undoLabel(c) {
  return {
    nextGame: 'Spiel gestartet', startGame: 'Spiel gestartet', beginGame: 'Spiel begonnen', reveal: 'Aufgelöst', afterReveal: 'Weiter',
    buzzRight: 'Buzzer richtig', buzzWrong: 'Buzzer falsch', manualWin: 'Sieger bestätigt', tieWin: 'Sieger festgelegt', adjTotal: 'Punkte geändert',
    adjCorrect: 'Richtige geändert', adjFinal: 'Finalwert geändert', jokerAdj: 'Joker geändert', skip: 'Übersprungen', toBoard: 'Zur Tafel',
    lock: 'Geschlossen', release: 'Freigegeben', startTie: 'Stechfrage', nextFinal: 'Finale', finish: 'Zum Finale', addTime: '+10 s',
    gotoQuestion: 'Gesprungen', standings: 'Zwischenstand', startShow: 'Intro', showNext: 'Intro weiter', skipShow: 'Intro übersprungen',
    nextHint: 'Hinweis', lobby: 'QR-Code', toEnd: 'Siegerehrung',
  }[c] || c;
}
