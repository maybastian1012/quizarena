// Datenmodell: Quiz -> Spiele -> Fragen, plus Finale und Stechfragen-Vorrat.

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const QUESTION_TYPES = {
  mc: 'Multiple Choice',
  tf: 'Wahr / Falsch',
  estimate: 'Schätzfrage',
  order: 'Reihenfolge',
  buzzer: 'Buzzer-Frage',
};

export const JOKERS = {
  double: { label: 'Verdoppeln', icon: '⚡', hint: 'Nach der Spielankündigung: Sieg zählt doppelt' },
  fifty: { label: '50:50', icon: '½', hint: 'Multiple Choice: falsche Antworten verschwinden' },
  time: { label: 'Zusatzzeit', icon: '⏱', hint: '10 Sekunden mehr Zeit bei einer Frage' },
};

export const WIN_MODES = {
  target: 'Wer zuerst die Zielpunktzahl erreicht',
  count: 'Meiste Punkte nach festgelegter Fragenzahl',
  elimination: 'Letzter übrig (Leben)',
};

export function newQuestion(type = 'mc') {
  // media: null | {kind:'file', id, mime, name, size} | {kind:'youtube', url, vid, start, end}
  // notes: Moderationsnotiz, nur auf dem Spielleiter-Handy sichtbar
  const q = { id: uid(), type, text: '', image: null, media: null, mediaFirst: false, time: 20, notes: '' };
  if (type === 'mc') { q.options = ['', '', '', '']; q.correct = 0; }
  if (type === 'tf') { q.correct = true; }
  if (type === 'estimate') { q.correct = 0; q.unit = ''; q.time = 30; }
  if (type === 'order') { q.items = ['', '', '', '']; q.time = 30; } // Einträge in richtiger Reihenfolge
  if (type === 'buzzer') { q.answer = ''; q.time = 30; }
  return q;
}

// YouTube-Link zerlegen: Video-ID und Startzeit (t=…)
export function parseYouTube(url) {
  const s = String(url || '').trim();
  const m = s.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
  if (!m) return null;
  const t = s.match(/[?&](?:t|start)=(\d+)/);
  return { vid: m[1], start: t ? Number(t[1]) : 0 };
}

export const orderIndices = q => (q.items || []).map((t, i) => (String(t).trim() ? i : -1)).filter(i => i >= 0);

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
  if (q.type === 'order' && orderIndices(q).length < 2) w.push(`${label}: mindestens zwei Einträge für die Reihenfolge nötig.`);
  if (q.type === 'buzzer' && !String(q.answer || '').trim()) w.push(`${label}: Lösung fehlt (wird bei der Auflösung gezeigt).`);
  if (q.media && q.media.kind === 'youtube' && !q.media.vid) w.push(`${label}: YouTube-Link ist ungültig.`);
}

// Text der richtigen Antwort (für Anzeige).
export function correctText(q) {
  if (q.type === 'mc') return q.options[q.correct];
  if (q.type === 'tf') return q.correct ? 'Wahr' : 'Falsch';
  if (q.type === 'order') return orderIndices(q).map(i => q.items[i]).join(' → ');
  if (q.type === 'buzzer') return q.answer || '–';
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

// Zweites Beispiel mit den Funktionen aus Stufe 2.
export function sampleQuiz2() {
  const ord = (text, items) => Object.assign(newQuestion('order'), { text, items });
  const buz = (text, answer) => Object.assign(newQuestion('buzzer'), { text, answer, time: 20 });
  const mc = (text, options, correct) => Object.assign(newQuestion('mc'), { text, options, correct });
  const est = (text, correct, unit = '') => Object.assign(newQuestion('estimate'), { text, correct, unit });

  const q = newQuiz('Beispiel: Neue Funktionen', 0);
  q.games = [
    Object.assign(newGame(1), {
      title: 'Zeitstrahl', description: 'Bringt alles in die richtige Reihenfolge.',
      questions: [
        ord('Sortiere nach Gründungsjahr (älteste zuerst).', ['Google', 'Facebook', 'YouTube', 'WhatsApp']),
        ord('Sortiere nach Größe (kleinster zuerst).', ['Mond', 'Erde', 'Jupiter', 'Sonne']),
        mc('Welcher Planet hat die meisten bekannten Monde?', ['Erde', 'Mars', 'Saturn', 'Merkur'], 2),
      ],
    }),
    Object.assign(newGame(2), {
      title: 'Schnellraten', description: 'Buzzer-Runde: Wer zuerst drückt, antwortet laut. Falsch = Minuspunkt.',
      questions: [
        buz('Wie heißt die Hauptstadt von Kanada?', 'Ottawa'),
        buz('Wie viele Bundesländer hat Deutschland?', '16'),
        buz('Welches Tier ist im Berliner Wappen?', 'Bär'),
      ],
      tiebreaker: est('Wie viele Einwohner hat Deutschland ungefähr (in Millionen)?', 83, 'Mio.'),
    }),
  ];
  q.final = Object.assign(newFinal(), {
    winMode: 'count', count: 3, description: '',
    questions: [
      mc('Wie viele Minuten hat ein Tag?', ['1.240', '1.440', '1.640', '1.840'], 1),
      ord('Sortiere von Norden nach Süden.', ['Hamburg', 'Kassel', 'Frankfurt', 'München']),
      buz('Wie heißt der längste Fluss der Welt?', 'Nil (je nach Messung auch Amazonas)'),
    ],
  });
  q.tiebreakers = [est('Wie hoch ist der Kölner Dom?', 157, 'm')];
  return q;
}
