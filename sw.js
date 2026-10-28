// 앱 파일을 캐시해 오프라인에서도 열리게 함. 온라인이면 항상 최신 파일을 먼저 받음(network-first).
const CACHE = 'myhealth-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'foods-kr.js', 'plan.js', 'manifest.webmanifest', 'icons/icon-180.png'];
const SCANNER = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else if (url.href === SCANNER) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
  }
  // 음식 API 요청은 캐시하지 않음
});
