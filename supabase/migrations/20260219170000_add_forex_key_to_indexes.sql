-- Add forex_key column to indexes table for live currency conversion
ALTER TABLE indexes ADD COLUMN IF NOT EXISTS forex_key TEXT DEFAULT NULL;

-- Update COLOMBO to display in LKR
UPDATE indexes
SET currency   = 'Rs',
    forex_key  = 'usd_lkr'
WHERE symbol = 'COLOMBO';

-- Update KOLKATA to use live INR rate
UPDATE indexes
SET forex_key = 'usd_inr'
WHERE symbol = 'KOLKATA';
