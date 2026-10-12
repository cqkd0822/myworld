/**
 * 轨迹几何工具 —— 零依赖，纯 Node 可跑。
 *
 * 三个容易出错的地方，这里都处理了：
 *
 * 1) 坐标系。GPX 存的是 WGS-84，而腾讯/高德/百度地图在中国大陆用加密后的
 *    GCJ-02。不纠偏轨迹会整体飘 50~500 米，落到路旁的楼顶上。
 *    判断是**逐点**做的，所以一趟跨境行程也能正确对齐。
 *
 * 2) 分段。GPX 可以有多个 <trkseg>（手表暂停、分段记录都会产生）。把所有点
 *    拉平成一个数组，段与段之间会被连成一条笔直的假线，距离和爬升都会虚高。
 *    这里全流程按段处理。
 *
 * 3) 距离虚高。GPS 定位误差有几米，徒步时每秒才走一米多，直接累加原始点间距
 *    等于把噪声当成路走——实测一条 6 公里环线能量出 8.4 公里（1.40 倍）。
 *    所以**统计用平滑后的轨迹，画图用原始几何**（平滑会让拐弯处抄近道）。
 */

/* ------------------------------------------------------------------ */
/* 坐标转换 WGS-84 -> GCJ-02                                            */
/* ------------------------------------------------------------------ */

const PI = Math.PI;
const A = 6378245.0; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/** 中国大陆粗略包围盒。境外坐标不做加密偏移。 */
function outOfChina(lat, lng) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** 把一对 WGS-84 坐标转成 GCJ-02。境外原样返回。 */
export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);

  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);

  return [lat + dLat, lng + dLng];
}

/* ------------------------------------------------------------------ */
/* GPX 解析                                                            */
/* ------------------------------------------------------------------ */

