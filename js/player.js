// Handy-Ansicht: beitreten und antworten.
import { createClient } from './net.js';
import { $, esc, OPTION_COLORS, OPTION_LETTERS } from './ui.js';

const app = $('#app');
const params = new URLSearchParams(location.search);
let code = (params.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isTest = params.has('test'); // Test-Tabs am Laptop bekommen eine eigene Identität
const store = isTest ? sessionStorage : localStorage;

let client = null;
let view = null;
let status = 'connecting';
let sentFor = null; // Frage-ID, für die bereits geantwortet wurde
let qDeadline = 0;
let raf = null;
let lastQ = null;

function pidKey() { return 'qa-pid-' + code; }

function start() {
  if (!code) return renderCodeForm();
  const pid = store.getItem(pidKey());
  const name = store.getItem('qa-name');
  if (!pid || !name) return renderJoin();
  connect(pid);
}

function connect(pid) {
  renderStatus();
  client = createClient(code, pid, {
    helloData: () => ({ name: store.getItem('qa-name') || '' }),
    onStatus: st => { status = st; renderStatus(); },
    onMessage: msg => {
      if (msg.t === 'view') { onView(msg.v); }
      if (msg.t === 'kicked') {
        store.removeItem(pidKey());
        app.innerHTML = page('', `<div class="big-icon">🚪</div><h1>Du wurdest entfernt</h1><p class="muted">Frag den Spielleiter, wenn das ein Versehen war.</p>
          <button class="btn primary" onclick="location.reload()">Neu beitreten</button>`);
        client = null;
      }
    },
  });
}

// ---------------------------------------------------------------- Formulare

function page(top, main) {
  return `<div class="phone"><div class="phone-top">${top}</div><div class="phone-main">${main}</div><div id="conn"></div></div>`;
}

function renderCodeForm() {
  app.innerHTML = page('<b>Quizarena</b>', `
    <div class="big-icon">🎮</div><h1>Beitreten</h1>
    <input type="text" id="code" class="p-input" maxlength="6" placeholder="CODE" autocapitalize="characters" autocomplete="off">
    <button class="btn primary big" id="go">Weiter</button>`);
  const go = () => {
    const c = $('#code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) return;
    location.search = '?r=' + c;
  };
  $('#go').onclick = go;
  $('#code').onkeydown = e => { if (e.key === 'Enter') go(); };
}

function renderJoin() {
  const old = store.getItem('qa-name') || '';
  app.innerHTML = page(`<b>Quizarena</b><span>Code ${esc(code)}</span>`, `
    <div class="big-icon">👋</div><h1>Wie heißt du?</h1>
    <p class="muted" style="margin:0">Im Teammodus: euer Teamname</p>
    <input type="text" id="name" class="p-input" maxlength="24" placeholder="Name" value="${esc(old)}" autocomplete="nickname">
    <button class="btn primary big" id="go">Mitspielen</button>`);
  const go = () => {
    const name = $('#name').value.trim();
    if (!name) return;
    store.setItem('qa-name', name);
    const pid = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    store.setItem(pidKey(), pid);
    app.innerHTML = page('', '<div class="big-icon">⏳</div><h1>Verbinde …</h1>');
    connect(pid);
  };
  $('#go').onclick = go;
  $('#name').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#name').focus();
}

function renderStatus() {
  const el = $('#conn');
  if (!el) return;
  const msg = { connecting: 'Verbinde mit dem Spiel …', offline: 'Verbindung unterbrochen – verbinde neu …', 'no-host': 'Spiel nicht gefunden. Läuft der Spielleiter-Bildschirm? Code prüfen.' }[status];
  el.innerHTML = msg && status !== 'online' ? `<div class="conn-banner">${msg}</div>` : '';
  if (!view && status !== 'online') {
    const main = document.querySelector('.phone-main');
    if (main && !main.dataset.waiting) {
      main.dataset.waiting = '1';
      main.innerHTML = `<div class="big-icon">⏳</div><h1>${status === 'no-host' ? 'Suche Spiel …' : 'Verbinde …'}</h1><p class="muted">Code ${esc(code)}</p>`;
    }
  }
}

// ---------------------------------------------------------------- Spielansicht

let lastKey = null;

function onView(v) {
  const newQ = v.q && (!lastQ || lastQ !== v.q.id);
  if (v.q) {
    qDeadline = Date.now() + v.q.remaining;
    if (newQ && navigator.vibrate) navigator.vibrate(60);
    lastQ = v.q.id;
  } else lastQ = null;
  view = v;
  // Während einer Frage nicht neu zeichnen, wenn sich für dieses Handy nichts geändert hat
  // (sonst ginge z. B. eine angefangene Schätzung verloren).
  const key = v.phase === 'q' && v.q ? ['q', v.q.id, v.q.answered, v.q.locked, sentFor].join('|') : null;
  if (key && key === lastKey) {
    const topEl = document.querySelector('.phone-top');
    if (topEl) topEl.innerHTML = topBar(v);
    return;
  }
  lastKey = key;
  render();
}

function topBar(v) {
  const me = v.me || {};
  let right = `${me.total ?? 0} ${me.total === 1 ? 'Punkt' : 'Punkte'}`;
  if (v.final) right = v.final.lives !== undefined ? `❤ ${v.final.lives}` : `Finale: ${v.final.score}${v.final.target ? ' / ' + v.final.target : ''}`;
  return `<span class="me"><span class="dot" style="background:${me.color || '#888'}"></span>${esc(me.name || '')}</span><span>${right}${me.rank && !v.final ? ` · Platz ${me.rank}` : ''}</span>`;
}

function render() {
  cancelAnimationFrame(raf);
  const v = view;
  if (!v) return;
  let main;
  if (v.phase === 'q' && v.q) main = renderQuestion(v.q);
  else if (v.phase === 'reveal' && v.r) main = renderReveal(v.r);
  else main = `<div class="big-icon">${v.icon || '🎲'}</div><h1>${esc(v.title)}</h1>${v.sub ? `<p class="muted" style="font-size:1.1em">${esc(v.sub)}</p>` : ''}`;
  app.innerHTML = page(topBar(v), main);
  renderStatus();
  bind();
  if (v.phase === 'q' && v.q && !v.q.locked) animateTimer(v.q);
}

function renderQuestion(q) {
  const answered = q.answered || sentFor === q.id;
  if (answered) return `<div class="big-icon">✅</div><h1>Antwort gesendet</h1><p class="muted">Warte auf die Auflösung …</p>`;
  if (q.locked) return `<div class="big-icon">⌛</div><h1>Zeit abgelaufen</h1>`;
  let input;
  if (q.type === 'mc') {
    input = `<div class="p-answers">${q.options.map(o => `<button class="p-ans" data-v="${o.i}" style="background:${OPTION_COLORS[o.i]}"><span class="l">${OPTION_LETTERS[o.i]}</span><span class="t">${esc(o.t)}</span></button>`).join('')}</div>`;
  } else if (q.type === 'tf') {
    input = `<div class="p-answers two"><button class="p-ans" data-v="true" style="background:#22a06b"><span class="l">✓</span><span class="t">Wahr</span></button>
      <button class="p-ans" data-v="false" style="background:#e63e5c"><span class="l">✗</span><span class="t">Falsch</span></button></div>`;
  } else {
    input = `<input type="text" inputmode="decimal" id="est" class="p-input" placeholder="Deine Schätzung" autocomplete="off">
      ${q.unit ? `<div class="muted">in ${esc(q.unit)}</div>` : ''}
      <button class="btn primary big" id="send">Abschicken</button>`;
  }
  return `<div class="p-timer"><i id="ptimer"></i></div>
    <div style="font-weight:700;font-size:1.15em">${esc(q.text)}</div>
    ${input}`;
}

function renderReveal(r) {
  if (!r.eligible) return `<div class="big-icon">👀</div><h1>Auflösung</h1><p class="muted">Lösung: ${esc(r.solution)}</p>`;
  const verdict = r.good ? '<div class="verdict good">Richtig!</div>' : r.answered ? '<div class="verdict bad">Leider falsch</div>' : '<div class="verdict bad">Keine Antwort</div>';
  return `<div class="big-icon">${r.good ? '🎉' : '😬'}</div>${verdict}
    <p style="font-size:1.1em">Lösung: <b>${esc(r.solution)}</b></p>
    ${r.mine !== null ? `<p class="muted">Deine Antwort: ${esc(r.mine)}</p>` : ''}
    ${r.lostLife ? '<p style="color:var(--bad);font-weight:700">−1 Leben</p>' : ''}`;
}

function parseNumber(s) {
  s = String(s).trim().replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : null;
}

function send(value) {
  const q = view && view.q;
  if (!q || !client) return;
  if (client.send({ t: 'answer', qid: q.id, value })) {
    sentFor = q.id;
    render();
  }
}

function bind() {
  document.querySelectorAll('.p-ans').forEach(b => b.onclick = () => {
    const raw = b.dataset.v;
    send(raw === 'true' ? true : raw === 'false' ? false : Number(raw));
  });
  const est = $('#est');
  if (est) {
    const go = () => {
      const n = parseNumber(est.value);
      if (n === null) { est.style.borderColor = 'var(--bad)'; return; }
      send(n);
    };
    $('#send').onclick = go;
    est.onkeydown = e => { if (e.key === 'Enter') go(); };
  }
}

function animateTimer(q) {
  const bar = $('#ptimer');
  if (!bar) return;
  (function frame() {
    const end = qDeadline;
    const rest = Math.max(0, end - Date.now());
    bar.style.transform = `scaleX(${q.dur ? rest / q.dur : 0})`;
    if (rest > 0) raf = requestAnimationFrame(frame);
  })();
}

start();
