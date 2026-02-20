-- Fix: platform_revenue.trade_id was UUID but trades.id is integer
ALTER TABLE platform_revenue ALTER COLUMN trade_id TYPE BIGINT USING NULL;
