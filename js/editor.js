// Editor: links Spiele-Liste, rechts das gewählte Spiel mit seinen Fragen.
import { getQuiz, saveQuiz } from './store.js';
import {
  newGame, newQuestion, normalizeQuiz, normalizeQuestion, parseYouTube, questionWarnings, questionLabel,
  QUESTION_TYPES, TYPE_ICONS, TYPE_HINTS, WIN_MODES, uid,
} from './model.js';
import { $, $$, esc, toast, readImage, downloadJSON, slug, OPTION_COLORS, OPTION_LETTERS } from './ui.js';
import { saveMediaFile, bundleQuiz, mediaUrl } from './media.js';
import { renderPreview } from './host.js';
import { importExcelInto } from './excel.js';

const ALL_TYPES = ['mc', 'tf', 'estimate', 'order', 'buzzer', 'hint', 'reveal', 'text', 'hilo'];
const MAX_MEDIA_MB = 200;

let quiz = null;
let root = null;
let saveTimer = null;
let sel = null;              // 'settings' | 'final' | 'ties' | 'g:<id>'
const openQ = new Set();     // aufgeklappte Fragen
let addMenu = null;          // Pfad, für den das „Frage hinzufügen“-Menü offen ist

export async function startEditor(el, id) {
  root = el;
  const q = await getQuiz(id);
  if (!q) { location.hash = ''; return; }
  quiz = normalizeQuiz(q);
  if (!sel || !validSel()) sel = quiz.games[0] ? 'g:' + quiz.games[0].id : 'settings';
  render();
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
}

export function stopEditor() {
  if (!root) return;
  flush();
  root.removeEventListener('input', onInput);
  root.removeEventListener('change', onChange);
  root.removeEventListener('click', onClick);
  closePreview();
  root = null;
}

function validSel() {
  if (['settings', 'final', 'ties'].includes(sel)) return true;
  return quiz.games.some(g => 'g:' + g.id === sel);
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

function get(path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), quiz); }
function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], quiz);
  obj[last] = value;
}
const gameIndex = () => quiz.games.findIndex(g => 'g:' + g.id === sel);

// ---------------------------------------------------------------- Rendern

function render() {
  const scrollY = window.scrollY;
  root.innerHTML = `<div class="ed">
    <header class="ed-head">
      <a class="btn small ghost" href="#">← Übersicht</a>
      <input type="text" class="ed-title" data-bind="title" value="${esc(quiz.title)}" placeholder="Name des Abends">
      <span class="muted ed-save" id="save-state">Gespeichert ✓</span>
      <button class="btn small ghost" data-act="export" title="Als Datei sichern">⤓ Exportieren</button>
      <a class="btn primary" href="#setup/${quiz.id}">Abend starten ▶</a>
    </header>
    <div class="ed-body">
      <aside class="ed-side">${sidebar()}</aside>
      <main class="ed-main">${mainPanel()}</main>
    </div>
  </div>`;
  window.scrollTo(0, scrollY);
  hydratePreviews();
}

function sidebar() {
  const item = (key, inner, cls = '') => `<button class="side-item ${sel === key ? 'on' : ''} ${cls}" data-act="select" data-key="${key}">${inner}</button>`;
  const games = quiz.games.map((g, i) => {
    const warn = g.questions.reduce((n, q) => n + questionWarnings(q).length, 0) + (g.type === 'quiz' && !g.questions.length ? 1 : 0);
    return item('g:' + g.id, `<span class="si-num">${i + 1}</span><span class="si-t">${esc(g.title || 'Ohne Titel')}</span>
      <span class="si-meta">${g.type === 'manual' ? '🏁' : g.questions.length}${warn ? ' <span class="warn-dot" title="Unvollständig">!</span>' : ''}</span>`);
  }).join('');
  return `
    ${item('settings', '<span class="si-num">⚙</span><span class="si-t">Allgemein</span>')}
    <div class="side-label">Vorrunde · ${quiz.games.length} Spiele</div>
    <div class="side-games">${games}</div>
    <div class="side-add">
      <button class="btn small" data-act="addGame" data-type="quiz">+ Fragespiel</button>
      <button class="btn small ghost" data-act="addGame" data-type="manual">+ Manuell</button>
    </div>
    <div class="side-label">Abschluss</div>
    ${item('final', `<span class="si-num">🔥</span><span class="si-t">${esc(quiz.final.title || 'Finale')}</span><span class="si-meta">${quiz.final.enabled ? quiz.final.questions.length : 'aus'}</span>`)}
    ${item('ties', `<span class="si-num">⚔</span><span class="si-t">Stechfragen</span><span class="si-meta">${quiz.tiebreakers.length}</span>`)}`;
}

