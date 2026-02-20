-- Drop old function signatures that conflict with the new mode-aware versions.
-- PostgreSQL treats functions with different parameter counts as separate overloads.
-- The old signatures (without p_mode) must be removed to avoid ambiguity.

DROP FUNCTION IF EXISTS execute_trade(UUID, TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS execute_index_trade(UUID, TEXT, TEXT, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS reset_account(UUID, NUMERIC);
DROP FUNCTION IF EXISTS place_order(UUID, TEXT, BOOLEAN, TEXT, TEXT, NUMERIC, NUMERIC, INT);
DROP FUNCTION IF EXISTS close_pair_trade(UUID, TEXT, NUMERIC);
