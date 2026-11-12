// Excel-Import und -Vorlage (nutzt SheetJS, wird erst bei Bedarf geladen).
import { newGame, newQuestion, newQuiz, normalizeQuiz } from './model.js';

/* global XLSX */

const LIB = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
let libPromise = null;

function loadLib() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB;
      s.onload = resolve;
      s.onerror = () => { libPromise = null; reject(new Error('Excel-Bibliothek konnte nicht geladen werden (Internet?)')); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

const HEAD = ['Spiel', 'Fragetyp', 'Frage', 'A', 'B', 'C', 'D', 'E', 'F', 'Lösung', 'Auch richtig', 'Einheit', 'Zeit', 'Modus', 'Punkte', 'Notiz'];

const EXAMPLES = [
  ['Erdkunde', 'Multiple Choice', 'Wie heißt die Hauptstadt von Australien?', 'Sydney', 'Melbourne', 'Canberra', 'Perth', '', '', 'C', '', '', 20, '', 1, ''],
  ['Erdkunde', 'Wahr/Falsch', 'Kaiserslautern liegt in Rheinland-Pfalz.', '', '', '', '', '', '', 'wahr', '', '', 15, '', '', ''],
  ['Erdkunde', 'Schätzfrage', 'Wie hoch ist die Zugspitze?', '', '', '', '', '', '', 2962, '', 'm', 30, '', '', ''],
  ['Zeitstrahl', 'Reihenfolge', 'Sortiere nach Gründungsjahr (älteste zuerst).', 'Google', 'Facebook', 'YouTube', 'WhatsApp', '', '', '', '', '', 30, '', 1, ''],
  ['Schnellraten', 'Buzzer', 'Wie heißt die Hauptstadt von Kanada?', '', '', '', '', '', '', 'Ottawa', '', '', 20, '', 1, ''],
  ['Wer bin ich?', 'Hinweis-Raten', 'Wer bin ich?', 'Ich wurde 1879 in Ulm geboren.', 'Ich bekam den Physik-Nobelpreis.', 'Meine Formel hat drei Buchstaben.', 'E = mc²', '', '', 'Albert Einstein', 'Einstein', '', 40, 'Buzzer', 1, 'Nobelpreis 1921'],
  ['Wer bin ich?', 'Bild aufdecken', 'Was ist auf dem Bild?', '', '', '', '', '', '', 'Eiffelturm', '', '', 30, 'Freitext', '', 'Bild im Editor hinzufügen'],
  ['Freie Antworten', 'Freitext', 'Wie heißt die Hauptstadt von Italien?', '', '', '', '', '', '', 'Rom', 'Roma', '', 30, '', 1, ''],
  ['Freie Antworten', 'Höher/Tiefer', 'Berlin hat 3,7 Mio. Einwohner. Hat Hamburg mehr oder weniger?', 'Berlin', 3.7, 'Hamburg', 1.9, '', '', '', '', 'Mio.', 15, '', '', ''],
  ['Becherturm', 'Manuell', 'Wer baut in 60 Sekunden den höchsten Becherturm?', '', '', '', '', '', '', '', '', '', 60, '', 1, ''],
  ['Finale', 'Multiple Choice', 'Welches Element hat das Symbol Fe?', 'Fluor', 'Eisen', 'Blei', 'Zinn', '', '', 'B', '', '', 20, '', '', ''],
  ['Stechfrage', 'Schätzfrage', 'In welchem Jahr landete Apollo 11 auf dem Mond?', '', '', '', '', '', '', 1969, '', '', 30, '', '', ''],
];

const GUIDE = [
  ['So füllst du die Tabelle „Fragen“ aus'],
  [''],
  ['Spalte', 'Bedeutung'],
  ['Spiel', 'Name des Spiels. Zeilen mit gleichem Namen landen im selben Spiel (in der Reihenfolge der Tabelle). „Finale“ = Finalfragen, „Stechfrage“ = Stechfragen-Vorrat.'],
  ['Fragetyp', 'Multiple Choice · Wahr/Falsch · Schätzfrage · Reihenfolge · Buzzer · Hinweis-Raten · Bild aufdecken · Freitext · Höher/Tiefer · Manuell'],
  ['Frage', 'Fragetext. Bei „Manuell“: Regeln/Beschreibung des Spiels.'],
  ['A–F', 'Multiple Choice: Antworten A–D. Reihenfolge: Einträge in RICHTIGER Reihenfolge. Hinweis-Raten: Hinweise 1–6. Höher/Tiefer: A = Startwert-Name, B = Startwert, C = Vergleich-Name, D = Vergleichswert.'],
  ['Lösung', 'Multiple Choice: Buchstabe (A–D). Wahr/Falsch: wahr oder falsch. Schätzfrage: Zahl. Buzzer/Hinweis/Bild/Freitext: Lösungstext.'],
  ['Auch richtig', 'Weitere akzeptierte Antworten, mit | getrennt (für Freitext-Vorschläge).'],
  ['Einheit', 'Optional, z. B. km oder Mio.'],
  ['Zeit', 'Sekunden für die Frage (bei „Manuell“: Timer, 0 = aus).'],
  ['Modus', 'Nur Hinweis-Raten und Bild aufdecken: Buzzer oder Freitext.'],
  ['Punkte', 'Punkte für den Spielsieg (erste Zeile eines Spiels zählt).'],
  ['Notiz', 'Moderationsnotiz – nur auf dem Spielleiter-Handy sichtbar.'],
  [''],
  ['Bilder, Videos und Musik fügst du danach im Editor hinzu.'],
];

export async function downloadTemplate() {
  await loadLib();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEAD, ...EXAMPLES]);
  ws['!cols'] = [18, 16, 48, 18, 18, 18, 18, 12, 12, 18, 18, 9, 7, 10, 8, 30].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Fragen');
  const g = XLSX.utils.aoa_to_sheet(GUIDE);
  g['!cols'] = [{ wch: 14 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, g, 'Anleitung');
  XLSX.writeFile(wb, 'Quizarena-Vorlage.xlsx');
}

