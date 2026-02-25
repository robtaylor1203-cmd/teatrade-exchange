-- ============================================================
-- ROLLING 24H VOLUME ON TEAS TABLE
-- ============================================================

-- 1. Add column
ALTER TABLE teas ADD COLUMN IF NOT EXISTS volume_24h NUMERIC NOT NULL DEFAULT 0;

-- 2. Function to recalculate from trades table
CREATE OR REPLACE FUNCTION update_volume_24h()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE teas t
    SET volume_24h = COALESCE(v.vol, 0)
    FROM (
        SELECT
            tr.tea_id,
            SUM(ABS(tr.quantity)) AS vol
        FROM trades tr
        WHERE tr.created_at >= NOW() - INTERVAL '24 hours'
          AND tr.tea_id IS NOT NULL
        GROUP BY tr.tea_id
    ) v
    WHERE t.id = v.tea_id;

    -- Zero out teas with no recent trades
    UPDATE teas
    SET volume_24h = 0
    WHERE id NOT IN (
        SELECT DISTINCT tea_id
        FROM trades
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND tea_id IS NOT NULL
    )
    AND volume_24h != 0;
END;
$$;

-- 3. Run once to populate initial values
SELECT update_volume_24h();