function mainPanel() {
  if (sel === 'settings') return settingsPanel();
  if (sel === 'final') return finalPanel();
  if (sel === 'ties') return tiesPanel();
  const i = gameIndex();
  return i >= 0 ? gamePanel(quiz.games[i], i) : settingsPanel();
}

function settingsPanel() {
  const nq = quiz.games.reduce((s, g) => s + g.questions.length, 0);
  return `<div class="panel">
    <div class="panel-kicker">Allgemein</div>
    <h2>Einstellungen des Abends</h2>
    <div class="field"><label>Titel (erscheint im Intro)</label><input type="text" data-bind="title" value="${esc(quiz.title)}"></div>
    <div class="field"><label>Untertitel im Intro (optional)</label><input type="text" data-bind="tagline" value="${esc(quiz.tagline || '')}" placeholder="z. B. Die große Familien-Gameshow"></div>
    <div class="stat-row"><div><b>${quiz.games.length}</b><span>Spiele</span></div><div><b>${nq}</b><span>Fragen</span></div><div><b>${quiz.final.enabled ? quiz.final.questions.length : '–'}</b><span>Finalfragen</span></div><div><b>${quiz.tiebreakers.length}</b><span>Stechfragen</span></div></div>
    <div class="card soft">
      <h3>📊 Fragen aus Excel ergänzen</h3>
      <p class="muted">Fragen in einer Tabelle sammeln und hier anhängen. Spiele mit gleichem Namen werden ergänzt, neue angelegt.</p>
      <div class="row">
        <label class="btn">📥 Excel-Datei wählen<input type="file" accept=".xlsx,.xls,.csv" data-excel hidden></label>
        <button class="btn ghost" data-act="template">⤓ Vorlage herunterladen</button>
      </div>
    </div>
  </div>`;
}

function gamePanel(g, i) {
  const p = `games.${i}`;
  return `<div class="panel">
    <div class="panel-head">
      <div class="panel-kicker">Spiel ${i + 1} von ${quiz.games.length}</div>
      <div class="panel-actions">
        <button class="btn small ghost" data-act="move" data-path="games" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} title="Nach oben">↑</button>
        <button class="btn small ghost" data-act="move" data-path="games" data-i="${i}" data-d="1" ${i === quiz.games.length - 1 ? 'disabled' : ''} title="Nach unten">↓</button>
        <button class="btn small ghost" data-act="dupGame" data-i="${i}" title="Duplizieren">⧉ Kopie</button>
        <button class="btn small danger" data-act="del" data-path="games" data-i="${i}">Löschen</button>
      </div>
    </div>
    <input type="text" class="panel-title" data-bind="${p}.title" value="${esc(g.title)}" placeholder="Spielname (wird angekündigt)">
    <div class="row field">
      <div class="seg">${['quiz', 'manual'].map(t => `<button class="${g.type === t ? 'on' : ''}" data-act="setType" data-path="${p}" data-val="${t}">${t === 'quiz' ? '❓ Fragespiel' : '🏁 Manuell (Sieger eintragen)'}</button>`).join('')}</div>
      <div class="num-field"><label>Punkte für Sieg</label><input type="number" min="0" data-bind="${p}.points" data-num value="${g.points}"></div>
      ${g.type === 'manual' ? `<div class="num-field"><label>Timer (Sek., 0 = aus)</label><input type="number" min="0" data-bind="${p}.timer" data-num value="${g.timer}"></div>` : ''}
    </div>
    <div class="field"><label>${g.type === 'manual' ? 'Regeln / Beschreibung' : 'Beschreibung (optional, wird angekündigt)'}</label><textarea data-bind="${p}.description" rows="2">${esc(g.description)}</textarea></div>
    ${g.type === 'quiz' ? `
      <div class="section-h"><h3>Fragen <span class="muted">(${g.questions.length})</span></h3>
        ${g.questions.length > 1 ? `<button class="btn small ghost" data-act="toggleAll" data-path="${p}.questions">${g.questions.every(q => openQ.has(q.id)) ? 'Alle zuklappen' : 'Alle aufklappen'}</button>` : ''}</div>
      ${questionList(`${p}.questions`, ALL_TYPES)}
      <div class="section-h"><h3>Eigene Stechfrage <span class="muted">(optional, sonst aus dem Vorrat)</span></h3></div>
      ${g.tiebreaker ? questionCard(g.tiebreaker, `${p}.tiebreaker`, 'Stechfrage', null) : `<button class="btn small ghost" data-act="addTie" data-i="${i}">+ Stechfrage (Schätzfrage) hinzufügen</button>`}
    ` : ''}
  </div>`;
}

