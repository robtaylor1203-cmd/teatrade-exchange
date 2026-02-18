# TeaTrade Exchange — System Architecture State (Live)
Last Updated: Feb 2026

## 1. Core Concept
A multi-currency tea exchange that ingests physical auction data (CSV) and simulates live market volatility based on global macro-economics (Forex/Oil).

## 2. Database Schema (Supabase)
**Table: `teas`**
- `symbol` (PK): Text (e.g., KEN-BP1, IND-ASM, SRI-BOP)
- `anchor_price`: Float (The last real auction price in USD)
- `currency_pair`: Text (The driver: 'USD_KES', 'USD_INR', 'USD_LKR')
- `reference_forex`: Float (The exchange rate at the moment of auction upload)
- `current_price`: Float (The live calculated price)
- `last_update`: Timestamptz

**Table: `market_state`**
- `key` (PK): Text (e.g., 'usd_kes', 'brent_crude')
- `value`: Float (Real-time value)

## 3. Data Pipeline (The "Watchdog")
**Location:** `tools/auction_watcher.py`
**Status:** Active & Secure (Env vars)
**Logic:**
1. Watches `auction_drops/` folder for CSV/Excel files.
2. Detects Origin via Filename:
   - "india" -> Divides price by 87.5 (INR) -> Sets pair 'USD_INR'
   - "sri" -> Divides price by 305.0 (LKR) -> Sets pair 'USD_LKR'
   - Default -> Assumes USD (Kenya) -> Sets pair 'USD_KES'
3. Updates `teas` table with new `anchor_price` and `reference_forex`.

## 4. Cloud Engine (Edge Function)
**Location:** `supabase/functions/market-ticker/index.ts`
**Logic:**
1. Generates/Fetches live Forex rates (KES, INR, LKR).
2. Calculates "Drift": `(Live_Rate - Reference_Rate) / Reference_Rate`.
3. Updates `current_price`: `Anchor * (1 + Drift * Volatility)`.
4. Runs every 60 seconds (via Cron).

## 5. Current Environment
- Backend: Supabase (PostgreSQL + Edge Functions)
- Frontend: Next.js 14 (App Router)
- Scripting: Python 3.10+ (Watchdog)
- Auth: Supabase Auth