// IndexedDB storage. Everything stays on this device.
// Stores: photos (records with image blobs), meta (settings, order), inbox (files shared to the app).

const DB_NAME = 'family-photo-evidence';
const DB_VERSION = 1;
let dbp = null;

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const putPhoto = rec => tx('photos', 'readwrite', s => { s.put(rec); });
export const deletePhoto = id => tx('photos', 'readwrite', s => { s.delete(id); });
export const getAllPhotos = () => tx('photos', 'readonly', s => reqP(s.getAll()));
export const getMeta = key => tx('meta', 'readonly', s => reqP(s.get(key)));
export const setMeta = (key, val) => tx('meta', 'readwrite', s => { s.put(val, key); });

export async function takeInbox() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('inbox', 'readwrite');
    const s = t.objectStore('inbox');
    const items = [];
    s.openCursor().onsuccess = e => {
      const c = e.target.result;
      if (c) { items.push(c.value); c.delete(); c.continue(); }
    };
    t.oncomplete = () => resolve(items);
    t.onerror = () => reject(t.error);
  });
}

export async function clearAll() {
  await tx('photos', 'readwrite', s => { s.clear(); });
  await tx('meta', 'readwrite', s => { s.delete('order'); });
}