function finalPanel() {
  const f = quiz.final;
  const max = quiz.games.reduce((s, g) => s + (Number(g.points) || 0), 0);
  const hint = f.winMode === 'target'
    ? `Jede richtige Antwort = 1 Punkt. In der Vorrunde sind maximal ${max} Punkte möglich, die Zielpunktzahl sollte darüber liegen.`
    : f.winMode === 'count' ? 'Nach der letzten Frage gewinnt, wer die meisten Punkte hat (inkl. Vorsprung).'
      : 'Jeder Vorrundenpunkt ist ein zusätzliches Leben. Falsche Antwort kostet ein Leben.';
  return `<div class="panel">
    <div class="panel-kicker">Abschluss</div>
    <input type="text" class="panel-title" data-bind="final.title" value="${esc(f.title)}">
    <label class="check field"><input type="checkbox" data-bind="final.enabled" ${f.enabled ? 'checked' : ''}> Finale spielen</label>
    ${f.enabled ? `
    <div class="field"><label>Wie wird das Finale gewonnen?</label>
      <div class="seg wrap">${Object.entries(WIN_MODES).map(([k, v]) => `<button class="${f.winMode === k ? 'on' : ''}" data-act="setVal" data-path="final.winMode" data-val="${k}">${v}</button>`).join('')}</div></div>
    <div class="row field">
      ${f.winMode === 'target' ? `<div class="num-field"><label>Zielpunktzahl</label><input type="number" min="1" data-bind="final.target" data-num value="${f.target}"></div>` : ''}
      ${f.winMode === 'count' ? `<div class="num-field"><label>Anzahl Fragen</label><input type="number" min="1" data-bind="final.count" data-num value="${f.count}"></div>` : ''}
      ${f.winMode === 'elimination' ? `<div class="num-field"><label>Leben zusätzlich</label><input type="number" min="0" data-bind="final.baseLives" data-num value="${f.baseLives}"></div>` : ''}
      <label class="check"><input type="checkbox" data-bind="final.headStart" ${f.headStart ? 'checked' : ''}> Vorrundenpunkte als Vorsprung</label>
    </div>
    <p class="muted sm">${hint}</p>
    <div class="field"><label>Beschreibung (vor dem Finale)</label><textarea data-bind="final.description" rows="2">${esc(f.description)}</textarea></div>
    <div class="section-h"><h3>Finalfragen <span class="muted">(${f.questions.length})</span></h3></div>
    ${questionList('final.questions', ALL_TYPES)}` : ''}
  </div>`;
}

function tiesPanel() {
  return `<div class="panel">
    <div class="panel-kicker">Abschluss</div>
    <h2>Stechfragen-Vorrat</h2>
    <p class="muted">Werden bei Gleichstand genutzt, wenn ein Spiel keine eigene Stechfrage hat, und im Finale. Wer am nächsten an der Lösung liegt, gewinnt.</p>
    ${questionList('tiebreakers', ['estimate'])}
  </div>`;
}

function questionList(path, types) {
  const list = get(path);
  const menu = addMenu === path
    ? `<div class="add-menu">${types.map(t => `<button class="add-type" data-act="addQ" data-path="${path}" data-type="${t}">
        <span class="at-i">${TYPE_ICONS[t]}</span><span class="at-t"><b>${QUESTION_TYPES[t]}</b><small>${TYPE_HINTS[t]}</small></span></button>`).join('')}
        <button class="btn small ghost" data-act="addMenu" data-path="">Abbrechen</button></div>`
    : types.length === 1
      ? `<button class="btn add-q" data-act="addQ" data-path="${path}" data-type="${types[0]}">+ ${QUESTION_TYPES[types[0]]}</button>`
      : `<button class="btn add-q" data-act="addMenu" data-path="${path}">+ Frage hinzufügen</button>`;
  return `<div class="qlist">${list.map((q, j) => questionCard(q, `${path}.${j}`, `${j + 1}`, { path, j, len: list.length })).join('')}</div>${menu}`;
}

