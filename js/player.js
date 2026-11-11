// Handy-Ansicht: beitreten, antworten, buzzern, Joker setzen.
import { createClient } from './net.js';
import { $, esc, OPTION_COLORS, OPTION_LETTERS } from './ui.js';
import { renderGm } from './gm.js';

const app = $('#app');
const params = new URLSearchParams(location.search);
let code = (params.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isTest = params.has('test'); // Test-Tabs am Laptop bekommen eine eigene Identität
const baseStore = isTest ? sessionStorage : localStorage;
const ns = isTest ? '-t' + params.get('test') : '';
const store = {
  getItem: k => baseStore.getItem(k + ns),
  setItem: (k, v) => baseStore.setItem(k + ns, v),
  removeItem: k => baseStore.removeItem(k + ns),
};

let client = null;
let view = null;
let status = 'connecting';
let sentFor = null;     // Frage-ID, für die bereits geantwortet wurde
let buzzedFor = null;   // Frage-ID, für die gebuzzert wurde
let qDeadline = 0;
let raf = null;
let lastQ = null;
let lastKey = null;
let order = { qid: null, seq: [] }; // Reihenfolge-Frage: getippte Reihenfolge
let choice = { qid: null, v: null };  // MC/WF: angetippt, aber noch nicht bestätigt
let armedDouble = false;
let isGm = false;

function pidKey() { return 'qa-pid-' + code; }
const roleKey = () => 'qa-role-' + code;
const gmPidKey = () => 'qa-gmpid-' + code;
const gmPwKey = () => 'qa-gmpw-' + code;

function start() {
  if (!code) return renderCodeForm();
  const role = store.getItem(roleKey());
  if (role === 'gm') {
    const pw = store.getItem(gmPwKey());
    return pw ? connectGm(pw) : renderGmLogin();
  }
  const pid = store.getItem(pidKey());
  const name = store.getItem('qa-name');
  if (pid && name) return connect(pid);
  renderRoleChoice();
}

// Bildschirm während des Spiels anlassen (wo der Browser das unterstützt)
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* nicht unterstützt oder abgelehnt */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && client) keepAwake(); });

function renderRoleChoice() {
  app.innerHTML = page(`<b>Quizarena</b><span>Code ${esc(code)}</span>`, `
    <div class="big-icon">🎮</div><h1>Willkommen!</h1>
    <button class="btn primary big" id="as-player">Mitspielen</button>
    <button class="btn big ghost" id="as-gm">🎙 Spielleiter</button>`);
  $('#as-player').onclick = () => { store.setItem(roleKey(), 'player'); renderJoin(); };
  $('#as-gm').onclick = () => renderGmLogin();
}

function renderGmLogin(error = '') {
  app.innerHTML = page(`<b>Quizarena</b><span>Code ${esc(code)}</span>`, `
    <div class="big-icon">🎙</div><h1>Spielleiter</h1>
    <p class="muted" style="margin:0">Hier siehst du die Lösungen. Bitte Passwort eingeben.</p>
    ${error ? `<div class="conn-banner">${esc(error)}</div>` : ''}
    <input type="password" id="pw" class="p-input" placeholder="Passwort" inputmode="numeric" autocomplete="off">
    <button class="btn primary big" id="go">Anmelden</button>
    <button class="btn ghost" id="back">Zurück</button>`);
  const go = () => {
    const pw = $('#pw').value.trim();
    if (!pw) return;
    store.setItem(roleKey(), 'gm');
    store.setItem(gmPwKey(), pw);
    app.innerHTML = page('', '<div class="big-icon">⏳</div><h1>Verbinde …</h1>');
    connectGm(pw);
  };
  $('#go').onclick = go;
  $('#pw').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#back').onclick = () => { store.removeItem(roleKey()); renderRoleChoice(); };
  $('#pw').focus();
}

function gmLogout() {
  if (client && client.stop) client.stop();
  client = null; view = null; isGm = false;
  store.removeItem(roleKey()); store.removeItem(gmPwKey());
  renderRoleChoice();
}

