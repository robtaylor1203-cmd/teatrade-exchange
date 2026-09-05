-- ============================================================
-- START / RESTART THE LIVE MARKET TICKER  (fixes "Feed Offline")
-- ============================================================
-- Run this in the Supabase SQL Editor. It schedules the background
-- market-ticker edge function to run every minute so prices stay live.
--
-- BEFORE RUNNING:
--   1. Enable the "pg_cron" and "pg_net" extensions:
--      Dashboard -> Database -> Extensions -> search each -> toggle ON.
--   2. Replace  PASTE_YOUR_SERVICE_ROLE_KEY_HERE  below with your
--      service_role key from  Dashboard -> Project Settings -> API.
--      (Keep the word "Bearer " in front of it.)
-- ============================================================

-- 1. Remove any old schedule (safe if none exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'invoke-market-ticker') THEN
    PERFORM cron.unschedule('invoke-market-ticker');
  END IF;
END $$;

-- 2. Schedule it to run every minute
SELECT cron.schedule(
  'invoke-market-ticker',
  '* * * * *',
  $$
    SELECT net.http_post(
      url    := 'https://uznxzyuknigzlxecjgtb.supabase.co/functions/v1/market-ticker',
      headers:= jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer PASTE_YOUR_SERVICE_ROLE_KEY_HERE'
      ),
      body   := '{}'::jsonb
    );
  $$
);

-- 3. (Optional) Verify it was scheduled
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'invoke-market-ticker';
