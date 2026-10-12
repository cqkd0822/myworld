-- 轨迹几何（paths/profile/waypoints 的 JSON）暂存 D1；R2 开通后迁走
ALTER TABLE tracks ADD COLUMN geom_json TEXT;
