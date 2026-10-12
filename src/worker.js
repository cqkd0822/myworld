/**
 * MyWorld API —— Phase 1：D1 只读接口。
 *
 * 返回形状与 assets/data/*.js 的 window.MYWORLD.* 完全同构（数组的数组），
 * 这样前端把数据源从「打包文件」切到「/api/*」时视图层零改动。
 *
 * 零依赖：不引 Hono，路由就这几个，手写更清楚。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const json = (data, ttl = 300) =>
      new Response(JSON.stringify(data), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${ttl}`,
          'access-control-allow-origin': '*',
        },
      });

    if (path === '/' || path === '') {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>MyWorld API</title>' +
        '<body style="font-family:-apple-system,PingFang SC,sans-serif;background:#0c1220;color:#eef2f9;padding:40px">' +
        '<h1>MyWorld API</h1><p>只读接口，数据主存储镜像在 Cloudflare D1 <code>myworld</code>。</p><ul>' +
        '<li><a style="color:#5aa2ff" href="/api/health">/api/health</a></li>' +
        '<li><a style="color:#5aa2ff" href="/api/flights">/api/flights</a>（100 段，与站点数据同构）</li>' +
        '<li><a style="color:#5aa2ff" href="/api/rail">/api/rail</a>（53 段）</li>' +
        '<li><a style="color:#5aa2ff" href="/api/rail-voided">/api/rail-voided</a>（23 条）</li>' +
        '<li><a style="color:#5aa2ff" href="/api/tracks">/api/tracks</a>（61 条元数据）</li>' +
        '<li>/api/tracks/:id/geometry（轨迹几何，按需加载）</li></ul>' +
        '<p style="color:#667089">站点本体仍由 Cloudflare Pages + GitHub 文件提供；本 Worker 只是服务端读模型。</p>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }

    try {
      if (path === '/api/health') {
        const [f, r, t] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) n FROM flights').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM rail').first(),
          env.DB.prepare('SELECT COUNT(*) n FROM tracks').first(),
        ]);
        return json({ ok: true, flights: f.n, rail: r.n, tracks: t.n });
      }

      if (path === '/api/flights') {
        const { results } = await env.DB.prepare(
          'SELECT id,date,airline,flight_no,from_raw,to_raw,aircraft,reg,std,sta,ata,cabin,seat,price,delay,note FROM flights ORDER BY id',
        ).all();
        return json(
          results.map((x) => [
            x.id, x.date, x.airline, x.flight_no, x.from_raw, x.to_raw, x.aircraft, x.reg,
            x.std, x.sta, x.ata, x.cabin, x.seat, x.price, x.delay, x.note || '',
          ]),
        );
      }

      if (path === '/api/rail') {
        const { results } = await env.DB.prepare(
          'SELECT id,date,train,from_station,to_station,seat,note FROM rail ORDER BY id',
        ).all();
        return json(results.map((x) => [x.id, x.date, x.train, x.from_station, x.to_station, x.seat, x.note]));
      }

      if (path === '/api/rail-voided') {
        const { results } = await env.DB.prepare(
          'SELECT train,from_station,to_station,date,reason FROM rail_voided ORDER BY id',
        ).all();
        return json(results.map((x) => [x.train, x.from_station, x.to_station, x.date, x.reason]));
      }

      if (path === '/api/tracks') {
        const { results } = await env.DB.prepare('SELECT * FROM tracks ORDER BY date').all();
        return json(
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

      const gm = path.match(/^\/api\/tracks\/([^/]+)\/geometry$/);
      if (gm) {
        const row = await env.DB.prepare('SELECT geom_json FROM tracks WHERE id = ?').bind(decodeURIComponent(gm[1])).first();
        if (!row || !row.geom_json) return new Response('not found', { status: 404 });
        return new Response(row.geom_json, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=86400',
            'access-control-allow-origin': '*',
          },
        });
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message) }, 0);
    }
  },
};
