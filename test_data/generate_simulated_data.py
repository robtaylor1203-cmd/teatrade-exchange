"""
generate_simulated_data.py
==========================
Generates realistic synthetic DAILY price history for every tea symbol and
index going back 3 years from today.

Why daily?
  • 1Y / 3M views bucket into daily candles — fully populated
  • 1M view shows ~30 daily candles — looks like real trading history
  • 1W view shows ~5 daily candles — supplements the live edge-function ticks

All rows are inserted with is_simulated = TRUE.
When you import real auction data (import_auction_data.py), any row where
is_simulated = TRUE at the same (symbol, recorded_at) timestamp is
automatically overwritten with the real auction price.

IMPORTANT: Run the SQL below in the Supabase SQL editor FIRST:

    ALTER TABLE price_history
        ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT false;

    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'price_history'::regclass
              AND contype   = 'u'
              AND conname   = 'price_history_symbol_recorded_at_key'
        ) THEN
            ALTER TABLE price_history
                ADD CONSTRAINT price_history_symbol_recorded_at_key
                UNIQUE (symbol, recorded_at);
        END IF;
    END $$;

    NOTIFY pgrst, 'reload schema';

Then run:
    $env:SUPABASE_SERVICE_KEY="..."
    python test_data/generate_simulated_data.py
"""

import os, sys, random, math, requests
from datetime import date, timedelta

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://uznxzyuknigzlxecjgtb.supabase.co")
SERVICE_KEY  = os.getenv("SUPABASE_SERVICE_KEY", "")
if not SERVICE_KEY:
    print("[ERROR] SUPABASE_SERVICE_KEY is not set.")
    sys.exit(1)

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

# ── Symbol catalogue ──────────────────────────────────────────────────────────
# current_price : live anchor value (same unit as what price_history stores)
# vol           : DAILY volatility (std-dev of log-return per trading day)
# volume        : typical daily kg traded (±20% noise added)
#
# Index notes:
#   KOLKATA  - stored in INR (~540)
#   FUTURES  - stored as full dollar value (~5083)
#   All others stored in USD
# ─────────────────────────────────────────────────────────────────────────────
SYMBOLS = [
    # ── Kenya grades ─────────────────────────────────────────────
    {"symbol": "KEN-BP1",  "current_price": 2.02,   "vol": 0.011, "volume": 850_000},
    {"symbol": "KEN-PF1",  "current_price": 2.32,   "vol": 0.011, "volume": 720_000},
    {"symbol": "KEN-DUST", "current_price": 2.18,   "vol": 0.010, "volume": 650_000},
    {"symbol": "KEN-PD",   "current_price": 1.98,   "vol": 0.013, "volume": 300_000},
    {"symbol": "KEN-BMF",  "current_price": 0.97,   "vol": 0.015, "volume": 80_000},
    {"symbol": "KEN-FNGS", "current_price": 1.40,   "vol": 0.013, "volume": 60_000},
    # ── Africa grades ────────────────────────────────────────────
    {"symbol": "MLW-BP1",  "current_price": 1.85,   "vol": 0.012, "volume": 400_000},
    {"symbol": "RWA-OP",   "current_price": 2.10,   "vol": 0.013, "volume": 250_000},
    # ── Indian grades ────────────────────────────────────────────
    {"symbol": "IND-ASM",  "current_price": 4.81,   "vol": 0.010, "volume": 600_000},
    {"symbol": "IND-DRJ",  "current_price": 8.23,   "vol": 0.013, "volume": 200_000},
    # ── Sri Lankan grades ────────────────────────────────────────
    {"symbol": "SRI-BOP",  "current_price": 3.80,   "vol": 0.011, "volume": 500_000},
    {"symbol": "SRI-PEK",  "current_price": 3.20,   "vol": 0.011, "volume": 350_000},
    # ── Kenya / Africa indexes ───────────────────────────────────
    {"symbol": "KENYA",    "current_price": 2.05,   "vol": 0.009, "volume": 5_500_000},
    {"symbol": "MOMBASA",  "current_price": 2.05,   "vol": 0.009, "volume": 5_500_000},
    {"symbol": "AFRICA",   "current_price": 2.05,   "vol": 0.009, "volume": 3_000_000},
    # ── India indexes ────────────────────────────────────────────
    {"symbol": "KOLKATA",  "current_price": 540.0,  "vol": 0.009, "volume": 3_000_000},
    {"symbol": "INDIA",    "current_price": 6.52,   "vol": 0.009, "volume": 2_000_000},
    # ── Ceylon indexes ───────────────────────────────────────────
    {"symbol": "COLOMBO",  "current_price": 5.14,   "vol": 0.010, "volume": 4_000_000},
    {"symbol": "CEYLON",   "current_price": 3.50,   "vol": 0.010, "volume": 2_500_000},
    # ── China index ──────────────────────────────────────────────
    {"symbol": "CHINA",    "current_price": 5.54,   "vol": 0.009, "volume": 2_000_000},
    # ── Asia / Global indexes ────────────────────────────────────
    {"symbol": "ASIA",     "current_price": 6.00,   "vol": 0.008, "volume": 4_000_000},
    {"symbol": "FUTURES",  "current_price": 5083.0, "vol": 0.007, "volume": 2_000_000},
]

