const CACHE_NAME = 'ltscanteen-shell-v1';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './assets/images/School-logo.webp'
];
const STATIC_FILE_PATTERN = /\.(?:css|html|ico|jpe?g|js|json|png|svg|webp|woff2?)$/i;
const APP_ROOT = new URL(self.registration.scope);
const API_ROOT = new URL('api/', APP_ROOT).pathname;

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) {
                return cache.addAll(APP_SHELL.map(function (path) {
                    return new URL(path, APP_ROOT).href;
                }));
            })
            .then(function () {
                return self.skipWaiting();
            })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (cacheNames) {
                return Promise.all(cacheNames
                    .filter(function (cacheName) {
                        return cacheName.startsWith('ltscanteen-') && cacheName !== CACHE_NAME;
                    })
                    .map(function (cacheName) {
                        return caches.delete(cacheName);
                    }));
            })
            .then(function () {
                return self.clients.claim();
            })
    );
});

self.addEventListener('fetch', function (event) {
    const request = event.request;
    const requestUrl = new URL(request.url);

    if (request.method !== 'GET' || requestUrl.origin !== self.location.origin ||
        requestUrl.pathname.startsWith(API_ROOT)) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(function () {
                const isAppHome = requestUrl.pathname === APP_ROOT.pathname ||
                    requestUrl.pathname === new URL('index.html', APP_ROOT).pathname;
                if (isAppHome) {
                    return caches.match(new URL('index.html', APP_ROOT).href);
                }
                throw new Error('Page is unavailable offline.');
            })
        );
        return;
    }

    if (!requestUrl.pathname.startsWith(APP_ROOT.pathname) ||
        !STATIC_FILE_PATTERN.test(requestUrl.pathname)) {
        return;
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.match(request).then(function (cachedResponse) {
                const networkResponse = fetch(request).then(function (response) {
                    if (response.ok && response.type === 'basic') {
                        cache.put(request, response.clone());
                    }
                    return response;
                });

                if (cachedResponse) {
                    event.waitUntil(networkResponse.catch(function () {}));
                    return cachedResponse;
                }
                return networkResponse;
            });
        })
    );
});
