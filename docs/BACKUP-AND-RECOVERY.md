# TeaTrade Exchange — Backup & Recovery Runbook

## 1. Architecture Overview

| Component | Location | Data |
|-----------|----------|------|
| PostgreSQL (Supabase) | `uznxzyuknigzlxecjgtb.supabase.co` | All user data, trades, positions, prices |
| Edge Functions | Supabase Edge (Deno) | Stateless — redeployed from `supabase/functions/` |
| Auction Watcher | Local machine / server | Stateless — `tools/auction_watcher.py` |
| Frontend | Static files (`index.html`, `js/`, `styles.css`) | No persistent data |
| Secrets | Supabase Vault | `ALPHA_KEY`, `TICKER_SECRET`, `ALLOWED_ORIGIN`, `SUPABASE_SERVICE_ROLE_KEY` |

## 2. Automated Backups (Supabase-Managed)

Supabase Pro plans include automatic daily backups with point-in-time recovery (PITR).

**Check your plan:**
- Dashboard → Project Settings → Database → Backups
- Free plans: daily backups, 7-day retention
- Pro plans: PITR with up to 7 days of WAL archiving

## 3. Manual Database Backup

### Full schema + data export

```bash
# Requires psql and your database connection string
# Find it: Dashboard → Settings → Database → Connection string → URI

pg_dump "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres" \
  --no-owner --no-acl \
  -F custom \
  -f teatrade_backup_$(date +%Y%m%d_%H%M%S).dump
```

### Schema-only export

```bash
pg_dump "postgresql://..." --schema-only -f schema_backup.sql
```

### Data-only export (for specific tables)

```bash
pg_dump "postgresql://..." --data-only \
  -t profiles -t positions -t trades -t index_positions \
  -f user_data_backup.sql
```

### Recommended backup schedule

| What | Frequency | Retention |
|------|-----------|-----------|
| Full database | Daily (automated by Supabase) | 7 days |
| Manual `pg_dump` | Weekly | 4 weeks |
| Schema export | After every migration | Indefinite (git) |
| Price history archive | Monthly (via `purge_old_price_history()`) | 90 days granular, indefinite hourly |

## 4. Recovery Procedures

### 4.1 — Restore from Supabase Automated Backup

1. Go to Dashboard → Project Settings → Database → Backups
2. Select the desired restore point
3. Click "Restore" (this replaces the current database)
4. **Warning:** This overwrites all data since the backup point

### 4.2 — Restore from Manual pg_dump

```bash
# Drop and recreate (DESTRUCTIVE — only use on empty/test database)
pg_restore -d "postgresql://..." --clean --if-exists teatrade_backup.dump

# Or restore to a specific schema (safer)
pg_restore -d "postgresql://..." --schema=public teatrade_backup.dump
```

### 4.3 — Restore Individual Tables

```bash
# Restore only the trades table
pg_restore -d "postgresql://..." -t trades teatrade_backup.dump
```

### 4.4 — Redeploy Edge Functions

If Edge Functions are lost or corrupted:

```bash
cd teatrade-exchange
supabase login
supabase link --project-ref uznxzyuknigzlxecjgtb

supabase functions deploy execute-trade --no-verify-jwt
supabase functions deploy execute-index-trade --no-verify-jwt
supabase functions deploy market-ticker --no-verify-jwt
supabase functions deploy health --no-verify-jwt
```

### 4.5 — Restore Secrets

```bash
supabase secrets set ALPHA_KEY=<your_alphavantage_key>
supabase secrets set TICKER_SECRET=<your_ticker_secret>
supabase secrets set ALLOWED_ORIGIN=*
```

### 4.6 — Re-run Database Migration

If the schema needs to be rebuilt from scratch:

1. Open Supabase Dashboard → SQL Editor
2. Paste the contents of `supabase_migration.sql`
3. Execute — this uses `CREATE TABLE IF NOT EXISTS` and `CREATE OR REPLACE FUNCTION` so it is safe to re-run

## 5. Disaster Scenarios

### Scenario A: Database corruption / accidental data deletion

1. **Immediate:** Disable the auction watcher (`Ctrl+C` the Python script)
2. **Assess:** Check which tables are affected via Dashboard → Table Editor
3. **Restore:** Use Supabase PITR (if on Pro) or latest automated backup
4. **Verify:** Run `SELECT count(*) FROM profiles; SELECT count(*) FROM trades;`
5. **Resume:** Restart the auction watcher

### Scenario B: Edge Function failure (trades not executing)

1. **Check:** `curl https://uznxzyuknigzlxecjgtb.supabase.co/functions/v1/health`
2. **Logs:** Dashboard → Edge Functions → Select function → Logs
3. **Fix:** Correct the code locally, then `supabase functions deploy <name> --no-verify-jwt`
4. **Verify:** Test a trade from the frontend

### Scenario C: Supabase project compromised (secrets leaked)

1. **Rotate immediately:**
   - Dashboard → Settings → API → Regenerate anon key and service role key
   - Update `js/config.js` with the new anon key
   - Update `tools/.env` with the new keys
   - `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<new_key>`
2. **Review:** Check `auth.users` for unauthorized accounts
3. **Audit:** Review `trades` table for suspicious activity
4. **Redeploy:** All Edge Functions (they read secrets at runtime)

### Scenario D: Price feed failure (stale prices)

1. **Check:** Is the auction watcher running? Check the terminal for heartbeat logs
2. **Check:** Dashboard → Table Editor → `market_state` → `last_ticker_run`
3. **Manual tick:** `curl -X POST -H "x-ticker-secret: <secret>" -H "apikey: <anon_key>" https://uznxzyuknigzlxecjgtb.supabase.co/functions/v1/market-ticker`
4. **Restart watcher:** `cd tools && python auction_watcher.py`

## 6. Data Retention & Archival

The `purge_old_price_history()` function archives granular price data:

```sql
-- Run monthly to archive data older than 90 days into hourly OHLC summaries
SELECT purge_old_price_history(90);
```

This moves 1-minute candles into the `price_history_daily` table as hourly aggregates, then deletes the raw rows. Schedule this via a Supabase cron job or manual execution.

## 7. Monitoring Checklist

| Check | Method | Frequency |
|-------|--------|-----------|
| Edge Functions healthy | `GET /functions/v1/health` | Every 5 min (uptime monitor) |
| Price feed active | `market_state.last_ticker_run` < 2 min ago | Every 5 min |
| Database size | Dashboard → Reports → Database | Weekly |
| Auth anomalies | Dashboard → Authentication → Users | Weekly |
| Backup status | Dashboard → Settings → Backups | Weekly |
| Edge Function logs | Dashboard → Edge Functions → Logs | On error |

## 8. Contact & Escalation

- **Supabase status:** https://status.supabase.com
- **Supabase support:** Dashboard → Support (Pro plan required for priority)
- **Emergency database access:** Use the direct connection string (not pooled) for administrative operations
