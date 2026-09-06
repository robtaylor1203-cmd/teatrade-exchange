-- Lower the default starting balance for NEW virtual accounts: $10,000 -> $2,500.
-- This is a fast metadata change (it does NOT rewrite the table), so it's safe
-- to run even while the database is busy.

ALTER TABLE profiles ALTER COLUMN virtual_balance SET DEFAULT 2500;

-- IMPORTANT: if the signup trigger `handle_new_user` inserts virtual_balance
-- explicitly, the column default above is ignored and new users still get the
-- old amount. Check the trigger with:
--
--   SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'handle_new_user';
--
-- If you see "virtual_balance" set to 10000 in there, change that number to 2500
-- (re-create the function with the new value). Paste the output to your dev if unsure.
