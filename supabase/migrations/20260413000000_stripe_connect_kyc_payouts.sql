-- ============================================================
-- Stripe Connect KYC & Payout System
-- ============================================================
-- Adds Stripe Connect fields to profiles, creates payout_requests
-- table with full RLS, and admin helper functions.
-- ============================================================

-- 1. Add KYC/Connect columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_connect_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'none'
    CHECK (kyc_status IN ('none', 'pending', 'verified', 'rejected', 'requires_info'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS kyc_completed_at TIMESTAMPTZ;

-- Protect sensitive columns from client writes
REVOKE UPDATE (stripe_connect_id, kyc_status, kyc_completed_at) ON profiles FROM authenticated;

-- 2. Create payout_requests table
CREATE TABLE IF NOT EXISTS payout_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_pence    INTEGER NOT NULL CHECK (amount_pence > 0),
    currency        TEXT NOT NULL DEFAULT 'gbp',
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'processing', 'completed', 'rejected', 'failed')),
    stripe_transfer_id  TEXT,
    stripe_payout_id    TEXT,
    admin_notes     TEXT,
    rejection_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at     TIMESTAMPTZ,
    processed_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payout_requests_user_id ON payout_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status);

-- Enable RLS
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;

-- Users can view their own payout requests
CREATE POLICY "Users can view own payouts"
    ON payout_requests FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert payout requests (status must be pending)
CREATE POLICY "Users can request payouts"
    ON payout_requests FOR INSERT
    WITH CHECK (auth.uid() = user_id AND status = 'pending');

-- Only service role can update payout requests (admin operations)
-- No UPDATE policy for authenticated role — updates go through edge functions

-- 3. Grant select on new columns for authenticated users
GRANT SELECT (stripe_connect_id, kyc_status, kyc_completed_at) ON profiles TO authenticated;

-- 4. Helper function: get KYC + payout status for current user
CREATE OR REPLACE FUNCTION get_kyc_payout_status(p_user_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_profile RECORD;
    v_payouts JSON;
    v_total_paid BIGINT;
BEGIN
    SELECT kyc_status, kyc_completed_at, stripe_connect_id, account_status, virtual_balance
    INTO v_profile
    FROM profiles
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN json_build_object('error', 'User not found');
    END IF;

    -- Get recent payout requests (last 20)
    SELECT COALESCE(json_agg(row_to_json(pr) ORDER BY pr.created_at DESC), '[]'::json)
    INTO v_payouts
    FROM (
        SELECT id, amount_pence, currency, status, rejection_reason,
               created_at, reviewed_at, processed_at, completed_at
        FROM payout_requests
        WHERE user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT 20
    ) pr;

    -- Total paid out
    SELECT COALESCE(SUM(amount_pence), 0)
    INTO v_total_paid
    FROM payout_requests
    WHERE user_id = p_user_id AND status = 'completed';

    RETURN json_build_object(
        'kyc_status', v_profile.kyc_status,
        'kyc_completed_at', v_profile.kyc_completed_at,
        'has_connect_account', v_profile.stripe_connect_id IS NOT NULL,
        'account_status', v_profile.account_status,
        'balance', v_profile.virtual_balance,
        'total_paid_pence', v_total_paid,
        'payout_requests', v_payouts
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_kyc_payout_status(UUID) TO authenticated;
