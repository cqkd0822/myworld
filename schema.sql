-- MyWorld D1 schema —— 字段与 assets/data/*.js 的数组顺序一一对应，
-- 这样 /api/* 可以直接返回同构数组，前端切换数据源时零改动。

CREATE TABLE IF NOT EXISTS flights (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,             -- YYYY-MM-DD
  airline    TEXT NOT NULL,
  flight_no  TEXT NOT NULL,
  from_raw   TEXT NOT NULL,             -- 含航站楼的原始机场名
  to_raw     TEXT NOT NULL,
  aircraft   TEXT,
  reg        TEXT,
  std        TEXT,                      -- 计划起飞 HH:MM
  sta        TEXT,                      -- 计划到达 HH:MM（可带 +1）
  ata        TEXT,                      -- 实际到达
  cabin      TEXT,
  seat       TEXT,
  price      REAL,                      -- null = 未记录
  delay      INTEGER,                   -- 到达晚点分钟，负=提前
  note       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rail (
  id           INTEGER PRIMARY KEY,
  date         TEXT NOT NULL,
  train        TEXT NOT NULL,
  from_station TEXT NOT NULL,
  to_station   TEXT NOT NULL,
  seat         TEXT,
  note         TEXT DEFAULT '',
  -- 时刻为**可空**：历史车票大多数只有日期，没有发到时刻。
  -- 有了才能用「到达 → 出发 ≤ 60 分」判定换乘；缺了就退回同日同城推定，
  -- 绝不拿近似值填进去。跨零点用 "+1" 后缀，与 flights 的 sta 同一写法。
  dep_time     TEXT,
  arr_time     TEXT
);

CREATE TABLE IF NOT EXISTS rail_voided (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  train        TEXT NOT NULL,
  from_station TEXT NOT NULL,
  to_station   TEXT NOT NULL,
  date         TEXT,
  reason       TEXT DEFAULT ''
);

-- 轨迹表只存**元数据与统计**。几何不存两份：
-- 原始点在 track_raw（唯一的真源），渲染用的抽稀 paths / 海拔剖面由
-- Worker 在 /api/tracks/:id/geometry 里现算并交给边缘缓存。
CREATE TABLE IF NOT EXISTS tracks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  date             TEXT,
  region           TEXT,
  kind             TEXT,                -- hike / run / race / course
  color            TEXT,
  start_time       TEXT,
  end_time         TEXT,
  distance_km      REAL,
  ascent_m         REAL,
  descent_m        REAL,
  min_ele          REAL,
  max_ele          REAL,
  duration_sec     INTEGER,
  moving_time_sec  INTEGER,
  moving_dist_km   REAL,
  moving_speed_kmh REAL,
  rest_time_sec    INTEGER,
  raw_points       INTEGER,
  shown_points     INTEGER,
  segments         INTEGER,
  gpx_key          TEXT,                -- R2 object key（Phase 1 为 gpx/ 路径）
  tolerance_m      REAL,
  ele_threshold_m  REAL,
  center_lat       REAL,
  center_lng       REAL,
  center_zoom      REAL
);

-- 原始轨迹点：一个 trkseg 一行，各自独立 gzip，避免撞 D1 单行 2 MB 上限。
-- 编码格式（1e-6 度增量整数 + 0.1 m 海拔 + 秒级时间增量）与精度论证见 src/raw.js。
-- 61 条轨迹合计 0.74 MB，最大单行 70 KB。
CREATE TABLE IF NOT EXISTS track_raw (
  id       TEXT    NOT NULL,
  part     INTEGER NOT NULL,
  points   INTEGER NOT NULL,
  gzip_b64 TEXT    NOT NULL,
  sha1     TEXT,
  PRIMARY KEY (id, part)
);

-- 发布元信息：published_at / version / 数据来源快照 hash
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_flights_date ON flights(date);
CREATE INDEX IF NOT EXISTS idx_rail_date    ON rail(date);
CREATE INDEX IF NOT EXISTS idx_tracks_date  ON tracks(date);
