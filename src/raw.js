/**
 * 原始轨迹点的紧凑编码 —— D1 里唯一的一份几何数据。
 *
 * 为什么要有这一层：GPX 是 XML，一条 6 小时徒步 2 MB，直接塞 D1 既浪费又
 * 没法算。这里压成「增量整数 + gzip」，一个点四个数：
 *
 *   dLat / dLng —— 相对上一点的 1e-6 度增量（≈0.11 m）
 *   ele         —— 海拔 0.1 m 整数，null = 该点没有海拔
 *   dt          —— 相对上一点的秒数增量，null = 该点没有时间戳
 *
 * 段头 `o` 存首点的绝对 [lat*1e6, lng*1e6, epoch 秒]，增量才有起点。
 *
 * **1e6 是实测出来的下限，不是随手取的**：换成 1e5（≈1.1 m），
 * Douglas-Peucker 会在发卡弯处选出不同的点——五台山逆朝那条重算后最大偏差
 * 81 米、点数从 298 变 301。1e6 时，解码后重算出的 paths 与
 * elevationProfile 和「全精度原始 GPX 直接算」**逐字节一致**（61/61 条）。
 *
 * **一个 trkseg 一行**（part = 段序号），各自独立 gzip。这样单条轨迹点数
 * 上不封顶：D1 单行上限 2 MB，目前最大的一段（14162 点）gzip 后 52 KB、
 * base64 之后 70 KB，还有 28 倍余量。
 *
 * 这份文件同时跑在 Node（tools/build-tracks.mjs 编码）和 Worker（解码后
 * 现算渲染几何）里，所以只用两边都有的全局：btoa/atob、CompressionStream、
 * crypto.subtle。零依赖。
 */

export const RAW_VERSION = 1;
export const COORD_SCALE = 1e6; // 1e-6 度 ≈ 0.11 m
export const ELE_SCALE = 10; // 0.1 m

/* ------------------------------------------------------------------ */
/* gzip <-> base64（Worker 与 Node 通用）                              */
/* ------------------------------------------------------------------ */

async function streamToBytes(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000; // 一次拼太多字符会爆调用栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gzipToB64(str) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  return bytesToB64(await streamToBytes(cs.readable));
}

export async function gunzipFromB64(b64) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(b64ToBytes(b64));
  writer.close();
  return new TextDecoder().decode(await streamToBytes(ds.readable));
}

/** 内容指纹，用作 ETag / 变更检测。base64 去掉尾部填充，够短也够唯一。 */
export async function sha1B64(b64) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(b64));
  return bytesToB64(new Uint8Array(digest)).replace(/=+$/, '');
}

/* ------------------------------------------------------------------ */
/* 段级编解码                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一段点（geo.mjs 的 {lat,lng,ele,time} 形状）-> JSON 字符串。
 * 不含 gzip，方便单测直接比对。
 */
export function encodeSegment(points) {
  const rows = new Array(points.length);
  let lat0 = 0;
  let lng0 = 0;
  let t0 = null;
  let prevLat = 0;
  let prevLng = 0;
  let prevT = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lat = Math.round(p.lat * COORD_SCALE);
    const lng = Math.round(p.lng * COORD_SCALE);
    if (i === 0) {
      lat0 = lat;
      lng0 = lng;
      prevLat = lat;
      prevLng = lng;
    }

    let dt = null;
    if (p.time) {
      const sec = Math.round(Date.parse(p.time) / 1000);
      if (Number.isFinite(sec)) {
        if (prevT === null) {
          t0 = sec; // 首个有时间戳的点定义段头 t0，自己的增量为 0
          dt = 0;
        } else {
          dt = sec - prevT;
        }
        prevT = sec;
      }
    }

    rows[i] = [lat - prevLat, lng - prevLng, typeof p.ele === 'number' && Number.isFinite(p.ele) ? Math.round(p.ele * ELE_SCALE) : null, dt];
    prevLat = lat;
    prevLng = lng;
  }

  return JSON.stringify({ v: RAW_VERSION, o: [lat0, lng0, t0], p: rows });
}

/**
 * 解码回 geo.mjs 的点形状。
 *
 * needTime=false（默认）时完全不碰时间：画轨迹只要 lat/lng/ele，
 * 省掉一万多次 Date 构造与 ISO 字符串——那是这条链路上最贵的一步。
 * 需要重算统计（移动时长/休息时长）时才传 needTime=true。
 */
export function decodeSegment(payload, { needTime = false } = {}) {
  const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!obj || obj.v !== RAW_VERSION) throw new Error(`不支持的 raw 版本：${obj && obj.v}`);

  const [lat0, lng0, t0] = obj.o;
  const rows = obj.p;
  const out = new Array(rows.length);

  let lat = lat0;
  let lng = lng0;
  let t = typeof t0 === 'number' ? t0 : null;

  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    lat += q[0];
    lng += q[1];
    const p = { lat: lat / COORD_SCALE, lng: lng / COORD_SCALE };
    if (q[2] !== null && q[2] !== undefined) p.ele = q[2] / ELE_SCALE;
    if (needTime && typeof q[3] === 'number' && t !== null) {
      t += q[3];
      p.time = new Date(t * 1000).toISOString();
    }
    out[i] = p;
  }
  return out;
}

/** 一段点 -> 一行 track_raw 需要的字段 */
export async function packSegment(points) {
  const json = encodeSegment(points);
  const b64 = await gzipToB64(json);
  return { b64, points: points.length, jsonBytes: json.length, sha1: await sha1B64(b64) };
}

/**
 * track_raw 的多行 -> geo.mjs 的 segments。
 * rows 需按 part 升序；列名 gzip_b64 与 D1 里一致。
 */
export async function unpackParts(rows, opts) {
  const segments = [];
  for (const r of rows) segments.push(decodeSegment(await gunzipFromB64(r.gzip_b64), opts));
  return segments.filter((s) => s.length > 0);
}
