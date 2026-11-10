// Editor: Quizze mit Spielen, Fragen, Finale und Stechfragen anlegen.
import { getQuiz, saveQuiz } from './store.js';
import { newGame, newQuestion, normalizeQuiz, QUESTION_TYPES, WIN_MODES, uid } from './model.js';
import { $, $$, esc, toast, readImage, downloadJSON, slug, OPTION_COLORS, OPTION_LETTERS } from './ui.js';

let quiz = null;
let root = null;
let saveTimer = null;
const open = new Set(); // aufgeklappte Bereiche merken

export async function startEditor(el, id) {
  root = el;
  const q = await getQuiz(id);
  if (!q) { location.hash = ''; return; }
  quiz = normalizeQuiz(q);
  render();
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('toggle', onToggle, true);
}

export function stopEditor() {
  if (!root) return;
  flush();
  root.removeEventListener('input', onInput);
  root.removeEventListener('change', onChange);
  root.removeEventListener('click', onClick);
  root.removeEventListener('toggle', onToggle, true);
  root = null;
}

// ---------------------------------------------------------------- Speichern

function scheduleSave() {
  const st = $('#save-state');
  if (st) st.textContent = 'Speichert …';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}

function flush() {
  clearTimeout(saveTimer);
  if (!quiz) return;
  saveQuiz(quiz).then(() => { const st = $('#save-state'); if (st) st.textContent = 'Gespeichert ✓'; })
    .catch(e => toast('Speichern fehlgeschlagen: ' + e.message));
}

// ---------------------------------------------------------------- Pfad-Helfer

function get(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), quiz);
}
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], quiz);
  obj[last] = value;
}

// ---------------------------------------------------------------- Rendern