function questionCard(q, p, label, pos) {
  const isOpen = openQ.has(q.id);
  const warns = questionWarnings(q);
  const controls = pos
    ? `<button class="btn tiny ghost" data-act="move" data-path="${pos.path}" data-i="${pos.j}" data-d="-1" ${pos.j === 0 ? 'disabled' : ''} title="Nach oben">↑</button>
       <button class="btn tiny ghost" data-act="move" data-path="${pos.path}" data-i="${pos.j}" data-d="1" ${pos.j === pos.len - 1 ? 'disabled' : ''} title="Nach unten">↓</button>
       <button class="btn tiny ghost" data-act="dupQ" data-path="${pos.path}" data-i="${pos.j}" title="Duplizieren">⧉</button>
       <button class="btn tiny danger" data-act="del" data-path="${pos.path}" data-i="${pos.j}" title="Löschen">✕</button>`
    : `<button class="btn tiny danger" data-act="delTie" data-path="${p}" title="Löschen">✕</button>`;
  return `<div class="q ${isOpen ? 'open' : ''}">
    <div class="q-head" data-act="toggleQ" data-id="${q.id}">
      <span class="q-num">${label}</span><span class="q-ic" title="${QUESTION_TYPES[q.type]}">${TYPE_ICONS[q.type]}</span>
      <span class="q-sum"><span class="q-type">${QUESTION_TYPES[q.type]}</span><span class="q-txt">${esc(questionLabel(q))}</span></span>
      ${warns.length ? `<span class="warn-dot" title="${esc(warns.join(' · '))}">!</span>` : ''}
      <span class="q-actions">
        <button class="btn tiny" data-act="preview" data-path="${p}" title="So sieht es auf dem TV aus">▶ Vorschau</button>
        ${controls}
      </span>
    </div>
    ${isOpen ? `<div class="q-body">${questionBody(q, p, warns)}</div>` : ''}
  </div>`;
}

