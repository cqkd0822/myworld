/**
 * 应用主逻辑 —— 路由 + 四个视图的渲染。
 *
 * 没有框架，也不需要：数据是静态的（100 段航班 + 53 段铁路 + 42 条轨迹，
 * 全量序列化后约 410 KB），页面用模板字符串拼出来就行。
 * 这样整个站零依赖、零构建，鼠标双击 index.html 就能看。
 *
 * 路由用 hash（#/flights 这种）。选 hash 而不是 history API，是因为
 * GitHub Pages 这类静态托管没有服务端重写，history 路由一刷新就 404。
 */

(function () {
  const M = window.MYWORLD || {};

  /**
   * 这个站点会被直接用 file:// 双击打开，所以任何一种「脚本没加载成功」
   * 都会让页面停在「正在加载…」而用户完全不知道为什么。
   * 这里先检查数据层是否就绪，不成就把原因画在页面上。
   */
  const U = M.util;
  if (!U || !M.site) {
    const el = document.getElementById('boot');
    if (el) {
      el.innerHTML =
        '<div style="max-width:400px;margin:0 auto">' +
        '<b style="color:#e5484d">页面没能启动</b>' +
        '<div style="margin-top:8px;font-size:13px">行程数据脚本没有加载完成。</div>' +
        '<div style="margin-top:10px;font-size:12px;color:#98a2b3">' +
        '请确认 assets/data/ 下的 5 个文件与 assets/js/data-utils.js 都在，' +
        '并且 <script> 标签的顺序没被打乱（顺序即依赖顺序）。' +
        '</div></div>';
    }
    return;
  }

  const esc = U.escapeHtml;

  /* ------------------------------------------------------------------ */
  /* 数据准备                                                            */
  /* ------------------------------------------------------------------ */

  const flights = U.buildFlights();
  const rails = U.buildRail();
  const voided = U.buildVoided();
  const tracks = M.tracks || [];
  const overview = U.computeOverview(flights, rails, tracks);

  const flightYears = [...overview.flightsByYear.keys()].sort((a, b) => b - a);
  const railYears = [...overview.railsByYear.keys()].sort((a, b) => b - a);
  const airlineNames = overview.airlines.map((a) => a[0]);

  /** 视图状态。切标签/筛选只改这个对象，然后整体重渲染。 */
  const state = {
    flightYear: 'all',
    flightAirline: 'all',
    railYear: 'all',
    flightQuery: '',
    railQuery: '',
    trackQuery: '',
    trackKind: 'all',
    // 「统计 | 列表 | 航迹图」三种视图。默认停在统计——打开一个 tab
    // 先看到成果，再往下翻明细。切到别的 tab 再回来，状态不会被打回原形。
    flightView: 'stats',
    railView: 'stats',
    trackView: 'stats',
  };

  /* ------------------------------------------------------------------ */
  /* 图标                                                                */
  /* ------------------------------------------------------------------ */

  const icon = {
    plane:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 13.4 3 11l18-7-7 18-2.4-7.6z"/></svg>',
    planeSmall:
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M21 4 3 11l7.6 2.4L21 4zM10.6 13.4 13 21l8-17-10.4 13.4z"/></svg>',
    arrow:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    chevron:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    back:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    download:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></svg>',
    pin:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-5.8 7-11a7 7 0 1 0-14 0c0 5.2 7 11 7 11z"/><circle cx="12" cy="11" r="2.4"/></svg>',
  };

  /** kind → [列表标签, tag 样式]。race=比赛完赛，hike=日常徒步，course=赛事官方路线 */
  const KIND_TAG = {
    race: ['已完赛', 'tag--ok'],
    hike: ['徒步', 'tag--ok'],
    run: ['越野跑', 'tag--ok'],
    course: ['赛事路线', 'tag--neutral'],
  };

  // 键名必须和 TABS 里的 key 一致，否则 tabbar 上会渲染出 "undefined"
  const tabIcon = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5V14h-5v6.5H5A1.5 1.5 0 0 1 3.5 19z"/></svg>',
    flights:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 13.4 3 11l18-7-7 18-2.4-7.6z"/><path d="M10.6 13.4 9 20l3.4-4.2"/></svg>',
    rail:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 9.5h14M9 20l-2 1.5M15 20l2 1.5M9.5 13h.01M14.5 13h.01"/></svg>',
    tracks:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19c2.5 0 2.5-6 5-6s2.5 6 5 6 3-4 5-6"/><circle cx="4" cy="19" r="1.6"/><circle cx="19" cy="13" r="1.6"/></svg>',
  };

  /* ------------------------------------------------------------------ */
  /* 小块渲染函数                                                        */
  /* ------------------------------------------------------------------ */

  function flightCard(f) {
    const fromPort = [f.from.airport, f.from.terminal].filter(Boolean).join(' ');
    const toPort = [f.to.airport, f.to.terminal].filter(Boolean).join(' ');
    const tag = U.delayTag(f);

    const depTime = f.std ? f.std.text : '--:--';
    // 跨日的到达时间要显式标出来，否则「00:43」会被误读成当天夜里
    const arrBase = f.ata || f.sta;
    const arrTime = arrBase ? arrBase.text : '--:--';
    const arrSup = arrBase && arrBase.dayOffset ? '<sup>+1</sup>' : '';

    const dur = f.blockMin ? U.formatDuration(f.blockMin) : '';
    const km = f.distanceKm ? `${U.formatNumber(f.distanceKm)} km` : '';

    const meta = [];
    meta.push(esc(f.aircraft));
    if (f.cabin) meta.push(esc(f.cabin) + (f.seat && f.seat !== '--' ? ` · ${esc(f.seat)}` : ''));
    meta.push(
      f.price != null
        ? `<span class="price">¥${U.formatNumber(f.price)}</span>`
        : '<span class="price price--unknown">票价未记录</span>',
    );

    const notes = [f.from.note, f.to.note].filter(Boolean);
    if (f.reg && /存疑/.test(f.reg)) notes.push(`注册号 ${f.reg}`);

    return `<article class="flight">
  <div class="flight__top">
    <span class="flight__date">${f.date ? `${f.date.text} ${f.date.weekday}` : f.dateRaw}</span>
    <span class="flight__no">${esc(f.flightNo)}</span>
    <span class="flight__airline">${esc(f.airline)}</span>
  </div>
  <div class="flight__body">
    <div class="endpoint">
      <div class="endpoint__time">${depTime}</div>
      <div class="endpoint__city">${esc(f.from.city)}</div>
      <div class="endpoint__port">${esc(fromPort || '—')}</div>
    </div>
    <div class="route">
      <div class="route__dur">${dur}</div>
      <div class="route__line"><span class="route__dash"></span><span class="route__plane">${
        icon.planeSmall
      }</span></div>
      <div class="route__dur">${km}</div>
    </div>
    <div class="endpoint endpoint--to">
      <div class="endpoint__time">${arrTime}${arrSup}</div>
      <div class="endpoint__city">${esc(f.to.city)}</div>
      <div class="endpoint__port">${esc(toPort || '—')}</div>
    </div>
  </div>
  <div class="flight__bottom">
    <div class="flight__meta">${meta.map(esc0).join('<i class="dot"></i>')}</div>
    <span class="tag ${tag.cls}">${tag.text}</span>
  </div>
  ${
    notes.length
      ? `<div class="flight__bottom" style="border-top:0;padding-top:0"><div class="flight__meta" style="color:var(--ink-3)">${notes
          .map(esc)
          .join(' · ')}</div></div>`
      : ''
  }
</article>`;
  }

  /** meta 里已经带了 HTML（price 那个 span），只对纯文本项转义 */
  function esc0(s) {
    return /^</.test(s) ? s : esc(s);
  }

  function railCard(r) {
    const cls = r.kind.cls || 'rail__no--g';
    const notes = r.note
      ? r.note
          .split(/[，,]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const noteTags = notes.map((n) => {
      let c = 'tag--neutral';
      if (/改签/.test(n)) c = 'tag--amber';
      else if (/候补/.test(n)) c = 'tag--rail';
      else if (/静音/.test(n)) c = 'tag--rail';
      return `<span class="tag ${c}">${esc(n)}</span>`;
    });

    return `<article class="rail">
  <div class="rail__badge">
    <div class="rail__no ${cls === 'rail__no--g' ? '' : cls}">${esc(r.train)}</div>
    <div class="rail__kind">${r.kind.label}</div>
  </div>
  <div class="rail__main">
    <div class="rail__route">
      <span class="rail__station">${esc(r.from)}</span>
      <span class="rail__arrow">${icon.arrow}</span>
      <span class="rail__station">${esc(r.to)}</span>
    </div>
    <div class="rail__meta">
      <span>${r.date ? `${r.date.text} ${r.date.weekday}` : r.dateRaw}</span>
      <i class="dot"></i>
      <span>${esc(r.seat)}</span>
    </div>
    ${noteTags.length ? `<div class="rail__notes">${noteTags.join('')}</div>` : ''}
  </div>
</article>`;
  }

  /** 按年份分组渲染一串卡片 */
  function grouped(items, renderCard, getDate) {
    const byYear = new Map();
    for (const it of items) {
      const d = getDate(it);
      const y = d ? d.year : '未知';
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(it);
    }

    const years = [...byYear.keys()].sort((a, b) => (a === '未知' ? 1 : b === '未知' ? -1 : b - a));

    return years
      .map(
        (y) => `<section>
  <div class="year-head">
    <span>${y} 年</span>
    <span class="year-head__count">${byYear.get(y).length} 段</span>
    <span class="year-head__rule"></span>
  </div>
  <div class="group">${byYear.get(y).map(renderCard).join('')}</div>
</section>`,
      )
      .join('');
  }

  function chipRow(label, options, active, key) {
    return `<div class="chips__label">${esc(label)}</div>
<div class="chips">${options
      .map(
        (o) =>
          `<button class="chip${o.value === active ? ' is-active' : ''}" data-chip="${key}" data-value="${esc(
            o.value,
          )}">${esc(o.label)}</button>`,
      )
      .join('')}</div>`;
  }

  /** 「统计 | 列表 | 航迹图」分段切换。views 传入要展示哪几段。
      地图视图的叫法跟着出行方式走：飞行叫航迹图，铁路叫线路图，足迹叫轨迹图。 */
  function viewToggle(kind, active, views = ['stats', 'list', 'map']) {
    const label = {
      stats: '统计',
      list: kind === 'tracks' ? '轨迹' : '列表',
      map: { flights: '航迹图', rail: '线路图', tracks: '轨迹图' }[kind] || '地图',
    };
    return `<div class="vtoggle" role="tablist">
      ${views
        .map(
          (v) =>
            `<button class="vtoggle__btn${active === v ? ' is-active' : ''}" data-tview="${kind}:${v}">${label[v]}</button>`,
        )
        .join('')}
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 航迹图                                                              */
  /* ------------------------------------------------------------------ */

  /** 飞行：底部统计条的四个数字 */
  function flightStats(list) {
    const cities = new Set();
    let km = 0;
    list.forEach((f) => {
      cities.add(f.from.city);
      cities.add(f.to.city);
      km += f.distanceKm || 0;
    });
    return [
      { n: cities.size, label: '城市' },
      { n: list.length, label: '航段' },
      { n: (km / 10000).toFixed(1) + '万', label: '公里' },
      { n: new Set(list.map((f) => f.airline)).size, label: '航司' },
    ];
  }

  /** 铁路：同样四个数字，但「车站」比「车次种类」更有信息量 */
  function railStats(list) {
    const cities = new Set();
    const stations = new Set();
    let km = 0;
    list.forEach((r) => {
      cities.add(r.fromCity);
      cities.add(r.toCity);
      stations.add(r.from);
      stations.add(r.to);
      km += r.distanceKm || 0;
    });
    return [
      { n: cities.size, label: '城市' },
      { n: list.length, label: '车次' },
      { n: (km / 10000).toFixed(1) + '万', label: '公里' },
      { n: stations.size, label: '车站' },
    ];
  }

  function routeMapView(kind) {
    const isFlight = kind === 'flights';
    const accent = isFlight ? '#ffc247' : '#3fd6c5';
    return `<div class="tmap" style="--tmap-accent:${accent}">
      <div class="tmap__host" id="tmapHost"></div>
      <div class="tmap__switch">${viewToggle(kind, 'map')}</div>
    </div>`;
  }

  /** 统计页外壳：深色主题由 is-stats 承担，切换条在顶部 */
  function statsPage(kind, active, body) {
    // 足迹不要「轨迹图」tab（地图对徒步无信息量），只留 统计 + 轨迹
    const views = kind === 'tracks' ? ['stats', 'list'] : ['stats', 'list', 'map'];
    return `<div class="wrap wrap--stats">
  <div class="listhead">${viewToggle(kind, active, views)}</div>
  ${body}
</div>`;
  }

  /**
   * 把航迹图挂到 #tmapHost 上。
   * 年份筛选沿用列表页的 state，所以你在航迹图里拖到 2024，
   * 切回列表看到的也是 2024——两边是同一份筛选状态。
   */
  /** 首页游历城市地图：把三源并集的城市点亮。 */
  function mountCityMap() {
    const host = document.getElementById('cityMapHost');
    if (!host) return;
    M.routemap.renderCityMap(host, overview.citiesAll, { accent: '#ffc247' });
  }

  function mountRouteMap(kind) {
    const host = document.getElementById('tmapHost');
    if (!host) return;

    const isFlight = kind === 'flights';
    const accent = isFlight ? '#ffc247' : '#3fd6c5';

    M.routemap.render({
      container: host,
      kind,
      accent,
      years: isFlight ? flightYears.slice().sort((a, b) => a - b) : railYears.slice().sort((a, b) => a - b),
      year: isFlight ? state.flightYear : state.railYear,
      load(year) {
        let list = isFlight ? flights : rails;
        if (year !== 'all') {
          list = list.filter((x) => x.date && x.date.year === Number(year));
        }
        // 同步回全局状态，列表页和航迹图共用同一份筛选
        if (isFlight) state.flightYear = String(year);
        else state.railYear = String(year);

        return isFlight
          ? { items: list, stats: flightStats(list) }
          : { items: list, stats: railStats(list) };
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* 视图：概览                                                          */
  /* ------------------------------------------------------------------ */

  function viewHome() {
    const spanText =
      overview.firstDate && overview.lastDate
        ? `${overview.firstDate} → ${overview.lastDate} · ${overview.years[0]}–${
            overview.years[overview.years.length - 1]
          } 年`
        : '';

    // 逐年柱状图：一段一年，蓝色是航班、青色是铁路，堆叠成出行总量
    const maxTotal = Math.max(
      1,
      ...overview.years.map(
        (y) => (overview.flightsByYear.get(y) || 0) + (overview.railsByYear.get(y) || 0),
      ),
    );

    const bars = overview.years
      .map((y) => {
        const f = overview.flightsByYear.get(y) || 0;
        const r = overview.railsByYear.get(y) || 0;
        const total = f + r;
        const h = (v) => `${Math.round((v / maxTotal) * 100)}%`;
        return `<div class="bars__col" title="${y} 年：航班 ${f} 段，铁路 ${r} 段">
  <span class="bars__n">${total || ''}</span>
  <div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:0;height:100%">
    <div class="bars__bar bars__bar--rail" style="${r ? `height:${h(r)}` : 'display:none'}"></div>
    <div class="bars__bar" style="${f ? `height:${h(f)}` : 'display:none'}"></div>
  </div>
</div>`;
      })
      .join('');

    const yearLabels = overview.years
      .map((y) => `<span>${String(y).slice(2)}</span>`)
      .join('');

    // 最近行程：航班和铁路混在一起按日期排，这才是「最近发生了什么」
    const recent = [
      ...flights.map((f) => ({
        date: f.dateRaw,
        html: `<div class="waypoint"><div class="waypoint__idx">${icon.planeSmall}</div>
          <div class="waypoint__name">${esc(f.from.city)} → ${esc(f.to.city)}</div>
          <span class="tag tag--neutral">${esc(f.flightNo)}</span></div>`,
      })),
      ...rails.map((r) => ({
        date: r.dateRaw,
        html: `<div class="waypoint"><div class="waypoint__idx" style="background:var(--rail-soft);color:var(--rail)">${icon.pin}</div>
          <div class="waypoint__name">${esc(r.from.replace('站', ''))} → ${esc(r.to.replace('站', ''))}</div>
          <span class="tag tag--rail">${esc(r.train)}</span></div>`,
      })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 8);

    const topRoutes = overview.routes.slice(0, 5);

    return `<div class="wrap">
  <section class="hero">
    <div class="hero__eyebrow">${esc(M.site.tagline)}</div>
    <!-- 页面 h1 由 render() 注入 sr-only 版本；这里只是视觉主标题，降级为 p 避免一页两个 h1 -->
    <p class="hero__title">${esc(M.site.title)}</p>
    <div class="hero__sub">${esc(spanText)}</div>
    <div class="hero__grid">
      <div class="hero__stat"><b>${overview.flightCount}</b><span>段航班</span></div>
      <div class="hero__stat"><b>${overview.railCount}</b><span>段铁路</span></div>
      <div class="hero__stat"><b>${overview.trackCount}</b><span>条轨迹</span></div>
    </div>
  </section>

  <section class="section">
    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">累计飞行里程</div>
        <div class="stat__value">${U.formatNumber(Math.round(overview.distanceSum))}<small>km</small></div>
        <div class="stat__foot">按城市间直线距离估算，约绕地球 ${(overview.distanceSum / 40075).toFixed(1)} 圈</div>
      </div>
      <div class="stat">
        <div class="stat__label">游历城市</div>
        <div class="stat__value">${overview.citiesAll.length}<small>座</small></div>
        <div class="stat__foot">航班 + 铁路 + 徒步三源并集 · 铁路经停 ${overview.stationCount} 站</div>
      </div>
      <div class="stat">
        <div class="stat__label">已知票价合计</div>
        <div class="stat__value">¥${U.formatNumber(overview.fareSum)}</div>
        <div class="stat__foot">${overview.fareCount} 段有票价 · 均价 ¥${U.formatNumber(
          Math.round(overview.fareAvg),
        )}</div>
      </div>
      <div class="stat">
        <div class="stat__label">准点率（严格）</div>
        <div class="stat__value">${Math.round(overview.onTimeRate * 100)}<small>%</small></div>
        <div class="stat__foot">${overview.onTime} 段准点或提前 / 共 ${overview.flightCount} 段 · 口径 delay≤0</div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section__head">
      <h2 class="section__title">游历城市</h2>
      <span class="section__hint">${overview.citiesAll.length} 座 · 按到访次数</span>
    </div>
    <div class="chips">
      ${overview.citiesAll
        .map(([city, total, o]) => {
          const parts = [
            o.flight ? `飞${o.flight}` : '',
            o.rail ? `铁${o.rail}` : '',
            o.track ? `徒${o.track}` : '',
          ].filter(Boolean).join(' · ');
          return `<span class="chip"><b>${esc(city)}</b><small>${total} 次${parts ? ' · ' + parts : ''}</small></span>`;
        })
        .join('')}
    </div>
    <div class="citymap" id="cityMapHost"></div>
  </section>

  <section class="section">
    <div class="section__head">
      <h2 class="section__title">逐年出行</h2>
      <span class="section__hint">${overview.years[0]}–${
      overview.years[overview.years.length - 1]
    }</span>
    </div>
    <div class="card">
      <div class="bars">
        <div class="bars__row">${bars}</div>
        <div class="bars__x">${yearLabels}</div>
      </div>
      <div class="legend">
        <span><i style="background:var(--brand)"></i>航班</span>
        <span><i style="background:var(--rail)"></i>铁路</span>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section__head"><h2 class="section__title">最常飞的航线</h2></div>
    <div class="card panel" style="margin-top:0">
      <div class="waypoints">
        ${topRoutes
          .map(
            ([name, n], i) => `<div class="waypoint">
          <div class="waypoint__idx">${i + 1}</div>
          <div class="waypoint__name">${esc(name)}</div>
          <span class="tag tag--neutral">${n} 次</span>
        </div>`,
          )
          .join('')}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section__head"><h2 class="section__title">最近行程</h2></div>
    <div class="card panel" style="margin-top:0">
      <div class="waypoints">${recent.map((r) => r.html).join('')}</div>
    </div>
  </section>

  <section class="section">
    <div class="section__head"><h2 class="section__title">导出数据</h2></div>
    <p class="export__hint">
      全站行程的机器可读副本：JSON 与 assets/data/ 下的原始数组同构，适合备份或自己再分析；
      CSV 带 UTF-8 BOM，Excel 直接打开中文不乱码。
    </p>
    <div class="export__btns">
      <button class="btn" type="button" data-export="json">${icon.download} JSON</button>
      <button class="btn" type="button" data-export="csv">${icon.download} CSV</button>
    </div>
  </section>

  <p class="footnote">
    飞行里程按城市间直线距离估算（民航实际航路比直线长 5%~15%，所以这是个下界）。
    爬升按 10 米阈值过滤高度抖动后累加，与其他工具的数字天然会有差异。
  </p>
</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：飞行                                                          */
  /* ------------------------------------------------------------------ */

  function viewFlights() {
    // 统计：永远看全量，筛选 chips 是列表页的事
    if (state.flightView === 'stats') {
      return statsPage('flights', 'stats', M.stats.flightView(flights, overview));
    }

    // 航迹图模式：整页都是地图，筛选（年份）由地图上的时间轴接管
    if (state.flightView === 'map') return routeMapView('flights');

    let list = flights;
    if (state.flightYear !== 'all') list = list.filter((f) => f.date && f.date.year === +state.flightYear);
    if (state.flightAirline !== 'all') list = list.filter((f) => f.airline === state.flightAirline);
    if (state.flightQuery.trim()) {
      const q = state.flightQuery.trim().toLowerCase();
      list = list.filter((f) =>
        [f.flightNo, f.airline, f.from.raw, f.to.raw, f.from.city, f.to.city, f.dateRaw, f.aircraft, f.reg, f.cabin, f.seat]
          .join(' ').toLowerCase().includes(q),
      );
    }

    const km = list.reduce((s, f) => s + (f.distanceKm || 0), 0);
    const fare = list.reduce((s, f) => s + (f.price || 0), 0);

    return `<div class="wrap">
  <div class="listhead">
    ${viewToggle('flights', 'list')}
  </div>
  <div class="filters">
    ${chipRow(
      '年份',
      [{ value: 'all', label: '全部' }, ...flightYears.map((y) => ({ value: String(y), label: `${y}` }))],
      state.flightYear,
      'flightYear',
    )}
    ${chipRow(
      '航空公司',
      [{ value: 'all', label: '全部' }, ...airlineNames.map((a) => ({ value: a, label: a }))],
      state.flightAirline,
      'flightAirline',
    )}
    <div class="searchrow"><input class="search" type="search" id="q-flight" data-q="flightQuery" placeholder="搜航班号 / 城市 / 机场 / 机型 / 日期" value="${esc(state.flightQuery)}"></div>
  </div>

  <div class="section__head">
    <h2 class="section__title">${list.length} 段航班</h2>
    <span class="section__hint">${U.formatNumber(Math.round(km))} km · ¥${U.formatNumber(fare)}</span>
  </div>

  ${list.length ? grouped(list, flightCard, (f) => f.date) : '<div class="empty">这个筛选条件下没有记录</div>'}
</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：铁路                                                          */
  /* ------------------------------------------------------------------ */

  function viewRail() {
    if (state.railView === 'stats') {
      return statsPage('rail', 'stats', M.stats.railView(rails));
    }

    if (state.railView === 'map') return routeMapView('rail');

    let list = rails;
    if (state.railYear !== 'all') list = list.filter((r) => r.date && r.date.year === +state.railYear);
    if (state.railQuery.trim()) {
      const q = state.railQuery.trim().toLowerCase();
      list = list.filter((r) =>
        [r.train, r.from, r.to, r.fromCity, r.toCity, r.note, r.dateRaw, r.seat].join(' ').toLowerCase().includes(q),
      );
    }

    const seatKinds = new Map();
    list.forEach((r) => seatKinds.set(r.seatKind, (seatKinds.get(r.seatKind) || 0) + 1));

    return `<div class="wrap">
  <div class="listhead">
    ${viewToggle('rail', 'list')}
  </div>
  <div class="filters">
    ${chipRow(
      '年份',
      [{ value: 'all', label: '全部' }, ...railYears.map((y) => ({ value: String(y), label: `${y}` }))],
      state.railYear,
      'railYear',
    )}
    <div class="searchrow"><input class="search" type="search" id="q-rail" data-q="railQuery" placeholder="搜车次 / 车站 / 城市 / 备注" value="${esc(state.railQuery)}"></div>
  </div>

  <div class="section__head">
    <h2 class="section__title">${list.length} 段行程</h2>
    <span class="section__hint">${[...seatKinds.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
  </div>

  ${list.length ? grouped(list, railCard, (r) => r.date) : '<div class="empty">这个筛选条件下没有记录</div>'}

  <div class="fold" id="voided">
    <button class="fold__btn" data-fold>
      <span>退票与改签原票</span>
      <span class="fold__count">${voided.length} 条未成行</span>
      <span class="fold__chev">${icon.chevron}</span>
    </button>
    <div class="fold__body">
      ${voided
        .map(
          (v) => `<div class="voided">
        <span class="voided__no">${esc(v.train)}</span>
        <span class="voided__route">${esc(v.from)} → ${esc(v.to)}</span>
        <span class="voided__why">${esc(v.reason)}</span>
      </div>`,
        )
        .join('')}
      <p class="footnote">这些票没有实际乘坐，所以不计入上面的行程数；留在这里是为了让「当初计划过什么」也有据可查。</p>
    </div>
  </div>
</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：足迹                                                          */
  /* ------------------------------------------------------------------ */

  /** 足迹统计 body：纯数字汇总（去休息移动口径），不渲染地图。 */
  function trackStatsBody(list) {
    const sum = (f) => list.reduce((a, t) => a + (f(t.stats) || 0), 0);
    const totalKm = sum((s) => s.distanceKm);
    const totalAscent = sum((s) => s.ascentM);
    const movingSec = sum((s) => s.movingTimeSec);
    const movingKm = sum((s) => s.movingDistanceKm);
    const races = list.filter((t) => t.kind === 'race').length;
    const longest = list.slice().sort((a, b) => b.stats.distanceKm - a.stats.distanceKm)[0];
    const stat = (label, value, unit, foot) =>
      `<div class="stat"><div class="stat__label">${label}</div><div class="stat__value">${value}<small>${unit}</small></div><div class="stat__foot">${foot}</div></div>`;
    return `<div class="stat-grid">
      ${stat('轨迹条数', list.length, '条', `徒步 ${list.length - races} · 越野/比赛 ${races}`)}
      ${stat('总里程', U.formatNumber(Math.round(totalKm)), 'km', `最长 ${esc(longest.name)} ${longest.stats.distanceKm} km`)}
      ${stat('总爬升', U.formatNumber(Math.round(totalAscent)), 'm', `平均每条 ${Math.round(totalAscent / list.length)} m`)}
      ${stat('移动时间', (movingSec / 3600).toFixed(0), 'h', '已剔除休息 / 过夜（间隔 >10 分钟）')}
      ${stat('平均移动速度', movingSec ? (movingKm / (movingSec / 3600)).toFixed(2) : '—', 'km/h', `移动里程 ${U.formatNumber(Math.round(movingKm))} km`)}
    </div>`;
  }

  function viewTracks() {
    if (!tracks.length) {
      return '<div class="wrap"><div class="empty">还没有轨迹。把 GPX 放进 tools/source/ 再跑一次构建脚本。</div></div>';
    }

    if (state.trackView === 'stats') {
      return statsPage('tracks', 'stats', trackStatsBody(tracks));
    }

    let tlist = tracks;
    if (state.trackKind !== 'all') tlist = tlist.filter((t) => t.kind === state.trackKind);
    if (state.trackQuery.trim()) {
      const q = state.trackQuery.trim().toLowerCase();
      tlist = tlist.filter((t) => [t.name, t.region, t.date].join(' ').toLowerCase().includes(q));
    }

    const cards = tlist
      .map((t) => {
        const s = t.stats;
        const mv = s.movingSpeedKmh ? s.movingSpeedKmh.toFixed(1) : null;
        return `<button class="track" data-track="${esc(t.id)}">
  <div class="track__head">
    <div class="track__pill" style="background:${t.color}">${icon.pin}</div>
    <div style="flex:1;min-width:0">
      <div class="track__name">${esc(t.name)}</div>
      <div class="track__region">${esc(t.region)} · ${esc(t.date)}</div>
    </div>
    <span class="tag ${(KIND_TAG[t.kind] || ['轨迹', 'tag--neutral'])[1]}">${
          (KIND_TAG[t.kind] || ['轨迹'])[0]
        }</span>
  </div>
  <div class="track__stats">
    <div class="track__stat"><b>${s.distanceKm}</b><span>公里</span></div>
    <div class="track__stat"><b>${U.formatNumber(s.ascentM)}</b><span>爬升 m</span></div>
    <div class="track__stat"><b>${mv || (s.durationSec ? U.formatSeconds(s.durationSec) : '—')}</b><span>${
          mv ? 'km/h 移动' : '用时'
        }</span></div>
  </div>
</button>`;
      })
      .join('');

    return `<div class="wrap">
  <div class="listhead">
    ${viewToggle('tracks', 'list', ['stats', 'list'])}
  </div>
  <div class="filters">
    ${chipRow('类型', [
      { value: 'all', label: '全部' },
      { value: 'hike', label: '徒步' },
      { value: 'run', label: '越野跑' },
      { value: 'race', label: '已完赛' },
    ], state.trackKind, 'trackKind')}
    <div class="searchrow"><input class="search" type="search" id="q-track" data-q="trackQuery" placeholder="搜轨迹名 / 地区 / 日期" value="${esc(state.trackQuery)}"></div>
  </div>
  <div class="section__head" style="margin-top:16px">
    <h2 class="section__title">${tlist.length} 条轨迹</h2>
    <span class="section__hint">共 ${U.formatNumber(
      Math.round(tlist.reduce((s, t) => s + t.stats.distanceKm, 0)),
    )} 公里</span>
  </div>
  <div class="group">${cards}</div>
</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：轨迹详情                                                      */
  /* ------------------------------------------------------------------ */

  let mapRef = null;

  function viewTrackDetail(id) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return '<div class="wrap"><div class="empty">找不到这条轨迹</div></div>';

    const s = t.stats;
    const pace = U.paceMinPerKm(s.durationSec, s.distanceKm);
    const mv = s.movingSpeedKmh ? s.movingSpeedKmh.toFixed(2) : null;

    return `<div class="wrap">
  <div id="mapHost" class="detail__map" style="margin-top:16px"></div>

  <p class="footnote" id="mapHint">${
    t.kind === 'course'
      ? '这是赛事官方路线文件，没有时间戳，所以没有用时和配速。'
      : '轨迹坐标已在构建期做过 WGS-84 → GCJ-02 纠偏，与腾讯地图底图对齐。'
  }</p>

  <div class="panel">
    <h2 class="panel__title">${esc(t.name)}</h2>
    <div class="kv">
      <div><div class="kv__k">总距离</div><div class="kv__v">${s.distanceKm}<small>km</small></div></div>
      <div><div class="kv__k">累计爬升</div><div class="kv__v">${U.formatNumber(s.ascentM)}<small>m</small></div></div>
      <div><div class="kv__k">累计下降</div><div class="kv__v">${U.formatNumber(s.descentM)}<small>m</small></div></div>
      <div><div class="kv__k">海拔区间</div><div class="kv__v">${U.formatNumber(s.minEle)}–${U.formatNumber(
      s.maxEle,
    )}<small>m</small></div></div>
      ${
        s.durationSec
          ? `<div><div class="kv__k">用时</div><div class="kv__v">${U.formatSeconds(s.durationSec)}</div></div>
                ${mv ? `<div><div class="kv__k">移动时间</div><div class="kv__v">${U.formatSeconds(s.movingTimeSec)}</div></div>
                <div><div class="kv__k">移动速度</div><div class="kv__v">${mv} km/h</div></div>
                <div><div class="kv__k">休息</div><div class="kv__v">${U.formatSeconds(s.restTimeSec)}</div></div>` : ''}
             <div><div class="kv__k">平均配速</div><div class="kv__v">${pace || '—'}<small>/km</small></div></div>`
          : ''
      }
      <div><div class="kv__k">记录点数</div><div class="kv__v">${U.formatNumber(s.rawPoints)}<small>→ 发到浏览器 ${
      s.shownPoints
    }</small></div></div>
    </div>
    ${
      t.startTime
        ? `<p class="footnote">${U.formatDateTime(t.startTime)} 起 · ${U.formatDateTime(t.endTime)} 止</p>`
        : ''
    }
  </div>

  <div class="panel">
    <h2 class="panel__title">海拔剖面</h2>
    ${M.map.svgProfile(t.profile, { color: t.color })}
  </div>

  ${
    t.waypoints.length
      ? `<div class="panel">
    <h2 class="panel__title">补给 / 检查点（${t.waypoints.length}）</h2>
    <div class="waypoints">
      ${t.waypoints
        .map(
          (w, i) => `<div class="waypoint">
        <div class="waypoint__idx">${i + 1}</div>
        <div class="waypoint__name">${esc(w.name || '未命名航点')}</div>
        <span class="tag tag--neutral">${w.lat.toFixed(3)}, ${w.lng.toFixed(3)}</span>
      </div>`,
        )
        .join('')}
    </div>
  </div>`
      : ''
  }

  <div style="display:flex;gap:10px;margin-top:14px">
    <a class="btn" href="${esc(s.gpx)}" download>${icon.download} 下载精简 GPX</a>
    <a class="btn btn--ghost" href="#/tracks">返回列表</a>
  </div>

  <p class="footnote">
    原始 ${U.formatNumber(s.rawPoints)} 个点（${U.formatNumber(
      Math.round(s.sourceBytes / 1024),
    )} KB）已抽稀到 ${U.formatNumber(s.shownPoints)} 个点（容差 ${s.toleranceM} 米），
    肉眼看不出差别。下载的 GPX 就是这个抽稀结果。
    爬升按 ${s.eleThresholdM} 米阈值过滤高度抖动后累加。
  </p>
</div>`;
  }

  function mountTrackMap(id) {
    const t = tracks.find((x) => x.id === id);
    const host = document.getElementById('mapHost');
    if (!t || !host) return;
    mapRef = M.map.renderTrack(t, host);
  }

  /* ------------------------------------------------------------------ */
  /* 路由                                                                */
  /* ------------------------------------------------------------------ */

  const TABS = [
    { key: 'home', label: '概览', hash: '#/' },
    { key: 'flights', label: '飞行', hash: '#/flights' },
    { key: 'rail', label: '铁路', hash: '#/rail' },
    { key: 'tracks', label: '足迹', hash: '#/tracks' },
  ];

  function currentRoute() {
    const hash = location.hash || '#/';
    const m = hash.match(/^#\/track\/(.+)$/);
    if (m) return { tab: 'tracks', trackId: decodeURIComponent(m[1]), detail: true };

    // #/flights/map 这种深链：既是可收藏的入口，也让自动化截图能直达航迹图
    const mapView = /\/map$/.test(hash);
    const statsView = /\/stats$/.test(hash);
    const listView = /\/list$/.test(hash);
    if (hash.startsWith('#/flights')) {
      if (mapView) state.flightView = 'map';
      else if (statsView) state.flightView = 'stats';
      else if (listView) state.flightView = 'list';
      return { tab: 'flights' };
    }
    if (hash.startsWith('#/rail')) {
      if (mapView) state.railView = 'map';
      else if (statsView) state.railView = 'stats';
      else if (listView) state.railView = 'list';
      return { tab: 'rail' };
    }
    if (hash.startsWith('#/tracks')) {
      if (statsView) state.trackView = 'stats';
      else if (listView) state.trackView = 'list';
      return { tab: 'tracks' };
    }
    return { tab: 'home' };
  }

  function renderTabs(active) {
    return TABS.map(
      (t) => `<a class="tabbar__btn${t.key === active ? ' is-active' : ''}" href="${t.hash}">
      ${tabIcon[t.key]}<span>${t.label}</span></a>`,
    ).join('');
  }

  function render() {
    const route = currentRoute();
    const view = document.getElementById('view');

    // 换页前先释放地图实例，否则每进一次详情就多留一个 WebGL context
    if (mapRef) {
      M.map.destroy();
      mapRef = null;
    }
    M.routemap.destroy();

    let html;
    if (route.detail) html = viewTrackDetail(route.trackId);
    else if (route.tab === 'flights') html = viewFlights();
    else if (route.tab === 'rail') html = viewRail();
    else if (route.tab === 'tracks') html = viewTracks();
    else html = viewHome();

    // 补一个屏幕阅读器用的 h1：顶栏标题是 <p>（否则一页两个 h1），
    // 视图内部直接从 h2 起步，层级才不断档
    const pageTitle = { home: M.site.title, flights: '航班记录', rail: '铁路行程', tracks: '徒步足迹' }[
      route.tab
    ];
    view.innerHTML = `<h1 class="sr-only">${esc(pageTitle)}</h1>` + html;
    document.getElementById('tabs').innerHTML = renderTabs(route.tab);

    // 航迹图占满一屏，列表页那条「给底部标签栏留空间」的 padding 就多余了
    const mapMode =
      (route.tab === 'flights' && state.flightView === 'map') ||
      (route.tab === 'rail' && state.railView === 'map');
    view.classList.toggle('is-mapview', Boolean(mapMode));

    // 统计页是深色的，顶栏和内容区要一起换肤；tabbar 保持浅色作锚点
    const statsMode =
      !route.detail &&
      ((route.tab === 'flights' && state.flightView === 'stats') ||
        (route.tab === 'rail' && state.railView === 'stats') ||
        (route.tab === 'tracks' && state.trackView === 'stats'));
    view.classList.toggle('is-stats', Boolean(statsMode));
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.classList.toggle('is-stats', Boolean(statsMode));

    const title = pageTitle;
    document.getElementById('topTitle').textContent = title;

    const back = document.getElementById('back');
    back.style.display = route.detail ? 'flex' : 'none';

    if (route.detail) mountTrackMap(route.trackId);
    else if (route.tab === 'flights' && state.flightView === 'map') mountRouteMap('flights');
    else if (route.tab === 'rail' && state.railView === 'map') mountRouteMap('rail');
    else if (route.tab === 'home') mountCityMap();

    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ------------------------------------------------------------------ */
  /* 数据导出（JSON / CSV）                                               */
  /* ------------------------------------------------------------------ */

  /** CSV 单元格转义：含逗号/引号/换行就包引号，内部引号翻倍 */
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function csvBlock(title, header, rows) {
    return [
      `# ${title}`,
      header.map(csvCell).join(','),
      ...rows.map((r) => r.map(csvCell).join(',')),
      '',
    ].join('\n');
  }

  function exportText(kind) {
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'json') {
      const payload = {
        site: M.site.title,
        generatedAt: new Date().toISOString(),
        note: 'flights/rail/railVoided 与 assets/data/*.js 的原始数组同构；tracks 只含统计与补给点，几何见 assets/data/tracks.js',
        flights: M.flights,
        rail: M.rail,
        railVoided: M.railVoided,
        tracks: tracks.map((t) => ({
          id: t.id, name: t.name, date: t.date, region: t.region,
          kind: t.kind, color: t.color, stats: t.stats, waypoints: t.waypoints,
        })),
      };
      return { name: `myworld-${stamp}.json`, mime: 'application/json', text: JSON.stringify(payload, null, 2) };
    }
    const text =
      csvBlock(
        '航班',
        ['序号','日期','航空公司','航班号','出发','到达','机型','注册号','计划起飞','计划到达','实际到达','舱位','座位','票价','晚点分钟','直线公里'],
        flights.map((f) => [
          f.id, f.dateRaw, f.airline, f.flightNo, f.from.raw, f.to.raw, f.aircraft, f.reg,
          f.std, f.sta, f.ata, f.cabinRaw || f.cabin, f.seat, f.price, f.delay,
          f.distanceKm == null ? '' : Math.round(f.distanceKm),
        ]),
      ) +
      csvBlock(
        '铁路',
        ['序号','日期','车次','出发站','到达站','出发城市','到达城市','座位','席别','直线公里','备注'],
        rails.map((r) => [
          r.id, r.dateRaw, r.train, r.from, r.to, r.fromCity, r.toCity, r.seat, r.seatKind,
          r.distanceKm == null ? '' : Math.round(r.distanceKm), r.note,
        ]),
      ) +
      csvBlock(
        '未成行原票',
        ['车次','出发站','到达站','日期','原因'],
        voided.map((v) => [v.train, v.from, v.to, v.dateRaw, v.reason]),
      );
    return { name: `myworld-${stamp}.csv`, mime: 'text/csv', text: '\uFEFF' + text };
  }

  function downloadExport(kind) {
    const { name, mime, text } = exportText(kind);
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ------------------------------------------------------------------ */
  /* 事件委托                                                            */
  /* ------------------------------------------------------------------ */

  document.addEventListener('click', (e) => {
    const tv = e.target.closest('[data-tview]');
    if (tv) {
      const [kind, mode] = tv.dataset.tview.split(':');
      if (kind === 'flights') state.flightView = mode;
      else if (kind === 'rail') state.railView = mode;
      else state.trackView = mode;
      render();
      return;
    }

    const chip = e.target.closest('[data-chip]');
    if (chip) {
      state[chip.dataset.chip] = chip.dataset.value;
      render();
      return;
    }

    const fold = e.target.closest('[data-fold]');
    if (fold) {
      fold.closest('.fold').classList.toggle('is-open');
      return;
    }

    const exp = e.target.closest('[data-export]');
    if (exp) {
      downloadExport(exp.dataset.export);
      return;
    }

    const trackBtn = e.target.closest('[data-track]');
    if (trackBtn) {
      location.hash = `#/track/${encodeURIComponent(trackBtn.dataset.track)}`;
      return;
    }

    if (e.target.closest('#back')) {
      history.back();
    }
  });

  // 搜索框：输入即过滤；重渲染后把焦点和光标还给输入框，否则每敲一个字就失焦
  document.addEventListener('input', (e) => {
    const inp = e.target.closest('[data-q]');
    if (!inp) return;
    const caret = inp.selectionStart;
    state[inp.dataset.q] = inp.value;
    render();
    const again = document.getElementById(inp.id);
    if (again) {
      again.focus();
      try { again.setSelectionRange(caret, caret); } catch (_) { /* 非文本输入忽略 */ }
    }
  });

  window.addEventListener('hashchange', render);

  function boot() {
    const el = document.getElementById('boot');
    try {
      render();
      if (el && el.parentNode) el.remove();
    } catch (err) {
      console.error(err);
      if (el) {
        el.innerHTML =
          '<div style="max-width:420px;margin:0 auto">' +
          '<b style="color:#e5484d">页面渲染出错</b>' +
          '<div style="margin-top:8px;font-size:13px">' +
          esc(String((err && err.message) || err)) +
          '</div></div>';
      }
    }
  }

  boot();

  // 离线缓存：只在 http(s) 下注册；file:// 双击预览没有 SW 也完全不受影响
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* 托管环境不让注册就算了，站本身不依赖它 */
    });
  }
})();
