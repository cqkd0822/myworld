/**
 * MyWorld 离线缓存。
 *
 * 策略很简单，因为这是一个纯静态站：
 * - 同源 GET 一律 cache-first：命中直接用，没命中拉网络并写缓存。
 *   资源 URL 带 ?v=<内容哈希>（tools/bump-cache.mjs 生成），内容一变
 *   URL 就变，天然绕过旧缓存，不需要手工清。
 * - 导航请求（刷新/直达某个 #/ 路由）network-first，断网时回落到
 *   缓存里的 index.html——SPA 外壳在，数据脚本也都在缓存里，整站可看。
 * - 跨域一律不碰：腾讯地图的瓦片和 API 有自己的缓存策略，也不该由我们存。
 */
const CACHE = 'myworld-v1';

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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

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
