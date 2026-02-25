-- Share bonus: credit $1,000 when users share (1-hour cooldown)

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_share_bonus_at TIMESTAMPTZ DEFAULT NULL;

CREATE OR REPLACE FUNCTION credit_share_bonus(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_last TIMESTAMPTZ;
BEGIN
    SELECT last_share_bonus_at INTO v_last
    FROM profiles WHERE id = p_user_id FOR UPDATE;

    IF v_last IS NOT NULL AND v_last > NOW() - INTERVAL '1 hour' THEN
        RETURN FALSE;
    END IF;

    UPDATE profiles
    SET virtual_balance     = virtual_balance + 1000,
        cash_balance        = cash_balance + 1000,
        last_share_bonus_at = NOW()
    WHERE id = p_user_id;

    RETURN TRUE;
END;
$$;