function questionBody(q, p, warns) {
  const time = `<div class="num-field"><label>Zeit (Sek.)</label><input type="number" min="5" data-bind="${p}.time" data-num value="${q.time}"></div>`;
  const textField = `<div class="field grow"><label>${q.type === 'hilo' ? 'Fragetext' : 'Frage'}</label><textarea data-bind="${p}.text" rows="2" placeholder="Fragetext">${esc(q.text)}</textarea></div>`;
  const answerAlt = `<div class="row">
      <div class="field grow"><label>Lösung</label><input type="text" data-bind="${p}.answer" value="${esc(q.answer || '')}"></div>
      ${q.type !== 'buzzer' ? `<div class="field grow"><label>Auch richtig (mit | trennen)</label><input type="text" data-bind="${p}.alternatives" value="${esc(q.alternatives || '')}" placeholder="z. B. Einstein | A. Einstein"></div>` : ''}
    </div>`;
  const modeSeg = `<div class="field"><label>So wird geantwortet</label><div class="seg">
      <button class="${q.mode !== 'text' ? 'on' : ''}" data-act="setVal" data-path="${p}.mode" data-val="buzzer">🔔 Buzzer (laut sagen, du wertest)</button>
      <button class="${q.mode === 'text' ? 'on' : ''}" data-act="setVal" data-path="${p}.mode" data-val="text">✍ Freitext (alle tippen)</button></div></div>`;

  let answer = '';
  switch (q.type) {
    case 'mc':
      answer = `<label>Antworten – richtige Antwort links anklicken</label><div class="opts">${q.options.map((o, k) => `
        <div class="opt ${q.correct === k ? 'is-right' : ''}"><input type="radio" name="r-${q.id}" data-bind="${p}.correct" data-num value="${k}" ${q.correct === k ? 'checked' : ''} title="Richtige Antwort">
          <span class="letter" style="background:${OPTION_COLORS[k]}">${OPTION_LETTERS[k]}</span>
          <input type="text" data-bind="${p}.options.${k}" value="${esc(o)}" placeholder="Antwort ${OPTION_LETTERS[k]}${k > 1 ? ' (optional)' : ''}"></div>`).join('')}</div>`;
      break;
    case 'tf':
      answer = `<div class="field"><label>Richtige Antwort</label><div class="seg">
        <button class="${q.correct ? 'on' : ''}" data-act="setVal" data-path="${p}.correct" data-val="true">✓ Wahr</button>
        <button class="${!q.correct ? 'on' : ''}" data-act="setVal" data-path="${p}.correct" data-val="false">✗ Falsch</button></div></div>`;
      break;
    case 'estimate':
      answer = `<div class="row"><div class="num-field"><label>Lösung (Zahl)</label><input type="number" step="any" data-bind="${p}.correct" data-num value="${q.correct}"></div>
        <div class="field"><label>Einheit (optional)</label><input type="text" data-bind="${p}.unit" value="${esc(q.unit || '')}" placeholder="z. B. km"></div></div>`;
      break;
    case 'order':
      answer = `<label>Einträge in der <b>richtigen</b> Reihenfolge (auf den Handys gemischt)</label>
        <div class="list-edit">${q.items.map((t, k) => `<div class="opt"><span class="letter plain">${k + 1}</span>
          <input type="text" data-bind="${p}.items.${k}" value="${esc(t)}" placeholder="Eintrag ${k + 1}">
          ${q.items.length > 2 ? `<button class="btn tiny ghost" data-act="delItem" data-path="${p}" data-list="items" data-i="${k}">✕</button>` : ''}</div>`).join('')}</div>
        ${q.items.length < 6 ? `<button class="btn small ghost" data-act="addItem" data-path="${p}" data-list="items">+ Eintrag</button>` : ''}`;
      break;
    case 'buzzer':
      answer = `${answerAlt}<p class="muted sm">Wer zuerst buzzert, antwortet laut. Falsch = Minuspunkt, die Frage ist dann vorbei. Die Zeit ist das Buzzer-Fenster.</p>`;
      break;
    case 'hint':
      answer = `<label>Hinweise (vom schwersten zum leichtesten)</label>
        <div class="list-edit">${q.hints.map((t, k) => `<div class="opt"><span class="letter plain">${k + 1}</span>
          <input type="text" data-bind="${p}.hints.${k}" value="${esc(t)}" placeholder="Hinweis ${k + 1}">
          ${q.hints.length > 1 ? `<button class="btn tiny ghost" data-act="delItem" data-path="${p}" data-list="hints" data-i="${k}">✕</button>` : ''}</div>`).join('')}</div>
        ${q.hints.length < 6 ? `<button class="btn small ghost" data-act="addItem" data-path="${p}" data-list="hints">+ Hinweis</button>` : ''}
        <div class="row field"><div class="num-field"><label>Neuer Hinweis alle … Sek. (0 = nur per Knopf)</label><input type="number" min="0" data-bind="${p}.hintEvery" data-num value="${q.hintEvery}"></div></div>
        ${modeSeg}${answerAlt}`;
      break;
    case 'reveal':
      answer = `${modeSeg}${answerAlt}<p class="muted sm">Das Bild oben wird auf dem TV von grob verpixelt bis scharf aufgedeckt – über die eingestellte Zeit.</p>`;
      break;
    case 'text':
      answer = `${answerAlt}<p class="muted sm">Antworten, die zur Lösung passen (Groß/Klein und kleine Tippfehler egal), werden automatisch als richtig vorgeschlagen. Du kannst am Spielleiter-Handy umschalten.</p>`;
      break;
    case 'hilo':
      answer = `<div class="hilo-edit">
          <div class="card soft"><label>Startwert (bekannt)</label><input type="text" data-bind="${p}.refLabel" value="${esc(q.refLabel)}" placeholder="z. B. Berlin">
            <input type="number" step="any" data-bind="${p}.refValue" data-num value="${q.refValue}"></div>
          <div class="hilo-vs-e">▲▼</div>
          <div class="card soft"><label>Vergleichswert (gesucht)</label><input type="text" data-bind="${p}.itemLabel" value="${esc(q.itemLabel)}" placeholder="z. B. Hamburg">
            <input type="number" step="any" data-bind="${p}.itemValue" data-num value="${q.itemValue}"></div>
        </div>
        <div class="row"><div class="field"><label>Einheit (optional)</label><input type="text" data-bind="${p}.unit" value="${esc(q.unit || '')}" placeholder="z. B. Mio. Einwohner"></div>
          <button class="btn small ghost" data-act="hiloText" data-path="${p}">✨ Fragetext vorschlagen</button></div>`;
      break;
  }

  const imageField = q.type === 'reveal'
    ? (q.image ? `<div class="media-box"><img class="thumb big" src="${q.image}" alt=""><button class="btn small danger" data-act="imgDel" data-path="${p}">Bild entfernen</button></div>`
      : `<label class="drop">🖼 Bild auswählen (Pflicht)<input type="file" accept="image/*" data-img="${p}" hidden></label>`)
    : (q.image ? `<div class="media-box"><img class="thumb" src="${q.image}" alt=""><button class="btn small danger" data-act="imgDel" data-path="${p}">Bild entfernen</button></div>`
      : `<label class="btn small ghost">🖼 Bild<input type="file" accept="image/*" data-img="${p}" hidden></label>`);

  return `
    ${warns.length ? `<div class="notice small">⚠ ${esc(warns.join(' · '))}</div>` : ''}
    <div class="row">${textField}${time}</div>
    ${q.type === 'reveal' ? `<div class="field">${imageField}</div>` : ''}
    ${answer}
    <details class="more-opts" ${q.media || (q.image && q.type !== 'reveal') || q.notes ? 'open' : ''}><summary>Medien & Notiz</summary>
      <div class="media-row">${q.type !== 'reveal' ? imageField : ''}${mediaEditor(q, p)}</div>
      <div class="field"><label>🎙 Moderationsnotiz (nur Spielleiter-Handy)</label><textarea data-bind="${p}.notes" rows="2" placeholder="z. B. Hintergrundinfo, Anekdote, Aussprache …">${esc(q.notes || '')}</textarea></div>
    </details>`;
}

