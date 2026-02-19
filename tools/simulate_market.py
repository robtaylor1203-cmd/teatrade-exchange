"""
TeaTrade Exchange — Market Simulation Engine
============================================
Creates a burst of realistic, randomised trading activity across all symbols
to stress-test the live platform: price movements, market depth bars, Realtime
subscriptions, leaderboard, and chart updates.

ALL simulation data is tagged with the email domain @teatrade.sim so it can be
wiped instantly without touching any real user data.

USAGE
-----
  # Run a simulation (default: 20 bots, 5 min, medium intensity)
  python tools/simulate_market.py

  # Custom run
  python tools/simulate_market.py --bots 50 --duration 300 --intensity high

  # Wipe all simulation data (one command, safe to re-run)
  python tools/simulate_market.py --cleanup

CLEANUP ALTERNATIVE
-------------------
  Run this in the Supabase SQL Editor:
      SELECT cleanup_simulation_bots();

ISOLATION GUARANTEE
-------------------
  - All bots have emails ending in @teatrade.sim
  - All trades are tagged with a sim_session UUID in the notes field
  - Cleanup deletes: auth.users, profiles, trades, positions for all sim bots
  - Real user data is NEVER touched
"""

import os
import sys
import time
import uuid
import random
import argparse
import logging
from datetime import datetime, timezone
from typing import Optional

import requests
from dotenv import load_dotenv

# ── CONFIG ────────────────────────────────────────────────────────────────────

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))

