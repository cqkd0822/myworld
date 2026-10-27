/**
 * MyWorld —— 单 Worker：静态站点 + /api 读模型 + 轨迹几何现算。
 *
 * 数据真源是 D1：
 *   flights / rail / rail_voided —— 行程记录
 *   tracks                       —— 轨迹元数据与统计
 *   track_raw                    —— **原始轨迹点**（唯一的几何真源）
 *
 * 渲染用的抽稀 paths 与海拔剖面**既不落库也不在边缘算**：
 *   - 落库 = 存第二份几何，raw 能 100% 复原它，没必要；
 *   - 边缘算 = Workers 免费档每次调用只有 10 ms CPU，最长那条轨迹
 *     （14162 点）的抽稀+剖面要约 30 ms，必然被掐死。
 * 所以 /api/tracks/:id/raw 只把原始点原样发给前端，抽稀与剖面在浏览器算
 * （同一份算法源码，见 tools/build-browser-geo.mjs）。精度与体积论证见 src/raw.js。
 *
 * 零依赖：不引 Hono，路由就这几个，手写更清楚。
 */

const round = (v, d = 2) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
};

/**
 * 带 ETag 的 JSON 响应：SW 走 stale-while-revalidate 后，后台再验证靠它拿 304，
 * 省掉每次回访重复传 30~40 KB 列表。SHA-1 取前 16 hex 做指纹，CPU 亚毫秒。
 */
