// Speicherung im Browser (IndexedDB): Quizze und der laufende Abend.
const DB_NAME = 'quizarena';
const VERSION = 2;
let dbPromise = null;

function showNotice(text) {
  let el = document.getElementById('db-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'db-notice';
    el.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:100;max-width:90vw;padding:14px 18px;border-radius:12px;background:#ffd23f;color:#241a00;font:600 16px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = text;
}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('quizzes')) db.createObjectStore('quizzes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media'); // Video-/Audiodateien als Blob
      };
      req.onsuccess = () => {
        const db = req.result;
        // Öffnet ein neuerer Tab eine neue Version, gibt dieser Tab die Datenbank frei.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
          showNotice('Quizarena wurde in einem anderen Tab aktualisiert. Bitte diese Seite neu laden.');
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // Ein anderer Tab mit einer älteren Version blockiert das Update.
      req.onblocked = () => showNotice('Bitte alle anderen Quizarena-Tabs schließen und diese Seite neu laden (Update auf neue Version).');
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const listQuizzes = () => run('quizzes', 'readonly', s => s.getAll())
  .then(list => list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
export const getQuiz = id => run('quizzes', 'readonly', s => s.get(id));
export const saveQuiz = quiz => { quiz.updatedAt = Date.now(); return run('quizzes', 'readwrite', s => s.put(quiz)); };
export const deleteQuiz = id => run('quizzes', 'readwrite', s => s.delete(id));
export const kvGet = key => run('kv', 'readonly', s => s.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', s => s.put(value, key));
export const kvDel = key => run('kv', 'readwrite', s => s.delete(key));
export const putMedia = (id, blob) => run('media', 'readwrite', s => s.put(blob, id));
export const getMedia = id => run('media', 'readonly', s => s.get(id));
export const deleteMedia = id => run('media', 'readwrite', s => s.delete(id));
export const listMediaKeys = () => run('media', 'readonly', s => s.getAllKeys());