function connectGm(pw) {
  isGm = true;
  let pid = store.getItem(gmPidKey());
  if (!pid) { pid = 'g' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); store.setItem(gmPidKey(), pid); }
  keepAwake();
  app.addEventListener('gm-logout', gmLogout);
  client = createClient(code, pid, {
    helloData: () => ({ role: 'gm', pw }),
    onStatus: st => { status = st; if (!view) renderStatus(); else { const c = $('#gm-conn'); if (c) c.innerHTML = connBanner(); } },
    onMessage: msg => {
      if (msg.t === 'gm') {
        view = msg.v;
        renderGm(app, msg.v, m => client && client.send(m));
        app.insertAdjacentHTML('beforeend', `<div id="gm-conn">${connBanner()}</div>`);
      }
      if (msg.t === 'gmDenied') {
        if (client) client.stop();
        client = null; view = null;
        store.removeItem(gmPwKey());
        renderGmLogin('Falsches Passwort.');
      }
    },
  });
}

function connBanner() {
  const msg = { connecting: 'Verbinde mit dem Spiel …', offline: 'Verbindung unterbrochen – verbinde neu …', 'no-host': 'Spiel nicht gefunden. Läuft der Spielleiter-Bildschirm?' }[status];
  return msg && status !== 'online' ? `<div class="conn-banner">${msg}</div>` : '';
}

