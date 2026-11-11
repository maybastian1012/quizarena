// Spielleiter-Ansicht auf dem Handy: Lösungen sehen, steuern, Punkte korrigieren.
import { esc } from './ui.js';

let deadline = 0;
let raf = null;
const JK = [['double', '⚡'], ['fifty', '½'], ['time', '⏱']];

const btn = (c, label, cls = '', arg = null, extra = '') =>
  `<button class="btn ${cls}" data-cmd="${c}" ${arg !== null ? `data-arg='${esc(JSON.stringify(arg))}'` : ''} ${extra}>${label}</button>`;

export function renderGm(app, v, send) {
  const y = window.scrollY;
  cancelAnimationFrame(raf);
  const ctrl = v.controls || {};
  const primary = ctrl.primary
    ? btn(ctrl.primary.c, ctrl.primary.label, 'primary big gm-primary', null, ctrl.primary.disabled ? 'disabled' : '')
    : '';
  const judge = (ctrl.buttons || []).filter(b => (b.cls || '').includes('judge'));
  const others = (ctrl.buttons || []).filter(b => !(b.cls || '').includes('judge'));

  app.innerHTML = `<div class="gm">
    <div class="gm-head">
      <div><b>🎙 Spielleiter</b> <span class="muted">· Code ${esc(v.code)}</span></div>
      <div class="gm-head-btns">
        ${btn('mute', v.muted ? '🔇' : '🔊', 'small ghost')}
        <button class="btn small ghost" id="gm-logout" title="Abmelden">⎋</button>
      </div>
    </div>
    <div class="gm-context">${esc(v.context || v.quiz)} <span class="gm-phase">${phaseLabel(v.phase)}</span></div>

    ${judge.length ? `<div class="gm-judge">${judge.map(b => btn(b.c, b.label, `big ${b.cls}`)).join('')}</div>` : ''}
    ${primary}
    ${others.length ? `<div class="gm-btns">${others.map(b => btn(b.c, b.label, `small ${b.cls || ''}`)).join('')}</div>` : ''}
    ${v.undo ? `<div class="gm-btns">${btn('undo', '↶ Rückgängig', 'small ghost')}<span class="muted" style="font-size:.8em">letzter Schritt: ${esc(undoLabel(v.undo))}</span></div>` : ''}

    ${phaseBlock(v)}
    ${v.next ? `<div class="gm-card gm-next"><div class="gm-label">Als Nächstes · ${esc(v.next.label)}</div>
      <div>${esc(v.next.text)}</div><div class="gm-sol">Lösung: ${esc(v.next.solution)}</div>
      ${v.next.notes ? `<div class="gm-notes">${esc(v.next.notes)}</div>` : ''}</div>` : ''}
    ${playersBlock(v)}
  </div>`;

  window.scrollTo(0, y);
  app.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => {
    const c = b.dataset.cmd;
    const arg = b.dataset.arg ? JSON.parse(b.dataset.arg) : undefined;
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    send({ t: 'cmd', c, arg });
    if (navigator.vibrate) navigator.vibrate(20);
  });
  const lo = app.querySelector('#gm-logout');
  if (lo) lo.onclick = () => { if (confirm('Als Spielleiter abmelden?')) app.dispatchEvent(new CustomEvent('gm-logout')); };

  if (v.q && !v.q.revealed && !v.q.locked && !v.q.waiting) {
    deadline = Date.now() + v.q.remaining;
    const el = app.querySelector('#gm-timer');
    (function tick() {
      if (!el) return;
      el.textContent = v.q.paused ? '⏸ Pause' : `${Math.ceil(Math.max(0, deadline - Date.now()) / 1000)} s`;
      if (!v.q.paused && deadline > Date.now()) raf = requestAnimationFrame(tick);
    })();
  }
}

function phaseLabel(p) {
  return {
    lobby: 'Lobby', board: 'Spieltafel', intro: 'Ankündigung', q: 'Frage läuft', reveal: 'Auflösung', manual: 'Manuelles Spiel',
    tie: 'Gleichstand', gameEnd: 'Spielende', finalIntro: 'Finale', end: 'Siegerehrung',
  }[p] || p;
}

