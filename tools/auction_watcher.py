"""
TeaTrade Exchange — Global Watchdog & Heartbeat
===============================================
1. Watches for Auction CSV files (Kenya, India, Sri Lanka).
2. Sends a "Heartbeat" to the Cloud Engine every 60s to keep prices ticking.
3. Securely loads keys from .env.
"""

import os
import sys
import time
import logging
import requests
from pathlib import Path
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ── CONFIGURATION ────────────────────────────────────────────────────

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "").strip()
TICKER_SECRET = os.getenv("TICKER_SECRET", "").strip()
WATCH_FOLDER = os.getenv("WATCH_FOLDER", r".\auction_drops").strip()
FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/market-ticker"

# Global Config
RATES_CONFIG = {
    "KENYA":     {"code": "USD_KES", "rate": 1.0},
    "INDIA":     {"code": "USD_INR", "rate": 87.5},
    "SRILANKA":  {"code": "USD_LKR", "rate": 305.0},
    "CHINA":     {"code": "USD_CNY", "rate": 7.2},
}

# ── LOGGING ──────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("auction_watcher")

# ── CONNECT ──────────────────────────────────────────────────────────
if not SUPABASE_URL or not SUPABASE_KEY:
    log.error("❌ Missing .env credentials.")
    sys.exit(1)

try:
    sb: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception as e:
    log.error(f"Failed to connect: {e}")
    sys.exit(1)

# ── FILE HANDLING (THE WATCHDOG) ─────────────────────────────────────

GRADE_SYMBOL_MAP = {
    "BP1": "KEN-BP1", "PF1": "KEN-PF1", "PD": "KEN-DUST", "DUST": "KEN-DUST",
    "ASM": "IND-ASM", "ASSAM": "IND-ASM", "DRJ": "IND-DRJ", "DARJEELING": "IND-DRJ",
    "BOP": "SRI-BOP", "PEK": "SRI-PEK", "OP": "SRI-OP"
}

def get_strategy(filename: str):
    fname = filename.lower()
    if "india" in fname or "kolkata" in fname: return RATES_CONFIG["INDIA"]
    if "sri" in fname or "lanka" in fname:     return RATES_CONFIG["SRILANKA"]
    if "china" in fname:                       return RATES_CONFIG["CHINA"]
    return RATES_CONFIG["KENYA"]

