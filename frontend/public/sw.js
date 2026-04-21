// sw.js
const CACHE_NAME = 'sharehub-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/main.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const files = formData.getAll('files');
        
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('ShareHubDB', 1);
          request.onupgradeneeded = (ev) => {
            ev.target.result.createObjectStore('sharedFiles', { autoIncrement: true });
          };
          request.onsuccess = (ev) => {
            const db = ev.target.result;
            const transaction = db.transaction('sharedFiles', 'readwrite');
            const store = transaction.objectStore('sharedFiles');
            store.clear();
            files.forEach(f => {
              if (f && typeof f === 'object' && f.size > 0) store.put(f);
            });
            transaction.oncomplete = () => resolve();
          };
          request.onerror = reject;
        });

        return Response.redirect('/?shared=true', 303);
      } catch (err) {
        console.error('Share error:', err);
        return Response.redirect('/', 303);
      }
    })());
    return;
  }

  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});
