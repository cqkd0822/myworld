var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = /* @__PURE__ */ __name((data, ttl = 300) => new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttl}`,
        "access-control-allow-origin": "*"
      }
    }), "json");
    if (path === "/" || path === "") {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>MyWorld API</title><body style="font-family:-apple-system,PingFang SC,sans-serif;background:#0c1220;color:#eef2f9;padding:40px"><h1>MyWorld API</h1><p>\u53EA\u8BFB\u63A5\u53E3\uFF0C\u6570\u636E\u4E3B\u5B58\u50A8\u955C\u50CF\u5728 Cloudflare D1 <code>myworld</code>\u3002</p><ul><li><a style="color:#5aa2ff" href="/api/health">/api/health</a></li><li><a style="color:#5aa2ff" href="/api/flights">/api/flights</a>\uFF08100 \u6BB5\uFF0C\u4E0E\u7AD9\u70B9\u6570\u636E\u540C\u6784\uFF09</li><li><a style="color:#5aa2ff" href="/api/rail">/api/rail</a>\uFF0853 \u6BB5\uFF09</li><li><a style="color:#5aa2ff" href="/api/rail-voided">/api/rail-voided</a>\uFF0823 \u6761\uFF09</li><li><a style="color:#5aa2ff" href="/api/tracks">/api/tracks</a>\uFF0861 \u6761\u5143\u6570\u636E\uFF09</li><li>/api/tracks/:id/geometry\uFF08\u8F68\u8FF9\u51E0\u4F55\uFF0C\u6309\u9700\u52A0\u8F7D\uFF09</li></ul><p style="color:#667089">\u7AD9\u70B9\u672C\u4F53\u4ECD\u7531 Cloudflare Pages + GitHub \u6587\u4EF6\u63D0\u4F9B\uFF1B\u672C Worker \u53EA\u662F\u670D\u52A1\u7AEF\u8BFB\u6A21\u578B\u3002</p>',
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      if (path === "/api/health") {
        const [f, r, t] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) n FROM flights").first(),
          env.DB.prepare("SELECT COUNT(*) n FROM rail").first(),
          env.DB.prepare("SELECT COUNT(*) n FROM tracks").first()
        ]);
        return json({ ok: true, flights: f.n, rail: r.n, tracks: t.n });
      }
      if (path === "/api/flights") {
        const { results } = await env.DB.prepare(
          "SELECT id,date,airline,flight_no,from_raw,to_raw,aircraft,reg,std,sta,ata,cabin,seat,price,delay FROM flights ORDER BY id"
        ).all();
        return json(
          results.map((x) => [
            x.id,
            x.date,
            x.airline,
            x.flight_no,
            x.from_raw,
            x.to_raw,
            x.aircraft,
            x.reg,
            x.std,
            x.sta,
            x.ata,
            x.cabin,
            x.seat,
            x.price,
            x.delay
          ])
        );
      }
      if (path === "/api/rail") {
        const { results } = await env.DB.prepare(
          "SELECT id,date,train,from_station,to_station,seat,note FROM rail ORDER BY id"
        ).all();
        return json(results.map((x) => [x.id, x.date, x.train, x.from_station, x.to_station, x.seat, x.note]));
      }
      if (path === "/api/rail-voided") {
        const { results } = await env.DB.prepare(
          "SELECT train,from_station,to_station,date,reason FROM rail_voided ORDER BY id"
        ).all();
        return json(results.map((x) => [x.train, x.from_station, x.to_station, x.date, x.reason]));
      }
      if (path === "/api/tracks") {
        const { results } = await env.DB.prepare("SELECT * FROM tracks ORDER BY date").all();
        return json(
          results.map((x) => ({
            id: x.id,
            name: x.name,
            date: x.date,
            region: x.region,
            kind: x.kind,
            color: x.color,
            startTime: x.start_time,
            endTime: x.end_time,
            stats: {
              distanceKm: x.distance_km,
              ascentM: x.ascent_m,
              descentM: x.descent_m,
              minEle: x.min_ele,
              maxEle: x.max_ele,
              durationSec: x.duration_sec,
              movingTimeSec: x.moving_time_sec,
              movingDistanceKm: x.moving_dist_km,
              movingSpeedKmh: x.moving_speed_kmh,
              restTimeSec: x.rest_time_sec,
              rawPoints: x.raw_points,
              shownPoints: x.shown_points,
              segments: x.segments,
              gpx: x.gpx_key,
              toleranceM: x.tolerance_m,
              eleThresholdM: x.ele_threshold_m
            },
            center: { lat: x.center_lat, lng: x.center_lng, zoom: x.center_zoom }
          }))
        );
      }
      const gm = path.match(/^\/api\/tracks\/([^/]+)\/geometry$/);
      if (gm) {
        const row = await env.DB.prepare("SELECT geom_json FROM tracks WHERE id = ?").bind(decodeURIComponent(gm[1])).first();
        if (!row || !row.geom_json) return new Response("not found", { status: 404 });
        return new Response(row.geom_json, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*"
          }
        });
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err && err.message) }, 0);
    }
  }
};

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Dx5QdF/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Dx5QdF/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
