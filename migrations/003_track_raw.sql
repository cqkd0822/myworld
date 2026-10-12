-- Phase 2：D1 里只留**原始坐标**，渲染几何（抽稀 paths + 海拔剖面）改为
-- Worker 现算 + 边缘缓存。
--
-- 依据（61/61 条实测）：把原始点编码成「1e-6 度增量整数 + 0.1 m 海拔 +
-- 秒级时间增量」后解码重算，得到的 paths、elevationProfile、以及
-- 距离/爬升/移动距离/移动速度，与「全精度原始 GPX 直接算」逐字节一致。
-- 也就是说 geom_json 是纯构建产物，raw 能 100% 复原它，没有理由存两份。
--
-- 顺带修掉一个真实的浪费：/api/tracks 用的是 SELECT *，此前每次打开足迹
-- 列表都要从 D1 拖出 564 KB 几何再整个丢掉。
CREATE TABLE IF NOT EXISTS track_raw (
  id       TEXT    NOT NULL,
  part     INTEGER NOT NULL,   -- trkseg 序号：一段一行，各自独立 gzip
  points   INTEGER NOT NULL,
  gzip_b64 TEXT    NOT NULL,   -- 增量整数 JSON 的 gzip + base64（编码见 src/raw.js）
  sha1     TEXT,               -- 内容指纹，用作 ETag
  PRIMARY KEY (id, part)
);
