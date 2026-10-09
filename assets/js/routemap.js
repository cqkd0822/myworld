/**
 * 航迹图 —— 航旅纵横风格的飞行 / 铁路轨迹地图。
 *
 * 三个设计决定：
 *
 * 1) **底图用腾讯 GL JS 的官方深色样式**（style1 墨渊）。自制深色地图
 *    意味着要自己画国界，而国界画错是合规问题，不是审美问题——
 *    腾讯的底图天然符合国家标准（含南海诸岛），这条路走不得。
 *
 * 2) **航线是大圆弧，不是贝塞尔曲线。** 两点间的大圆才是真实航向，
 *    用球面插值（slerp）算出来，北京—广州那种明显的弧度是物理事实，
 *    不是装饰。
 *
 * 3) **地图加载失败也不白屏。** 先画一张离线的深色 SVG 航线图，
 *    底图挂了它还在——和轨迹详情页用的是同一套思路。
 */

(function () {
  const M = (window.MYWORLD = window.MYWORLD || {});

  let current = null;

  /** '#rrggbb' + 透明度 → 'rgba(r,g,b,a)'。PolylineStyle 没有 opacity 选项。 */
  function tint(hex, a) {
    const h = String(hex || '').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
    return `rgba(${r},${g},${b},${a})`;
  }

  /* ------------------------------------------------------------------ */
  /* 大圆插值                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 球面上两点之间的大圆路径。a/b 是 [lat, lng]，返回 seg+1 个插值点。
   * 推导：把两端点转成三维单位向量，按球面线性插值（slerp）再转回经纬度。
   */
  function greatCircle(a, b, seg) {
    const toRad = (d) => (d * Math.PI) / 180;
    const [la1, lo1] = a;
    const [la2, lo2] = b;
    const f1 = toRad(la1);
    const l1 = toRad(lo1);
    const f2 = toRad(la2);
    const l2 = toRad(lo2);

    const x1 = Math.cos(f1) * Math.cos(l1);
    const y1 = Math.cos(f1) * Math.sin(l1);
    const z1 = Math.sin(f1);
    const x2 = Math.cos(f2) * Math.cos(l2);
    const y2 = Math.cos(f2) * Math.sin(l2);
    const z2 = Math.sin(f2);

    const dx = x1 - x2;
    const dy = y1 - y2;
    const dz = z1 - z2;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // 两端几乎重合（同城往返）就不用插了，画一条短线即可
    if (d < 1e-9) return [a.slice(), b.slice()];

    const sd = Math.sin(d);
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const A = Math.sin((1 - t) * d) / sd;
      const B = Math.sin(t * d) / sd;
      const x = A * x1 + B * x2;
      const y = A * y1 + B * y2;
      const z = A * z1 + B * z2;
      pts.push([
        (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
        (Math.atan2(y, x) * 180) / Math.PI,
      ]);
    }
    return pts;
  }

  /* ------------------------------------------------------------------ */
  /* 聚合                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 把一段段行程聚合成「城市对」航线。同一条 A→B 和 B→A 算同一条线，
   * 否则往返会被画成两根叠在一起的弧。
   */
  function aggregate(items) {
    const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const routes = new Map();
    const visits = new Map();

    for (const it of items) {
      // 兼容两种入参：铁路是平铺的 fromCity，航班是嵌套的 from.city
      const a = it.fromCity || (it.from && it.from.city);
      const b = it.toCity || (it.to && it.to.city);
      if (!a || !b || !M.cityCoords[a] || !M.cityCoords[b]) continue;

      const k = pairKey(a, b);
      if (!routes.has(k)) routes.set(k, { a, b, count: 0, km: 0 });
      const r = routes.get(k);
      r.count += 1;
      r.km += it.distanceKm || 0;

      visits.set(a, (visits.get(a) || 0) + 1);
      visits.set(b, (visits.get(b) || 0) + 1);
    }

    return { routes: [...routes.values()], visits };
  }

  /* ------------------------------------------------------------------ */
  /* 离线 SVG（底图挂了也能看）                                          */
  /* ------------------------------------------------------------------ */

  function svgRoutes(routes, opts) {
    const width = opts.width || 680;
    const height = opts.height || 420;
    const accent = opts.accent || '#ffc247';

    if (!routes.length) {
      return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
        <rect width="${width}" height="${height}" fill="#0b1220"/>
        <text x="50%" y="50%" fill="#64748b" font-size="13" text-anchor="middle">没有可绘制的航线</text>
      </svg>`;
    }

    // 全国范围固定框：不按航线包围盒缩放，否则只去过两个邻近城市时
    // 会把中国放大到认不出来
    const LAT0 = 18, LAT1 = 51, LNG0 = 76, LNG1 = 134;
    const kx = Math.cos((((LAT0 + LAT1) / 2) * Math.PI) / 180);
    const sx = (width - 24) / ((LNG1 - LNG0) * kx);
    const sy = (height - 24) / (LAT1 - LAT0);
    const s = Math.min(sx, sy);
    const ox = (width - (LNG1 - LNG0) * kx * s) / 2;
    const oy = (height - (LAT1 - LAT0) * s) / 2;

    const project = ([lat, lng]) => [
      ox + (lng - LNG0) * kx * s,
      oy + (LAT1 - lat) * s,
    ];

    const arcs = routes
      .map((r) => {
        const pts = greatCircle(M.cityCoords[r.a], M.cityCoords[r.b], 40).map(project);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
        return `<path d="${d}" fill="none" stroke="${accent}" stroke-width="${r.count > 1 ? 1.8 : 1.1}" opacity="${r.count > 1 ? 0.85 : 0.5}"/>`;
      })
      .join('');

    const dots = [...new Set(routes.flatMap((r) => [r.a, r.b]))]
      .map((c) => {
        const [x, y] = project(M.cityCoords[c]);
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#fff" opacity="0.92"/>`;
      })
      .join('');

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-label="航线示意图">
      <rect width="${width}" height="${height}" fill="#0b1220"/>
      ${arcs}${dots}
    </svg>`;
  }

  /* ------------------------------------------------------------------ */
  /* 标注图标                                                            */
  /* ------------------------------------------------------------------ */

  /** 城市光点：白芯 + 彩色光环，几档大小对应到访频次 */
  function dotDataUri(color, r) {
    const w = r * 2 + 6;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}">
<circle cx="${w / 2}" cy="${w / 2}" r="${r + 2.4}" fill="${color}" opacity="0.28"/>
<circle cx="${w / 2}" cy="${w / 2}" r="${r}" fill="#ffffff"/>
<circle cx="${w / 2}" cy="${w / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /**
   * 带城市名的光点。名字直接画进 SVG 里而不是用 MultiLabel——
   * 后者在部分 GL JS 版本上不渲染，光点却从来没让我们失望过。
   * 白描边保证在深浅两种底图上都读得清。
   */
  function labeledDotUri(name, color, r, dark) {
    const fs = 12;
    const chars = [...String(name)].length;
    const dotR = r + 2.5;
    const cx = dotR + 3;
    const cy = Math.max(dotR + 3, fs / 2 + 3);
    const w = cx + dotR + 5 + chars * fs + 6;
    const h = cy * 2;
    const fill = dark ? '#f1f5f9' : '#1f2937';
    const halo = dark ? 'rgba(8,15,30,.85)' : '#ffffff';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<circle cx="${cx}" cy="${cy}" r="${r + 2.4}" fill="${color}" opacity="0.28"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="1.8"/>
<text x="${cx + r + 5}" y="${cy}" font-size="${fs}" fill="${fill}" stroke="${halo}" stroke-width="3"
  paint-order="stroke" stroke-linejoin="round" dominant-baseline="central"
  font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">${name}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ------------------------------------------------------------------ */
  /* 时间轴                                                              */
  /* ------------------------------------------------------------------ */

  function timelineHtml(years, year) {
    // 滑块刻度：0..n-1 是具体年份，n 是「全部」
    const max = years.length;
    const idx = year === 'all' ? max : Math.max(0, years.indexOf(Number(year)));
    return `<div class="tmap__timeline">
      <div class="tmap__tlabel" id="tmapYearLabel">${year === 'all' ? '全部' : year + ' 年'}</div>
      <div class="tmap__track">
        <input class="tmap__slider" id="tmapSlider" type="range" min="0" max="${max}" step="1" value="${idx}" aria-label="按年份筛选航线" />
        <div class="tmap__ticks">${years.map((y) => `<i></i>`).join('')}</div>
      </div>
      <button class="tmap__allbtn" id="tmapAll" type="button">全部</button>
    </div>`;
  }

  function statsHtml(stats) {
    return `<div class="tmap__stats">${stats
      .map(
        (s) => `<div class="tmap__stat"><b>${s.n}</b><span>${s.label}</span></div>`,
      )
      .join('')}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 主流程                                                              */
  /* ------------------------------------------------------------------ */

  function destroy() {
    if (current && current.destroy) current.destroy();
    current = null;
  }

  /**
   * 渲染航迹图。
   *
   * @param {Object} opts
   * @param {HTMLElement} opts.container  挂载容器（position:relative）
   * @param {string} opts.kind            'flights' | 'rail'，只影响文案
   * @param {number[]} opts.years         可选年份（升序）
   * @param {string|number} opts.year     初始筛选
   * @param {string} opts.accent          航线主色
   * @param {Function} opts.load          (year) => { items, stats }
   */
  function render(opts) {
    destroy();

    const container = opts.container;
    const kind = opts.kind || 'flights';
    const accent = opts.accent || '#ffc247';
    const years = (opts.years || []).slice().sort((a, b) => a - b);
    let year = opts.year == null ? 'all' : opts.year;

    // ---- 骨架：先画离线版，地图之后叠上去 ----
    const first = opts.load(year) || { items: [], stats: [] };
    container.innerHTML = `
      <div class="tmap__offline" id="tmapOffline">${svgRoutes(
        aggregate(first.items).routes,
        { accent },
      )}</div>
      <div class="tmap__hint" id="tmapHint">正在加载地图底图…</div>
      <div class="tmap__panels">
        ${timelineHtml(years, year)}
        ${statsHtml(first.stats || [])}
      </div>`;

    const offlineEl = container.querySelector('#tmapOffline');
    const hintEl = container.querySelector('#tmapHint');
    const panelsEl = container.querySelector('.tmap__panels');
    const statsEl = container.querySelector('.tmap__stats');
    const labelEl = container.querySelector('#tmapYearLabel');
    const sliderEl = container.querySelector('#tmapSlider');
    const allBtn = container.querySelector('#tmapAll');

    let map = null;
    let layers = [];

    function clearLayers() {
      for (const l of layers) {
        try {
          l.setMap(null);
        } catch (e) {
          /* 已销毁，忽略 */
        }
      }
      layers = [];
    }

    /** 把航线、城市点、标注画上去（地图和离线 SVG 共用这一份聚合结果） */
    function draw(items) {
      const { routes, visits } = aggregate(items);

      // 底图没起来时只更新离线 SVG
      if (!map) {
        offlineEl.innerHTML = svgRoutes(routes, { accent });
        return;
      }

      clearLayers();
      const TMap = window.TMap;
      const toPath = (pts) => pts.map(([lat, lng]) => new TMap.LatLng(lat, lng));

      // 航线按次数分档，飞得越多的线越粗——这是航迹图最直观的信息层级
      const buckets = new Map();
      for (const r of routes) {
        const bucket = r.count >= 4 ? 2 : r.count >= 2 ? 1 : 0;
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket).push(
          toPath(greatCircle(M.cityCoords[r.a], M.cityCoords[r.b], 48)),
        );
      }

      // 三档粗细。样式键名必须和几何上的 styleId 完全一致，
      // 少定义一个就会让那一档回退成默认蓝色（踩过这个坑）。
      const widthFor = [2.2, 3.4, 4.8];
      const coreStyles = {};
      const glowStyles = {};
      for (let b = 0; b < 3; b++) {
        coreStyles['b' + b] = new TMap.PolylineStyle({
          color: accent,
          width: widthFor[b],
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,.6)',
          lineCap: 'round',
        });
        glowStyles['b' + b] = new TMap.PolylineStyle({
          color: tint(accent, 0.18),
          width: widthFor[b] + 7,
          lineCap: 'round',
        });
      }

      // 几何 id 在同一个地图实例里必须唯一，两个图层都要带各自的前缀
      const glowGeoms = [];
      const coreGeoms = [];
      for (const [bucket, pathList] of buckets) {
        pathList.forEach((paths, i) => {
          glowGeoms.push({ id: `g${bucket}_${i}`, styleId: 'b' + bucket, paths });
          coreGeoms.push({ id: `c${bucket}_${i}`, styleId: 'b' + bucket, paths });
        });
      }

      // 底层晕光：宽而淡，负责「发光」的观感。
      // 透明度只能写进 rgba 颜色里——PolylineStyle 没有 opacity 这个选项。
      layers.push(new TMap.MultiPolyline({ map, styles: glowStyles, geometries: glowGeoms }));
      // 上层实线
      layers.push(new TMap.MultiPolyline({ map, styles: coreStyles, geometries: coreGeoms }));

      // 城市光点：到访多的点更大；只给前 12 名配名字——全标出来手机上会糊成一团
      const cities = [...visits.keys()];
      const ranked = cities.slice().sort((a, b) => visits.get(b) - visits.get(a));
      const labeled = new Set(ranked.slice(0, 12));
      const dark = Boolean(M.site && M.site.mapStyleId);

      const plainStyles = {
        big: new TMap.MarkerStyle({
          width: 20,
          height: 20,
          anchor: { x: 10, y: 10 },
          src: dotDataUri(accent, 4.6),
        }),
        small: new TMap.MarkerStyle({
          width: 14,
          height: 14,
          anchor: { x: 7, y: 7 },
          src: dotDataUri(accent, 3),
        }),
      };
      const plainGeoms = [];
      const labelStyles = {};
      const labelGeoms = [];

      for (const c of cities) {
        const n = visits.get(c);
        const pos = new TMap.LatLng(M.cityCoords[c][0], M.cityCoords[c][1]);
        if (labeled.has(c)) {
          const r = n >= 8 ? 4.4 : 3.6;
          const uri = labeledDotUri(c, accent, r, dark);
          const w = r + 5.5 + 5 + [...c].length * 12 + 6;
          const h = Math.max(r * 2 + 6, 19);
          const sk = 'n' + labelGeoms.length;
          labelStyles[sk] = new TMap.MarkerStyle({
            width: w,
            height: h,
            anchor: { x: r + 5.5, y: h / 2 },
            src: uri,
          });
          labelGeoms.push({ id: sk, styleId: sk, position: pos });
        } else {
          const big = n >= 8;
          plainGeoms.push({
            id: 'p' + plainGeoms.length,
            styleId: big ? 'big' : 'small',
            position: pos,
          });
        }
      }

      if (plainGeoms.length) {
        layers.push(
          new TMap.MultiMarker({ map, styles: plainStyles, geometries: plainGeoms }),
        );
      }
      // 带名字的光点要在普通光点之上，所以后创建
      if (labelGeoms.length) {
        layers.push(new TMap.MultiMarker({ map, styles: labelStyles, geometries: labelGeoms }));
      }

      // 视野对框
      try {
        if (cities.length) {
          const lats = cities.map((c) => M.cityCoords[c][0]);
          const lngs = cities.map((c) => M.cityCoords[c][1]);
          const bounds = new TMap.LatLngBounds(
            new TMap.LatLng(Math.min.apply(null, lats), Math.min.apply(null, lngs)),
            new TMap.LatLng(Math.max.apply(null, lats), Math.max.apply(null, lngs)),
          );
          if (map.fitBounds) {
            map.fitBounds(bounds, { padding: 40 });
            // 底部有统计条和时间轴挡着，把视野整体上移一点，
            // 否则南边的城市会被面板盖住
            if (map.panBy) map.panBy(0, 58);
          }
        }
      } catch (e) {
        /* 保留当前视野 */
      }
    }

    function setYear(y) {
      year = y;
      const data = opts.load(y) || { items: [], stats: [] };
      if (labelEl) labelEl.textContent = y === 'all' ? '全部' : y + ' 年';
      if (statsEl) statsEl.innerHTML = statsHtml(data.stats || []).replace(/^<div class="tmap__stats">|<\/div>$/g, '');
      draw(data.items || []);
    }

    // ---- 时间轴交互 ----
    if (sliderEl) {
      sliderEl.addEventListener('input', () => {
        const v = Number(sliderEl.value);
        const y = v >= years.length ? 'all' : years[v];
        if (labelEl) labelEl.textContent = y === 'all' ? '全部' : y + ' 年';
      });
      sliderEl.addEventListener('change', () => {
        const v = Number(sliderEl.value);
        setYear(v >= years.length ? 'all' : years[v]);
      });
    }
    if (allBtn) {
      allBtn.addEventListener('click', () => {
        setYear('all');
        if (sliderEl) sliderEl.value = String(years.length);
      });
    }

    // ---- 起地图 ----
    const fallback = M.map
      .loadApi()
      .then((TMap) => {
        const canvas = document.createElement('div');
        canvas.style.cssText = 'position:absolute;inset:0';
        container.insertBefore(canvas, panelsEl);

        const styleId = (M.site && M.site.mapStyleId) || '';
        const initOpts = {
          center: new TMap.LatLng(34.5, 108.9),
          zoom: 4.4,
          pitch: 0,
          viewMode: '2D',
        };
        // 只有确实配置了样式才传——空字符串或未绑定的编号都可能让底图返灰
        if (styleId) initOpts.mapStyleId = styleId;
        map = new TMap.Map(canvas, initOpts);

        if (styleId) {
          // 有的版本构造参数里的 mapStyleId 不生效，补一刀 setMapStyleId
          try {
            if (typeof map.setMapStyleId === 'function') map.setMapStyleId(styleId);
          } catch (e) {
            /* 保持默认底图 */
          }
        }

        draw(first.items || []);

        const off = container.querySelector('#tmapOffline');
        if (off) off.remove();
        if (hintEl) hintEl.remove();

        current = {
          destroy() {
            clearLayers();
            if (map && map.destroy) map.destroy();
          },
        };
        return map;
      })
      .catch((err) => {
        // 底图挂了：离线 SVG 还在，只是没有真实的地图轮廓
        if (hintEl) {
          hintEl.style.background = 'rgba(190,40,40,.92)';
          hintEl.textContent = '底图未加载：' + err.message;
        }
        current = { destroy() {} };
        return null;
      });

    return { fallback, setYear };
  }

  M.routemap = { render, destroy, greatCircle, aggregate };
})();