function mediaEditor(q, p) {
  const m = q.media;
  const first = `<label class="check" style="margin-top:6px"><input type="checkbox" data-bind="${p}.mediaFirst" ${q.mediaFirst ? 'checked' : ''}> Erst abspielen, dann Antworten freigeben</label>`;
  if (!m) {
    return `<label class="btn small ghost">🎬 Video/Audio<input type="file" accept="video/*,audio/*" data-mediafile="${p}" hidden></label>
      <button class="btn small ghost" data-act="mediaYT" data-path="${p}">▶ YouTube-Link</button>`;
  }
  if (m.kind === 'file') {
    const isAudio = (m.mime || '').startsWith('audio');
    return `<div class="media-box"><b>${isAudio ? '🔊' : '🎬'} ${esc(m.name || 'Mediendatei')}</b> <span class="muted">(${((m.size || 0) / 1048576).toFixed(1)} MB)</span>
      <button class="btn tiny danger" data-act="mediaDel" data-path="${p}">Entfernen</button>
      <div><${isAudio ? 'audio' : 'video'} class="media-preview" data-prev="${m.id}" controls preload="metadata"></${isAudio ? 'audio' : 'video'}></div>
      <div class="row">
        <div class="num-field"><label>Start (Sek.)</label><input type="number" min="0" step="0.5" data-bind="${p}.media.start" data-num value="${m.start || 0}"></div>
        <div class="num-field"><label>Ende (0 = Schluss)</label><input type="number" min="0" step="0.5" data-bind="${p}.media.end" data-num value="${m.end || 0}"></div>
        <button class="btn small ghost" data-act="mediaMark" data-path="${p}" data-which="start">⏮ Start = Vorschau</button>
        <button class="btn small ghost" data-act="mediaMark" data-path="${p}" data-which="end">⏭ Ende = Vorschau</button>
      </div>${first}</div>`;
  }
  return `<div class="media-box"><b>▶ YouTube</b> <button class="btn tiny danger" data-act="mediaDel" data-path="${p}">Entfernen</button>
    <div class="row"><div class="field grow"><label>Link</label><input type="text" data-bind="${p}.media.url" value="${esc(m.url || '')}" placeholder="https://www.youtube.com/watch?v=…"></div>
      <div class="num-field"><label>Start (Sek.)</label><input type="number" min="0" data-bind="${p}.media.start" data-num value="${m.start || 0}"></div>
      <div class="num-field"><label>Ende (0 = Schluss)</label><input type="number" min="0" data-bind="${p}.media.end" data-num value="${m.end || 0}"></div></div>
    <div class="muted sm">${m.vid ? `Video erkannt ✓` : 'Noch kein gültiger Link.'} Braucht am Abend Internet.</div>${first}</div>`;
}