function undoLabel(c) {
  return {
    nextGame: 'Spiel gestartet', startGame: 'Spiel gestartet', beginGame: 'Spiel begonnen', reveal: 'Aufgelöst', afterReveal: 'Weiter',
    buzzRight: 'Buzzer richtig', buzzWrong: 'Buzzer falsch', manualWin: 'Sieger bestätigt', tieWin: 'Sieger festgelegt', adjTotal: 'Punkte geändert',
    adjCorrect: 'Richtige geändert', adjFinal: 'Finalwert geändert', skip: 'Übersprungen', toBoard: 'Zur Tafel', lock: 'Geschlossen', release: 'Freigegeben',
    startTie: 'Stechfrage', nextFinal: 'Finale', finish: 'Zum Finale', addTime: '+10 s',
  }[c] || c;
}

function phaseBlock(v) {
  switch (v.phase) {
    case 'lobby':
      return `<div class="gm-card"><div class="gm-label">Lobby</div>${v.players.length} Mitspieler verbunden. Starte mit „Spieltafel öffnen“.</div>`;
    case 'board':
      return `<div class="gm-card"><div class="gm-label">Spiele</div>${(v.games || []).map(g => `
        <div class="gm-row">
          <span class="gm-num">${g.idx + 1}</span>
          <span class="grow"><b>${esc(g.title)}</b> <span class="muted">· ${g.type === 'manual' ? 'manuell' : 'Fragen'} · ${g.points} P</span>
            ${g.done ? `<br><span class="gm-win">🏆 ${esc(g.winner)}</span>` : ''}</span>
          ${g.done ? '' : btn('startGame', 'Starten', 'small', g.idx)}
        </div>`).join('')}</div>`;
    case 'intro':
    case 'manual': {
      const g = v.game;
      let picks = '';
      if (v.phase === 'manual') {
        picks = `<div class="gm-label" style="margin-top:10px">Sieger antippen</div><div class="gm-picks">${v.players.map(p =>
          btn('manualToggle', esc(p.name) + (p.doubled ? ' ⚡' : ''), `pick ${v.manualSel.includes(p.id) ? 'sel' : ''}`, p.id, `style="box-shadow:inset 0 -4px 0 ${p.color}"`)).join('')}</div>`;
      }
      const dbl = v.players.filter(p => p.doubled).map(p => esc(p.name));
      return `<div class="gm-card"><div class="gm-label">${esc(v.context)}</div>
        ${g.description ? `<div>${esc(g.description)}</div>` : ''}
        <div class="muted">Sieg: ${g.points} P${g.type === 'quiz' ? ` · ${g.questions} Fragen` : ''}</div>
        ${dbl.length ? `<div class="gm-win">⚡ Verdoppelt: ${dbl.join(', ')}</div>` : ''}${picks}</div>`;
    }
    case 'q':
    case 'reveal':
      return questionBlock(v.q);
    case 'tie':
      return `<div class="gm-card"><div class="gm-label">Gleichstand · ${esc(v.tie.label)}</div>
        ${v.tie.hasQuestion ? '<div class="muted">Stechfrage starten oder Sieger direkt festlegen:</div>' : '<div class="muted">Keine Stechfrage übrig – Sieger festlegen:</div>'}
        <div class="gm-picks">${v.tie.ids.map(id => {
          const p = v.players.find(x => x.id === id) || { name: '?' };
          return btn('tieWin', `🏆 ${esc(p.name)}`, 'pick', id, `data-confirm="${esc(p.name)} als Sieger festlegen?"`);
        }).join('')}</div></div>`;
    case 'gameEnd':
      return `<div class="gm-card"><div class="gm-label">Spielende</div><div class="gm-big">🏆 ${esc(v.result.winners)}</div><div class="muted">+${v.result.pts} ${Number(v.result.pts) === 1 ? 'Punkt' : 'Punkte'}</div></div>`;
    case 'finalIntro':
      return `<div class="gm-card"><div class="gm-label">Finale</div>Startwerte stehen unten bei den Spielern.</div>`;
    case 'end':
      return `<div class="gm-card"><div class="gm-label">Siegerehrung</div><div class="gm-big">👑 ${esc(v.champion || '–')}</div></div>`;
  }
  return '';
}