def parse_and_upload(filepath: str):
    """Parse auction file and atomically update teas + audit log.
    
    On any error during the batch, previously updated rows in this batch
    are rolled back by restoring their prior anchor_price / reference_forex.
    """
    filename = Path(filepath).name
    strategy = get_strategy(filename)
    rate = strategy["rate"]
    pair = strategy["code"]
    
    log.info(f"Origin: {filename} -> Using {pair} (Divisor: {rate})")

    try:
        ext = Path(filepath).suffix.lower()
        if ext in (".xlsx", ".xls"): df = pd.read_excel(filepath)
        elif ext == ".csv": df = pd.read_csv(filepath)
        else: return

        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
        grade_col = next((c for c in df.columns if "grade" in c), None)
        price_col = next((c for c in df.columns if "price" in c or "sold" in c), None)

        if not grade_col or not price_col:
            log.warning(f"Could not find grade/price columns in {filename}")
            return

        grouped = df.groupby(grade_col)[price_col].mean()
        updates = []
        
        for grade, raw_price in grouped.items():
            symbol = GRADE_SYMBOL_MAP.get(str(grade).strip().upper())
            if not symbol:
                continue

            try:
                numeric_price = float(raw_price)
            except (ValueError, TypeError):
                log.warning(f"   Skipping {symbol}: non-numeric price '{raw_price}'")
                continue

            if numeric_price <= 0:
                log.warning(f"   Skipping {symbol}: negative/zero price ({numeric_price})")
                continue

            if rate <= 0:
                log.error(f"   Skipping {symbol}: invalid rate ({rate})")
                continue

            usd_price = numeric_price / rate

            if usd_price < 0.01 or usd_price > 500:
                log.warning(f"   Skipping {symbol}: price ${usd_price:.2f} outside bounds ($0.01-$500)")
                continue

            ref_forex = 129.45 if pair == "USD_KES" else rate
            updates.append({
                "symbol": symbol,
                "anchor_price": usd_price,
                "reference_forex": ref_forex,
                "currency_pair": pair,
                "raw_price": numeric_price,
            })

        if not updates:
            log.warning(f"No valid updates parsed from {filename}")
            return

        # Fetch current values for rollback tracking
        symbols = [u["symbol"] for u in updates]
        current_rows = sb.table("teas").select("id, symbol, anchor_price, reference_forex") \
            .in_("symbol", symbols).execute()
        prior_state = {r["symbol"]: r for r in (current_rows.data or [])}

        applied = []
        try:
            for u in updates:
                old = prior_state.get(u["symbol"], {})
                log.info(f"   -> {u['symbol']}: {u['raw_price']} local = ${u['anchor_price']:.2f} USD")

                sb.table("teas").update({
                    "anchor_price": u["anchor_price"],
                    "reference_forex": u["reference_forex"],
                    "currency_pair": u["currency_pair"],
                    "last_update": "now()"
                }).eq("symbol", u["symbol"]).execute()

                # Write audit trail
                sb.table("anchor_price_audit").insert({
                    "tea_id": old.get("id", 0),
                    "tea_symbol": u["symbol"],
                    "old_anchor_price": old.get("anchor_price"),
                    "new_anchor_price": u["anchor_price"],
                    "old_reference_forex": old.get("reference_forex"),
                    "new_reference_forex": u["reference_forex"],
                    "changed_by": "watchdog",
                    "source_file": filename,
                }).execute()

                applied.append(u["symbol"])

            log.info(f"Uploaded {len(applied)} items from {filename}.")

        except Exception as batch_err:
            log.error(f"Batch error after {len(applied)} updates: {batch_err}")
            log.info("Rolling back applied updates...")
            for sym in applied:
                old = prior_state.get(sym)
                if old:
                    try:
                        sb.table("teas").update({
                            "anchor_price": old["anchor_price"],
                            "reference_forex": old["reference_forex"],
                        }).eq("symbol", sym).execute()
                        log.info(f"   Rolled back {sym}")
                    except Exception as rb_err:
                        log.error(f"   Rollback FAILED for {sym}: {rb_err}")
            raise

    except Exception as e:
        log.error(f"Error processing {filepath}: {e}")

class Handler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory or not event.src_path.endswith((".csv", ".xls", ".xlsx")): return
        time.sleep(1)
        parse_and_upload(event.src_path)

# ── THE HEARTBEAT (KEEPS THE MARKET OPEN) ────────────────────────────

def send_heartbeat():
    """Pings the Cloud Engine to force a price tick."""
    try:
        # We use the REST API to trigger the function
        headers = {
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "apikey": SUPABASE_KEY,
            "Content-Type": "application/json",
        }
        if TICKER_SECRET:
            headers["x-ticker-secret"] = TICKER_SECRET
        response = requests.post(FUNCTION_URL, headers=headers, json={})
        
        if response.status_code == 200:
            data = response.json()
            source = data.get("source", "UNKNOWN")
            count = data.get("updated_count", 0)
            log.info(f"💓 Heartbeat: Market Ticked ({source}). Updated {count} teas.")
        else:
            log.warning(f"⚠️ Heartbeat Missed: {response.status_code} - {response.text}")
            
    except Exception as e:
        log.error(f"⚠️ Heartbeat Failed: {e}")

# ── MAIN LOOP ────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not os.path.exists(WATCH_FOLDER): os.makedirs(WATCH_FOLDER)
    
    log.info(f"🔒 GLOBAL WATCHDOG & HEARTBEAT ACTIVE.")
    log.info(f"   Monitoring: {WATCH_FOLDER}")
    log.info(f"   Heartbeat: Pinging cloud every 60s...")
    
    observer = Observer()
    observer.schedule(Handler(), WATCH_FOLDER, recursive=False)
    observer.start()

    # The Heartbeat Loop
    try:
        while True:
            send_heartbeat() # Tick the market
            time.sleep(30)   # Wait 1 minute
    except KeyboardInterrupt:
        observer.stop()
        observer.join()
        log.info("Stopped.")