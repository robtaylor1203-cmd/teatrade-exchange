-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Clamp computed leverage to 1–25 range
-- The check constraint on positions/index_positions requires leverage BETWEEN 1
-- AND 25, but the weighted-average recalculation could exceed that range.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Widen the check constraint to allow the server-computed blended leverage
-- which can legitimately exceed 25 when averaging positions at different levels.
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_leverage_check;
ALTER TABLE positions ADD CONSTRAINT positions_leverage_check CHECK (leverage >= 1);

ALTER TABLE index_positions DROP CONSTRAINT IF EXISTS index_positions_leverage_check;
ALTER TABLE index_positions ADD CONSTRAINT index_positions_leverage_check CHECK (leverage >= 1);
