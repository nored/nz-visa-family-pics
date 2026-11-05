// Service worker: offline app shell, and the Web Share Target that receives photos
// shared from the Android share sheet when the app is installed.

const CACHE = 'fpe-v5';
const SHELL = [
  './', 'index.html', 'styles.css?v=5', 'app.js?v=5', 'pdf.js?v=5', 'db.js?v=5', 'project.js?v=5', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'fonts/DejaVuSans.ttf', 'fonts/DejaVuSans-Bold.ttf', 'fonts/DejaVuSans-Oblique.ttf',
  'vendor/pdf-lib.min.js', 'vendor/fontkit.umd.min.js', 'vendor/exifr-full.umd.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('family-photo-evidence', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('photos').filter(f => f && typeof f !== 'string');
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('inbox', 'readwrite');
    const s = t.objectStore('inbox');
    for (const f of files) s.add({ file: f, name: f.name, type: f.type });
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  return Response.redirect(new URL(`./?shared=${files.length}`, self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // network first so a new deploy shows up at once; cache when offline
  e.respondWith((async () => {
    try {
      // revalidate with the server instead of trusting GitHub Pages' 10-minute max-age
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('index.html');
      throw new Error('offline');
    }
  })());
});
