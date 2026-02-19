-- Migration: Restore full trade flow impact trigger with market_pressure
-- and immutable price_history (DO NOTHING on conflict).

CREATE OR REPLACE FUNCTION apply_trade_flow_impact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_symbol        TEXT;
    v_tea           RECORD;
    v_buy_5m        NUMERIC := 0;
    v_sell_5m       NUMERIC := 0;
    v_buy_30m       NUMERIC := 0;
    v_sell_30m      NUMERIC := 0;
    v_cnt_5m        INT     := 0;
    v_cnt_30m       INT     := 0;
    v_net_flow      NUMERIC;
    v_raw_impact    NUMERIC;
    v_flow_effect   NUMERIC;
    v_new_price     NUMERIC;
    v_ref_vol       CONSTANT NUMERIC := 5000;
    v_max_impact    CONSTANT NUMERIC := 0.02;
BEGIN
    -- Resolve the symbol being traded
    IF NEW.tea_id IS NOT NULL THEN
        SELECT symbol INTO v_symbol FROM teas WHERE id = NEW.tea_id;
    ELSIF NEW.index_symbol IS NOT NULL THEN
        v_symbol := NEW.index_symbol;
    END IF;
    IF v_symbol IS NULL THEN RETURN NEW; END IF;

    -- Aggregate buy/sell volumes over 5-min and 30-min windows
    SELECT
        COALESCE(SUM(quantity) FILTER (WHERE side='BUY'  AND created_at >= NOW()-INTERVAL'5 minutes'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side='SELL' AND created_at >= NOW()-INTERVAL'5 minutes'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side='BUY'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side='SELL'), 0),
        COUNT(*)              FILTER (WHERE created_at >= NOW()-INTERVAL'5 minutes'),
        COUNT(*)
    INTO v_buy_5m, v_sell_5m, v_buy_30m, v_sell_30m, v_cnt_5m, v_cnt_30m
    FROM trades
    WHERE created_at >= NOW() - INTERVAL '30 minutes'
      AND (
          (NEW.tea_id       IS NOT NULL AND tea_id      = NEW.tea_id)
       OR (NEW.index_symbol IS NOT NULL AND index_symbol = v_symbol)
      );

    -- Push to market_pressure (fires Supabase Realtime to frontend)
    INSERT INTO market_pressure
        (symbol, buy_volume_5m, sell_volume_5m,
         buy_volume_30m, sell_volume_30m,
         trade_count_5m, trade_count_30m,
         last_side, last_qty, updated_at)
    VALUES
        (v_symbol, v_buy_5m, v_sell_5m,
         v_buy_30m, v_sell_30m,
         v_cnt_5m,  v_cnt_30m,
         NEW.side, NEW.quantity, NOW())
    ON CONFLICT (symbol) DO UPDATE SET
        buy_volume_5m   = EXCLUDED.buy_volume_5m,
        sell_volume_5m  = EXCLUDED.sell_volume_5m,
        buy_volume_30m  = EXCLUDED.buy_volume_30m,
        sell_volume_30m = EXCLUDED.sell_volume_30m,
        trade_count_5m  = EXCLUDED.trade_count_5m,
        trade_count_30m = EXCLUDED.trade_count_30m,
        last_side       = EXCLUDED.last_side,
        last_qty        = EXCLUDED.last_qty,
        updated_at      = EXCLUDED.updated_at;

    -- Apply price impact for individual tea grades only.
    -- Index prices are composites computed from constituent teas.
    SELECT * INTO v_tea FROM teas WHERE symbol = v_symbol;
    IF NOT FOUND
       OR v_tea.anchor_price IS NULL
       OR v_tea.anchor_price <= 0
       OR v_tea.current_price IS NULL
       OR v_tea.current_price <= 0
    THEN
        RETURN NEW;
    END IF;

    v_net_flow    := v_buy_30m - v_sell_30m;
    v_raw_impact  := v_net_flow / v_ref_vol;
    v_flow_effect := TANH(v_raw_impact) * v_max_impact;
    v_new_price   := v_tea.current_price * (1.0 + v_flow_effect);

    -- Hard guard: stay within ±15% of real-world auction anchor
    v_new_price := GREATEST(v_tea.anchor_price * 0.85,
                    LEAST(  v_tea.anchor_price * 1.15, v_new_price));

    UPDATE teas
    SET  current_price = v_new_price,
         last_update   = NOW()
    WHERE symbol = v_symbol;

    -- Append to immutable price history
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
