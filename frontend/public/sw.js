// sw.js — ShareHub Service Worker
const CACHE_NAME = 'sharehub-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Activate immediately
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Claim all tabs immediately
self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(keys => 
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      )
    ])
  );
});

// Map of common mimeTypes to extensions for Android gallery fix
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
};

function ensureExtension(file) {
  let name = file.name || 'shared_file';
  
  // Check if name already has an extension
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0 && lastDot > name.length - 8) {
    // Already has extension
    return file;
  }
  
  // Derive extension from mimeType
  const ext = MIME_TO_EXT[file.type] || '';
  if (ext) {
    name = name + ext;
  }
  
  // Create new File with correct name
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Handle PWA Share Target POST to /share
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const rawFiles = formData.getAll('files');
        
        // Fix file extensions (Android gallery sometimes strips them)
        const files = rawFiles.map(f => {
          if (f && typeof f === 'object' && f.size > 0) {
            return ensureExtension(f);
          }
          return f;
        }).filter(f => f && f.size > 0);

        if (files.length === 0) {
          return Response.redirect('/', 303);
        }

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
            files.forEach(f => store.put(f));
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          };
          request.onerror = () => reject(request.error);
        });

        return Response.redirect('/?shared=true', 303);
      } catch (err) {
        console.error('Share target error:', err);
        return Response.redirect('/?share_error=true', 303);
      }
    })());
    return;
  }

  // Network-first for navigation (HTML pages), cache-first for assets
  if (e.request.method === 'GET') {
    if (e.request.mode === 'navigate') {
      // Navigation: network first, fall back to cache
      e.respondWith(
        fetch(e.request).catch(() => caches.match('/index.html'))
      );
    } else {
      // Assets: cache first
      e.respondWith(
        caches.match(e.request).then((response) => {
          return response || fetch(e.request);
        })
      );
    }
  }
});