SUPABASE_URL  = os.getenv('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY  = os.getenv('SUPABASE_KEY', '')   # service role key

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_KEY must be set in tools/.env")
    sys.exit(1)

REST   = f"{SUPABASE_URL}/rest/v1"
AUTH   = f"{SUPABASE_URL}/auth/v1/admin/users"
HEADERS = {
    'apikey':        SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
}

# ── LOGGING ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('sim')

# ── SYMBOL UNIVERSE ───────────────────────────────────────────────────────────

TEA_SYMBOLS = [
    'KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS',
    'IND-ASM', 'IND-DRJ',
    'SRI-BOP', 'SRI-PEK',
    'CHN-YUN',
    'MLW-BP1', 'RWA-OP',
]

INDEX_SYMBOLS = [
    'KENYA', 'INDIA', 'CEYLON', 'CHINA', 'AFRICA', 'ASIA',
]

# Trader personality archetypes — controls how a bot behaves
ARCHETYPES = {
    'momentum': {'buy_bias': 0.70, 'qty_range': (500,  4000), 'freq_s': 8 },
    'mean_rev': {'buy_bias': 0.45, 'qty_range': (200,  2000), 'freq_s': 12},
    'scalper':  {'buy_bias': 0.52, 'qty_range': (100,   500), 'freq_s': 4 },
    'whale':    {'buy_bias': 0.55, 'qty_range': (3000,10000), 'freq_s': 30},
    'passive':  {'buy_bias': 0.50, 'qty_range': (100,  1000), 'freq_s': 20},
}

INTENSITY_SETTINGS = {
    'low':    {'interval_mult': 2.5, 'jitter': 0.5},
    'medium': {'interval_mult': 1.0, 'jitter': 0.3},
    'high':   {'interval_mult': 0.4, 'jitter': 0.1},
}

SIM_TAG = '@teatrade.sim'

# ── HELPERS ───────────────────────────────────────────────────────────────────

_RETRY_EXC = (requests.exceptions.SSLError, requests.exceptions.ConnectionError)

def _request(method: str, url: str, headers: dict, retries: int = 3, **kwargs):
    """All HTTP calls go through here — retries on SSL/connection drops."""
    delay = 2.0
    for attempt in range(retries):
        try:
            r = requests.request(method, url, headers=headers,
                                 timeout=15, **kwargs)
            return r
        except _RETRY_EXC as exc:
            if attempt < retries - 1:
                log.debug(f"    Network hiccup ({exc.__class__.__name__}), "
                          f"retrying in {delay:.0f}s…")
                time.sleep(delay)
                delay *= 2
            else:
                raise

def _get(path: str, params: dict = None):
    r = _request('GET', f"{REST}/{path}", HEADERS, params=params)
    return r.json() if r.ok else None

def _post(path: str, payload: dict):
    r = _request('POST', f"{REST}/{path}", HEADERS, json=payload)
    return r.json() if r.ok else None

def _post_raw(url: str, payload: dict):
    r = _request('POST', url, HEADERS, json=payload)
    return r.status_code, r.json() if r.text else {}

def _post_raw_with_headers(url: str, headers: dict, payload: dict):
    r = _request('POST', url, headers, json=payload)
    return r.status_code, r.json() if r.text else {}

def _delete(path: str, params: dict):
    r = _request('DELETE', f"{REST}/{path}", HEADERS, params=params)
    return r.ok

# ── FETCH LIVE PRICES ─────────────────────────────────────────────────────────

def fetch_tea_prices() -> dict:
    """Returns {symbol: current_price} for all teas."""
    data = _get('teas', {'select': 'symbol,current_price'})
    if not data:
        return {}
    return {row['symbol']: float(row['current_price']) for row in data if row.get('current_price')}

def compute_index_price(index_sym: str, prices: dict) -> Optional[float]:
    compositions = {
        'KENYA':   ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS'],
        'INDIA':   ['IND-ASM', 'IND-DRJ'],
        'CEYLON':  ['SRI-BOP', 'SRI-PEK'],
        'CHINA':   ['CHN-YUN'],
        'AFRICA':  ['KEN-BP1', 'KEN-PF1', 'KEN-DUST', 'KEN-PD', 'KEN-BMF', 'KEN-FNGS', 'MLW-BP1', 'RWA-OP'],
        'ASIA':    ['IND-ASM', 'IND-DRJ', 'SRI-BOP', 'SRI-PEK', 'CHN-YUN'],
    }
    teas = compositions.get(index_sym, [])
    vals = [prices[t] for t in teas if t in prices]
    return sum(vals) / len(vals) if vals else None

# ── BOT LIFECYCLE ─────────────────────────────────────────────────────────────

def create_bot(n: int, session_id: str) -> Optional[dict]:
    """Create one sim bot user + profile. Returns {id, email} or None."""
    email    = f"simbot_{n:03d}_{session_id[:8]}{SIM_TAG}"
    password = f"SimPass_{uuid.uuid4().hex[:12]}!"

    # Include the first 8 chars of session_id so every run gets unique usernames
    # even if a previous run wasn't cleaned up yet.
    short_sid = session_id[:8]
    username  = f"SimBot_{n:03d}_{short_sid}"

    # Create auth user via admin API.
    # user_metadata is read by the handle_new_user DB trigger to populate
    # the profiles row — username MUST be included here to satisfy the NOT NULL
    # constraint on profiles.username.
    status, resp = _post_raw(AUTH, {
        'email':         email,
        'password':      password,
        'email_confirm': True,   # skip email verification
        'user_metadata': {
            'username':   username,
            'is_sim_bot': True,
            'session_id': session_id,
        },
    })

    if status not in (200, 201):
        log.warning(f"  Could not create bot {n}: {resp.get('message', resp)}")
        return None

    user_id = resp.get('id') or resp.get('user', {}).get('id')
    if not user_id:
        return None

    # Upsert profile — trigger may have already created it, so merge on conflict.
    cash = round(random.uniform(50_000, 200_000), 2)
    upsert_headers = {
        **HEADERS,
        'Prefer': 'return=representation,resolution=merge-duplicates',
    }
    prof_status, prof_resp = _post_raw_with_headers(
        f"{SUPABASE_URL}/rest/v1/profiles",
        upsert_headers,
        {
            'id':           user_id,
            'username':     username,
            'cash_balance': cash,
        },
    )

    if prof_status not in (200, 201):
        log.warning(f"  Profile upsert failed for bot {n}: {prof_resp}")
        # Retry with a plain INSERT as fallback
        insert_headers = {**HEADERS, 'Prefer': 'return=representation'}
        prof_status2, prof_resp2 = _post_raw_with_headers(
            f"{SUPABASE_URL}/rest/v1/profiles",
            insert_headers,
            {
                'id':           user_id,
                'username':     username,
                'cash_balance': cash,
            },
        )
        if prof_status2 not in (200, 201):
            log.warning(f"  Profile INSERT also failed for bot {n}: {prof_resp2}")

    # Verify profile exists before returning
    verify = _request('GET', f"{SUPABASE_URL}/rest/v1/profiles",
                       HEADERS, params={'id': f'eq.{user_id}', 'select': 'id'})
    if not verify.ok or not verify.json():
        log.warning(f"  Bot {n}: profile not found after creation, skipping")
        return None

    log.info(f"  ✓ Bot {n:03d} created → {email}")
    return {'id': user_id, 'email': email}

def delete_bot_user(user_id: str):
    _request('DELETE', f"{AUTH}/{user_id}", HEADERS)

# ── TRADE EXECUTION ───────────────────────────────────────────────────────────

def place_trade(bot_id: str, bot_n: int, prices: dict, session_id: str,
                archetype_cfg: dict):
    """Place one random trade for a bot directly into the trades table."""

    # Pick a symbol — 60% tea, 40% index
    if random.random() < 0.60:
        sym = random.choice(TEA_SYMBOLS)
        price = prices.get(sym)
        if not price:
            return
        tea_data = _get('teas', {'select': 'id', 'symbol': f'eq.{sym}', 'limit': '1'})
        if not tea_data:
            return
        tea_id    = tea_data[0]['id']
        idx_sym   = None
    else:
        idx_sym = random.choice(INDEX_SYMBOLS)
        price   = compute_index_price(idx_sym, prices)
        if not price:
            return
        tea_id  = None

    side  = 'BUY' if random.random() < archetype_cfg['buy_bias'] else 'SELL'
    qty   = round(random.uniform(*archetype_cfg['qty_range']), 0)
    total = round(price * qty, 2)

    # Add a tiny random slippage (+/- 0.5%) to make prices look organic
    slippage = price * random.uniform(-0.005, 0.005)
    exec_price = round(price + slippage, 4)

    payload = {
        'user_id':      bot_id,
        'tea_id':       tea_id,
        'index_symbol': idx_sym,
        'side':         side,
        'quantity':     qty,
        'price':        exec_price,
        'total_value':  total,
        'status':       'FILLED',
        'notes':        f'sim_session:{session_id}',
    }

    status, resp = _post_raw(f"{SUPABASE_URL}/rest/v1/trades", payload)
    sym_display = idx_sym or sym
    if status in (200, 201):
        log.info(f"  Bot {bot_n:03d} {side:4s} {qty:>6.0f} kg {sym_display:<12s} @ ${exec_price:.4f}")
    else:
        log.warning(f"  Bot {bot_n:03d} trade FAILED (HTTP {status}): {resp}")

# ── MAIN SIMULATION LOOP ──────────────────────────────────────────────────────

def run_simulation(n_bots: int, duration_s: int, intensity: str):
    session_id = uuid.uuid4().hex
    cfg        = INTENSITY_SETTINGS[intensity]

    log.info("=" * 60)
    log.info(f"  TeaTrade Market Simulation")
    log.info(f"  Session  : {session_id[:16]}")
    log.info(f"  Bots     : {n_bots}")
    log.info(f"  Duration : {duration_s}s")
    log.info(f"  Intensity: {intensity}")
    log.info(f"  Cleanup  : python simulate_market.py --cleanup")
    log.info(f"         OR : SELECT cleanup_simulation_bots(); in SQL Editor")
    log.info("=" * 60)

    # 1. Create bots — paced to stay within Supabase Auth API rate limits.
    # Every 10 bots we pause 15s to let the throttle window reset; without
    # this, Supabase starts adding multi-second delays per request around bot 20.
    log.info(f"\n[1/3] Creating {n_bots} simulation bots…")
    bots = []
    for i in range(1, n_bots + 1):
        bot = create_bot(i, session_id)
        if bot:
            archetype = random.choice(list(ARCHETYPES.keys()))
            bots.append({**bot, 'n': i, 'archetype': archetype,
                          'cfg': ARCHETYPES[archetype],
                          'next_trade_at': time.time() + random.uniform(0, 5)})
        time.sleep(0.5)    # base inter-bot delay
        if i % 10 == 0 and i < n_bots:
            log.info(f"  ⏸  Cooldown after bot {i} (letting Auth API recover 15s)…")
            time.sleep(15)

    if not bots:
        log.error("No bots created — check your SUPABASE_KEY and URL")
        return

    log.info(f"\n[2/3] Simulation running for {duration_s}s…")
    log.info(f"  Archetypes: { {a: sum(1 for b in bots if b['archetype'] == a) for a in ARCHETYPES} }")
    log.info("")

    end_time = time.time() + duration_s
    trade_count = 0
    empty_price_warnings = 0

    while time.time() < end_time:
        prices = fetch_tea_prices()
        if not prices:
            empty_price_warnings += 1
            if empty_price_warnings <= 3 or empty_price_warnings % 10 == 0:
                log.warning(f"  fetch_tea_prices() returned empty (attempt {empty_price_warnings}) — check REST API access")
            time.sleep(2)
            continue

        now = time.time()
        for bot in bots:
            if now >= bot['next_trade_at']:
                place_trade(bot['id'], bot['n'], prices, session_id, bot['cfg'])
                trade_count += 1

                # Schedule next trade with intensity multiplier + jitter
                base_interval = bot['cfg']['freq_s'] * cfg['interval_mult']
                jitter = base_interval * cfg['jitter'] * random.uniform(-1, 1)
                bot['next_trade_at'] = now + max(1, base_interval + jitter)

        remaining = int(end_time - time.time())
        if remaining % 30 == 0 and remaining > 0:
            log.info(f"  ⏱  {remaining}s remaining | {trade_count} trades placed so far")

        time.sleep(0.5)

    log.info(f"\n[3/3] Simulation complete. {trade_count} trades placed by {len(bots)} bots.")
    log.info("")
    log.info("  To wipe all simulation data:")
    log.info("    python tools/simulate_market.py --cleanup")
    log.info("    -- or --")
    log.info("    SELECT cleanup_simulation_bots();  (Supabase SQL Editor)")

# ── CLEANUP ───────────────────────────────────────────────────────────────────

def run_cleanup():
    log.info("Scanning for simulation bots…")

    # Find all sim bot auth users
    page, all_users = 0, []
    while True:
        r = _request('GET', AUTH, HEADERS,
                     params={'page': page, 'per_page': 1000})
        if not r.ok:
            break
        data = r.json()
        users = data.get('users', data) if isinstance(data, dict) else data
        if not users:
            break
        sim = [u for u in users if u.get('email', '').endswith(SIM_TAG)]
        all_users.extend(sim)
        if len(users) < 1000:
            break
        page += 1

    if not all_users:
        log.info("  No simulation bots found — nothing to clean up.")
        return

    log.info(f"  Found {len(all_users)} simulation bot(s). Deleting…")

    ids = [u['id'] for u in all_users]

    # Delete trades
    for chunk in [ids[i:i+50] for i in range(0, len(ids), 50)]:
        id_list = ','.join(f'"{i}"' for i in chunk)
        _request('DELETE', f"{REST}/trades", HEADERS,
                 params={'user_id': f'in.({id_list})'})

    # Delete positions
    for chunk in [ids[i:i+50] for i in range(0, len(ids), 50)]:
        id_list = ','.join(f'"{i}"' for i in chunk)
        _request('DELETE', f"{REST}/positions", HEADERS,
                 params={'user_id': f'in.({id_list})'})

    # Delete profiles
    for chunk in [ids[i:i+50] for i in range(0, len(ids), 50)]:
        id_list = ','.join(f'"{i}"' for i in chunk)
        _request('DELETE', f"{REST}/profiles", HEADERS,
                 params={'id': f'in.({id_list})'})

    # Delete auth users
    deleted = 0
    for user in all_users:
        r = _request('DELETE', f"{AUTH}/{user['id']}", HEADERS)
        if r.ok or r.status_code == 404:
            deleted += 1

    log.info(f"  ✓ Deleted {deleted}/{len(all_users)} simulation bot accounts")
    log.info("  ✓ Trades, positions, and profiles wiped")
    log.info("  ✓ Platform is clean — zero trace of simulation data")

# ── ENTRY POINT ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='TeaTrade Market Simulation Engine',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument('--bots',      type=int,   default=20,
                        help='Number of simulation bots (default: 20)')
    parser.add_argument('--duration',  type=int,   default=300,
                        help='Simulation duration in seconds (default: 300)')
    parser.add_argument('--intensity', choices=['low', 'medium', 'high'],
                        default='medium',
                        help='Trading frequency (default: medium)')
    parser.add_argument('--cleanup',   action='store_true',
                        help='Delete all simulation bots and their data')

    args = parser.parse_args()

    if args.cleanup:
        run_cleanup()
    else:
        run_simulation(args.bots, args.duration, args.intensity)
