-- ============================================================
-- ORDER FLOW REAL-TIME ENGINE
-- Paste this entire file into the Supabase SQL Editor and run.
-- ============================================================
-- What this creates:
--   1. market_pressure table  - live buy/sell aggregates per
--      symbol, updated the instant any trade is inserted.
--      The frontend subscribes to this via Supabase Realtime.
--   2. apply_trade_flow_impact() trigger function that:
--        a. Recalculates 5-min and 30-min buy/sell volumes.
--        b. Writes them to market_pressure (fires Realtime push
--           to every connected browser within ~50-100ms).
--        c. Applies Kyle's-Lambda tanh-bounded flow impact
--           directly to teas.current_price in the same
--           transaction - no cron lag whatsoever.
--        d. Appends a price_history row for chart continuity.
--   3. Trigger attached to trades table (AFTER INSERT).
-- ============================================================


-- ── 1. market_pressure table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS market_pressure (
    symbol          TEXT        PRIMARY KEY,
    buy_volume_5m   NUMERIC     NOT NULL DEFAULT 0,
    sell_volume_5m  NUMERIC     NOT NULL DEFAULT 0,
    buy_volume_30m  NUMERIC     NOT NULL DEFAULT 0,
    sell_volume_30m NUMERIC     NOT NULL DEFAULT 0,
    trade_count_5m  INT         NOT NULL DEFAULT 0,
    trade_count_30m INT         NOT NULL DEFAULT 0,
    last_side       TEXT        CHECK (last_side IN ('BUY','SELL')),
    last_qty        NUMERIC     DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full replica identity so Realtime broadcasts old + new row values
ALTER TABLE market_pressure REPLICA IDENTITY FULL;

ALTER TABLE market_pressure ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market_pressure_read"  ON market_pressure;
DROP POLICY IF EXISTS "market_pressure_write" ON market_pressure;

-- Any authenticated user can read aggregated market flow data
CREATE POLICY "market_pressure_read"
    ON market_pressure FOR SELECT
    TO authenticated USING (true);

-- Only the service role (trigger / edge function) can write
CREATE POLICY "market_pressure_write"
    ON market_pressure FOR ALL
    TO service_role USING (true);

-- Index for fast symbol lookups
CREATE INDEX IF NOT EXISTS idx_market_pressure_updated
    ON market_pressure (updated_at DESC);


-- ── 2. Trigger function ───────────────────────────────────────────────────────

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
    -- Kyle's Lambda parameters - kept identical to edge function constants
    v_ref_vol       CONSTANT NUMERIC := 5000;  -- kg normalisation reference
    v_max_impact    CONSTANT NUMERIC := 0.02;  -- max +/-2% flow impact per event
BEGIN

    -- ── Resolve the symbol being traded ──────────────────────────────────────
    IF NEW.tea_id IS NOT NULL THEN
        SELECT symbol INTO v_symbol FROM teas WHERE id = NEW.tea_id;
    ELSIF NEW.index_symbol IS NOT NULL THEN
        v_symbol := NEW.index_symbol;
    END IF;

    -- Nothing to do if we cannot identify the symbol
    IF v_symbol IS NULL THEN
        RETURN NEW;
    END IF;

    -- ── Aggregate buy/sell volumes for 5-min and 30-min windows ─────────────
    -- Full re-scan on every trade insert so numbers are always current.
    SELECT
        COALESCE(SUM(quantity) FILTER (WHERE side = 'BUY'  AND created_at >= NOW() - INTERVAL '5 minutes'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side = 'SELL' AND created_at >= NOW() - INTERVAL '5 minutes'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side = 'BUY'),  0),
        COALESCE(SUM(quantity) FILTER (WHERE side = 'SELL'), 0),
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes'),
        COUNT(*)
    INTO v_buy_5m, v_sell_5m, v_buy_30m, v_sell_30m, v_cnt_5m, v_cnt_30m
    FROM trades
    WHERE created_at >= NOW() - INTERVAL '30 minutes'
      AND (
          (NEW.tea_id       IS NOT NULL AND tea_id       = NEW.tea_id)
       OR (NEW.index_symbol IS NOT NULL AND index_symbol = v_symbol)
      );

    -- ── Push updated aggregates to market_pressure ───────────────────────────
    -- This INSERT/UPDATE fires the Supabase Realtime event that every
    -- connected browser receives within ~50-100 ms.
    INSERT INTO market_pressure
        (symbol,
         buy_volume_5m,  sell_volume_5m,
         buy_volume_30m, sell_volume_30m,
         trade_count_5m, trade_count_30m,
         last_side, last_qty, updated_at)
    VALUES
        (v_symbol,
         v_buy_5m,  v_sell_5m,
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

    -- ── Price impact: individual tea grades only ──────────────────────────────
    -- Index symbols (KENYA, MOMBASA …) are computed composites of tea prices,
    -- not rows in the teas table, so we skip them here.
    SELECT * INTO v_tea FROM teas WHERE symbol = v_symbol;
    IF NOT FOUND
       OR v_tea.anchor_price  IS NULL OR v_tea.anchor_price  <= 0
       OR v_tea.current_price IS NULL OR v_tea.current_price <= 0
    THEN
        RETURN NEW;
    END IF;

    -- Kyle's Lambda with tanh bounding over the 30-min window
    v_net_flow    := v_buy_30m - v_sell_30m;
    v_raw_impact  := v_net_flow / v_ref_vol;
    v_flow_effect := tanh(v_raw_impact) * v_max_impact;

    v_new_price := v_tea.current_price * (1.0 + v_flow_effect);

    -- Hard guard: price must remain within +/-15% of real auction anchor
    v_new_price := GREATEST(v_tea.anchor_price * 0.85,
                    LEAST(  v_tea.anchor_price * 1.15, v_new_price));

    -- Commit the live price update
    -- This also fires the existing teas Realtime subscription on the frontend,
    -- so charts and quote cards update automatically at the same instant.
    UPDATE teas
    SET  current_price = v_new_price,
         last_update   = NOW()
    WHERE symbol = v_symbol;

    -- Append to immutable price history for chart time-series continuity
    INSERT INTO price_history (symbol, price, volume, recorded_at, is_simulated)
    VALUES (v_symbol, v_new_price, NEW.quantity, NOW(), false)
    ON CONFLICT (symbol, recorded_at)
    DO UPDATE SET
        price        = EXCLUDED.price,
        volume       = price_history.volume + EXCLUDED.volume,
        is_simulated = false;

    RETURN NEW;
END;
$$;


-- ── 3. Attach trigger to trades table ────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_trade_flow_impact ON trades;

CREATE TRIGGER trg_trade_flow_impact
    AFTER INSERT ON trades
    FOR EACH ROW
    EXECUTE FUNCTION apply_trade_flow_impact();
