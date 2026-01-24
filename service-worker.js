// service-worker.js
const CACHE_VERSION = 'cbt-v3.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;

// Assets to cache immediately
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;600;700;800&display=swap',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js'
];

// Install - Cache static assets
self.addEventListener('install', event => {
  console.log('[ServiceWorker] Installing...');
  
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE)
        .then(cache => cache.addAll(STATIC_ASSETS))
        .then(() => console.log('[ServiceWorker] Static assets cached')),
      
      self.skipWaiting()
    ])
  );
});

// Activate - Clean old caches
self.addEventListener('activate', event => {
  console.log('[ServiceWorker] Activating...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName.startsWith('cbt-') && 
              cacheName !== STATIC_CACHE && 
              cacheName !== API_CACHE && 
              cacheName !== IMAGE_CACHE) {
            console.log('[ServiceWorker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[ServiceWorker] Claiming clients');
      return self.clients.claim();
    })
  );
});

// Fetch - Cache strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // API requests - Network first, then cache
  if (url.pathname.includes('/api/')) {
    event.respondWith(handleApiRequest(event));
  }
  // Image requests - Cache first, then network
  else if (url.pathname.match(/\.(jpg|jpeg|png|gif|svg|webp)$/i)) {
    event.respondWith(handleImageRequest(event));
  }
  // Static assets - Cache first
  else {
    event.respondWith(handleStaticRequest(event));
  }
});

// API Request Handler
async function handleApiRequest(event) {
  const request = event.request;
  const cache = await caches.open(API_CACHE);
  
  try {
    // Try network first
    const networkResponse = await fetch(request);
    
    // Clone response to store in cache
    const responseClone = networkResponse.clone();
    
    // Cache successful responses (except GET with query params for dynamic data)
    if (networkResponse.ok && request.method === 'GET' && 
        !request.url.includes('?')) {
      cache.put(request, responseClone);
    }
    
    return networkResponse;
  } catch (error) {
    console.log('[ServiceWorker] Network failed, trying cache:', error);
    
    // Try cache if network fails
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      console.log('[ServiceWorker] Serving from cache:', request.url);
      return cachedResponse;
    }
    
    // Return offline response if no cache
    return new Response(
      JSON.stringify({ 
        error: 'NetworkError', 
        message: 'You are offline and no cached data available.',
        offline: true 
      }),
      { 
        status: 503, 
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Image Request Handler
async function handleImageRequest(event) {
  const cache = await caches.open(IMAGE_CACHE);
  const cachedResponse = await cache.match(event.request);
  
  if (cachedResponse) {
    // Update cache in background
    fetchAndCache(event.request, cache);
    return cachedResponse;
  }
  
  // If not in cache, fetch and cache
  return fetchAndCache(event.request, cache);
}

async function fetchAndCache(request, cache) {
  try {
    const response = await fetch(request);
    
    if (response.ok) {
      const clone = response.clone();
      cache.put(request, clone);
    }
    
    return response;
  } catch (error) {
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#f0f0f0"/><text x="200" y="150" text-anchor="middle" fill="#666" font-family="Arial" font-size="14">Gambar tidak tersedia</text></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
}

// Static Request Handler
async function handleStaticRequest(event) {
  const cache = await caches.open(STATIC_CACHE);
  const cachedResponse = await cache.match(event.request);
  
  if (cachedResponse) {
    // Update cache in background
    fetch(event.request).then(response => {
      if (response.ok) {
        cache.put(event.request, response);
      }
    }).catch(() => {});
    
    return cachedResponse;
  }
  
  return fetch(event.request);
}

// Background sync for offline data
self.addEventListener('sync', event => {
  if (event.tag === 'sync-jawaban') {
    event.waitUntil(syncPendingJawaban());
  }
});

async function syncPendingJawaban() {
  console.log('[ServiceWorker] Syncing pending jawaban...');
  
  try {
    const pending = await getPendingJawaban();
    
    for (const item of pending) {
      await sendJawabanToServer(item);
      await removePendingJawaban(item.id);
    }
    
    console.log('[ServiceWorker] Sync completed');
  } catch (error) {
    console.error('[ServiceWorker] Sync failed:', error);
  }
}

async function getPendingJawaban() {
  // Implementasi get from IndexedDB
  return [];
}

async function sendJawabanToServer(jawaban) {
  // Implementasi send to server
}

async function removePendingJawaban(id) {
  // Implementasi remove from IndexedDB
}

// Push notifications
self.addEventListener('push', event => {
  const options = {
    body: event.data?.text() || 'Pemberitahuan dari CBT Ujian',
    icon: '/favicon.ico',
    badge: '/badge.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1'
    },
    actions: [
      {
        action: 'open',
        title: 'Buka Aplikasi'
      },
      {
        action: 'close',
        title: 'Tutup'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification('CBT Ujian Online', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  if (event.action === 'open') {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then(windowClients => {
        if (windowClients.length > 0) {
          return windowClients[0].focus();
        }
        return clients.openWindow('/');
      })
    );
  }
});