async function hydratePreviews() {
  for (const el of $$('[data-prev]', root)) {
    const url = await mediaUrl(el.dataset.prev);
    if (url) el.src = url;
  }
}

// ---------------------------------------------------------------- Vorschau

function openPreview(path, mode = 'q') {
  const q = get(path);
  if (!q) return;
  closePreview();
  const ov = document.createElement('div');
  ov.id = 'pv';
  ov.innerHTML = `<div class="pv-box">
    <div class="pv-bar"><b>Vorschau</b> <span class="muted">so sieht es auf dem TV aus</span>
      <span class="spacer"></span>
      <div class="seg small"><button class="${mode === 'q' ? 'on' : ''}" data-pv="q">Frage</button><button class="${mode === 'reveal' ? 'on' : ''}" data-pv="reveal">Auflösung</button></div>
      <button class="btn small ghost" data-pv="close">Schließen ✕</button></div>
    <div class="pv-frame"><div class="pv-scale" id="pv-scale"></div></div></div>`;
  document.body.appendChild(ov);
  const scaleBox = $('#pv-scale');
  renderPreview(scaleBox, quiz, JSON.parse(JSON.stringify(q)), mode);
  const fit = () => {
    const frame = ov.querySelector('.pv-frame');
    const s = Math.min(frame.clientWidth / 1280, frame.clientHeight / 720);
    scaleBox.style.transform = `scale(${s})`;
  };
  fit();
  window.addEventListener('resize', fit);
  ov._fit = fit;
  ov.onclick = e => {
    const b = e.target.closest('[data-pv]');
    if (e.target === ov || (b && b.dataset.pv === 'close')) return closePreview();
    if (b) openPreview(path, b.dataset.pv);
  };
}

function closePreview() {
  const ov = $('#pv');
  if (ov) { window.removeEventListener('resize', ov._fit); ov.remove(); }
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
  // Titel in der Seitenleiste live mitziehen
  if (/^games\.\d+\.title$/.test(el.dataset.bind)) {
    const item = root.querySelector('.side-item.on .si-t');
    if (item) item.textContent = el.value || 'Ohne Titel';
  }
  if (el.dataset.bind === 'title') $$('[data-bind="title"]', root).forEach(x => { if (x !== el) x.value = el.value; });
  scheduleSave();
}