function connect(pid) {
  keepAwake();
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
    store.setItem(roleKey(), 'player');
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

function viewKey(v) {
  if (v.phase === 'q' && v.q) {
    const q = v.q;
    return ['q', q.id, q.answered, q.locked, q.waiting, q.paused, q.options ? q.options.length : '', q.buzz ? q.buzz.name : '', q.usedFifty, q.usedTime,
      q.jokers ? `${q.jokers.fifty}/${q.jokers.time}` : '-', sentFor, buzzedFor].join('|');
  }
  if (v.phase === 'intro') return ['intro', v.title, v.double ? `${v.double.left}/${v.double.used}` : '', armedDouble].join('|');
  return null;
}

function onView(v) {
  const newQ = v.q && (!lastQ || lastQ !== v.q.id);
  if (v.q) {
    qDeadline = Date.now() + v.q.remaining;
    if (newQ) {
      if (navigator.vibrate) navigator.vibrate(60);
      order = { qid: v.q.id, seq: [] };
    }
    lastQ = v.q.id;
  } else lastQ = null;
  if (v.phase !== 'intro') armedDouble = false;
  view = v;
  // Nicht neu zeichnen, wenn sich für dieses Handy nichts geändert hat (sonst gehen Eingaben verloren).
  const key = viewKey(v);
  if (key && key === lastKey) {
    const topEl = document.querySelector('.phone-top');
    if (topEl) topEl.innerHTML = topBar(v);
    if (v.q && !v.q.locked && !v.q.waiting) animateTimer(v.q);
    return;
  }
  lastKey = key;
  render();
}

function topBar(v) {
  const me = v.me || {};
  let right = `${me.total ?? 0} ${me.total === 1 ? 'Punkt' : 'Punkte'}`;
  if (v.final) right = v.final.lives !== undefined ? `❤ ${v.final.lives}` : `Finale: ${v.final.score}${v.final.target ? ' / ' + v.final.target : ''}`;
  const j = me.jokers || {};
  const jk = [['double', '⚡'], ['fifty', '½'], ['time', '⏱']].filter(([k]) => j[k] > 0).map(([k, i]) => `${i}${j[k] > 1 ? j[k] : ''}`).join(' ');
  return `<span class="me"><span class="dot" style="background:${me.color || '#888'}"></span>${esc(me.name || '')}${jk ? ` <span class="p-jk">${jk}</span>` : ''}</span><span>${right}${me.rank && !v.final ? ` · Platz ${me.rank}` : ''}</span>`;
}

function render() {
  cancelAnimationFrame(raf);
  const v = view;
  if (!v) return;
  // angefangene Schätzung retten
  const est = $('#est');
  const keep = est ? { qid: est.dataset.qid, val: est.value } : null;

  let main;
  if (v.phase === 'q' && v.q) main = renderQuestion(v.q);
  else if (v.phase === 'reveal' && v.r) main = renderReveal(v.r);
  else if (v.phase === 'intro') main = renderIntro(v);
  else main = waitScreen(v);
  app.innerHTML = page(topBar(v), main);
  renderStatus();
  bind();
  const est2 = $('#est');
  if (est2 && keep && keep.qid === est2.dataset.qid) est2.value = keep.val;
  if (v.phase === 'q' && v.q && !v.q.locked && !v.q.waiting) animateTimer(v.q);
}

function waitScreen(v) {
  return `<div class="big-icon">${v.icon || '🎲'}</div><h1>${esc(v.title)}</h1>${v.sub ? `<p class="muted" style="font-size:1.1em">${esc(v.sub)}</p>` : ''}`;
}

function renderIntro(v) {
  let joker = '';
  if (v.double) {
    if (v.double.used) joker = '<div class="p-joker-set">⚡ Verdoppelt! Ein Sieg in diesem Spiel zählt doppelt.</div>';
    else if (v.double.left > 0) {
      joker = `<button class="btn big p-joker-btn ${armedDouble ? 'armed' : ''}" id="double">${armedDouble ? 'Wirklich setzen? Nochmal tippen' : `⚡ Verdoppeln-Joker setzen (noch ${v.double.left})`}</button>`;
    }
  }
  return `${waitScreen(v)}${joker}`;
}

function jokerBar(q) {
  if (!q.jokers) return '';
  const b = [];
  if (q.jokers.fifty > 0) b.push(`<button class="btn small p-jbtn" data-joker="fifty">½ 50:50 (${q.jokers.fifty})</button>`);
  if (q.jokers.time > 0) b.push(`<button class="btn small p-jbtn" data-joker="time">⏱ +10 s (${q.jokers.time})</button>`);
  return b.length ? `<div class="p-jokers">${b.join('')}</div>` : '';
}

function renderQuestion(q) {
  const head = `<div style="font-weight:700;font-size:1.15em">${esc(q.text)}</div>`;
  if (q.waiting) return `<div class="big-icon">👀</div><h1>Gut aufpassen!</h1><p class="muted">Schau auf den großen Bildschirm. Gleich geht es los.</p>`;

  if (q.type === 'buzzer') {
    if (q.buzz) {
      return q.buzz.me
        ? '<div class="big-icon">🎤</div><h1>Du bist dran!</h1><p class="muted" style="font-size:1.1em">Sag deine Antwort laut.</p>'
        : `<div class="big-icon">🔔</div><h1>${esc(q.buzz.name)} hat gebuzzert</h1>`;
    }
    if (q.locked) return '<div class="big-icon">⌛</div><h1>Zeit abgelaufen</h1>';
    if (buzzedFor === q.id) return '<div class="big-icon">🔔</div><h1>Gebuzzert …</h1>';
    return `<div class="p-timer"><i id="ptimer"></i></div>${head}<button class="p-buzz" id="buzz">BUZZ!</button>`;
  }

  const answered = q.answered || sentFor === q.id;
  if (answered) return `<div class="big-icon">✅</div><h1>Antwort gesendet</h1><p class="muted">Warte auf die Auflösung …</p>`;
  if (q.locked) return `<div class="big-icon">⌛</div><h1>Zeit abgelaufen</h1>`;

  let input;
  // Auswahl verwerfen, falls 50:50 sie gerade entfernt hat
  if (q.type === 'mc' && choice.qid === q.id && !q.options.some(o => o.i === choice.v)) choice = { qid: null, v: null };
  const picked = choice.qid === q.id ? choice.v : null;
  const sel = v => (picked !== null && String(picked) === String(v) ? 'sel' : picked !== null ? 'unsel' : '');
  const confirmBtn = `<button class="btn primary big p-confirm" id="confirm" ${picked === null ? 'disabled' : ''}>${picked === null ? 'Antwort antippen …' : 'Antwort bestätigen ✓'}</button>`;
  if (q.type === 'mc') {
    input = `<div class="p-answers">${q.options.map(o => `<button class="p-ans ${sel(o.i)}" data-v="${o.i}" style="background:${OPTION_COLORS[o.i]}"><span class="l">${OPTION_LETTERS[o.i]}</span><span class="t">${esc(o.t)}</span></button>`).join('')}</div>${confirmBtn}`;
  } else if (q.type === 'tf') {
    input = `<div class="p-answers two"><button class="p-ans ${sel(true)}" data-v="true" style="background:#1f8a5b"><span class="l">✓</span><span class="t">Wahr</span></button>
      <button class="p-ans ${sel(false)}" data-v="false" style="background:#b8323f"><span class="l">✗</span><span class="t">Falsch</span></button></div>${confirmBtn}`;
  } else if (q.type === 'order') {
    const seq = order.qid === q.id ? order.seq : [];
    input = `<div class="muted" style="font-size:.9em">Tippe die Einträge in der richtigen Reihenfolge an.</div>
      <div class="p-order">${q.items.map(it => {
        const pos = seq.indexOf(it.i);
        return `<button class="p-order-item ${pos >= 0 ? 'set' : ''}" data-oi="${it.i}" ${pos >= 0 ? 'disabled' : ''}>${pos >= 0 ? `<span class="badge">${pos + 1}</span>` : ''}${esc(it.t)}</button>`;
      }).join('')}</div>
      <div class="row" style="justify-content:center">
        <button class="btn" id="oreset" ${seq.length ? '' : 'disabled'}>Zurücksetzen</button>
        <button class="btn primary" id="osend" ${seq.length === q.items.length ? '' : 'disabled'}>Abschicken</button>
      </div>`;
  } else {
    input = `<input type="text" inputmode="decimal" id="est" data-qid="${q.id}" class="p-input" placeholder="Deine Schätzung" autocomplete="off">
      ${q.unit ? `<div class="muted">in ${esc(q.unit)}</div>` : ''}
      <button class="btn primary big" id="send">Abschicken</button>`;
  }
  const used = `${q.usedFifty ? '<span class="p-used">½ 50:50 aktiv</span>' : ''}${q.usedTime ? '<span class="p-used">⏱ +10 s aktiv</span>' : ''}`;
  return `<div class="p-timer"><i id="ptimer"></i></div>${head}${used ? `<div>${used}</div>` : ''}${input}${jokerBar(q)}`;
}

function renderReveal(r) {
  if (!r.eligible) return `<div class="big-icon">👀</div><h1>Auflösung</h1><p class="muted">Lösung: ${esc(r.solution)}</p>`;
  if (r.type === 'buzzer') {
    if (r.good) return `<div class="big-icon">🎉</div><div class="verdict good">Richtig!</div><p>Lösung: <b>${esc(r.solution)}</b></p>`;
    if (r.penalty) return `<div class="big-icon">😬</div><div class="verdict bad">Falsch – Minuspunkt</div><p>Lösung: <b>${esc(r.solution)}</b></p>${r.lostLife ? '<p style="color:var(--bad);font-weight:700">−1 Leben</p>' : ''}`;
    return `<div class="big-icon">💡</div><h1>Lösung: ${esc(r.solution)}</h1>${r.buzzName ? `<p class="muted">${esc(r.buzzName)} hatte gebuzzert.</p>` : '<p class="muted">Niemand hat gebuzzert.</p>'}`;
  }
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
  // Antippen wählt nur aus, gesendet wird erst mit „Bestätigen“
  document.querySelectorAll('.p-ans').forEach(b => b.onclick = () => {
    const raw = b.dataset.v;
    choice = { qid: view.q.id, v: raw === 'true' ? true : raw === 'false' ? false : Number(raw) };
    if (navigator.vibrate) navigator.vibrate(15);
    render();
  });
  const conf = $('#confirm');
  if (conf) conf.onclick = () => { if (choice.qid === view.q.id && choice.v !== null) send(choice.v); };
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
  document.querySelectorAll('[data-oi]').forEach(b => b.onclick = () => {
    if (order.qid !== view.q.id) order = { qid: view.q.id, seq: [] };
    order.seq.push(Number(b.dataset.oi));
    render();
  });
  const reset = $('#oreset');
  if (reset) reset.onclick = () => { order.seq = []; render(); };
  const osend = $('#osend');
  if (osend) osend.onclick = () => send(order.seq.slice());
  const buzz = $('#buzz');
  if (buzz) buzz.onclick = () => {
    const q = view.q;
    if (client && client.send({ t: 'buzz', qid: q.id })) {
      buzzedFor = q.id;
      if (navigator.vibrate) navigator.vibrate(150);
      render();
    }
  };
  document.querySelectorAll('[data-joker]').forEach(b => b.onclick = () => {
    if (client) client.send({ t: 'joker', kind: b.dataset.joker, qid: view.q && view.q.id });
    b.disabled = true;
  });
  const dbl = $('#double');
  if (dbl) dbl.onclick = () => {
    if (!armedDouble) { armedDouble = true; lastKey = null; render(); return; }
    armedDouble = false;
    if (client) client.send({ t: 'joker', kind: 'double' });
    dbl.disabled = true;
  };
}

function animateTimer(q) {
  cancelAnimationFrame(raf);
  const bar = $('#ptimer');
  if (!bar) return;
  if (q.paused) { bar.style.transform = `scaleX(${q.dur ? Math.min(1, q.remaining / q.dur) : 0})`; bar.classList.add('paused'); return; }
  (function frame() {
    const rest = Math.max(0, qDeadline - Date.now());
    bar.style.transform = `scaleX(${q.dur ? Math.min(1, rest / q.dur) : 0})`;
    if (rest > 0) raf = requestAnimationFrame(frame);
  })();
}

start();
