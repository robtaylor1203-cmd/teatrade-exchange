# TeaTrade Exchange — Settlement Model

## Settlement Type: Instant (T+0)

All trades on TeaTrade Exchange settle **instantly** at the point of execution.

## How It Works

Every trade — whether a single tea buy/sell, index trade, or pair trade — is processed by a PostgreSQL `SECURITY DEFINER` function in a **single atomic transaction**:

1. Lock the user's `profiles` row (`FOR UPDATE`) to prevent concurrent manipulation
2. Validate balance (for BUY) or holding (for SELL)
3. Debit/credit `cash_balance`
4. Update the `positions` record
5. Insert an immutable `trades` audit record

All five steps either fully complete or fully roll back. There is no intermediate state.

## Settlement Timeline

| Event | Time |
|-------|------|
| Order submitted | T+0 |
| Balance debited | T+0 (same transaction) |
| Position recorded | T+0 (same transaction) |
| Trade log written | T+0 (same transaction) |
| Realtime update broadcast | T+0 to T+1s (via Supabase Realtime) |

## Why T+0 (Not T+1 or T+2)?

Traditional commodity markets use T+1 (next business day) or T+2 settlement because physical delivery and interbank fund transfers take time. TeaTrade Exchange is a **paper trading simulation platform** — no physical tea changes hands and no real funds move between banks. Therefore:

- Instant settlement removes counterparty risk (no concept applies here)
- Instant settlement gives traders immediate feedback on capital efficiency
- Instant settlement accurately simulates auction-based spot trading where prices are locked at the auction hammer

## Future Consideration

If TeaTrade moves to real-money trading with actual fund transfers, a T+1 settlement cycle with an escrow model would be appropriate. This would require:
- An `escrow_balance` column alongside `cash_balance`
- A daily settlement job that moves funds from escrow to settled
- A `settlement_queue` table to track pending settlements
- Regulatory approval for the settlement agent role
