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
  note         TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rail_voided (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  train        TEXT NOT NULL,
  from_station TEXT NOT NULL,
  to_station   TEXT NOT NULL,
  date         TEXT,
  reason       TEXT DEFAULT ''
);

-- 轨迹只存元数据与统计；几何(paths/profile)体积大，Phase 1 仍由
-- 生成态 tracks.js / 后续 R2 提供，D1 不重复存。
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

-- 发布元信息：published_at / version / 数据来源快照 hash
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_flights_date ON flights(date);
CREATE INDEX IF NOT EXISTS idx_rail_date    ON rail(date);
CREATE INDEX IF NOT EXISTS idx_tracks_date  ON tracks(date);
