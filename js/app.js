// Laptop-Seite: Übersicht, Abend einrichten, Editor und Spielleiter-Ansicht.
import { listQuizzes, getQuiz, saveQuiz, deleteQuiz, kvGet, kvSet } from './store.js';
import { newQuiz, normalizeQuiz, sampleQuiz, validateQuiz, uid } from './model.js';
import { $, $$, esc, toast, downloadJSON, slug } from './ui.js';
import { startEditor, stopEditor } from './editor.js';
import { startHost, stopHost, createSession } from './host.js';
import { makeCode } from './net.js';

const app = $('#app');
let current = null; // aktive Ansicht mit stop()

async function route() {
  if (current && current.stop) current.stop();
  current = null;
  const [view, arg] = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  try {
    if (view === 'edit' && arg) { current = { stop: stopEditor }; await startEditor(app, arg); }
    else if (view === 'setup' && arg) await renderSetup(arg);
    else if (view === 'host') { current = { stop: stopHost }; await startHost(app, makeCode); }
    else await renderHome();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="home"><h2>Fehler</h2><p>${esc(e.message)}</p><a class="btn" href="#">Zur Übersicht</a></div>`;
  }
}

// ---------------------------------------------------------------- Übersicht

async function renderHome() {
  if (!(await kvGet('seeded'))) {
    await saveQuiz(sampleQuiz());
    await kvSet('seeded', true);
  }
  const quizzes = await listQuizzes();
  const session = await kvGet('session');
  app.innerHTML = `<div class="home">
    <div class="logo">Quiz<span>arena</span></div>
    <p class="muted" style="font-size:1.1em">Euer Spieleabend mit Vorrunden, Finale und Handys als Buzzer.</p>
    ${session ? `<div class="notice"><b>Laufender Abend:</b> ${esc(session.quiz.title)} · Code ${esc(session.code || '–')}
      <div class="actions" style="margin-top:8px;display:flex;gap:.5em"><a class="btn primary small" href="#host">Fortsetzen</a></div></div>` : ''}
    <div class="section-title"><h2>Deine Quizze</h2>
      <div style="display:flex;gap:.5em;flex-wrap:wrap">
        <button class="btn" data-a="import">Importieren</button>
        <button class="btn primary" data-a="new">+ Neues Quiz</button>
      </div></div>
    <input type="file" id="import-file" accept=".json,application/json" hidden>
    <div class="cards">${quizzes.map(q => {
      const nq = q.games.reduce((s, g) => s + (g.questions ? g.questions.length : 0), 0);
      return `<div class="card"><h3>${esc(q.title)}</h3>
        <div class="muted">${q.games.length} Spiele · ${nq} Fragen${q.final && q.final.enabled ? ' · mit Finale' : ''}</div>
        <div class="muted" style="font-size:.85em">geändert ${new Date(q.updatedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div>
        <div class="actions">
          <a class="btn primary small" href="#setup/${q.id}">Starten ▶</a>
          <a class="btn small" href="#edit/${q.id}">Bearbeiten</a>
          <button class="btn small ghost" data-a="dup" data-id="${q.id}" title="Duplizieren">⧉</button>
          <button class="btn small ghost" data-a="export" data-id="${q.id}" title="Als Datei exportieren">⤓</button>
          <button class="btn small danger" data-a="del" data-id="${q.id}" title="Löschen">✕</button>
        </div></div>`;
    }).join('') || '<p class="muted">Noch keine Quizze.</p>'}</div>
  </div>`;

  $$('[data-a]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    switch (b.dataset.a) {
      case 'new': { const q = newQuiz(); await saveQuiz(q); location.hash = 'edit/' + q.id; break; }
      case 'import': $('#import-file').click(); break;
      case 'dup': {
        const q = await getQuiz(id);
        q.id = uid(); q.title += ' (Kopie)';
        await saveQuiz(q); renderHome(); break;
      }
      case 'export': { const q = await getQuiz(id); downloadJSON(q, `${slug(q.title)}.quiz.json`); break; }
      case 'del': {
        const q = await getQuiz(id);
        if (confirm(`„${q.title}“ wirklich löschen? Das lässt sich nicht rückgängig machen. Tipp: vorher exportieren.`)) { await deleteQuiz(id); renderHome(); }
        break;
      }
    }
  });
  $('#import-file').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const q = normalizeQuiz(JSON.parse(await file.text()));
      q.id = uid();
      await saveQuiz(q);
      toast(`„${q.title}“ importiert`);
      renderHome();
    } catch (err) { toast('Datei konnte nicht gelesen werden: ' + err.message, 4000); }
  };
}

// ---------------------------------------------------------------- Abend einrichten

async function renderSetup(id) {
  const raw = await getQuiz(id);
  if (!raw) { location.hash = ''; return; }
  const quiz = normalizeQuiz(raw);
  const warnings = validateQuiz(quiz);
  const session = await kvGet('session');
  app.innerHTML = `<div class="home" style="max-width:700px">
    <a class="btn small" href="#">← Übersicht</a>
    <h1 style="margin-top:20px">${esc(quiz.title)}</h1>
    <p class="muted">${quiz.games.length} Spiele${quiz.final.enabled ? ' + Finale' : ''}</p>
    ${warnings.length ? `<div class="notice"><b>Hinweise zum Quiz</b><ul>${warnings.slice(0, 8).map(w => `<li>${esc(w)}</li>`).join('')}${warnings.length > 8 ? `<li>… und ${warnings.length - 8} weitere</li>` : ''}</ul>
      <a class="btn small" style="margin-top:8px" href="#edit/${quiz.id}">Quiz bearbeiten</a></div>` : ''}
    <div class="card" style="margin-top:16px">
      <h3>Wer spielt?</h3>
      <label class="check field"><input type="radio" name="mode" value="single" checked> Einzelspieler – jede Person mit eigenem Handy</label>
      <label class="check field"><input type="radio" name="mode" value="team"> Teams – ein Handy pro Team</label>
    </div>
    ${session ? `<div class="notice">Es läuft noch ein Abend (${esc(session.quiz.title)}). Wenn du einen neuen startest, wird der alte Spielstand gelöscht.</div>` : ''}
    <div style="margin-top:20px;display:flex;gap:.6em;flex-wrap:wrap">
      <button class="btn primary big" id="go">Lobby öffnen ▶</button>
    </div>
  </div>`;
  $('#go').onclick = async () => {
    if (session && !confirm('Laufenden Abend verwerfen und neuen starten?')) return;
    const mode = $('input[name=mode]:checked').value;
    const s = createSession(quiz, mode);
    s.code = makeCode();
    await kvSet('session', s);
    location.hash = 'host';
  };
}

window.addEventListener('hashchange', route);
route();