async function onChange(e) {
  const el = e.target;
  if ('excel' in el.dataset) {
    const file = el.files && el.files[0];
    if (!file) return;
    try {
      const res = await importExcelInto(quiz, file);
      scheduleSave();
      render();
      toast(`${res.added} Fragen übernommen${res.warnings.length ? ` · ${res.warnings.length} Hinweise` : ''}`, 4000);
      if (res.warnings.length) alert('Hinweise zum Import:\n\n' + res.warnings.slice(0, 15).join('\n'));
    } catch (err) { toast('Excel konnte nicht gelesen werden: ' + err.message, 5000); }
    return;
  }
  if (el.dataset.mediafile) {
    const file = el.files && el.files[0];
    if (!file) return;
    if (file.size > MAX_MEDIA_MB * 1048576) { toast(`Datei ist zu groß (max. ${MAX_MEDIA_MB} MB). Tipp: Clip kürzen.`, 4000); return; }
    try {
      toast('Datei wird gespeichert …');
      set(el.dataset.mediafile + '.media', await saveMediaFile(file));
      scheduleSave();
      render();
    } catch (err) { toast('Speichern fehlgeschlagen: ' + err.message, 4000); }
    return;
  }
  if (el.dataset.bind && el.dataset.bind.endsWith('.media.url')) {
    const base = el.dataset.bind.replace(/\.url$/, '');
    const m = get(base);
    const parsed = parseYouTube(el.value);
    m.url = el.value;
    m.vid = parsed ? parsed.vid : '';
    if (parsed && parsed.start && !m.start) m.start = parsed.start;
    scheduleSave();
    render();
    return;
  }
  if (el.dataset.img) {
    const file = el.files && el.files[0];
    if (!file) return;
    try {
      set(el.dataset.img + '.image', await readImage(file));
      scheduleSave();
      render();
    } catch (err) { toast(err.message); }
    return;
  }
  if (!el.dataset.bind) return;
  if (el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') {
    set(el.dataset.bind, valueOf(el));
    scheduleSave();
    render();
  }
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  // Klicks auf Knöpfe im Fragenkopf sollen die Frage nicht auf-/zuklappen
  if (b.dataset.act === 'toggleQ' && e.target.closest('button')) return;
  e.preventDefault();
  const { act, path, type } = b.dataset;
  const i = Number(b.dataset.i);
  switch (act) {
    case 'select':
      sel = b.dataset.key; addMenu = null;
      render();
      window.scrollTo(0, 0);
      return;
    case 'export':
      flush();
      bundleQuiz(quiz).then(x => downloadJSON(x, `${slug(quiz.title)}.quiz.json`));
      return;
    case 'template':
      import('./excel.js').then(m => m.downloadTemplate()).catch(err => toast('Vorlage nicht verfügbar: ' + err.message));
      return;
    case 'preview':
      openPreview(path);
      return;
    case 'toggleQ':
      openQ.has(b.dataset.id) ? openQ.delete(b.dataset.id) : openQ.add(b.dataset.id);
      render();
      return;
    case 'toggleAll': {
      const list = get(path);
      const allOpen = list.every(q => openQ.has(q.id));
      list.forEach(q => (allOpen ? openQ.delete(q.id) : openQ.add(q.id)));
      render();
      return;
    }
    case 'addMenu':
      addMenu = path || null;
      render();
      return;
    case 'addGame': {
      const g = newGame(quiz.games.length + 1, type);
      quiz.games.push(g);
      sel = 'g:' + g.id;
      break;
    }
    case 'dupGame': {
      const copy = JSON.parse(JSON.stringify(quiz.games[i]));
      copy.id = uid();
      copy.title += ' (Kopie)';
      copy.questions.forEach(q => { q.id = uid(); });
      if (copy.tiebreaker) copy.tiebreaker.id = uid();
      quiz.games.splice(i + 1, 0, copy);
      sel = 'g:' + copy.id;
      break;
    }
    case 'setType':
      set(path + '.type', b.dataset.val);
      break;
    case 'setVal': {
      let v = b.dataset.val;
      if (v === 'true') v = true; else if (v === 'false') v = false;
      set(path, v);
      break;
    }
    case 'addQ': {
      const q = newQuestion(type);
      get(path).push(q);
      openQ.add(q.id);
      addMenu = null;
      break;
    }
    case 'dupQ': {
      const arr = get(path);
      const copy = normalizeQuestion({ ...JSON.parse(JSON.stringify(arr[i])), id: uid() });
      arr.splice(i + 1, 0, copy);
      openQ.add(copy.id);
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
      const what = path === 'games' ? `Spiel „${arr[i].title}“ mit allen Fragen` : 'diese Frage';
      if (!confirm(`${what} wirklich löschen?`)) return;
      arr.splice(i, 1);
      if (path === 'games') sel = quiz.games[Math.min(i, quiz.games.length - 1)] ? 'g:' + quiz.games[Math.min(i, quiz.games.length - 1)].id : 'settings';
      break;
    }
    case 'addTie': {
      const q = newQuestion('estimate');
      quiz.games[i].tiebreaker = q;
      openQ.add(q.id);
      break;
    }
    case 'delTie':
      if (!confirm('Stechfrage löschen?')) return;
      set(path, null);
      break;
    case 'imgDel':
      set(path + '.image', null);
      break;
    case 'mediaYT':
      set(path + '.media', { kind: 'youtube', url: '', vid: '', start: 0, end: 0 });
      break;
    case 'mediaDel':
      set(path + '.media', null);
      break;
    case 'mediaMark': {
      const m = get(path + '.media');
      const prev = b.closest('.media-box').querySelector('.media-preview');
      if (!m || !prev) return;
      m[b.dataset.which] = Math.round(prev.currentTime * 2) / 2;
      break;
    }
    case 'addItem':
      get(path)[b.dataset.list].push('');
      break;
    case 'delItem':
      get(path)[b.dataset.list].splice(i, 1);
      break;
    case 'hiloText': {
      const q = get(path);
      const unit = q.unit ? ' ' + q.unit : '';
      q.text = `${q.refLabel || 'A'} hat ${String(q.refValue).replace('.', ',')}${unit}. Hat ${q.itemLabel || 'B'} mehr oder weniger?`;
      break;
    }
    default:
      return;
  }
  scheduleSave();
  render();
}