const TYPE_MAP = [
  [/^(mc|multiple)/, 'mc'], [/^(wf|wahr|tf|richtig)/, 'tf'], [/^sch[aä]tz/, 'estimate'], [/^reihen/, 'order'],
  [/^buzz/, 'buzzer'], [/^hinweis/, 'hint'], [/^bild/, 'reveal'], [/^frei/, 'text'], [/^(h[oö]her|hilo|mehr)/, 'hilo'], [/^manu/, 'manual'],
];

function typeOf(s) {
  const t = String(s || '').trim().toLowerCase();
  const hit = TYPE_MAP.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
}

function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // „2.962“ = zweitausendneunhundertzweiundsechzig
  return Number(s);
}

const str = v => String(v ?? '').trim();

function rowToQuestion(r, type, warn, where) {
  const q = newQuestion(type);
  q.text = str(r['Frage']) || q.text;
  const t = num(r['Zeit']);
  if (Number.isFinite(t) && t > 0) q.time = t;
  if (str(r['Notiz'])) q.notes = str(r['Notiz']);
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const cols = letters.map(l => str(r[l]));
  const sol = r['Lösung'] ?? r['Loesung'];
  switch (type) {
    case 'mc': {
      q.options = cols.slice(0, 4);
      const s = str(sol).toUpperCase();
      let idx = letters.indexOf(s);
      if (idx < 0) idx = q.options.findIndex(o => o.toLowerCase() === str(sol).toLowerCase());
      if (idx < 0 || idx > 3) { warn.push(`${where}: Lösung „${str(sol)}“ unklar – A gesetzt.`); idx = 0; }
      q.correct = idx;
      break;
    }
    case 'tf':
      q.correct = !/^(f|falsch|nein|no|false|0)/i.test(str(sol));
      break;
    case 'estimate': {
      const n = num(sol);
      if (!Number.isFinite(n)) warn.push(`${where}: Lösung ist keine Zahl.`);
      q.correct = Number.isFinite(n) ? n : 0;
      q.unit = str(r['Einheit']);
      break;
    }
    case 'order':
      q.items = cols.filter(Boolean);
      if (q.items.length < 2) warn.push(`${where}: weniger als zwei Einträge.`);
      break;
    case 'hint':
      q.hints = cols.filter(Boolean);
      if (!q.hints.length) warn.push(`${where}: keine Hinweise.`);
      q.answer = str(sol); q.alternatives = str(r['Auch richtig']);
      q.mode = /frei|text/i.test(str(r['Modus'])) ? 'text' : 'buzzer';
      q.hintEvery = Math.max(4, Math.round((q.time || 40) / Math.max(1, q.hints.length + 1)));
      break;
    case 'reveal':
      q.answer = str(sol); q.alternatives = str(r['Auch richtig']);
      q.mode = /frei|text/i.test(str(r['Modus'])) ? 'text' : 'buzzer';
      warn.push(`${where}: Bild bitte im Editor hinzufügen.`);
      break;
    case 'buzzer':
    case 'text':
      q.answer = str(sol); q.alternatives = str(r['Auch richtig']);
      break;
    case 'hilo':
      q.refLabel = cols[0]; q.refValue = num(cols[1]) || 0; q.itemLabel = cols[2]; q.itemValue = num(cols[3]) || 0;
      q.unit = str(r['Einheit']);
      if (!Number.isFinite(num(cols[1])) || !Number.isFinite(num(cols[3]))) warn.push(`${where}: Werte in B und D müssen Zahlen sein.`);
      break;
  }
  return q;
}