function render() {
  const scrollY = window.scrollY;
  const f = quiz.final;
  root.innerHTML = `<div class="editor">
    <div class="editor-head">
      <a class="btn small" href="#">← Übersicht</a>
      <input type="text" class="title" data-bind="title" value="${esc(quiz.title)}" placeholder="Name des Abends">
      <span class="muted" id="save-state">Gespeichert ✓</span>
      <button class="btn small" data-act="export">Exportieren</button>
      <a class="btn primary" href="#setup/${quiz.id}">Abend starten ▶</a>
    </div>
    <p class="muted">Änderungen werden automatisch in diesem Browser gespeichert. Mit „Exportieren“ sicherst du das Quiz als Datei.</p>

    <h2 class="section-title"><span>Vorrunde · ${quiz.games.length} ${quiz.games.length === 1 ? 'Spiel' : 'Spiele'}</span></h2>
    ${quiz.games.map(gameBlock).join('')}
    <div class="add-row">
      <button class="btn" data-act="addGame" data-type="quiz">+ Fragespiel</button>
      <button class="btn" data-act="addGame" data-type="manual">+ Manuelles Spiel</button>
    </div>

    <h2 class="section-title"><span>Finale</span></h2>
    <details class="block final-block" data-key="final" ${open.has('final') ? 'open' : ''}>
      <summary><span class="num">🔥</span><span class="t">${esc(f.title || 'Finale')}</span>
        <span class="tag">${f.enabled ? `${WIN_MODES[f.winMode]} · ${f.questions.length} Fragen` : 'deaktiviert'}</span></summary>
      <div class="block-body">
        <label class="check field"><input type="checkbox" data-bind="final.enabled" ${f.enabled ? 'checked' : ''}> Finale spielen</label>
        <div class="row field">
          <div class="grow"><label>Titel</label><input type="text" data-bind="final.title" value="${esc(f.title)}"></div>
          <div class="grow"><label>Wie wird das Finale gewonnen?</label>
            <select data-bind="final.winMode" data-rerender>${Object.entries(WIN_MODES).map(([k, v]) => `<option value="${k}" ${f.winMode === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="row field">
          ${f.winMode === 'target' ? `<div><label>Zielpunktzahl (inkl. Vorsprung)</label><input type="number" min="1" data-bind="final.target" data-num value="${f.target}"></div>` : ''}
          ${f.winMode === 'count' ? `<div><label>Anzahl Fragen</label><input type="number" min="1" data-bind="final.count" data-num value="${f.count}"></div>` : ''}
          ${f.winMode === 'elimination' ? `<div><label>Leben zusätzlich zum Vorsprung</label><input type="number" min="0" data-bind="final.baseLives" data-num value="${f.baseLives}"></div>` : ''}
          <label class="check" style="margin-bottom:.6em"><input type="checkbox" data-bind="final.headStart" ${f.headStart ? 'checked' : ''}> Vorrundenpunkte als Vorsprung</label>
        </div>
        <p class="muted" style="margin-top:0">${finalHint(f)}</p>
        <div class="field"><label>Beschreibung (wird vor dem Finale gezeigt)</label><textarea data-bind="final.description">${esc(f.description)}</textarea></div>
        ${questionList('final.questions', ['mc', 'tf', 'estimate'])}
      </div>
    </details>

    <h2 class="section-title"><span>Stechfragen-Vorrat</span></h2>
    <details class="block" data-key="ties" ${open.has('ties') ? 'open' : ''}>
      <summary><span class="num">⚔️</span><span class="t">Allgemeine Stechfragen</span><span class="tag">${quiz.tiebreakers.length} Schätzfragen</span></summary>
      <div class="block-body">
        <p class="muted">Werden bei Gleichstand genutzt, wenn ein Spiel keine eigene Stechfrage hat, und im Finale. Wer am nächsten an der Lösung liegt, gewinnt.</p>
        ${questionList('tiebreakers', ['estimate'])}
      </div>
    </details>
  </div>`;
  window.scrollTo(0, scrollY);
}

function finalHint(f) {
  const max = quiz.games.reduce((s, g) => s + (Number(g.points) || 0), 0);
  if (f.winMode === 'target') return `Jede richtige Antwort = 1 Punkt. In der Vorrunde sind maximal ${max} Punkte möglich, die Zielpunktzahl sollte darüber liegen (sonst wird sie beim Start automatisch angehoben).`;
  if (f.winMode === 'count') return 'Jede richtige Antwort = 1 Punkt. Nach der letzten Frage gewinnt, wer die meisten Punkte hat (inkl. Vorsprung).';
  return 'Jeder Vorrundenpunkt ist ein zusätzliches Leben. Falsche oder fehlende Antwort kostet ein Leben, bei Schätzfragen verliert, wer am weitesten weg liegt.';
}

function gameBlock(g, i) {
  const key = 'g-' + g.id;
  const p = `games.${i}`;
  const tag = g.type === 'manual' ? 'Manuell' : `${g.questions.length} ${g.questions.length === 1 ? 'Frage' : 'Fragen'}`;
  return `<details class="block" data-key="${key}" ${open.has(key) ? 'open' : ''}>
    <summary>
      <span class="num">${i + 1}</span><span class="t" data-title-of="${p}">${esc(g.title || 'Ohne Titel')}</span>
      <span class="tag">${tag} · ${g.points} P</span>
      <span class="icon-btns">
        <button class="btn small ghost" data-act="move" data-path="games" data-i="${i}" data-d="-1" title="Nach oben" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small ghost" data-act="move" data-path="games" data-i="${i}" data-d="1" title="Nach unten" ${i === quiz.games.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small ghost" data-act="dupGame" data-i="${i}" title="Duplizieren">⧉</button>
        <button class="btn small danger" data-act="del" data-path="games" data-i="${i}" title="Löschen">✕</button>
      </span>
    </summary>
    <div class="block-body">
      <div class="row field">
        <div class="grow"><label>Spielname (wird angekündigt)</label><input type="text" data-bind="${p}.title" value="${esc(g.title)}"></div>
        <div><label>Spieltyp</label><select data-bind="${p}.type" data-rerender>
          <option value="quiz" ${g.type === 'quiz' ? 'selected' : ''}>Fragespiel</option>
          <option value="manual" ${g.type === 'manual' ? 'selected' : ''}>Manuell (Sieger eintragen)</option></select></div>
        <div style="width:110px"><label>Punkte für Sieg</label><input type="number" min="0" data-bind="${p}.points" data-num value="${g.points}"></div>
        ${g.type === 'manual' ? `<div style="width:130px"><label>Timer (Sek., 0 = aus)</label><input type="number" min="0" data-bind="${p}.timer" data-num value="${g.timer}"></div>` : ''}
      </div>
      <div class="field"><label>${g.type === 'manual' ? 'Regeln / Beschreibung' : 'Beschreibung (optional)'}</label><textarea data-bind="${p}.description">${esc(g.description)}</textarea></div>
      ${g.type === 'quiz' ? `
        ${questionList(`${p}.questions`, ['mc', 'tf', 'estimate'])}
        <h3 style="margin-top:18px;font-size:1em">Eigene Stechfrage <span class="muted" style="font-weight:400">(optional, sonst aus dem Vorrat)</span></h3>
        ${g.tiebreaker ? questionCard(g.tiebreaker, `${p}.tiebreaker`, 'Stechfrage', null) : `<button class="btn small" data-act="addTie" data-i="${i}">+ Stechfrage hinzufügen</button>`}
      ` : ''}
    </div>
  </details>`;
}

function questionList(path, types) {
  const list = get(path);
  return `<div>${list.map((q, j) => questionCard(q, `${path}.${j}`, `Frage ${j + 1}`, { path, j, len: list.length })).join('')}</div>
    <div class="add-row">${types.map(t => `<button class="btn small" data-act="addQ" data-path="${path}" data-type="${t}">+ ${QUESTION_TYPES[t]}</button>`).join('')}</div>`;
}

function questionCard(q, p, label, pos) {
  const controls = pos
    ? `<button class="btn small ghost" data-act="move" data-path="${pos.path}" data-i="${pos.j}" data-d="-1" ${pos.j === 0 ? 'disabled' : ''}>↑</button>
       <button class="btn small ghost" data-act="move" data-path="${pos.path}" data-i="${pos.j}" data-d="1" ${pos.j === pos.len - 1 ? 'disabled' : ''}>↓</button>
       <button class="btn small danger" data-act="del" data-path="${pos.path}" data-i="${pos.j}">✕</button>`
    : `<button class="btn small danger" data-act="delTie" data-path="${p}">✕</button>`;
  let answer = '';
  if (q.type === 'mc') {
    answer = `<label>Antworten – richtige Antwort anklicken</label><div class="opts">${q.options.map((o, k) => `
      <div class="opt"><input type="radio" name="r-${q.id}" data-bind="${p}.correct" data-num value="${k}" ${q.correct === k ? 'checked' : ''} title="Richtige Antwort">
        <span class="letter" style="background:${OPTION_COLORS[k]}">${OPTION_LETTERS[k]}</span>
        <input type="text" data-bind="${p}.options.${k}" value="${esc(o)}" placeholder="Antwort ${OPTION_LETTERS[k]}${k > 1 ? ' (optional)' : ''}"></div>`).join('')}</div>`;
  } else if (q.type === 'tf') {
    answer = `<div style="width:200px"><label>Richtige Antwort</label><select data-bind="${p}.correct" data-bool>
      <option value="true" ${q.correct ? 'selected' : ''}>Wahr</option><option value="false" ${!q.correct ? 'selected' : ''}>Falsch</option></select></div>`;
  } else {
    answer = `<div class="row"><div style="width:200px"><label>Lösung (Zahl)</label><input type="number" step="any" data-bind="${p}.correct" data-num value="${q.correct}"></div>
      <div style="width:160px"><label>Einheit (optional)</label><input type="text" data-bind="${p}.unit" value="${esc(q.unit || '')}" placeholder="z. B. km"></div></div>`;
  }
  return `<div class="q">
    <div class="q-head"><span class="type">${label} · ${QUESTION_TYPES[q.type]}</span>
      <label style="margin:0;display:flex;align-items:center;gap:.4em">Zeit <input type="number" min="5" style="width:80px" data-bind="${p}.time" data-num value="${q.time}"> s</label>
      ${controls}</div>
    <div class="field"><textarea data-bind="${p}.text" placeholder="Fragetext">${esc(q.text)}</textarea></div>
    <div class="field">${q.image
      ? `<img class="thumb" src="${q.image}" alt=""><button class="btn small danger" data-act="imgDel" data-path="${p}">Bild entfernen</button>`
      : `<label class="btn small" style="display:inline-flex;color:var(--text);font-size:.88em">🖼 Bild hinzufügen<input type="file" accept="image/*" data-img="${p}" hidden></label>`}</div>
    ${answer}
  </div>`;
}

// ---------------------------------------------------------------- Ereignisse

function valueOf(el) {
  if (el.type === 'checkbox') return el.checked;
  if ('bool' in el.dataset) return el.value === 'true';
  if ('num' in el.dataset) { const n = parseFloat(el.value); return Number.isFinite(n) ? n : 0; }
  return el.value;
}

function onInput(e) {
  const el = e.target;
  if (!el.dataset.bind || el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') return;
  set(el.dataset.bind, valueOf(el));
  const t = root.querySelector(`[data-title-of="${el.dataset.bind.replace(/\.title$/, '')}"]`);
  if (t && el.dataset.bind.endsWith('.title')) t.textContent = el.value || 'Ohne Titel';
  scheduleSave();
}

async function onChange(e) {
  const el = e.target;
  if (el.dataset.img) {
    const file = el.files && el.files[0];
    if (!file) return;
    try {
      const data = await readImage(file);
      set(el.dataset.img + '.image', data);
      scheduleSave();
      render();
    } catch (err) { toast(err.message); }
    return;
  }
  if (!el.dataset.bind) return;
  if (el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') {
    set(el.dataset.bind, valueOf(el));
    scheduleSave();
    if ('rerender' in el.dataset || el.type === 'checkbox') render();
  }
}

function onToggle(e) {
  const d = e.target;
  if (d.tagName !== 'DETAILS' || !d.dataset.key) return;
  d.open ? open.add(d.dataset.key) : open.delete(d.dataset.key);
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  // Buttons in <summary> sollen nicht auf-/zuklappen
  e.preventDefault();
  const { act, path, type } = b.dataset;
  const i = Number(b.dataset.i);
  switch (act) {
    case 'export':
      flush();
      downloadJSON(quiz, `${slug(quiz.title)}.quiz.json`);
      return;
    case 'addGame': {
      const g = newGame(quiz.games.length + 1, type);
      quiz.games.push(g);
      open.add('g-' + g.id);
      break;
    }
    case 'dupGame': {
      const copy = JSON.parse(JSON.stringify(quiz.games[i]));
      copy.id = uid();
      copy.title += ' (Kopie)';
      copy.questions.forEach(q => { q.id = uid(); });
      if (copy.tiebreaker) copy.tiebreaker.id = uid();
      quiz.games.splice(i + 1, 0, copy);
      break;
    }
    case 'addQ': {
      get(path).push(newQuestion(type));
      break;
    }
    case 'move': {
      const arr = get(path), j = i + Number(b.dataset.d);
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      break;
    }
    case 'del': {
      const arr = get(path);
      const what = path === 'games' ? `Spiel „${arr[i].title}“` : 'diese Frage';
      if (!confirm(`${what} wirklich löschen?`)) return;
      arr.splice(i, 1);
      break;
    }
    case 'addTie':
      quiz.games[i].tiebreaker = newQuestion('estimate');
      break;
    case 'delTie':
      if (!confirm('Stechfrage löschen?')) return;
      set(path, null);
      break;
    case 'imgDel':
      set(path + '.image', null);
      break;
    default:
      return;
  }
  scheduleSave();
  render();
}
