/**
 * 轨迹地图 —— 腾讯位置服务 GL JS。
 *
 * 两个刻意的设计：
 *
 * 1) **先画离线轮廓，再叠地图。** 轨迹坐标已经在数据文件里了，所以不等地图
 *    加载就能画出一条真实的轨迹轮廓。地图 API 因为 key 白名单、断网、
 *    跨境瓦片等原因打不开时，用户看到的仍然是一条正确的轨迹形状，
 *    而不是一个空白灰框——这对一个「记录」站是底线。
 *
 * 2) **坐标已经在构建期转过 GCJ-02。** 页面里不再做纠偏，直接喂给腾讯地图。
 *    转换逻辑只存在一份（tools/geo.mjs），避免前后端两套实现慢慢跑偏。
 */

(function () {
  const M = (window.MYWORLD = window.MYWORLD || {});

  let apiPromise = null;
  let current = null;

  /* ------------------------------------------------------------------ */
  /* 离线轮廓（无地图也能看）                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 把轨迹投影成 SVG path。用等距圆柱投影 + 纬度余弦校正，
   * 在几十公里的尺度上肉眼看不出一阶偏差。
   */
  function svgPreview(paths, opts) {
    const width = (opts && opts.width) || 640;
    const height = (opts && opts.height) || 320;
    const pad = 18;
    const color = (opts && opts.color) || '#1b6ff0';

    const pts = [].concat(...paths);
    if (!pts.length) return '';

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const [lat, lng] of pts) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    const latRef = (((minLat + maxLat) / 2) * Math.PI) / 180;
    const kx = Math.cos(latRef);

    // 经度按 cos(纬度) 压缩后再算跨度，否则高纬度轨迹会被横向拉扁
    const spanX = Math.max((maxLng - minLng) * kx, 1e-9);
    const spanY = Math.max(maxLat - minLat, 1e-9);
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);

    const offX = (width - spanX * scale) / 2;
    const offY = (height - spanY * scale) / 2;

    const project = ([lat, lng]) => [
      offX + (lng - minLng) * kx * scale,
      // SVG 的 y 轴向下，纬度向北增大，所以这里要翻过来
      offY + (maxLat - lat) * scale,
    ];

    const d = paths
      .map((seg) =>
        seg
          .map((p, i) => {
            const [x, y] = project(p);
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(' '),
      )
      .filter(Boolean)
      .join(' ');

    const all = pts.map(project);
    const start = all[0];
    const end = all[all.length - 1];

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-label="轨迹轮廓">
  <rect width="${width}" height="${height}" fill="#eef2f8"/>
  <path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.95" vector-effect="non-scaling-stroke"/>
  <circle cx="${start[0].toFixed(1)}" cy="${start[1].toFixed(1)}" r="5" fill="#12a150" stroke="#fff" stroke-width="2"/>
  <circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="5" fill="#e5484d" stroke="#fff" stroke-width="2"/>
</svg>`;
  }

  /** 海拔剖面图（纯 SVG，不依赖任何库） */
  function svgProfile(profile, opts) {
    const width = (opts && opts.width) || 640;
    const height = (opts && opts.height) || 130;
    const padTop = 12;
    const padBottom = 20;
    const color = (opts && opts.color) || '#1b6ff0';

    if (!profile || profile.length < 2) return '';

    const maxKm = profile[profile.length - 1][0] || 1;
    let minEle = Infinity;
    let maxEle = -Infinity;
    for (const [, ele] of profile) {
      if (ele < minEle) minEle = ele;
      if (ele > maxEle) maxEle = ele;
    }
    // 上下各留一点余量，否则最高点会顶到框线上
    const spanEle = Math.max(maxEle - minEle, 1);
    const lo = minEle - spanEle * 0.08;
    const hi = maxEle + spanEle * 0.08;

    const x = (km) => (km / maxKm) * width;
    const y = (ele) => padTop + (1 - (ele - lo) / (hi - lo)) * (height - padTop - padBottom);

    const line = profile
      .map(([km, ele], i) => `${i === 0 ? 'M' : 'L'}${x(km).toFixed(1)} ${y(ele).toFixed(1)}`)
      .join(' ');

    const area = `${line} L${width} ${height - padBottom} L0 ${height - padBottom} Z`;

    // 只标起始、中点、终点三个刻度，手机上多了也看不清
    const ticks = [0, maxKm / 2, maxKm].map((km) => (
      { km, px: x(km) }
    ));

    return `<svg viewBox="0 0 ${width} ${height}" class="profile" preserveAspectRatio="none" aria-label="海拔剖面">
  <defs>
    <linearGradient id="eleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <path d="${area}" fill="url(#eleFill)"/>
  <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  <line x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}" stroke="#e7eaf0" stroke-width="1"/>
  ${ticks
    .map(
      (t, i) =>
        `<text x="${Math.min(Math.max(t.px, 16), width - 16)}" y="${height - 6}" font-size="10" fill="#98a2b3" text-anchor="${['start', 'middle', 'end'][i]}">${
          i === 0 ? '0' : t.km.toFixed(1)
        } km</text>`,
    )
    .join('')}
  <text x="4" y="${padTop + 4}" font-size="10" fill="#98a2b3">${Math.round(maxEle)} m</text>
  <text x="4" y="${height - padBottom - 3}" font-size="10" fill="#98a2b3">${Math.round(minEle)} m</text>
</svg>`;
  }

  /* ------------------------------------------------------------------ */
  /* 腾讯地图                                                           */
  /* ------------------------------------------------------------------ */

  function loadApi() {
    if (window.TMap) return Promise.resolve(window.TMap);
    if (apiPromise) return apiPromise;

    apiPromise = new Promise((resolve, reject) => {
      const key = (M.site && M.site.mapKey) || '';
      if (!key) {
        reject(new Error('未配置腾讯地图 key'));
        return;
      }
      const s = document.createElement('script');
      s.src = `https://map.qq.com/api/gljs?v=1.exp&key=${encodeURIComponent(key)}`;
      s.async = true;
      s.onload = () => (window.TMap ? resolve(window.TMap) : reject(new Error('TMap 加载后未挂载')));
      s.onerror = () => reject(new Error('地图脚本加载被拒绝（多为 key 域名白名单或断网）'));
      document.head.appendChild(s);
    });

    return apiPromise;
  }

  /** 用内联 SVG 做标注图标，省掉一次图片请求，也不会因为图床挂掉变成破图。 */
  function pinDataUri(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">
<path d="M13 33C13 33 24 20.6 24 13A11 11 0 1 0 2 13c0 7.6 11 20 11 20z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
<circle cx="13" cy="13" r="4.2" fill="#ffffff"/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function dotDataUri(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<circle cx="8" cy="8" r="5.5" fill="#ffffff" stroke="${color}" stroke-width="2.5"/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function destroy() {
    if (current && current.destroy) {
      try {
        current.destroy();
      } catch (e) {
        /* 地图内部已经释放，忽略 */
      }
    }
    current = null;
  }

  /**
   * 渲染轨迹地图。
   * 返回 { fallback: Promise, destroy() }。地图加载失败不抛异常——
   * 底层的离线轮廓已经画好了，失败只是少一层底图。
   */
  function renderTrack(track, container) {
    destroy();

    // 第一帧先把离线轮廓画上去
    container.innerHTML = `<div class="map-offline" style="position:absolute;inset:0">${svgPreview(
      track.paths,
      { color: track.color },
    )}</div>`;

    const overlay = document.createElement('div');
    overlay.className = 'map-loading';
    overlay.style.cssText =
      'position:absolute;left:10px;bottom:10px;z-index:5;background:rgba(255,255,255,.9);' +
      'padding:4px 9px;border-radius:999px;font-size:11px;color:#5a6478';
    overlay.textContent = '正在加载地图底图…';
    container.appendChild(overlay);

    const fallback = loadApi()
      .then((TMap) => {
        const canvas = document.createElement('div');
        canvas.style.cssText = 'position:absolute;inset:0';
        container.appendChild(canvas);

        const map = new TMap.Map(canvas, {
          center: new TMap.LatLng(track.center.lat, track.center.lng),
          zoom: track.center.zoom,
          pitch: 0,
          viewMode: '2D',
        });

        // 构建期的 zoom 只是初值，这里按真实容器尺寸精确对框。
        // 包一层 try：不同版本 GL JS 的 fitBounds 签名不完全一致，
        // 失败也只是退回初值，不至于让整条轨迹画不出来。
        try {
          const all = [].concat(...track.paths);
          const lats = all.map((p) => p[0]);
          const lngs = all.map((p) => p[1]);
          const bounds = new TMap.LatLngBounds(
            new TMap.LatLng(Math.min.apply(null, lats), Math.min.apply(null, lngs)),
            new TMap.LatLng(Math.max.apply(null, lats), Math.max.apply(null, lngs)),
          );
          if (map.fitBounds) map.fitBounds(bounds, { padding: 34 });
        } catch (e) {
          /* 保留初值 */
        }

        const geometries = track.paths.map((seg, i) => ({
          id: `seg-${i}`,
          styleId: 'trail',
          paths: seg.map(([lat, lng]) => new TMap.LatLng(lat, lng)),
        }));

        new TMap.MultiPolyline({
          map,
          styles: {
            trail: new TMap.PolylineStyle({
              color: track.color,
              width: 5,
              borderWidth: 1.5,
              borderColor: '#ffffff',
              lineCap: 'round',
            }),
          },
          geometries,
        });

        // 起点 / 终点。环线（松花湖是闭合环线）两点几乎重合，
        // 所以终点用更醒目的红色，并且画在起点的上层。
        const first = track.paths[0] || [];
        const lastSeg = track.paths[track.paths.length - 1] || [];
        const markers = [];
        if (first.length) {
          markers.push({
            id: 'start',
            styleId: 'start',
            position: new TMap.LatLng(first[0][0], first[0][1]),
          });
        }
        if (lastSeg.length) {
          const p = lastSeg[lastSeg.length - 1];
          markers.push({ id: 'end', styleId: 'end', position: new TMap.LatLng(p[0], p[1]) });
        }
        track.waypoints.forEach((w, i) => {
          markers.push({
            id: `wp-${i}`,
            styleId: 'waypoint',
            position: new TMap.LatLng(w.lat, w.lng),
          });
        });

        if (markers.length) {
          new TMap.MultiMarker({
            map,
            styles: {
              start: new TMap.MarkerStyle({
                width: 26,
                height: 34,
                anchor: { x: 13, y: 33 },
                src: pinDataUri('#12a150'),
              }),
              end: new TMap.MarkerStyle({
                width: 26,
                height: 34,
                anchor: { x: 13, y: 33 },
                src: pinDataUri('#e5484d'),
              }),
              waypoint: new TMap.MarkerStyle({
                width: 16,
                height: 16,
                anchor: { x: 8, y: 8 },
                src: dotDataUri(track.color),
              }),
            },
            geometries: markers,
          });
        }

        // 地图就绪后把离线轮廓与提示条撤掉
        const off = container.querySelector('.map-offline');
        if (off) off.remove();
        overlay.remove();

        current = {
          destroy() {
            if (map && map.destroy) map.destroy();
          },
        };
        return map;
      })
      .catch((err) => {
        // 地图挂了不等于页面挂了：轮廓还在，只是少一层底图
        overlay.style.background = 'rgba(253,236,237,.94)';
        overlay.style.color = '#b42318';
        overlay.style.maxWidth = 'calc(100% - 20px)';
        overlay.textContent = `底图未加载：${err.message}`;
        return null;
      });

    return { fallback };
  }

  M.map = { renderTrack, svgPreview, svgProfile, destroy, loadApi };
})();
