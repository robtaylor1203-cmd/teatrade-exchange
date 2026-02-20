-- Allow negative quantities in positions for short selling
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_quantity_positive;
ALTER TABLE index_positions DROP CONSTRAINT IF EXISTS index_positions_quantity_positive;

-- quantity != 0 is enforced by DELETE logic in execute_trade / execute_index_trade