async function jsonWithEtag(request, data, ttl = 300) {
  const body = JSON.stringify(data);
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const etag = `"${hex.slice(0, 16)}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': `public, max-age=${ttl}` },
    });
  }
  return new Response(body, {
    headers: { ...JSON_HEADERS, 'cache-control': `public, max-age=${ttl}`, etag },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const json = (data, ttl = 300, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...JSON_HEADERS, 'cache-control': `public, max-age=${ttl}` },
      });

    if (path === '/' || path === '') {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>MyWorld API</title>' +
          '<body style="font-family:-apple-system,PingFang SC,sans-serif;background:#0c1220;color:#eef2f9;padding:40px">' +
          '<h1>MyWorld API</h1><p>站点与接口同域；数据真源是 Cloudflare D1 <code>myworld</code>。</p><ul>' +
          '<li><a style="color:#5aa2ff" href="/api/health">/api/health</a></li>' +
          '<li><a style="color:#5aa2ff" href="/api/flights">/api/flights</a></li>' +
          '<li><a style="color:#5aa2ff" href="/api/rail">/api/rail</a> · <a style="color:#5aa2ff" href="/api/rail-voided">/api/rail-voided</a></li>' +
          '<li><a style="color:#5aa2ff" href="/api/tracks">/api/tracks</a>（元数据 + 统计）</li>' +
          '<li>/api/tracks/:id/raw —— 原始点（gzip+base64），前端解码后本地抽稀/算剖面</li></ul>' +
          '<p style="color:#667089">静态站点由同一个 Worker 的 Assets 提供。</p>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    /* ---------------- 管理写接口 ---------------- */
    if (path.startsWith('/api/admin/')) {
      // 没配 ADMIN_TOKEN 时一律拒绝：宁可管理接口不可用，也不能裸奔。
      // 本地调试把 token 写进 .dev.vars（已 gitignore）。
      if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ ok: false, error: 'unauthorized' }, 0, 401);
      }
      // 统计重算留在构建期（node tools/build-tracks.mjs 改 MANIFEST 阈值后重灌），
      // 不在边缘做：免费档 10 ms CPU 扛不住万点级轨迹的全量重算。
      // 这个鉴权壳子留给后面的 /admin 上传（GPX/截图解析后写 D1）。
      return json({ ok: false, error: 'unknown admin route' }, 0, 404);
    }

    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }

    try {
      if (path === '/api/health') {
        const [f, r, t, raw] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) n FROM flights').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM rail').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM tracks').first(),
          env.DB.prepare('SELECT COUNT(DISTINCT id) n, SUM(points) p FROM track_raw').first(),
        ]);
        return json({ ok: true, flights: f.n, rail: r.n, tracks: t.n, trackRaw: raw.n, trackRawPoints: raw.p });
      }

      if (path === '/api/flights') {
        const { results } = await env.DB.prepare(
          'SELECT id,date,airline,flight_no,from_raw,to_raw,aircraft,reg,std,sta,ata,cabin,seat,price,delay,note FROM flights ORDER BY id',
        ).all();
        return jsonWithEtag(
          request,
          results.map((x) => [
            x.id, x.date, x.airline, x.flight_no, x.from_raw, x.to_raw, x.aircraft, x.reg,
            x.std, x.sta, x.ata, x.cabin, x.seat, x.price, x.delay, x.note || '',
          ]),
        );
      }

      if (path === '/api/rail') {
        // dep_time / arr_time 由 006 migration 加入。线上若先上了代码、还没跑
        // migration，这条查询会报「no such column」——退回旧列而不是 500，
        // 否则整个铁路页会被一条 DDL 拖空。
        let results;
        try {
          ({ results } = await env.DB.prepare(
            'SELECT id,date,train,from_station,to_station,seat,note,dep_time,arr_time FROM rail ORDER BY id',
          ).all());
        } catch (e) {
          ({ results } = await env.DB.prepare(
            'SELECT id,date,train,from_station,to_station,seat,note FROM rail ORDER BY id',
          ).all());
        }
        return jsonWithEtag(
          request,
          results.map((x) => [
            x.id, x.date, x.train, x.from_station, x.to_station, x.seat, x.note,
            x.dep_time ?? null, x.arr_time ?? null,
          ]),
        );
      }

      if (path === '/api/rail-voided') {
        const { results } = await env.DB.prepare(
          'SELECT train,from_station,to_station,date,reason FROM rail_voided ORDER BY id',
        ).all();
        return jsonWithEtag(
          request,
          results.map((x) => [x.train, x.from_station, x.to_station, x.date, x.reason]),
        );
      }

      if (path === '/api/tracks') {
        // 显式列名，不要 SELECT *：几何一旦混进这张表，每次列表请求都会白拖几百 KB
        const { results } = await env.DB.prepare(
          `SELECT id,name,date,region,kind,color,start_time,end_time,
                  distance_km,ascent_m,descent_m,min_ele,max_ele,duration_sec,
                  moving_time_sec,moving_dist_km,moving_speed_kmh,rest_time_sec,
                  raw_points,shown_points,segments,gpx_key,tolerance_m,ele_threshold_m,
                  center_lat,center_lng,center_zoom
             FROM tracks ORDER BY date`,
        ).all();
        return jsonWithEtag(
          request,
          results.map((x) => ({
            id: x.id, name: x.name, date: x.date, region: x.region, kind: x.kind, color: x.color,
            startTime: x.start_time, endTime: x.end_time,
            stats: {
              distanceKm: x.distance_km, ascentM: x.ascent_m, descentM: x.descent_m,
              minEle: x.min_ele, maxEle: x.max_ele, durationSec: x.duration_sec,
              movingTimeSec: x.moving_time_sec, movingDistanceKm: x.moving_dist_km,
              movingSpeedKmh: x.moving_speed_kmh, restTimeSec: x.rest_time_sec,
              rawPoints: x.raw_points, shownPoints: x.shown_points, segments: x.segments,
              gpx: x.gpx_key, toleranceM: x.tolerance_m, eleThresholdM: x.ele_threshold_m,
            },
            center: { lat: x.center_lat, lng: x.center_lng, zoom: x.center_zoom },
          })),
        );
      }

      const gm = path.match(/^\/api\/tracks\/([^/]+)\/raw$/);
      if (gm) return trackRaw(decodeURIComponent(gm[1]), request, env);

      return new Response('not found', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 0, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* 原始点下发：D1 -> 前端（浏览器里解码 + 抽稀 + 算剖面）               */
/* ------------------------------------------------------------------ */

/**
 * 把 track_raw 原样发给前端。Worker 在这条路径上几乎不花 CPU：
 * 一次索引查询 + 一次主查询 + 拼 JSON，14162 点那条也只有 70 KB base64。
 *
 * ETag 由各段 sha1 拼成：重灌某条轨迹后指纹自动变化，浏览器与 CDN 的
 * 旧缓存自然失效；没变则 304，连 70 KB 都不用传。
 */
async function trackRaw(id, request, env) {
  const meta = await env.DB.prepare('SELECT tolerance_m FROM tracks WHERE id = ?').bind(id).first();
  if (!meta) return new Response('not found', { status: 404 });

  const { results } = await env.DB
    .prepare('SELECT part, points, gzip_b64, sha1 FROM track_raw WHERE id = ? ORDER BY part')
    .bind(id)
    .all();
  if (!results.length) {
    return new Response(JSON.stringify({ error: 'track_raw 里没有这条轨迹的原始点' }), {
      status: 409,
      headers: JSON_HEADERS,
    });
  }

  const etag = `"${id}-${results.map((r) => r.sha1 || r.part).join('.')}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'public, max-age=86400' } });
  }

  return new Response(JSON.stringify({ id, toleranceM: meta.tolerance_m, parts: results }), {
    headers: {
      ...JSON_HEADERS,
      // 内容只由 track_raw 决定，而它在 ETag 里，所以可以放心 immutable。
      'cache-control': 'public, max-age=31536000, immutable',
      etag,
    },
  });
}
