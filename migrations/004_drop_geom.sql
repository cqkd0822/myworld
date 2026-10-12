-- geom_json 退役：它是纯构建产物，track_raw 能 100% 复原它。
-- 顺带修掉一个真实的浪费：/api/tracks 用 SELECT *，此前每次打开足迹列表
-- 都要从 D1 拖出 564 KB 几何再整个丢掉。
--
-- 注意上线顺序：先建 track_raw 并灌 seed-raw.sql，再部署新 Worker，
-- 最后才执行本文件——这样旧 Worker 在整个窗口期内都还有 geom_json 可用。
ALTER TABLE tracks DROP COLUMN geom_json;