function questionBlock(q) {
  let status;
  if (q.revealed) status = `<span class="gm-pill">Aufgelöst</span>${q.winners && q.winners.length ? ` ✓ ${esc(q.winners.join(', '))}` : ' Niemand richtig'}`;
  else if (q.waiting) status = '<span class="gm-pill">Medium läuft – Antworten noch gesperrt</span>';
  else if (q.locked) status = '<span class="gm-pill">Antworten geschlossen</span>';
  else status = `<span class="gm-pill gold" id="gm-timer"></span>`;

  let answers = '';
  const a = q.answers;
  if (a.kind === 'options') {
    answers = a.options.map(o => `<div class="gm-opt ${o.correct ? 'ok' : ''}" style="border-left-color:${o.color}">
      <b>${esc(o.letter)}</b> ${esc(o.text)} ${o.correct ? '✓' : ''}<span class="gm-names">${o.names.length ? esc(o.names.join(', ')) : '–'}</span></div>`).join('');
  } else if (a.kind === 'list') {
    answers = a.items.length ? a.items.map(x => `<div class="gm-opt ${x.ok === true ? 'ok' : x.ok === false ? 'bad' : ''}">
      <b>${esc(x.name)}</b> ${esc(x.text)} ${x.extra ? `<span class="muted">${esc(x.extra)}</span>` : ''}${x.ok === true ? ' ✓' : x.ok === false ? ' ✗' : ''}</div>`).join('')
      : '<div class="muted">Noch keine Antworten</div>';
  } else if (a.kind === 'buzz') {
    answers = q.buzz
      ? `<div class="gm-big">🔔 ${esc(q.buzz.name)}</div>${q.buzz.result ? `<div>${q.buzz.result === 'right' ? '✓ richtig' : '✗ falsch (−1)'}</div>` : '<div class="muted">Antwort anhören und werten</div>'}`
      : '<div class="muted">Noch niemand gebuzzert</div>';
  }

  return `<div class="gm-card">
    <div class="gm-label">${esc(q.label)} · ${esc(q.typeLabel)}${q.hasMedia ? ' · 🎬' : ''}</div>
    <div class="gm-q">${esc(q.text)}</div>
    <div class="gm-sol">Lösung: ${esc(q.solution)}</div>
    ${q.notes ? `<div class="gm-notes">🎙 ${esc(q.notes)}</div>` : ''}
    <div class="gm-status">${status} ${q.type !== 'buzzer' ? `<span class="muted">${q.answered}/${q.eligible} geantwortet</span>` : ''}</div>
    ${!q.revealed && q.missing.length && q.type !== 'buzzer' ? `<div class="muted" style="font-size:.85em">Fehlt noch: ${esc(q.missing.join(', '))}</div>` : ''}
    <div class="gm-answers">${answers}</div>
  </div>`;
}

function playersBlock(v) {
  if (!v.players.length) return '';
  const rows = v.players.map(p => {
    const jk = JK.filter(([k]) => p.jokers[k] > 0).map(([k, i]) => `${i}${p.jokers[k] > 1 ? p.jokers[k] : ''}`).join(' ');
    const adj = (c, val, label) => `<span class="gm-adj">${btn(c, '−', 'tiny', { pid: p.id, d: -1 })}<span title="${label}">${val}</span>${btn(c, '+', 'tiny', { pid: p.id, d: 1 })}</span>`;
    return `<div class="gm-prow ${p.online ? '' : 'off'}">
      <span class="gm-pname"><span class="dot" style="background:${p.color}"></span>${esc(p.name)} ${jk ? `<span class="p-jk">${jk}</span>` : ''}</span>
      ${adj('adjTotal', p.total, 'Gesamtpunkte')}
      ${p.correct !== null ? adj('adjCorrect', p.correct, 'Richtige im Spiel') : ''}
      ${p.final !== null ? adj('adjFinal', p.final, v.finalLabel) : ''}
      ${btn('kick', '✕', 'tiny ghost', p.id, `data-confirm="${esc(p.name)} aus dem Spiel entfernen?"`)}
    </div>`;
  }).join('');
  const heads = `<div class="gm-prow gm-phead"><span class="gm-pname">Spieler</span><span>Punkte</span>
    ${v.players[0].correct !== null ? '<span>Richtige</span>' : ''}${v.players[0].final !== null ? `<span>${esc(v.finalLabel)}</span>` : ''}<span></span></div>`;
  return `<div class="gm-card"><div class="gm-label">Spieler & Korrektur</div>${heads}${rows}</div>`;
}
