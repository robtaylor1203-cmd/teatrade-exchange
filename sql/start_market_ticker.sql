-- START MARKET TICKER CRON JOB
-- Please run this in your Supabase SQL Editor to restart the live ticker.
-- It ensures the background market-ticker edge function is invoked every 60 seconds
-- so that prices are "ticking and live" even when no users are trading manually.

-- 1. Remove any old broken schedules for this ticker (safely)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'invoke-market-ticker') THEN
    PERFORM cron.unschedule('invoke-market-ticker');
  END IF;
END $$;

-- 2. Create the new schedule
SELECT cron.schedule(
  'invoke-market-ticker',
  '* * * * *', -- Every minute
  $$
    SELECT net.http_post(
      url:='https://uznxzyuknigzlxecjgtb.supabase.co/functions/v1/market-ticker',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY", "x-ticker-secret": "YOUR_TICKER_SECRET_IF_ANY"}',
      body:='{}'
    );
  $$
);

-- NOTE: Ensure you replace "YOUR_SERVICE_ROLE_KEY" with your actual Supabase service_role key
-- if the edge function requires authentication.
