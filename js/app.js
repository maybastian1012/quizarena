// Laptop-Seite: Übersicht, Abend einrichten, Editor und Spielleiter-Ansicht.
import { listQuizzes, getQuiz, saveQuiz, deleteQuiz, kvGet, kvSet, kvDel } from './store.js';
import { newQuiz, normalizeQuiz, sampleQuiz, sampleQuiz2, sampleQuiz3, validateQuiz, uid, JOKERS } from './model.js';
import { $, $$, esc, toast, downloadJSON, slug } from './ui.js';
import { bundleQuiz, unbundleQuiz, gcMedia } from './media.js';
import { unlockAudio } from './sfx.js';
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
  document.body.dataset.view = view || 'home';
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
  const seeds = [['seeded', sampleQuiz], ['seeded2', sampleQuiz2], ['seeded3', sampleQuiz3]];
  for (const [key, make] of seeds) {
    if (!(await kvGet(key))) { await saveQuiz(make()); await kvSet(key, true); }
  }
  gcMedia().catch(() => {});
  const quizzes = await listQuizzes();
  const session = await kvGet('session');
  app.innerHTML = `<div class="home">
    <header class="home-head">
      <div class="logo">Quiz<span>arena</span></div>
      <p class="muted lead">Euer Spieleabend mit Vorrunden, Finale und Handys als Buzzer.</p>
    </header>

    ${session ? `<section class="resume">
      <div><div class="panel-kicker">Laufender Abend</div><b>${esc(session.quiz.title)}</b> <span class="muted">· Code ${esc(session.code || '–')} · ${Object.keys(session.players || {}).length} Spieler</span></div>
      <div class="row"><a class="btn primary" href="#host">Fortsetzen ▶</a><button class="btn ghost small" data-a="discard">Verwerfen</button></div>
    </section>` : ''}

    <section class="home-actions">
      <button class="action" data-a="new"><span class="ai">＋</span><b>Neues Quiz</b><small>leer beginnen</small></button>
      <button class="action" data-a="excel"><span class="ai">📊</span><b>Aus Excel</b><small>Fragen aus Tabelle</small></button>
      <button class="action" data-a="import"><span class="ai">📂</span><b>Datei öffnen</b><small>exportiertes Quiz</small></button>
      <button class="action" data-a="template"><span class="ai">⤓</span><b>Excel-Vorlage</b><small>zum Ausfüllen</small></button>
    </section>
    <input type="file" id="import-file" accept=".json,application/json" hidden>
    <input type="file" id="excel-file" accept=".xlsx,.xls,.csv" hidden>

    <h2 class="home-h">Deine Quizze <span class="muted">(${quizzes.length})</span></h2>
    <div class="cards">${quizzes.map(q => {
      const nq = q.games.reduce((s, g) => s + (g.questions ? g.questions.length : 0), 0);
      return `<article class="card qcard">
        <h3>${esc(q.title)}</h3>
        <div class="meta"><span>${q.games.length} Spiele</span><span>${nq} Fragen</span>${q.final && q.final.enabled ? '<span>🔥 Finale</span>' : ''}</div>
        <div class="muted sm">geändert ${new Date(q.updatedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div>
        <div class="actions">
          <a class="btn primary small" href="#setup/${q.id}">Starten ▶</a>
          <a class="btn small" href="#edit/${q.id}">Bearbeiten</a>
          <span class="spacer"></span>
          <button class="btn tiny ghost" data-a="dup" data-id="${q.id}" title="Duplizieren">⧉</button>
          <button class="btn tiny ghost" data-a="export" data-id="${q.id}" title="Als Datei sichern">⤓</button>
          <button class="btn tiny danger" data-a="del" data-id="${q.id}" title="Löschen">✕</button>
        </div></article>`;
    }).join('') || '<p class="muted">Noch keine Quizze.</p>'}</div>
  </div>`;

  $$('[data-a]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    switch (b.dataset.a) {
      case 'new': { const q = newQuiz(); await saveQuiz(q); location.hash = 'edit/' + q.id; break; }
      case 'import': $('#import-file').click(); break;
      case 'excel': $('#excel-file').click(); break;
      case 'template':
        import('./excel.js').then(m => m.downloadTemplate()).catch(err => toast('Vorlage nicht verfügbar: ' + err.message, 4000));
        break;
      case 'discard':
        if (confirm('Laufenden Abend verwerfen? Der Spielstand geht verloren.')) { await kvDel('session'); renderHome(); }
        break;
      case 'dup': {
        const q = await getQuiz(id);
        q.id = uid(); q.title += ' (Kopie)';
        await saveQuiz(q); renderHome(); break;
      }
      case 'export': { const q = await getQuiz(id); downloadJSON(await bundleQuiz(q), `${slug(q.title)}.quiz.json`); break; }
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
      const q = normalizeQuiz(await unbundleQuiz(JSON.parse(await file.text())));
      q.id = uid();
      await saveQuiz(q);
      toast(`„${q.title}“ importiert`);
      renderHome();
    } catch (err) { toast('Datei konnte nicht gelesen werden: ' + err.message, 4000); }
  };
  $('#excel-file').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { quizFromExcel } = await import('./excel.js');
      const res = await quizFromExcel(file);
      await saveQuiz(res.quiz);
      toast(`${res.added} Fragen aus Excel übernommen`, 3500);
      if (res.warnings.length) alert('Hinweise zum Import:\n\n' + res.warnings.slice(0, 15).join('\n'));
      location.hash = 'edit/' + res.quiz.id;
    } catch (err) { toast('Excel konnte nicht gelesen werden: ' + err.message, 5000); }
  };
}

