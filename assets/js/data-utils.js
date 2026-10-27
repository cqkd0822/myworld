/**
 * 数据加工 —— 把 data/ 下的原始数组变成视图能直接用的对象。
 *
 * 原则：原始数据文件保持和 Excel 一致的形态（好核对、好手改），
 * 所有推导（城市、里程、时长、状态）都放在这里算。
 */

(function () {
  const M = (window.MYWORLD = window.MYWORLD || {});

  /* ------------------------------------------------------------------ */
  /* 机场名解析                                                          */
  /* ------------------------------------------------------------------ */

  const CITY_KEYS = Object.keys(M.cityCoords || {}).sort((a, b) => b.length - a.length);
  const ALIAS_KEYS = Object.keys(M.stationCity || {}).sort((a, b) => b.length - a.length);

  /**
   * 「鄂尔多斯伊金霍洛T2」→ 城市 鄂尔多斯 / 机场 伊金霍洛 / 航站楼 T2
   *
   * 城市用**最长前缀匹配**而不是按字数切：中文机场名没有分隔符，
   * 而城市名长度从 2 到 5 字不等（北京 / 鄂尔多斯 / 乌鲁木齐），
   * 按固定字数切一定会切错。
   */
  function parseAirportName(raw) {
    const original = String(raw || '').trim();

    // 先把「（经停中卫沙坡头）」这类原始备注摘出来，它不属于机场名
    const noteMatch = original.match(/[（(]([^）)]*)[）)]\s*$/);
    const note = noteMatch ? noteMatch[1].trim() : '';
    let name = noteMatch ? original.slice(0, noteMatch.index).trim() : original;

    // 航站楼：T1 / T2 / T3 / T2B / T4
    let terminal = '';
    const tMatch = name.match(/(T\d[A-Z]?)$/i);
    if (tMatch) {
      terminal = tMatch[1].toUpperCase();
      name = name.slice(0, tMatch.index).trim();
    }

    let city = '';
    for (const key of CITY_KEYS) {
      if (name.startsWith(key)) {
        city = key;
        break;
      }
    }

    const airport = city ? name.slice(city.length) : name;

    return { raw: original, city: city || name, airport, terminal, note };
  }

  /**
   * 「汉口站」→ 城市 武汉 / 站名 汉口
   * 「南昌西站」→ 城市 南昌 / 站名 西
   *
   * 火车站名比机场名更不讲道理：有以城市命名的（南昌西），也有完全
   * 看不出归属的（汉口、沙坪坝、龙嘉、香港西九龙）。所以先查
   * airports.js 里的 stationCity 别名表，再退回城市最长前缀匹配。
   */
  function parseStationName(raw) {
    const original = String(raw || '').trim();
    // 掉尾缀「站」即可，「北/南/东/西」要留着——太湖南、武穴北本身就是区分信息
    const name = original.replace(/火车站$/, '').replace(/站$/, '');

    for (const key of ALIAS_KEYS) {
      if (name.startsWith(key)) {
        return { raw: original, city: M.stationCity[key], station: name.slice(key.length) };
      }
    }
    for (const key of CITY_KEYS) {
      if (name.startsWith(key)) {
        return { raw: original, city: key, station: name.slice(key.length) };
      }
    }
    return { raw: original, city: name, station: '' };
  }

  /** 两个城市之间的直线距离（公里）。没查到坐标返回 null。 */
  function cityDistanceKm(a, b) {    const p = M.cityCoords[a];
    const q = M.cityCoords[b];
    if (!p || !q) return null;

    const R = 6371.0088;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(q[0] - p[0]);
    const dLng = toRad(q[1] - p[1]);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(p[0])) * Math.cos(toRad(q[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* ------------------------------------------------------------------ */
  /* 时间                                                                */
  /* ------------------------------------------------------------------ */

  /** "00:43+1" → { minutes: 43, dayOffset: 1 }；"18:00" → { minutes: 1080, dayOffset: 0 } */
  function parseClock(str) {
    if (!str) return null;
    const m = String(str).match(/^(\d{1,2}):(\d{2})(\+(\d))?$/);
    if (!m) return null;
    return {
      hh: Number(m[1]),
      mm: Number(m[2]),
      minutes: Number(m[1]) * 60 + Number(m[2]),
      dayOffset: m[4] ? Number(m[4]) : 0,
      text: `${m[1].padStart(2, '0')}:${m[2]}`,
    };
  }

  /** 计划起飞 → 计划到达 的分钟数。跨日靠 dayOffset 补，不是靠"时间比大小"。 */
  function blockMinutes(std, sta) {
    const a = parseClock(std);
    const b = parseClock(sta);
    if (!a || !b) return null;
    const diff = b.minutes + b.dayOffset * 1440 - a.minutes;
    return diff > 0 ? diff : null;
  }

  function formatDuration(min) {
    if (min == null) return '';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h === 0) return `${m}分`;
    if (m === 0) return `${h}小时`;
    return `${h}小时${m}分`;
  }

  function formatSeconds(sec) {
    if (sec == null) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h === 0) return `${m} 分`;
    return `${h} 小时 ${String(m).padStart(2, '0')} 分`;
  }

  /** 配速：分钟/公里 */
  function paceMinPerKm(sec, km) {
    if (sec == null || !km) return null;
    const per = sec / 60 / km;
    // 平均慢于 60'/km（<1 km/h）基本意味着记录里含过夜或长停顿
    // （黄山跨年那条跨了 22.5 小时），这时「配速」是误导数字，
    // 返回 null 让页面改显示总用时
    if (per >= 60) return null;
    const m = Math.floor(per);
    const s = Math.round((per - m) * 60);
    return `${m}'${String(s).padStart(2, '0')}"`;
  }

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function parseDate(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      md: `${m[2]}-${m[3]}`,
      weekday: WEEKDAYS[d.getDay()],
      text: `${m[1]}-${m[2]}-${m[3]}`,
      short: `${Number(m[2])}月${Number(m[3])}日`,
    };
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes(),
    )}`;
  }

  /* ------------------------------------------------------------------ */
  /* 航班                                                               */
  /* ------------------------------------------------------------------ */

  const CABIN_NAMES = {
    F: '头等舱',
    A: '头等舱',
    C: '公务舱',
    D: '公务舱',
    J: '公务舱',
    W: '超级经济舱',
    G: '超级经济舱',
    Y: '经济舱',
  };

  /** 「经济舱(V)」→ 经济舱；「舱位A」→ A（原始表里这两行写法不规范，单独兜住） */
  function cabinLevel(text) {
    const s = String(text || '').trim();
    if (!s || s === '--') return '';
    const m = s.match(/^([^（(]+)/);
    return m ? m[1].trim() : s;
  }

  function buildFlights() {
    const rows = M.flights || [];

    const list = rows.map((r) => {
      const [
        id,
        dateRaw,
        airline,
        flightNo,
        fromRaw,
        toRaw,
        aircraft,
        reg,
        std,
        sta,
        ata,
        cabin,
        seat,
        price,
        delay,
        note,
      ] = r;

      const date = parseDate(dateRaw);
      const from = parseAirportName(fromRaw);
      const to = parseAirportName(toRaw);
      const dep = parseClock(std);
      const arrPlan = parseClock(sta);
      const arrAct = parseClock(ata);

      // 实际到达若跨日，日期也要跟着跨，否则「00:43+1」会被显示成当天
      let actualDate = dateRaw;
      if (arrAct && arrAct.dayOffset > 0 && date) {
        const d = new Date(date.year, date.month - 1, date.day + arrAct.dayOffset);
        const p = (n) => String(n).padStart(2, '0');
        actualDate = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      }

      return {
        id,
        raw: r,
        date,
        dateRaw,
        actualDate,
        airline,
        flightNo,
        from,
        to,
        aircraft,
        reg,
        std: dep,
        sta: arrPlan,
        ata: arrAct,
        cabin: cabinLevel(cabin),
        cabinRaw: cabin,
        seat,
        price: typeof price === 'number' ? price : null,
        delay: typeof delay === 'number' ? delay : null,
        note: note || '',
        distanceKm: cityDistanceKm(from.city, to.city),
        blockMin: blockMinutes(std, sta),
      };
    });

    return list.sort((a, b) => (a.dateRaw < b.dateRaw ? 1 : a.dateRaw > b.dateRaw ? -1 : b.id - a.id));
  }

  /** 延误状态：正数晚点、负数提前、0 准点 */
  function delayTag(flight) {
    const d = flight.delay;
    if (d == null) return { cls: 'tag--neutral', text: '无记录' };
    if (d > 0) return { cls: 'tag--warn', text: `晚点 ${d} 分` };
    if (d < 0) return { cls: 'tag--ok', text: `提前 ${-d} 分` };
    return { cls: 'tag--ok', text: '准点' };
  }

  /* ------------------------------------------------------------------ */
  /* 铁路                                                               */
  /* ------------------------------------------------------------------ */

  const TRAIN_KINDS = {
    G: { label: '高铁', cls: 'rail__no--g' },
    D: { label: '动车', cls: 'rail__no--d' },
    C: { label: '城际', cls: 'rail__no--c' },
    S: { label: '市郊', cls: 'rail__no--ktz' },
    Z: { label: '直达', cls: 'rail__no--ktz' },
    T: { label: '特快', cls: 'rail__no--ktz' },
    K: { label: '快速', cls: 'rail__no--ktz' },
    L: { label: '临客', cls: 'rail__no--ktz' },
    Y: { label: '旅游', cls: 'rail__no--ktz' },
  };

  /** 座位串是混合语义，这里只做粗分类，用于统计和图标 */
  function seatKind(seat) {
    const s = String(seat || '');
    if (!s || s === '—') return '未记录';
    if (s.includes('无座')) return '无座';
    if (s.includes('不对号')) return '不对号';
    if (s.includes('铺')) return '卧铺';
    if (/车.*[A-Za-z]号?$/.test(s) || /\d+[A-Z]$/.test(s)) return '坐票';
    return '坐票';
  }

  function buildRail() {
    const rows = M.rail || [];

    return rows
      .map((r) => {
        const [id, dateRaw, train, from, to, seat, note, depRaw, arrRaw] = r;
        const prefix = String(train || '').charAt(0).toUpperCase();
        const fromCity = parseStationName(from).city;
        const toCity = parseStationName(to).city;
        return {
          id,
          date: parseDate(dateRaw),
          dateRaw,
          train,
          kind: TRAIN_KINDS[prefix] || { label: '普速', cls: 'rail__no--ktz' },
          prefix,
          from,
          to,
          /* 航迹图用：站名 → 城市，以及城市间直线距离 */
          fromCity,
          toCity,
          distanceKm: cityDistanceKm(fromCity, toCity),
          seat,
          seatKind: seatKind(seat),
          note: note || '',
          /* 时刻可空。空就是「没记录」，不要当成 00:00 */
          dep: parseClock(depRaw),
          arr: parseClock(arrRaw),
        };
      })
      .sort((a, b) => (a.dateRaw < b.dateRaw ? 1 : a.dateRaw > b.dateRaw ? -1 : b.id - a.id));
  }

  /* ------------------------------------------------------------------ */
  /* 换乘归并                                                            */
  /* ------------------------------------------------------------------ */

  /** 中转窗口：前段到达 → 后段出发，60 分钟内算同一次出行 */
  const TRANSFER_WINDOW_MIN = 60;

  /** 日期 → 天序数，用来算跨零点的绝对分钟 */
  function dayOrdinal(d) {
    return d ? Math.round(Date.UTC(d.year, d.month - 1, d.day) / 86400000) : null;
  }

  /** 时刻 → 绝对分钟（含跨日偏移）。日期或时刻缺一就没有意义，返回 null。 */
  function clockAbs(date, clock) {
    const day = dayOrdinal(date);
    if (day == null || !clock) return null;
    return day * 1440 + clock.minutes + (clock.dayOffset || 0) * 1440;
  }

  /**
   * a 能不能接上 b，返回 link 描述或 null。
   *
   * 三种情形：
   *   1. 同车次、且前段到达站 == 后段出发站 → 分段购票，不是换乘；
   *   2. 两端都有时刻 → 严格按 0~60 分钟判定（跨零点由绝对分钟自然处理），
   *      同城异站也认——有时刻就是事实；
   *   3. 缺时刻 → 只推定「同日 + 同城 + 同站」；异站不推定，因为分不清
   *      「赶去另一个站」和「在那座城玩到晚上」（T172/D583 就是后者）。
   */
  function railLink(a, b) {
    if (!a || !b || a === b) return null;
    if (!a.toCity || a.toCity !== b.fromCity) return null;

    const sameStation = a.to === b.from;
    const sameTrain = String(a.train) === String(b.train) && sameStation;

    const arrAbs = clockAbs(a.date, a.arr);
    const depAbs = clockAbs(b.date, b.dep);

    if (arrAbs != null && depAbs != null) {
      const gap = depAbs - arrAbs;
      // gap < 0：后段在时间上早于前段，说明录入有误，不连
      if (gap < 0 || gap > TRANSFER_WINDOW_MIN) return null;
      return { gap, sameStation, sameTrain, precise: true };
    }

    // 缺时刻：只有同站接续才推定（同车次必然同站，已在 sameTrain 里）
    if (!sameStation) return null;
    const da = dayOrdinal(a.date);
    const db = dayOrdinal(b.date);
    if (da == null || db == null || da !== db) return null;
    return { gap: null, sameStation, sameTrain, precise: false };
  }

  /**
   * 铁路段 → 出行（trip）。
   *
   * 不能「按顺序扫相邻两条」：id 是录入顺序，不保证是行程顺序
   * （2025-11-14 的 T172 比它前面的 D583 晚录入，实际却后发）。
   * 这里建图做一对一贪心匹配：每段最多一个前驱、一个后继，
   * 天然排除「深圳北→广州东 / 深圳北→广州南」这种同起点替代票。
   */
  function buildRailTrips(list) {
    const items = list.slice();
    const edges = [];

    for (const a of items) {
      for (const b of items) {
        const link = railLink(a, b);
        if (!link) continue;
        // 有时刻的优先（信息确定），再按间隔短的优先，最后按 id 稳定排序
        edges.push({ a, b, link, score: link.precise ? link.gap : 10000 });
      }
    }
    edges.sort((x, y) => x.score - y.score || x.a.id - y.a.id || x.b.id - y.b.id);

    const next = new Map(); // a.id → { b, link }
    const prev = new Map(); // b.id → a.id
    for (const e of edges) {
      if (next.has(e.a.id) || prev.has(e.b.id)) continue;
      next.set(e.a.id, { b: e.b, link: e.link });
      prev.set(e.b.id, e.a.id);
    }

    // 链头 = 没有前驱的段，顺着 next 走到底就是一次出行
    const ordered = items.slice().sort((x, y) => {
      const kx = (dayOrdinal(x.date) ?? 9e9) * 100000 + (x.dep ? x.dep.minutes : 720) * 100 + x.id;
      const ky = (dayOrdinal(y.date) ?? 9e9) * 100000 + (y.dep ? y.dep.minutes : 720) * 100 + y.id;
      return kx - ky;
    });

    const trips = [];
    const seen = new Set();
    for (const head of ordered) {
      if (prev.has(head.id) || seen.has(head.id)) continue;
      const legs = [];
      const links = [];
      let cur = head;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        legs.push(cur);
        const nx = next.get(cur.id);
        if (!nx) break;
        links.push(nx.link);
        cur = nx.b;
      }
      trips.push(makeTrip(legs, links));
    }

    // 理论上没有环；真出现了也不能把段丢掉
    for (const r of items) if (!seen.has(r.id)) trips.push(makeTrip([r], []));

    trips.sort((a, b) =>
      a.dateRaw < b.dateRaw ? 1 : a.dateRaw > b.dateRaw ? -1 : a.legs[0].id - b.legs[0].id,
    );
    return trips;
  }

  function makeTrip(legs, links) {
    const first = legs[0];
    const last = legs[legs.length - 1];
    return {
      date: first.date,
      dateRaw: first.dateRaw,
      legs,
      links,
      /* 主行程：首段起点 → 末段终点 */
      fromStation: first.from,
      toStation: last.to,
      fromCity: first.fromCity,
      toCity: last.toCity,
      /* 同车分段买票，不算一次换乘 */
      transfers: links.filter((l) => !l.sameTrain).length,
      /* 只要有一处靠推定，整卡就标「时刻未记录」 */
      precise: links.length > 0 && links.every((l) => l.precise),
      waitMin: links.reduce((s, l) => s + (l.gap || 0), 0),
    };
  }

  function buildVoided() {
    return (M.railVoided || []).map((r) => ({
      train: r[0],
      from: r[1],
      to: r[2],
      dateRaw: r[3],
      reason: r[4],
      date: parseDate(r[3]),
    }));
  }

  /* ------------------------------------------------------------------ */
  /* 汇总统计                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 轨迹 → 城市：先按名字最长前缀匹配城市词典，再退回 region 的「省 · 市」。
   *
   * 有些轨迹名字和 region 都不是城市名（徽杭古道跨绩溪→杭州、武功山是景区名），
   * 这里单独指认；绩溪属宣城，武功山这段是萍乡进宜春出，记常规起点萍乡。
   */
  const TRACK_CITY_ALIAS = {
    徽杭古道: '宣城',
    武功山: '萍乡',
  };

  function trackCity(t) {
    const parts = String(t.region || '').split('·').map((x) => x.trim());
    for (const src of [t.name, parts[1], parts[0]]) {
      const v = String(src || '');
      for (const key of CITY_KEYS) if (v.startsWith(key)) return key;
      for (const key of Object.keys(TRACK_CITY_ALIAS)) if (v.includes(key)) return TRACK_CITY_ALIAS[key];
    }
    return null;
  }

  function computeOverview(flights, rails, tracks) {
    const fareList = flights.filter((f) => f.price != null);
    const fareSum = fareList.reduce((s, f) => s + f.price, 0);
    const distanceSum = flights.reduce((s, f) => s + (f.distanceKm || 0), 0);

    const cities = new Set();
    flights.forEach((f) => {
      cities.add(f.from.city);
      cities.add(f.to.city);
    });

    const airlines = new Map();
    flights.forEach((f) => airlines.set(f.airline, (airlines.get(f.airline) || 0) + 1));

    // 航线热度：把「A→B」和「B→A」算作同一条航线，否则往返会被拆成两条
    const routes = new Map();
    flights.forEach((f) => {
      const key = [f.from.city, f.to.city].sort().join(' ⇄ ');
      routes.set(key, (routes.get(key) || 0) + 1);
    });

    // 游历城市：航班 + 铁路 + 徒步三源并集，按到访次数排序
    const cityStats = new Map();
    const bump = (city, src) => {
      if (!city) return;
      const o = cityStats.get(city) || { rail: 0, flight: 0, track: 0 };
      o[src] += 1;
      cityStats.set(city, o);
    };
    flights.forEach((f) => { bump(f.from.city, 'flight'); bump(f.to.city, 'flight'); });
    rails.forEach((r) => { bump(r.fromCity, 'rail'); bump(r.toCity, 'rail'); });
    tracks.forEach((t) => bump(trackCity(t), 'track'));
    const citiesAll = [...cityStats.entries()]
      .map(([city, o]) => [city, o.rail + o.flight + o.track, o])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));

    const withDelay = flights.filter((f) => f.delay != null);
    // 准点率全站统一 A15 口径：到达不晚于计划 +15 分钟（民航业通用）
    const onTime = withDelay.filter((f) => f.delay <= 15).length;
    const stationCount = new Set();
    rails.forEach((r) => {
      stationCount.add(r.from);
      stationCount.add(r.to);
    });

    const flightsByYear = new Map();
    flights.forEach((f) => {
      if (f.date) flightsByYear.set(f.date.year, (flightsByYear.get(f.date.year) || 0) + 1);
    });
    const railsByYear = new Map();
    rails.forEach((r) => {
      if (r.date) railsByYear.set(r.date.year, (railsByYear.get(r.date.year) || 0) + 1);
    });

    const years = [...new Set([...flightsByYear.keys(), ...railsByYear.keys()])].sort();

    return {
      flightCount: flights.length,
      railCount: rails.length,
      trackCount: tracks.length,
      distanceSum,
      fareSum,
      fareCount: fareList.length,
      fareAvg: fareList.length ? fareSum / fareList.length : 0,
      cities: [...cities].sort(),
      citiesAll,
      cityStats,
      airlines: [...airlines.entries()].sort((a, b) => b[1] - a[1]),
      routes: [...routes.entries()].sort((a, b) => b[1] - a[1]),
      onTime,
      delayed: withDelay.length - onTime,
      onTimeRate: withDelay.length ? onTime / withDelay.length : 0,
      delayKnown: withDelay.length,
      stationCount: stationCount.size,
      maxDelay: flights.reduce((m, f) => Math.max(m, f.delay || 0), 0),
      longest: flights
        .filter((f) => f.distanceKm)
        .sort((a, b) => b.distanceKm - a.distanceKm)[0],
      pricey: fareList.sort((a, b) => b.price - a.price)[0],
      firstDate: [
        ...flights.map((f) => f.dateRaw),
        ...rails.map((r) => r.dateRaw),
        ...tracks.map((t) => t.date),
      ]
        .filter(Boolean)
        .sort()[0] || null,
      lastDate: [
        ...flights.map((f) => f.dateRaw),
        ...rails.map((r) => r.dateRaw),
        ...tracks.map((t) => t.date),
      ]
        .filter(Boolean)
        .sort()
        .pop() || null,
      flightsByYear,
      railsByYear,
      years,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 足迹地图（城市点到点）                                              */
  /* ------------------------------------------------------------------ */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  M.util = {
    parseAirportName,
    parseStationName,
    cityDistanceKm,
    parseClock,
    blockMinutes,
    formatDuration,
    formatSeconds,
    paceMinPerKm,
    parseDate,
    formatDateTime,
    buildFlights,
    buildRail,
    buildRailTrips,
    buildVoided,
    delayTag,
    seatKind,
    computeOverview,
    escapeHtml,
    formatNumber: (n, d = 0) =>
      Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }),
  };
})();
