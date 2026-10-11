/**
 * 统计视图 —— 航旅纵横风格的深色统计页。
 *
 * 设计原则（对照航旅纵横截图逐条学来的）：
 * - 数字永远是主角：大字 + 小标签，别用图标和装饰去抢戏
 * - 一屏一个信息重心：先给总量的「数字墙」，再给「之最」，最后才是分布图
 * - 排行榜只给 TOP 几名，条形是细渐变条不是色块
 * - 曲线要平滑、带面积填充，顶点上标数字，不要坐标轴和网格线
 *
 * 全部输出 HTML 字符串，无依赖、无图表库。
 */

(function () {
  const M = window.MYWORLD || {};
  const U = M.util;
  if (!U) return;

  const esc = U.escapeHtml;

  /* ------------------------------------------------------------------ */
  /* 通用部件                                                            */
  /* ------------------------------------------------------------------ */

  /** 数字墙：一行 2~4 个大数字卡 */
  function kpiRow(cards) {
    return `<div class="st-kpis">${cards
      .map(
        (c) => `<div class="st-kpi">
      <div class="st-kpi__label">${esc(c.label)}</div>
      <div class="st-kpi__num">${c.num}</div>
      ${c.sub ? `<div class="st-kpi__sub">${c.sub}</div>` : ''}
    </div>`,
      )
      .join('')}</div>`;
  }

  /**
   * 排行榜：TOP1/2/3 彩色名次 + 细渐变条。
   * rows: [{ name, count, extra? }]
   */
  const RANK_COLORS = ['#3ddc97', '#38bdf8', '#c084fc'];

  /** 百分比钳在 4~96，两端的数字标签才不会探出卡片 */
  function clampPct(p) {
    return Math.min(96, Math.max(4, p));
  }

  /**
   * 曲线首尾标签的定位。中间点居中，但首点左对齐、末点右对齐——
   * 全部居中的话末两个点会被 clampPct 挤到同一个位置，
   * 「2025」「2026」就叠成一个词了（实测截图复现过）。
   */
  function edgeAlign(i, n, pct) {
    if (n > 1 && i === 0) return 'left:0%;transform:none';
    if (n > 1 && i === n - 1) return 'left:100%;transform:translateX(-100%)';
    return `left:${clampPct(pct)}%`;
  }

  function rankBars(rows, { unit = '次', max = null } = {}) {
    const top = rows.slice(0, 10);
    const maxV = max || Math.max(1, ...top.map((r) => r.count));
    return `<div class="st-rank">${top
      .map((r, i) => {
        const medal = i < 3 ? `<i class="st-rank__top st-rank__top--${i + 1}">TOP${i + 1}</i>` : `<i class="st-rank__idx">${i + 1}</i>`;
        const w = Math.max(4, Math.round((r.count / maxV) * 100));
        return `<div class="st-rank__row">
      <div class="st-rank__head">${medal}<span class="st-rank__name">${esc(r.name)}</span><span class="st-rank__n">${r.count} ${esc(unit)}</span></div>
      <div class="st-rank__track"><div class="st-rank__bar" style="width:${w}%"></div></div>
    </div>`;
      })
      .join('')}</div>`;
  }

  /**
   * 平滑曲线 + 面积。pts: [{label, value}]。
   * 用 Catmull-Rom 转三次贝塞尔，出来的曲线和航旅纵横那种「肉感」一致。
   *
   * 线和面积走 SVG（preserveAspectRatio=none + non-scaling-stroke，缩放不糊）；
   * 数字和 x 轴标签走 HTML 覆盖层——SVG 文字在横向压缩下会变形，踩过这个坑。
   */
  function smoothCurve(pts, { h = 132, color = '#3ddc97' } = {}) {
    const W = 640;
    const padX = 22, padTop = 30, padBot = 26;
    const maxV = Math.max(1, ...pts.map((p) => p.value));
    const step = (W - padX * 2) / Math.max(1, pts.length - 1);
    const X = (i) => padX + i * step;
    const Y = (v) => padTop + (1 - v / maxV) * (h - padTop - padBot);

    const xy = pts.map((p, i) => [X(i), Y(p.value)]);

    // Catmull-Rom → bezier
    let d = `M ${xy[0][0]} ${xy[0][1]}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[Math.max(0, i - 1)], p1 = xy[i], p2 = xy[i + 1], p3 = xy[Math.min(xy.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    const area = d + ` L ${xy[xy.length - 1][0]} ${h - padBot} L ${xy[0][0]} ${h - padBot} Z`;

    const dots = xy
      .map(
        ([x, y], i) => `<span class="st-curve__dot" style="left:${(x / W) * 100}%;top:${y.toFixed(1)}px;border-color:${color}"></span><span class="st-curve__num" style="${edgeAlign(i, pts.length, (x / W) * 100)};top:${(y - 22).toFixed(1)}px">${pts[i].value}</span>`,
      )
      .join('');
    const labels = xy
      .map(
        ([x], i) => `<span class="st-curve__x" style="${edgeAlign(i, pts.length, (x / W) * 100)}">${esc(pts[i].label)}</span>`,
      )
      .join('');

    const gid = 'sg' + Math.random().toString(36).slice(2, 7);
    return `<div class="st-curve" style="height:${h}px">
    <svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${color}" stop-opacity="0.30"/>
          <stop offset="1" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>
    ${dots}${labels}
  </div>`;
  }

  /**
   * 等宽柱状图 —— 24 小时出发时刻和 12 个月分布共用。
   * 行内小图，不要坐标轴；只把峰值单独染色，让「几点出发」「哪个月在山里」
   * 一眼就有答案，其余柱子退成背景。variant 只换色，不改骨架。
   */
  function colBars(values, labels, { variant = '' } = {}) {
    const max = Math.max(1, ...values);
    const peak = values.indexOf(max);
    const bars = values
      .map((v, i) => {
        const hp = Math.max(v ? 6 : 2, Math.round((v / max) * 100));
        const isPeak = i === peak && v > 0;
        return `<div class="st-hours__col" title="${esc(labels[i])} · ${v}">
      <div class="st-hours__bar${isPeak ? ' is-peak' : ''}" style="height:${hp}%"></div>
      <span class="st-hours__h${isPeak ? ' is-peak' : ''}">${esc(labels[i])}</span>
    </div>`;
      })
      .join('');
    return `<div class="st-hours${variant ? ' ' + variant : ''}">${bars}</div>`;
  }

  /** 24 小时出发柱状 */
  function hourBars(hours) {
    return colBars(hours, hours.map((_, h) => String(h)));
  }

  /** 区间分布横条（车型 / 座位这类「类别占比」） */
  function shareBars(rows, { unit = '次' } = {}) {
    const maxV = Math.max(1, ...rows.map((r) => r.count));
    const total = rows.reduce((s, r) => s + r.count, 0) || 1;
    return `<div class="st-share">${rows
      .map(
        (r) => `<div class="st-share__row">
      <span class="st-share__name">${esc(r.name)}</span>
      <div class="st-share__track"><div class="st-share__bar" style="width:${Math.max(3, Math.round((r.count / maxV) * 100))}%"></div></div>
      <span class="st-share__n">${r.count} ${esc(unit)}<i>${Math.round((r.count / total) * 100)}%</i></span>
    </div>`,
      )
      .join('')}</div>`;
  }

  /** 「之最」双卡：左常用右最多，右上角带 pill 标签 */
  function duoCard(left, right) {
    const one = (c) => `<div class="st-duo__card">
      <div class="st-duo__top"><span>${esc(c.label)}</span>${c.pill ? `<i class="st-pill">${esc(c.pill)}</i>` : ''}</div>
      <div class="st-duo__big">${c.big}</div>
      <div class="st-duo__sub">${c.sub || ''}</div>
    </div>`;
    return `<div class="st-duo">${one(left)}${one(right)}</div>`;
  }

  function section(title, hint, body) {
    return `<div class="st-sec">
    <div class="st-sec__head"><h2>${esc(title)}</h2>${hint ? `<span>${esc(hint)}</span>` : ''}</div>
    <div class="st-sec__body">${body}</div>
  </div>`;
  }

  /** 年度序列 → 曲线数据。中间缺的年份补 0：那年确实一次没坐，跳过它
      会让横轴失真（2023 和 2025 挨在一起，看不出隔了一年）。 */
  function yearSeries(byYearMap) {
    const years = [...byYearMap.keys()].sort((a, b) => a - b);
    if (!years.length) return [];
    const pts = [];
    for (let y = years[0]; y <= years[years.length - 1]; y++) {
      pts.push({ label: String(y), value: byYearMap.get(y) || 0 });
    }
    return pts;
  }

  /** 紧凑时长：5h17m —— st-inline 的卡片窄，「5 小时 17 分」会把卡片撑破 */
  function shortDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h ? `${h}h${m ? m + 'm' : ''}` : `${m}m`;
  }

  /* ------------------------------------------------------------------ */
  /* 飞行                                                                */
  /* ------------------------------------------------------------------ */

  /** 机型归并：737-89L(WL) 这种子型号对统计毫无意义，归到主流型号 */
  function normAircraft(k) {
    let s = String(k || '').replace(/[（(]/g, '(').replace(/[）)]/g, '');
    let m;
    if ((m = s.match(/^空客A?(319|320|321)(?!.*NEO)/i))) return '空客' + m[1] + '系列';
    if (/空客A?320/i.test(s) && /NEO/i.test(s)) return '空客320NEO系列';
    if (/空客A?321/i.test(s) && /NEO/i.test(s)) return '空客321NEO系列';
    if ((m = s.match(/^空客A?(330|350)/i))) return '空客' + m[1] + '系列';
    if (/波音737.*7\d\d|737-7/.test(s)) return '波音737-700';
    if (/波音737 MAX/i.test(s)) return '波音737 MAX 8';
    if (/737.*8\d\d|737-8/.test(s)) return '波音737-800';
    if ((m = s.match(/^波音(777|787)/))) return '波音' + m[1] + '系列';
    return s;
  }

  function builder(list) {
    const byYear = new Map();
    const airlines = new Map();
    const aircraft = new Map();
    const routes = new Map();
    const airports = new Map();
    const hours = Array(24).fill(0);
    const cities = new Set();
    let km = 0, onTime = 0, delayKnown = 0, fare = 0, fareN = 0, blockMin = 0;

    for (const f of list) {
      const y = f.date && f.date.year;
      if (y) byYear.set(y, (byYear.get(y) || 0) + 1);
      airlines.set(f.airline, (airlines.get(f.airline) || 0) + 1);
      const ac = normAircraft(f.aircraft);
      aircraft.set(ac, (aircraft.get(ac) || 0) + 1);
      const routeKey = [f.from.city, f.to.city].sort().join('—');
      routes.set(routeKey, (routes.get(routeKey) || 0) + 1);
      airports.set(f.from.airport, (airports.get(f.from.airport) || 0) + 1);
      airports.set(f.to.airport, (airports.get(f.to.airport) || 0) + 1);
      if (f.std) hours[f.std.hh] += 1;
      cities.add(f.from.city);
      cities.add(f.to.city);
      km += f.distanceKm || 0;
      if (f.delay != null) {
        delayKnown += 1;
        if (f.delay <= 15) onTime += 1;
      }
      if (f.price != null) {
        fare += f.price;
        fareN += 1;
      }
      if (f.blockMin) blockMin += f.blockMin;
    }

    return { byYear, airlines, aircraft, routes, airports, hours, cities, km, onTime, delayKnown, fare, fareN, blockMin };
  }

  function flightView(list, overview) {
    const s = builder(list);
    const topAirports = [...s.airports.entries()].sort((a, b) => b[1] - a[1]);
    const topRoutes = [...s.routes.entries()].sort((a, b) => b[1] - a[1]);
    const acRank = [...s.aircraft.entries()].sort((a, b) => b[1] - a[1]);
    const alRank = [...s.airlines.entries()].sort((a, b) => b[1] - a[1]);

    // 厂商徽章：空客 / 波音 / 商飞 / 其他
    let airbus = 0, boeing = 0, comac = 0, other = 0;
    for (const [k, n] of s.aircraft) {
      if (k.startsWith('空客')) airbus += n;
      else if (k.startsWith('波音')) boeing += n;
      else if (/商飞|ARJ|C919/.test(k)) comac += n;
      else other += n;
    }
    const makers = [
      { name: '空客', n: airbus },
      { name: '波音', n: boeing },
      { name: '商飞', n: comac },
      { name: '其他', n: other },
    ].filter((m) => m.n > 0);

    const hoursTotal = Math.round(s.blockMin / 60);

    const html = [];

    html.push(
      kpiRow([
        { label: '城市', num: s.cities.size, sub: '座' },
        { label: '机场', num: s.airports.size, sub: '个' },
        { label: '航线', num: s.routes.size, sub: '条' },
      ]),
    );

    html.push(
      duoCard(
        {
          label: '机场',
          pill: '去得最多',
          big: esc(topAirports[0] ? topAirports[0][0] : '—'),
          sub: topAirports[0] ? `${topAirports[0][1]} 次起降` : '',
        },
        {
          label: '航线',
          pill: '飞得最多',
          big: esc(topRoutes[0] ? topRoutes[0][0].replace('—', ' – ') : '—'),
          sub: topRoutes[0] ? `${topRoutes[0][1]} 次往返` : '',
        },
      ),
    );

    // 第二排小数字：里程 / 空中时间 / 准点率
    html.push(
      `<div class="st-inline">
      <div><b>${(s.km / 10000).toFixed(1)}<i>万</i></b><span>公里<br>约绕地球 ${(s.km / 40075).toFixed(1)} 圈</span></div>
      <div><b>${hoursTotal}<i>h</i></b><span>空中时间<br>纯飞行时长合计</span></div>
      <div><b>${s.delayKnown ? Math.round((s.onTime / s.delayKnown) * 100) : '--'}<i>%</i></b><span>准点率（宽松）<br>${s.onTime}/${s.delayKnown} 段 ≤15 分</span></div>
    </div>`,
    );

    if (s.byYear.size > 1) {
      html.push(section('飞行日历', `${list.length} 段 · 按年`, smoothCurve(yearSeries(s.byYear), { h: 138 })));
    }

    html.push(
      section('机型排行榜', `共 ${s.aircraft.size} 种机型`, `
      <div class="st-makers">${makers
        .map(
          (m) => `<div class="st-maker"><i>${esc(m.name.slice(0, 2))}</i><span>${esc(m.name)}</span><b>${m.n}</b></div>`,
        )
        .join('')}</div>
      ${rankBars(acRank.map(([name, count]) => ({ name, count })))}`),
    );

    html.push(section('搭乘客司', `共 ${s.airlines.size} 家`, rankBars(alRank.map(([name, count]) => ({ name, count })))));

    html.push(section('出发时刻', '偏爱几点起飞', hourBars(s.hours)));

    if (overview) {
      html.push(
        section('票价与舱位', '', `
      <div class="st-inline st-inline--tight">
        <div><b>¥${U.formatNumber(s.fare)}</b><span>票价合计<br>${s.fareN} 段有记录</span></div>
        <div><b>¥${U.formatNumber(Math.round(s.fare / Math.max(1, s.fareN)))}</b><span>平均票价<br>有记录段的均值</span></div>
        <div><b>${list.filter((f) => f.cabin === '经济舱').length}</b><span>经济舱<br>占比 ${Math.round((list.filter((f) => f.cabin === '经济舱').length / list.length) * 100)}%</span></div>
      </div>`),
      );
    }

    return `<div class="st-page">${html.join('')}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 铁路                                                                */
  /* ------------------------------------------------------------------ */

  function railView(list) {
    const byYear = new Map();
    const kinds = new Map();
    const seats = new Map();
    const segs = new Map();
    const trains = new Map();
    const cities = new Set();
    const stations = new Set();
    let km = 0;

    for (const r of list) {
      const y = r.date && r.date.year;
      if (y) byYear.set(y, (byYear.get(y) || 0) + 1);
      kinds.set(r.kind.label, (kinds.get(r.kind.label) || 0) + 1);
      seats.set(r.seatKind, (seats.get(r.seatKind) || 0) + 1);
      const key = [r.fromCity, r.toCity].sort().join('—');
      segs.set(key, (segs.get(key) || 0) + 1);
      trains.set(r.train, (trains.get(r.train) || 0) + 1);
      cities.add(r.fromCity);
      cities.add(r.toCity);
      stations.add(r.from);
      stations.add(r.to);
      km += r.distanceKm || 0;
    }

    const topSegs = [...segs.entries()].sort((a, b) => b[1] - a[1]);
    const topTrains = [...trains.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 1);
    const KIND_ORDER = ['高铁', '动车', '城际', '普速', '直达', '特快'];
    const kindRows = KIND_ORDER.filter((k) => kinds.has(k)).map((k) => ({ name: k, count: kinds.get(k) }));

    const html = [];

    html.push(
      kpiRow([
        { label: '城市', num: cities.size, sub: '座' },
        { label: '车站', num: stations.size, sub: '个' },
        { label: '区间', num: segs.size, sub: '条' },
      ]),
    );

    html.push(
      duoCard(
        {
          label: '区间',
          pill: '走得最勤',
          big: esc(topSegs[0] ? topSegs[0][0].replace('—', ' – ') : '—'),
          sub: topSegs[0] ? `${topSegs[0][1]} 次往返` : '',
        },
        {
          label: '车次',
          pill: '常坐',
          big: esc(topTrains[0] ? topTrains[0][0] : topTrains.length ? '—' : '—'),
          sub: topTrains[0] ? `${topTrains[0][1]} 次 · 同车次复购` : '还没有坐重过的车次',
        },
      ),
    );

    html.push(
      `<div class="st-inline">
      <div><b>${(km / 10000).toFixed(1)}<i>万</i></b><span>公里<br>铁路里程合计</span></div>
      <div><b>${list.length}</b><span>段行程<br>${list.filter((r) => r.prefix === 'G').length} 段高铁</span></div>
      <div><b>${Math.max(...[...byYear.values()])}</b><span>单年峰值<br>${[...byYear.entries()].sort((a, b) => b[1] - a[1])[0][0]} 年</span></div>
    </div>`,
    );

    const yearPts = yearSeries(byYear);
    if (yearPts.length >= 3) {
      // 年份够多才有「趋势」可言，两年数据画出来是条无意义的平线
      html.push(section('铁路日历', `${list.length} 段 · 按年`, smoothCurve(yearPts, { h: 138, color: '#3fd6c5' })));
    } else if (yearPts.length === 2) {
      const [a, b] = yearPts;
      html.push(
        duoCard(
          { label: a.label + ' 年', pill: '起点', big: `${a.value} 段`, sub: '' },
          { label: b.label + ' 年', pill: '最近', big: `${b.value} 段`, sub: '' },
        ),
      );
    }

    html.push(section('车型构成', '高铁为主', shareBars(kindRows)));
    // 「未记录」垫底：它不是一种坐席，排在前面只会占住最显眼的位置
    const seatRows = [...seats.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (/未记录/.test(a.name) ? 1 : /未记录/.test(b.name) ? -1 : b.count - a.count));
    html.push(section('坐席偏好', '', shareBars(seatRows)));

    return `<div class="st-page">${html.join('')}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 足迹                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * ITRA 成绩卡。P.I. 之间只差几十点，画成等宽条全长一个样，还不如把数字排开——
   * 一行赛事名 + 右对齐的 P.I. 大数字，下面一行元信息。像成绩单，不像图表。
   */
  function itraBoard(rows) {
    return `<div class="st-itra">${rows
      .map((t) => {
        const i = t.itra;
        const meta = [
          `积分 ${i.points == null ? '—' : i.points}`,
          `等强配速 ${i.equivPace}`,
          `总排名 ${i.overall}`,
          `年龄组 ${i.ageRank}`,
          i.mountain == null ? '' : `山地 ${i.mountain}`,
        ].filter(Boolean);
        return `<div class="st-itra__row">
      <div class="st-itra__top">
        <span class="st-itra__name">${esc(t.name)}</span>
        <span class="st-itra__pi">P.I.<b>${i.perf}</b></span>
      </div>
      <div class="st-itra__meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
    </div>`;
      })
      .join('')}</div>`;
  }

  /** region 形如「浙江 · 杭州」「香港」「皖浙 · 徽杭古道」，取省级那段 */
  function provinceOf(region) {
    const p = String(region || '').split('·')[0].trim();
    return p || '未标注';
  }

  /** 单次最高海拔的分档。比「平均海拔」更能说明这一天到底有没有上山。 */
  const ELE_BANDS = [
    { below: 300, label: '300 m 以下' },
    { below: 1000, label: '300 – 1000 m' },
    { below: 2000, label: '1000 – 2000 m' },
    { below: 3000, label: '2000 – 3000 m' },
    { below: Infinity, label: '3000 m 以上' },
  ];

  function trackView(tracks) {
    if (!tracks.length) return '<div class="st-page"><div class="st-empty">还没有轨迹</div></div>';

    let km = 0, up = 0, dn = 0, sec = 0, movingSec = 0, movingKm = 0;
    let maxEle = 0, minEle = Infinity;
    const byMonth = Array(12).fill(0);
    const byYear = new Map();
    const byProvince = new Map();
    const bands = ELE_BANDS.map(() => 0);
    const kinds = { hike: { n: 0, km: 0, up: 0 }, run: { n: 0, km: 0, up: 0 } };

    for (const t of tracks) {
      const s = t.stats;
      km += s.distanceKm;
      up += s.ascentM;
      dn += s.descentM || 0;
      if (s.durationSec) sec += s.durationSec;
      movingSec += s.movingTimeSec || 0;
      movingKm += s.movingDistanceKm || 0;
      maxEle = Math.max(maxEle, s.maxEle);
      minEle = Math.min(minEle, s.minEle);

      const mi = Number(String(t.date).slice(5, 7)) - 1;
      if (mi >= 0 && mi < 12) byMonth[mi] += 1;

      const y = String(t.date).slice(0, 4);
      const yv = byYear.get(y) || { n: 0, km: 0 };
      yv.n += 1;
      yv.km += s.distanceKm;
      byYear.set(y, yv);

      const p = provinceOf(t.region);
      byProvince.set(p, (byProvince.get(p) || 0) + 1);

      // 落在第一个「最高海拔 < 阈值」的档里；比最高档还高就归最后一档
      let bi = ELE_BANDS.findIndex((b) => s.maxEle < b.below);
      if (bi < 0) bi = ELE_BANDS.length - 1;
      bands[bi] += 1;

      // race（完赛比赛）和 run 在本站是同一类，口径跟列表页的 chip 对齐
      const k = t.kind === 'race' || t.kind === 'run' ? 'run' : 'hike';
      kinds[k].n += 1;
      kinds[k].km += s.distanceKm;
      kinds[k].up += s.ascentM;
    }

    const html = [];
    const yearText = [...byYear.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([y, v]) => `${y} 年 ${v.n} 条`)
      .join(' · ');

    // 总量级的时间别带分钟：「373h2m」既难读又把卡片撑破，三位数的小时就地取整
    const dur = (s) => (s >= 100 * 3600 ? `${Math.floor(s / 3600)}h` : shortDuration(s));

    /* 一、数字墙：总量三件套 */
    html.push(
      kpiRow([
        { label: '轨迹', num: tracks.length, sub: '条' },
        { label: '累计爬升', num: U.formatNumber(up), sub: '米' },
        { label: '最高海拔', num: U.formatNumber(maxEle), sub: '米' },
      ]),
    );

    /* 二、第二排小数字：里程 / 时长 / 珠峰 */
    html.push(
      `<div class="st-inline">
      <div><b>${km.toFixed(1)}<i>km</i></b><span>累计距离<br>平均每条 ${(km / tracks.length).toFixed(1)} km</span></div>
      <div><b>${sec ? dur(sec) : '—'}</b><span>累计时长<br>移动 ${movingSec ? dur(movingSec) : '—'}${
        movingSec ? ` · ${(movingKm / (movingSec / 3600)).toFixed(1)} km/h` : ''
      }</span></div>
      <div><b>${(up / 8849).toFixed(1)}<i>×</i></b><span>相当于<br>爬了 ${(up / 8849).toFixed(1)} 座珠峰</span></div>
    </div>`,
    );

    /* 三、之最：两条记录各自的极值 */
    const longest = tracks.reduce((a, b) => (b.stats.distanceKm > a.stats.distanceKm ? b : a));
    const climbiest = tracks.reduce((a, b) => (b.stats.ascentM > a.stats.ascentM ? b : a));
    const md = (d) => String(d).slice(5).replace('-', '/');

    html.push(
      duoCard(
        {
          label: '最长一次',
          pill: md(longest.date),
          big: esc(longest.name),
          sub: `${longest.stats.distanceKm} km · 爬升 ${U.formatNumber(longest.stats.ascentM)} m`,
        },
        {
          label: '爬升最多',
          pill: md(climbiest.date),
          big: esc(climbiest.name),
          sub: `${U.formatNumber(climbiest.stats.ascentM)} m · ${climbiest.stats.distanceKm} km`,
        },
      ),
    );

    /* 四、月度分布：一年里哪几个月在山里 */
    html.push(
      section(
        '月度分布',
        yearText,
        colBars(byMonth, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], {
          variant: 'st-hours--month',
        }),
      ),
    );

    /* 五、运动构成：徒步 vs 越野跑（42px 的窄名列放不下长标签，距离爬升放 hint 里讲） */
    const kindRows = [
      { name: '徒步', count: kinds.hike.n },
      { name: '越野跑', count: kinds.run.n },
    ].filter((r) => r.count > 0);

    html.push(
      section(
        '运动构成',
        `徒步 ${Math.round(kinds.hike.km)} km · 越野跑 ${Math.round(kinds.run.km)} km`,
        shareBars(kindRows, { unit: '条' }),
      ),
    );

    /* 六、爬升密度：越野跑者真正在意的指标——每公里要爬多少米 */
    const density = tracks
      .map((t) => ({ name: t.name, count: Math.round(t.stats.ascentM / Math.max(0.1, t.stats.distanceKm)), t }))
      .sort((a, b) => b.count - a.count);
    html.push(
      section('爬升密度', '每公里要爬多少米 · 越陡越靠前', rankBars(density, { unit: 'm/km' })),
    );

    /* 七、海拔区间：这一天最高到了哪儿 */
    html.push(
      section(
        '海拔区间',
        `最低到过 ${U.formatNumber(minEle)} m · 累计下降 ${U.formatNumber(dn)} m`,
        shareBars(
          ELE_BANDS.map((b, i) => ({ name: b.label, count: bands[i] })).filter((r) => r.count > 0),
          { unit: '条' },
        ),
      ),
    );

    /* 八、去过的山：省级行政区 */
    const provinces = [...byProvince.entries()].sort((a, b) => b[1] - a[1]);
    html.push(
      section(
        '去过的山',
        `共 ${provinces.length} 个省级行政区`,
        rankBars(provinces.map(([name, count]) => ({ name, count })), { unit: '条' }),
      ),
    );

    /* 九、越野跑成绩：ITRA 官方数据，按表现指数排 */
    const races = tracks.filter((t) => t.itra).sort((a, b) => b.itra.perf - a.itra.perf);
    if (races.length) {
      html.push(section('越野跑成绩', `ITRA · ${races.length} 场有官方记录`, itraBoard(races)));
    }

    return `<div class="st-page">${html.join('')}</div>`;
  }

  M.stats = { flightView, railView, trackView };
})();