function parseTrkpts(xml) {
  const points = [];
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;

  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';

    const lat = Number((attrs.match(/\blat\s*=\s*"([^"]+)"/) ?? [])[1]);
    const lng = Number((attrs.match(/\blon\s*=\s*"([^"]+)"/) ?? [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const eleRaw = inner.match(/<ele>\s*([^<]+?)\s*<\/ele>/);
    const timeRaw = inner.match(/<time>\s*([^<]+?)\s*<\/time>/);
    const ele = eleRaw ? Number(eleRaw[1]) : undefined;

    points.push({
      lat,
      lng,
      ele: Number.isFinite(ele) ? ele : undefined,
      time: timeRaw ? timeRaw[1] : undefined,
    });
  }

  return points;
}

/**
 * 解析成「段的数组」。同时兼容标准的多 <trkseg> 结构与
 * 没有 trkseg、trkpt 直接挂在 <trk> 下的简化导出。
 *
 * 用正则而非 XML 库，是为了零依赖——这样同一个文件在 Node 脚本里
 * 直接就能跑，不需要 npm install。
 */
export function parseGpx(xml) {
  const segments = [];
  const segRe = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/g;

  let segMatch;
  while ((segMatch = segRe.exec(xml)) !== null) {
    const pts = parseTrkpts(segMatch[1]);
    if (pts.length > 0) segments.push(pts);
  }

  if (segments.length === 0) {
    const pts = parseTrkpts(xml);
    if (pts.length > 0) segments.push(pts);
  }

  return segments;
}

/**
 * 解析 <wpt> 航点。赛事路线文件常把补给站/检查点写成航点，
 * 这些点是理解赛道的关键信息，值得一起取出来。
 */
export function parseWaypoints(xml) {
  const out = [];
  const re = /<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/g;

  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';

    const lat = Number((attrs.match(/\blat\s*=\s*"([^"]+)"/) ?? [])[1]);
    const lng = Number((attrs.match(/\blon\s*=\s*"([^"]+)"/) ?? [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const nameMatch = inner.match(/<name>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/name>/);
    const name = nameMatch ? nameMatch[1].trim() : '';

    out.push({ lat, lng, name });
  }

  return out;
}

/** 拍平所有段。只用于计数等不涉及几何计算的场景。 */
export function flatten(segments) {
  return segments.flat();
}

/* ------------------------------------------------------------------ */
/* 几何计算                                                            */
/* ------------------------------------------------------------------ */

/** 两点球面距离（米） */
export function haversine(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 点到线段 AB 的近似垂距（米），用等距圆柱投影把角度差换成米 */
function perpendicularDistance(p, a, b) {
  const latRef = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const k = Math.cos(latRef);
  const M_PER_DEG_LAT = 110540;
  const M_PER_DEG_LNG = 111320;

  const px = (p.lng - a.lng) * k * M_PER_DEG_LNG;
  const py = (p.lat - a.lat) * M_PER_DEG_LAT;
  const bx = (b.lng - a.lng) * k * M_PER_DEG_LNG;
  const by = (b.lat - a.lat) * M_PER_DEG_LAT;

  const len = Math.hypot(bx, by);
  if (len === 0) return Math.hypot(px, py);

  return Math.abs(px * by - py * bx) / len;
}

/**
 * Ramer-Douglas-Peucker 抽稀。用显式栈而非递归，避免长轨迹爆栈。
 *
 * 这条直接决定了「十年轨迹能不能塞进一个 Git 仓库」：手表 1 秒 1 个点，
 * 6 小时徒步就是 2 万多个点、原始 GPX 2~3 MB；抽稀后通常只剩几百个点，
 * 肉眼完全看不出差别。
 */
export function simplify(points, toleranceM = 5) {
  const n = points.length;
  if (n <= 2) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack = [[0, n - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const dist = perpendicularDistance(points[i], points[first], points[last]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }

    if (maxDist > toleranceM && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export function simplifySegments(segments, toleranceM = 5) {
  return segments.map((seg) => simplify(seg, toleranceM)).filter((seg) => seg.length > 0);
}

/**
 * 滑动平均平滑。**只用于算统计，不改变显示用的轨迹几何。**
 * 代价是拐弯处会被轻微抄近道，所以显示轨迹仍然用未平滑的几何。
 */
export function smoothSegments(segments, window = 5) {
  if (window < 3) return segments;
  const half = Math.floor(window / 2);

  return segments.map((seg) => {
    if (seg.length < window) return seg.slice();

    return seg.map((p, i) => {
      const from = Math.max(0, i - half);
      const to = Math.min(seg.length - 1, i + half);
      let lat = 0;
      let lng = 0;
      let eleSum = 0;
      let eleCount = 0;

      for (let j = from; j <= to; j++) {
        lat += seg[j].lat;
        lng += seg[j].lng;
        if (typeof seg[j].ele === 'number') {
          eleSum += seg[j].ele;
          eleCount += 1;
        }
      }

      const n = to - from + 1;
      return {
        lat: lat / n,
        lng: lng / n,
        ele: eleCount > 0 ? eleSum / eleCount : undefined,
        time: p.time,
      };
    });
  });
}

/**
 * 只平滑海拔，经纬度原样保留。
 *
 * 用途是让海拔剖面图好看——原始高度值带 ±0.5 米级抖动，画出来是一条毛刺线。
 * **不要用它来算爬升**：真正的爬升控制是靠 trackStats 的阈值过滤，
 * 先平滑再阈值会把陡坡的起步段抹掉，反而少算。
 */
export function smoothElevation(segments, window = 7) {
  if (window < 3) return segments;
  const half = Math.floor(window / 2);

  return segments.map((seg) =>
    seg.map((p, i) => {
      if (typeof p.ele !== 'number') return { ...p };

      const from = Math.max(0, i - half);
      const to = Math.min(seg.length - 1, i + half);
      let sum = 0;
      let n = 0;

      for (let j = from; j <= to; j++) {
        const e = seg[j].ele;
        if (typeof e === 'number') {
          sum += e;
          n += 1;
        }
      }

      return { ...p, ele: n > 0 ? sum / n : p.ele };
    }),
  );
}

/**
 * 累计距离、爬升、下降、海拔区间。
 *
 * 距离：直接累加原始点间距。**不要先平滑**——实测一条 337 公里的阿尔卑斯
 * 赛道，5 点滑动平均会把距离压到 310 公里（少 8%），因为平滑在盘山发卡弯处
 * 抄了近道。原始 GPS 抖动带来的虚高通常只有 1~2%，远比抄近道造成的低估小。
 *
 * 爬升：先做阈值过滤。低于阈值的起伏视为高度抖动丢弃，否则 ±1 米的噪声在
 * 几万个点上会被累加成几千米的虚假爬升。10 米是常见取值。
 *
 * 距离只在段内累加，段与段之间不连线（段间没走路）。
 */
/** 相邻点间隔超过它即视为休息（午餐 / 过夜 / 暂停），整段剔除。10 分钟对徒步是稳妥阈值。 */
const REST_GAP_MS = 10 * 60 * 1000;

export function trackStats(segments, eleThreshold = 10) {
  let distance = 0;
  let ascent = 0;
  let descent = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;
  let pointCount = 0;
  let movingTimeMs = 0;
  let movingDistanceM = 0;

  for (const seg of segments) {
    pointCount += seg.length;
    let lastEle;
    let pending = 0;

    for (let i = 0; i < seg.length; i++) {
      const p = seg[i];
      if (i > 0) distance += haversine(seg[i - 1], p);
      // 去休息：相邻点时间间隔 <= REST_GAP 才算「在移动」，
      // 超过的（ lunch / 过夜 / 手表暂停）整段剔除，不计入移动时间与移动距离。
      if (i > 0 && p.time && seg[i - 1].time) {
        const dt = Date.parse(p.time) - Date.parse(seg[i - 1].time);
        if (dt >= 0 && dt <= REST_GAP_MS) {
          movingTimeMs += dt;
          movingDistanceM += haversine(seg[i - 1], p);
        }
      }

      if (typeof p.ele === 'number') {
        if (p.ele < minEle) minEle = p.ele;
        if (p.ele > maxEle) maxEle = p.ele;

        if (typeof lastEle === 'number') {
          pending += p.ele - lastEle;
          if (Math.abs(pending) >= eleThreshold) {
            if (pending > 0) ascent += pending;
            else descent -= pending;
            pending = 0;
          }
        }
        lastEle = p.ele;
      }
    }
  }

  const all = flatten(segments);

  return {
    distanceKm: distance / 1000,
    ascentM: ascent,
    descentM: descent,
    minEle: Number.isFinite(minEle) ? minEle : 0,
    maxEle: Number.isFinite(maxEle) ? maxEle : 0,
    pointCount,
    segmentCount: segments.length,
    startTime: all.find((p) => p.time)?.time,
    endTime: [...all].reverse().find((p) => p.time)?.time,
    // 去休息后的近似移动指标：跨天 / 含过夜的徒步用它算速度，
    // 不再被 12 小时的「总用时」稀释成 1 km/h。
    movingTimeSec: Math.round(movingTimeMs / 1000),
    movingDistanceKm: movingDistanceM / 1000,
    movingSpeedKmh: movingTimeMs > 0 ? (movingDistanceM / 1000) / (movingTimeMs / 3600000) : 0,
    restTimeSec: Math.max(0, Math.round((((all[all.length - 1]?.time ? Date.parse(all[all.length - 1].time) : 0) - (all[0]?.time ? Date.parse(all[0].time) : 0)) - movingTimeMs) / 1000)),
  };
}

/**
 * 均匀重采样成海拔剖面数据。累计距离在每个段内往前推进，
 * 段与段之间不增加距离（因为没走路）。
 * 返回 [[累计公里, 海拔米], ...]
 */
export function elevationProfile(segments, count = 200) {
  const flat = [];
  let accumulated = 0;

  for (const seg of segments) {
    for (let i = 0; i < seg.length; i++) {
      const p = seg[i];
      if (typeof p.ele !== 'number') continue;
      if (i > 0) accumulated += haversine(seg[i - 1], p);
      flat.push([accumulated / 1000, p.ele]);
    }
  }

  if (flat.length < 2) return [];

  const total = flat[flat.length - 1][0];
  if (total === 0) return [];

  const step = flat.length <= count ? 1 : (flat.length - 1) / (count - 1);
  const samples = [];

  for (let i = 0; i < count; i++) {
    const idx = Math.min(flat.length - 1, Math.round(i * step));
    samples.push(flat[idx]);
  }

  return samples;
}

/**
 * 按轨迹范围算出中心点与缩放级别。
 *
 * 这里算的是**初值**（让首屏不闪一下），运行时地图还会再调一次 fitBounds
 * 做精确对框，所以允许有一点误差，但必须是有限值——
 * 传入形状不对时会静默产出 NaN，那种 bug 只能在真机上发现。
 *
 * 兼容两种入参：[lat, lng] 元组（toMapPaths 的返回值）和 {lat, lng} 对象。
 */
export function centerAndZoom(points) {
  if (!points || points.length === 0) return { lat: 39.9042, lng: 116.4074, zoom: 10 };

  const norm = points.map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : p));

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const p of norm) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  const lat = (minLat + maxLat) / 2;
  const lng = (minLng + maxLng) / 2;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat: 39.9042, lng: 116.4074, zoom: 10 };
  }

  // 经度方向要按纬度余弦压缩：Web Mercator 里 1° 经度的**地面距离**随纬度变小，
  // 不压缩的话高纬度轨迹会被当成"更宽"，zoom 就会偏小、把轨迹框得太紧。
  const latMid = (lat * Math.PI) / 180;
  const spanDeg = Math.max(
    maxLat - minLat,
    (maxLng - minLng) * Math.cos(latMid),
    1e-6,
  );

  // Web Mercator：zoom 为 z 时每度占 256 * 2^z / 360 像素。
  // 反解出「让轨迹横向占满约 320px」的 z，320 是手机地图容器的一般宽度。
  const zoom = Math.max(3, Math.min(17, Math.round(Math.log2((320 * 360) / (256 * spanDeg)))));

  return { lat, lng, zoom };
}

/**
 * 把轨迹转成地图可直接绘制的坐标。国内段自动做 GCJ-02 纠偏，
 * 境外段保持原样——判断是逐点做的。
 */
export function toMapPaths(segments, decimals = 5) {
  const factor = 10 ** decimals;
  const round = (v) => Math.round(v * factor) / factor;

  return segments.map((seg) =>
    seg.map((p) => {
      const [lat, lng] = wgs84ToGcj02(p.lat, p.lng);
      return [round(lat), round(lng)];
    }),
  );
}

/** 同理，航点也要纠偏。 */
export function waypointsToMap(waypoints, decimals = 5) {
  const factor = 10 ** decimals;
  const round = (v) => Math.round(v * factor) / factor;

  return waypoints.map((w) => {
    const [lat, lng] = wgs84ToGcj02(w.lat, w.lng);
    return { name: w.name, lat: round(lat), lng: round(lng) };
  });
}

/* ------------------------------------------------------------------ */
/* GPX 写出                                                            */
/* ------------------------------------------------------------------ */

/**
 * 写出一份精简 GPX。保留 <time> 但只保留到秒，
 * 这样文件既能被其他软件读回去，体积又小。
 */
export function writeGpx(name, segments) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<gpx version="1.1" creator="MyWorld" xmlns="http://www.topografix.com/GPX/1/1">\n';
  out += `  <metadata><name>${esc(name)}</name></metadata>\n`;
  out += '  <trk>\n';
  out += `    <name>${esc(name)}</name>\n`;

  for (const seg of segments) {
    out += '    <trkseg>\n';
    for (const p of seg) {
      out += `      <trkpt lat="${p.lat}" lon="${p.lng}">`;
      if (typeof p.ele === 'number') out += `<ele>${Math.round(p.ele * 10) / 10}</ele>`;
      if (p.time) out += `<time>${p.time}</time>`;
      out += '</trkpt>\n';
    }
    out += '    </trkseg>\n';
  }

  out += '  </trk>\n</gpx>\n';
  return out;
}
