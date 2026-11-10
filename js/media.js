// Video-/Audiodateien: speichern, anzeigen, exportieren, aufräumen.
import { putMedia, getMedia, deleteMedia, listMediaKeys, listQuizzes, kvGet } from './store.js';
import { uid } from './model.js';

const urlCache = new Map();

export async function saveMediaFile(file) {
  const id = 'm' + uid();
  await putMedia(id, file);
  return { kind: 'file', id, mime: file.type || '', name: file.name, size: file.size };
}

export async function mediaUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getMedia(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

// Alle <video>/<audio data-media="…"> in einem Bereich mit Quelle versorgen.
export async function hydrateMedia(root) {
  const els = [...root.querySelectorAll('[data-media]')];
  for (const el of els) {
    const url = await mediaUrl(el.dataset.media);
    if (url) el.src = url;
    else el.replaceWith(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Mediendatei fehlt in diesem Browser.' }));
  }
}

export function allQuestions(quiz) {
  const list = [];
  (quiz.games || []).forEach(g => { list.push(...(g.questions || [])); if (g.tiebreaker) list.push(g.tiebreaker); });
  if (quiz.final) list.push(...(quiz.final.questions || []));
  list.push(...(quiz.tiebreakers || []));
  return list;
}

export function mediaIds(quiz) {
  return allQuestions(quiz).filter(q => q.media && q.media.kind === 'file').map(q => q.media.id);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || '' });
}

// Export: Quiz inklusive Mediendateien in einer JSON-Datei.
export async function bundleQuiz(quiz) {
  const out = JSON.parse(JSON.stringify(quiz));
  out._media = {};
  for (const id of mediaIds(quiz)) {
    const blob = await getMedia(id);
    if (blob) out._media[id] = { mime: blob.type, data: await blobToBase64(blob) };
  }
  return out;
}

export async function unbundleQuiz(obj) {
  const media = obj._media || {};
  delete obj._media;
  for (const [id, m] of Object.entries(media)) await putMedia(id, base64ToBlob(m.data, m.mime));
  return obj;
}

// Nicht mehr verwendete Mediendateien löschen.
export async function gcMedia() {
  const used = new Set();
  (await listQuizzes()).forEach(q => mediaIds(q).forEach(id => used.add(id)));
  const session = await kvGet('session');
  if (session) mediaIds(session.quiz).forEach(id => used.add(id));
  for (const key of await listMediaKeys()) if (!used.has(key)) await deleteMedia(key);
}
