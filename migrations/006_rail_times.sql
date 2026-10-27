-- 铁路时刻：换乘判定需要「前段到达」与「后段出发」的间隔。
-- 两列都可空——历史车票大多没有时刻，前端会退回「同日同城」的推定规则，
-- 不会用估算值填。有据可查时再单独 UPDATE 补录。
--
-- 执行：npx wrangler d1 execute myworld --remote --file=migrations/006_rail_times.sql
ALTER TABLE rail ADD COLUMN dep_time TEXT;
ALTER TABLE rail ADD COLUMN arr_time TEXT;
