// Speicherung im Browser (IndexedDB): Quizze und der laufende Abend.
const DB_NAME = 'quizarena';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('quizzes')) db.createObjectStore('quizzes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