YEARS_BACK = 3      # years of history to generate
BATCH_SIZE = 500    # rows per API call


# ── Date helpers ──────────────────────────────────────────────────────────────

def trading_days(years_back: int):
    """Every weekday (Mon–Fri) from years_back years ago up to yesterday."""
    today = date.today()
    start = today - timedelta(days=years_back * 365)
    days  = []
    d = start
    while d < today:
        if d.weekday() < 5:   # 0=Mon … 4=Fri
            days.append(d)
        d += timedelta(days=1)
    return days


# ── Random walk ───────────────────────────────────────────────────────────────

def generate_walk(current_price: float, n_days: int, vol: float, seed: int):
    """
    Generate n_days prices ending near current_price via a reversed random walk.
    Prices are always kept positive.
    """
    rng = random.Random(seed)
    prices = [current_price]
    for _ in range(n_days - 1):
        log_r = rng.gauss(0, vol)
        prices.append(max(prices[-1] * math.exp(log_r), current_price * 0.1))
    prices.reverse()
    return prices


# ── Supabase upsert ───────────────────────────────────────────────────────────

def upsert_batch(records: list) -> bool:
    """Upsert a batch; real data (is_simulated=false) is never overwritten."""
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/price_history",
        headers={**HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=records,
        params={"on_conflict": "symbol,recorded_at"},
    )
    if not resp.ok:
        print(f"  [ERROR] {resp.status_code} {resp.text[:200]}")
        return False
    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    days = trading_days(YEARS_BACK)
    n    = len(days)
    print(f"Generating {n} daily data points per symbol")
    print(f"  Range : {days[0]} to {days[-1]}")
    print(f"  Symbols: {len(SYMBOLS)}")
    print(f"  Total rows: ~{n * len(SYMBOLS):,}\n")

    rng = random.Random(42)

    for sym in SYMBOLS:
        symbol = sym["symbol"]
        prices = generate_walk(sym["current_price"], n, sym["vol"],
                               seed=hash(symbol) & 0xFFFFFF)
        base_vol = sym["volume"]

        records = []
        for i, d in enumerate(days):
            # 09:00 UTC = noon Nairobi (UTC+3) / mid-morning London
            ts = f"{d.isoformat()}T09:00:00+00:00"
            p  = round(prices[i], 4)
            v  = max(0, base_vol + rng.randint(-int(base_vol * 0.2),
                                                int(base_vol * 0.2)))
            records.append({
                "symbol":       symbol,
                "price":        p,
                "volume":       v,
                "recorded_at":  ts,
                "is_simulated": True,
            })

        # Send in batches
        sent = 0
        ok   = True
        for start in range(0, len(records), BATCH_SIZE):
            batch = records[start:start + BATCH_SIZE]
            if not upsert_batch(batch):
                ok = False
                break
            sent += len(batch)

        status = "[OK]  " if ok else "[FAIL]"
        print(f"  {status} {symbol:12s}  {sent}/{n} rows")

    print("\n[DONE] Simulated history loaded.")
    print("Run import_auction_data.py to overwrite any matching real-data weeks.")


if __name__ == "__main__":
    main()
