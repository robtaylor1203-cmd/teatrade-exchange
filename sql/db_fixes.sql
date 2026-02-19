-- ══════════════════════════════════════════════════════════════════
-- FIX 1: apply_trade_flow_impact — price_history rows are immutable.
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apply_trade_flow_impact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_symbol        TEXT;
    v_tea           RECORD;
    v_buy_30m       NUMERIC := 0;
    v_sell_30m      NUMERIC := 0;
    v_net_flow      NUMERIC;
    v_raw_impact    NUMERIC;
    v_flow_effect   NUMERIC;
    v_new_price     NUMERIC;
    c_ref_vol       CONSTANT NUMERIC := 5000;
    c_max_impact    CONSTANT NUMERIC := 0.02;
BEGIN
    IF NEW.tea_id IS NULL THEN RETURN NEW; END IF;

    SELECT symbol INTO v_symbol FROM teas WHERE id = NEW.tea_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT * INTO v_tea FROM teas WHERE id = NEW.tea_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT
        COALESCE(SUM(CASE WHEN side = 'BUY'  THEN quantity ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN side = 'SELL' THEN quantity ELSE 0 END), 0)
    INTO v_buy_30m, v_sell_30m
    FROM trades
    WHERE tea_id    = NEW.tea_id
      AND created_at >= NOW() - INTERVAL '30 minutes';

    v_net_flow    := v_buy_30m - v_sell_30m;
    v_raw_impact  := v_net_flow / c_ref_vol;
    v_flow_effect := TANH(v_raw_impact) * c_max_impact;
    v_new_price   := v_tea.current_price * (1.0 + v_flow_effect);

    v_new_price := GREATEST(
        v_tea.anchor_price * 0.85,
        LEAST(v_tea.anchor_price * 1.15, v_new_price)
    );

    UPDATE teas
    SET    current_price = v_new_price,
           last_update   = NOW()
    WHERE  id = NEW.tea_id;

    -- Write-once: DO NOTHING on conflict so history is never overwritten
    INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
    VALUES (v_symbol, v_new_price, NEW.quantity, NOW(), false)
    ON CONFLICT (symbol, recorded_at) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_flow_impact ON trades;
CREATE TRIGGER trg_trade_flow_impact
    AFTER INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION apply_trade_flow_impact();

-- ══════════════════════════════════════════════════════════════════
-- FIX 2: purge_old_price_history — no-op stub, never deletes data.
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION purge_old_price_history(
    p_retention_days INT DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN jsonb_build_object(
        'success',      true,
        'message',      'Price history is permanent and is never purged.',
        'deleted_rows', 0
    );
END;
$$;
