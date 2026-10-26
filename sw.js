/**
 * MyWorld 离线缓存。
 *
 * 策略（2026-10-26 改版）：
 * - 静态资源 cache-first：URL 带 ?v=<内容哈希>，内容一变 URL 就变，天然绕过旧缓存。
 * - 导航请求 network-first：断网回落缓存里的 index.html，SPA 外壳在就整站可看。
 * - /api/* 改为 **stale-while-revalidate**：命中缓存立即返回（回访秒开），
 *   后台带 If-None-Match 再验证——304 不动缓存；200 且旧缓存存在时 postMessage
 *   通知页面静默重渲染；后台失败且只有缓存时通知页面挂「离线缓存」横幅。
 *   老策略是 network-first，回访用户每次都要干等 4 个请求落地才首渲。
 * - 跨域一律不碰：腾讯地图瓦片有自己的缓存策略。
 */
const CACHE = 'myworld-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

function postClients(msg) {
  return self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage(msg)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);

        const revalidate = async () => {
          try {
            const headers = {};
            const etag = cached && cached.headers.get('etag');
            if (etag) headers['if-none-match'] = etag;
            const res = await fetch(req, { headers });
            if (res.status === 304) return cached || res;
            if (res.ok) {
              await cache.put(req, res.clone());
              if (cached) postClients({ type: 'api-updated', path: url.pathname });
              return res;
            }
            return cached || res;
          } catch (err) {
            if (cached) {
              postClients({ type: 'api-cache', path: url.pathname });
              return cached;
            }
            throw err;
          }
        };

        if (cached) {
          // 秒开：先给缓存，后台再验证（waitUntil 保证后台任务跑完）
          e.waitUntil(revalidate());
          return cached;
        }
        return revalidate();
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html')),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
