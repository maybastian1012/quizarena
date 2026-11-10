// Datenmodell: Quiz -> Spiele -> Fragen, plus Finale und Stechfragen-Vorrat.

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const QUESTION_TYPES = {
  mc: 'Multiple Choice',
  tf: 'Wahr / Falsch',
  estimate: 'Schätzfrage',
};

export const WIN_MODES = {
  target: 'Wer zuerst die Zielpunktzahl erreicht',
  count: 'Meiste Punkte nach festgelegter Fragenzahl',
  elimination: 'Letzter übrig (Leben)',
};

export function newQuestion(type = 'mc') {
  const q = { id: uid(), type, text: '', image: null, time: 20 };
  if (type === 'mc') { q.options = ['', '', '', '']; q.correct = 0; }
  if (type === 'tf') { q.correct = true; }
  if (type === 'estimate') { q.correct = 0; q.unit = ''; q.time = 30; }
  return q;
}

export function newGame(n = 1, type = 'quiz') {
  return {
    id: uid(),
    title: `Spiel ${n}`,
    description: '',
    type,            // 'quiz' = Fragespiel, 'manual' = Spiel ohne Fragen, Sieger wird eingetragen
    points: 1,       // Spielpunkte für den Sieg
    timer: 0,        // nur manuelle Spiele: optionaler Countdown in Sekunden
    questions: [],
    tiebreaker: null // optionale eigene Stechfrage (Schätzfrage)
  };
}

export function newQuiz(title = 'Neuer Spieleabend', games = 10) {
  return {
    id: uid(),
    title,
    updatedAt: Date.now(),
    games: Array.from({ length: games }, (_, i) => newGame(i + 1)),
    final: newFinal(),
    tiebreakers: [],
  };
}

export function newFinal() {
  return {
    enabled: true,
    title: 'Finale',
    description: 'Die Punkte aus den Vorrunden sind euer Vorsprung.',
    winMode: 'target',
    target: 15,      // Zielpunktzahl (Vorsprung zählt mit)
    count: 10,       // Anzahl Fragen im Modus "count"
    baseLives: 1,    // Leben im Modus "elimination" zusätzlich zum Vorsprung
    headStart: true, // Vorrundenpunkte als Startwert
    questions: [],
  };
}

// Fehlende Felder bei älteren/importierten Quizzen ergänzen.
export function normalizeQuiz(q) {
  q.id = q.id || uid();
  q.title = q.title || 'Spieleabend';
  q.games = Array.isArray(q.games) ? q.games : [];
  q.games.forEach((g, i) => {
    Object.entries(newGame(i + 1)).forEach(([k, v]) => { if (g[k] === undefined) g[k] = v; });
    g.questions = (g.questions || []).map(normalizeQuestion);
    if (g.tiebreaker) g.tiebreaker = normalizeQuestion(g.tiebreaker);
  });
  q.final = Object.assign(newFinal(), q.final || {});
  q.final.questions = (q.final.questions || []).map(normalizeQuestion);
  q.tiebreakers = (q.tiebreakers || []).map(normalizeQuestion);
  return q;
}

function normalizeQuestion(x) {
  const base = newQuestion(x.type || 'mc');
  return Object.assign(base, x, { id: x.id || uid() });
}

// Prüft ein Quiz vor dem Start. Gibt Liste von Warnungen zurück.
export function validateQuiz(quiz) {
  const w = [];
  if (!quiz.games.length) w.push('Das Quiz hat keine Spiele.');
  quiz.games.forEach((g, i) => {
    const name = `Spiel ${i + 1} „${g.title || 'ohne Titel'}“`;
    if (g.type === 'quiz' && !g.questions.length) w.push(`${name} hat keine Fragen.`);
    g.questions.forEach((q, j) => checkQuestion(q, `${name}, Frage ${j + 1}`, w));
  });
  if (quiz.final.enabled) {
    const f = quiz.final;
    if (!f.questions.length) w.push('Das Finale hat keine Fragen.');
    f.questions.forEach((q, j) => checkQuestion(q, `Finale, Frage ${j + 1}`, w));
    if (f.winMode === 'count' && f.count > f.questions.length) {
      w.push(`Finale: ${f.count} Fragen eingestellt, aber nur ${f.questions.length} vorhanden.`);
    }
  }
  return w;
}