// ---------------------------------------------------------------- Abend einrichten

async function renderSetup(id) {
  const raw = await getQuiz(id);
  if (!raw) { location.hash = ''; return; }
  const quiz = normalizeQuiz(raw);
  const warnings = validateQuiz(quiz);
  const session = await kvGet('session');
  const jokers = { double: 1, fifty: 1, time: 1 };
  const nq = quiz.games.reduce((s, g) => s + g.questions.length, 0);
  app.innerHTML = `<div class="setup">
    <a class="btn small ghost" href="#">← Übersicht</a>
    <div class="panel-kicker" style="margin-top:20px">Abend einrichten</div>
    <h1>${esc(quiz.title)}</h1>
    <div class="meta"><span>${quiz.games.length} Spiele</span><span>${nq} Fragen</span>${quiz.final.enabled ? '<span>🔥 Finale</span>' : ''}</div>

    ${warnings.length ? `<details class="notice"><summary><b>⚠ ${warnings.length} Hinweis${warnings.length > 1 ? 'e' : ''} zum Quiz</b> – trotzdem startbar</summary><ul>${warnings.slice(0, 10).map(w => `<li>${esc(w)}</li>`).join('')}${warnings.length > 10 ? `<li>… und ${warnings.length - 10} weitere</li>` : ''}</ul>
      <a class="btn small" href="#edit/${quiz.id}">Quiz bearbeiten</a></details>` : ''}

    <section class="setup-step">
      <h3><span class="step-n">1</span> Wer spielt?</h3>
      <div class="choice-row">
        <label class="choice"><input type="radio" name="mode" value="single" checked><span class="ch-i">🙋</span><b>Einzelspieler</b><small>jede Person mit eigenem Handy</small></label>
        <label class="choice"><input type="radio" name="mode" value="team"><span class="ch-i">👥</span><b>Teams</b><small>ein Handy pro Team</small></label>
      </div>
    </section>

    <section class="setup-step">
      <h3><span class="step-n">2</span> Joker pro ${'Spieler/Team'}</h3>
      ${Object.entries(JOKERS).map(([k, j]) => `<div class="stepper-row">
        <div class="grow"><b>${j.icon} ${j.label}</b><div class="muted sm">${j.hint}</div></div>
        <div class="stepper"><button data-step="${k}" data-d="-1">−</button><span id="jv-${k}">${jokers[k]}</span><button data-step="${k}" data-d="1">+</button></div>
      </div>`).join('')}
      <p class="muted sm">0 = Joker nicht verwenden. Eingesetzt werden die Joker über die Handys.</p>
    </section>

    ${session ? `<div class="notice">Es läuft noch ein Abend (${esc(session.quiz.title)}). Beim Start eines neuen wird er verworfen.</div>` : ''}
    <button class="btn primary big setup-go" id="go">Lobby öffnen ▶</button>
  </div>`;
  $$('[data-step]').forEach(b => b.onclick = () => {
    const k = b.dataset.step;
    jokers[k] = Math.max(0, Math.min(9, jokers[k] + Number(b.dataset.d)));
    $('#jv-' + k).textContent = jokers[k];
  });
  $('#go').onclick = async () => {
    if (session && !confirm('Laufenden Abend verwerfen und neuen starten?')) return;
    const mode = $('input[name=mode]:checked').value;
    unlockAudio();
    const s = createSession(quiz, mode, jokers);
    s.code = makeCode();
    await kvSet('session', s);
    location.hash = 'host';
  };
}

window.addEventListener('hashchange', route);
route();
