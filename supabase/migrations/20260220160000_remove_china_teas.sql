-- ═══════════════════════════════════════════════════════════════════════════════
-- REMOVE CHINA TEAS
-- No price transparency on Chinese teas — remove from tradable instruments
-- ═══════════════════════════════════════════════════════════════════════════════

-- Clean up referencing rows, then delete the teas
DELETE FROM pending_orders  WHERE symbol LIKE 'CHN-%';
DELETE FROM positions       WHERE tea_id IN (SELECT id FROM teas WHERE symbol LIKE 'CHN-%');
DELETE FROM trades          WHERE tea_id IN (SELECT id FROM teas WHERE symbol LIKE 'CHN-%');
DELETE FROM market_pressure WHERE symbol LIKE 'CHN-%';
DELETE FROM price_history   WHERE symbol LIKE 'CHN-%';
DELETE FROM teas            WHERE symbol LIKE 'CHN-%';
