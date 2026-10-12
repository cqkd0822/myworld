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
          'SELECT id,date,airline,flight_no,from_raw,to_raw,aircraft,reg,std,sta,ata,cabin,seat,price,delay FROM flights ORDER BY id',
        ).all();
        return json(
          results.map((x) => [
            x.id, x.date, x.airline, x.flight_no, x.from_raw, x.to_raw, x.aircraft, x.reg,
            x.std, x.sta, x.ata, x.cabin, x.seat, x.price, x.delay,
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

      return new Response('not found', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message) }, 0);
    }
  },
};