function checkQuestion(q, label, w) {
  if (!q.text.trim() && !q.image) w.push(`${label}: Fragetext fehlt.`);
  if (q.type === 'mc') {
    const filled = q.options.filter(o => o.trim()).length;
    if (filled < 2) w.push(`${label}: mindestens zwei Antworten nötig.`);
    if (!q.options[q.correct] || !q.options[q.correct].trim()) w.push(`${label}: die richtige Antwort ist leer.`);
  }
}

// Text der richtigen Antwort (für Anzeige).
export function correctText(q) {
  if (q.type === 'mc') return q.options[q.correct];
  if (q.type === 'tf') return q.correct ? 'Wahr' : 'Falsch';
  return formatNumber(q.correct) + (q.unit ? ' ' + q.unit : '');
}

export function formatNumber(n) {
  if (n === null || n === undefined || n === '') return '–';
  return Number(n).toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

// Beispielquiz zum Ausprobieren.
export function sampleQuiz() {
  const mc = (text, options, correct, time = 20) => Object.assign(newQuestion('mc'), { text, options, correct, time });
  const tf = (text, correct) => Object.assign(newQuestion('tf'), { text, correct, time: 15 });
  const est = (text, correct, unit = '') => Object.assign(newQuestion('estimate'), { text, correct, unit });

  const q = newQuiz('Beispiel-Abend', 0);
  const g1 = Object.assign(newGame(1), {
    title: 'Erdkunde', description: 'Vier Fragen rund um die Welt.',
    questions: [
      mc('Welcher Fluss hat die längste Strecke innerhalb Deutschlands?', ['Elbe', 'Rhein', 'Donau', 'Weser'], 1),
      tf('Kaiserslautern liegt in Rheinland-Pfalz.', true),
      mc('Wie heißt die Hauptstadt von Australien?', ['Sydney', 'Melbourne', 'Canberra', 'Perth'], 2),
      est('Wie hoch ist die Zugspitze?', 2962, 'm'),
    ],
    tiebreaker: est('Wie lang ist der Äquator ungefähr?', 40075, 'km'),
  });
  const g2 = Object.assign(newGame(2), {
    title: 'Zahlen & Schätzen', description: 'Wer liegt am nächsten dran?',
    questions: [
      est('In welchem Jahr fiel die Berliner Mauer?', 1989),
      est('Wie viele Knochen hat ein erwachsener Mensch?', 206),
      tf('Ein Oktopus hat drei Herzen.', true),
    ],
  });
  const g3 = Object.assign(newGame(3, 'manual'), {
    title: 'Becherturm', description: 'Wer baut in 60 Sekunden den höchsten Turm aus Bechern?', timer: 60,
  });
  q.games = [g1, g2, g3];
  q.final = Object.assign(newFinal(), {
    winMode: 'target', target: 5,
    questions: [
      mc('Welches Element hat das chemische Symbol Fe?', ['Fluor', 'Eisen', 'Blei', 'Zinn'], 1),
      tf('Der Mount Everest ist der höchste Berg der Erde über dem Meeresspiegel.', true),
      mc('Wie viele Spieler einer Fußballmannschaft stehen auf dem Feld?', ['9', '10', '11', '12'], 2),
      mc('Wer malte die Mona Lisa?', ['Michelangelo', 'Leonardo da Vinci', 'Raffael', 'Rembrandt'], 1),
      est('Wie viele Tasten hat ein klassisches Klavier?', 88),
      mc('Welcher Planet ist der Sonne am nächsten?', ['Venus', 'Mars', 'Merkur', 'Erde'], 2),
      tf('Schall breitet sich im Wasser langsamer aus als in Luft.', false),
    ],
  });
  q.tiebreakers = [
    est('In welchem Jahr landete Apollo 11 auf dem Mond?', 1969),
    est('Wie schnell ist Schall in Luft bei 20 °C?', 343, 'm/s'),
  ];
  return q;
}