async function readRows(file) {
  await loadLib();
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const name = wb.SheetNames.find(n => /frage/i.test(n)) || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
}

// Zeilen in ein Quiz einsortieren (bestehende Spiele gleichen Namens werden ergänzt)
function applyRows(quiz, rows) {
  const warn = [];
  let added = 0;
  rows.forEach((r, k) => {
    const where = `Zeile ${k + 2}`;
    const gname = str(r['Spiel']);
    const type = typeOf(r['Fragetyp']);
    if (!gname && !str(r['Frage'])) return; // leere Zeile
    if (!type) { warn.push(`${where}: Fragetyp „${str(r['Fragetyp'])}“ unbekannt – übersprungen.`); return; }
    if (/^final/i.test(gname)) {
      if (type === 'manual') { warn.push(`${where}: „Manuell“ geht im Finale nicht.`); return; }
      quiz.final.enabled = true;
      quiz.final.questions.push(rowToQuestion(r, type, warn, where)); added++; return;
    }
    if (/^stech/i.test(gname)) {
      if (type !== 'estimate') warn.push(`${where}: Stechfragen müssen Schätzfragen sein – als Schätzfrage übernommen.`);
      quiz.tiebreakers.push(rowToQuestion(r, 'estimate', warn, where)); added++; return;
    }
    let g = quiz.games.find(x => x.title.trim().toLowerCase() === (gname || 'Spiel').toLowerCase());
    if (!g) {
      g = newGame(quiz.games.length + 1, type === 'manual' ? 'manual' : 'quiz');
      g.title = gname || `Spiel ${quiz.games.length + 1}`;
      const pts = num(r['Punkte']);
      if (Number.isFinite(pts) && pts >= 0) g.points = pts;
      quiz.games.push(g);
    }
    if (type === 'manual') {
      g.type = 'manual';
      g.description = str(r['Frage']);
      const t = num(r['Zeit']);
      if (Number.isFinite(t)) g.timer = t;
      return;
    }
    g.questions.push(rowToQuestion(r, type, warn, where)); added++;
  });
  return { added, warnings: warn };
}

export async function importExcelInto(quiz, file) {
  const rows = await readRows(file);
  // leere Platzhalter-Spiele („Spiel 1“ ohne Fragen) beim ersten Import entfernen
  if (quiz.games.every(g => !g.questions.length && /^Spiel \d+$/.test(g.title))) quiz.games = [];
  return applyRows(quiz, rows);
}

export async function quizFromExcel(file) {
  const rows = await readRows(file);
  const quiz = newQuiz(file.name.replace(/\.(xlsx|xls|csv)$/i, ''), 0);
  quiz.final.enabled = false;
  const res = applyRows(quiz, rows);
  return { quiz: normalizeQuiz(quiz), ...res };
}
