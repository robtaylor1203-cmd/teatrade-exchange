-- One-time balance top-up and account unlock for tea_trader_123
UPDATE profiles
SET virtual_balance = 30000,
    cash_balance = 30000,
    account_status = 'ACTIVE'
WHERE username = 'tea_trader_123';
