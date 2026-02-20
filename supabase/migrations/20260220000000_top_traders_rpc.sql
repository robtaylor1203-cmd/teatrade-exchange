CREATE OR REPLACE FUNCTION top_traders_by_volume(since_ts TIMESTAMPTZ, max_rows INT DEFAULT 5)
RETURNS TABLE(user_id UUID, username TEXT, total_volume NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT
        t.user_id,
        COALESCE(p.username, LEFT(t.user_id::text, 8)) AS username,
        SUM(ABS(t.quantity)) AS total_volume
    FROM trades t
    LEFT JOIN profiles p ON p.id = t.user_id
    WHERE t.created_at >= since_ts
    GROUP BY t.user_id, p.username
    ORDER BY total_volume DESC
    LIMIT max_rows;
$$;
