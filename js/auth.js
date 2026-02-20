/**
 * TeaTrade Exchange - Authentication Module
 * Handles sign-up, login, logout, session checks, early access,
 * and auth-dependent UI updates.
 *
 * Globals used from config.js: supabaseClient, state
 * Calls into other modules: loadPositions(), loadIndexPositions(),
 *   updatePortfolioDisplay(), updateTradeButton(), showToast()
 */

// =============================================
// AUTH STATE
// =============================================

async function checkAuthState() {
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (user) {
            state.currentUser = user;

            const mfaRequired = await checkMfaRequired();
            if (mfaRequired) {
                showMfaChallengeModal();
                return;
            }

            await loadUserProfile();
            updateUIForLoggedInUser();
            if (typeof startUserSubscriptions === 'function') startUserSubscriptions(user.id);
            if (typeof _ensureTradeNotificationChannel === 'function') _ensureTradeNotificationChannel();
        } else {
            updateUIForLoggedOutUser();
        }
    } catch (error) {
        console.error('Auth check error:', error);
    }
}

// =============================================
// AUTH MODAL
// =============================================

function openAuthModal() {
    document.getElementById('auth-modal').classList.add('visible');
}

function closeAuthModal() {
    document.getElementById('auth-modal').classList.remove('visible');
    // Clear errors
    document.getElementById('signup-error').classList.remove('visible');
    document.getElementById('login-error').classList.remove('visible');
}

function switchAuthTab(tab) {
    const isSignup = tab === 'signup';
    document.getElementById('tab-signup').classList.toggle('active', isSignup);
    document.getElementById('tab-login').classList.toggle('active', !isSignup);
    document.getElementById('tab-signup').setAttribute('aria-selected', isSignup);
    document.getElementById('tab-login').setAttribute('aria-selected', !isSignup);
    document.getElementById('signup-form-container').style.display = isSignup ? 'block' : 'none';
    document.getElementById('login-form-container').style.display = isSignup ? 'none' : 'block';
    // Move focus to first input in the active tab
    const activeForm = isSignup ? 'signup-form-container' : 'login-form-container';
    setTimeout(() => document.querySelector(`#${activeForm} input`)?.focus(), 50);
}

// =============================================
// SIGN-UP / LOGIN / LOGOUT
// =============================================

async function handleSignup(e) {
    e.preventDefault();
    const btn = document.getElementById('signup-btn');
    const errorDiv = document.getElementById('signup-error');

    const username = document.getElementById('signup-username').value.trim().toLowerCase();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;

    // Validate username
    if (!/^[a-z0-9_]+$/.test(username)) {
        errorDiv.textContent = 'Username can only contain letters, numbers, and underscores';
        errorDiv.classList.add('visible');
        return;
    }

    // H4 FIX: Enforce strong password policy
    if (password.length < 8) {
        errorDiv.textContent = 'Password must be at least 8 characters';
        errorDiv.classList.add('visible');
        return;
    }
    if (!/[A-Z]/.test(password)) {
        errorDiv.textContent = 'Password must contain at least one uppercase letter';
        errorDiv.classList.add('visible');
        return;
    }
    if (!/[0-9]/.test(password)) {
        errorDiv.textContent = 'Password must contain at least one number';
        errorDiv.classList.add('visible');
        return;
    }
    if (!/[!@#$%^&*()_+\-=\[\]{}|;:'",.\/?]/.test(password)) {
        errorDiv.textContent = 'Password must contain at least one special character';
        errorDiv.classList.add('visible');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating Account...';
    errorDiv.classList.remove('visible');

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: {
                    username: username,
                    display_name: username
                }
            }
        });

        if (error) throw error;

        state.currentUser = data.user;
        await loadUserProfile();
        updateUIForLoggedInUser();
        if (typeof startUserSubscriptions === 'function') startUserSubscriptions(data.user.id);
        closeAuthModal();

        // C7 FIX: Prompt email verification
        if (data.user && !data.user.email_confirmed_at) {
            showToast('Check Your Email', 'Please verify your email address to enable trading. Check your inbox for a confirmation link.');
        } else {
            showToast('Welcome to TeaTrade!', 'You have $10,000 virtual cash to start trading.');
        }

    } catch (error) {
        console.error('Signup error:', error);
        errorDiv.textContent = error.message || 'Signup failed. Please try again.';
        errorDiv.classList.add('visible');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Account & Start Trading';
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errorDiv = document.getElementById('login-error');

    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    btn.disabled = true;
    btn.textContent = 'Logging in...';
    errorDiv.classList.remove('visible');

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password
        });

        if (error) throw error;

        state.currentUser = data.user;
        closeAuthModal();

        const mfaRequired = await checkMfaRequired();
        if (mfaRequired) {
            showMfaChallengeModal();
        } else {
            await loadUserProfile();
            updateUIForLoggedInUser();
            if (typeof startUserSubscriptions === 'function') startUserSubscriptions(data.user.id);
            if (typeof _ensureTradeNotificationChannel === 'function') _ensureTradeNotificationChannel();
            showToast('Welcome back!', `Good to see you, ${state.userProfile?.username || 'trader'}!`);
        }

    } catch (error) {
        console.error('Login error:', error);
        errorDiv.textContent = error.message || 'Login failed. Please check your credentials.';
        errorDiv.classList.add('visible');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Log In';
    }
}

async function handleLogout() {
    if (!confirm('Are you sure you want to log out?')) return;

    try {
        if (typeof stopUserSubscriptions === 'function') stopUserSubscriptions();
        await supabaseClient.auth.signOut();
        state.currentUser = null;
        state.userProfile = null;
        state.positions = [];
        updateUIForLoggedOutUser();
    } catch (error) {
        console.error('Logout error:', error);
    }
}

// =============================================
// PROFILE LOADING
// =============================================

async function loadUserProfile() {
    if (!state.currentUser) return;

    try {
        const { data, error } = await apiGetProfile(state.currentUser.id);
        if (error) throw error;
        state.userProfile = data;

        const saved = localStorage.getItem('teatrade_trading_mode');
        if (saved === 'REAL' || saved === 'VIRTUAL') state.tradingMode = saved;

        console.log('Profile loaded, mode:', state.tradingMode, 'balance:', getActiveBalance());
        updateBalanceDisplay();

        const toggle = document.getElementById('mode-toggle');
        if (toggle) toggle.checked = (state.tradingMode === 'REAL');
        const indicator = document.getElementById('mode-indicator');
        if (indicator) {
            indicator.classList.toggle('mode-real', state.tradingMode === 'REAL');
            indicator.classList.toggle('mode-virtual', state.tradingMode !== 'REAL');
        }
        const label = document.getElementById('mode-label');
        if (label) label.textContent = state.tradingMode === 'REAL' ? 'REAL' : 'VIRTUAL';

        await loadPositions();
        await loadIndexPositions();
        _syncLocalFollowsToDb();
    } catch (error) {
        console.error('Profile load error:', error);
    }
}

async function _syncLocalFollowsToDb() {
    const SYNC_KEY = 'tt_follows_synced';
    if (localStorage.getItem(SYNC_KEY) || !state.currentUser) return;
    try {
        const list = getTraderWatchlist();
        for (const entry of list) {
            const { data: profile } = await apiLookupUserByUsername(entry.username);
            if (profile?.id && profile.id !== state.currentUser.id) {
                await apiFollowUser(profile.id);
            }
        }
        localStorage.setItem(SYNC_KEY, '1');
    } catch (e) {
        console.warn('Follow sync:', e);
    }
}

// =============================================
// EARLY ACCESS
// =============================================

function submitEarlyAccess(e) {
    e.preventDefault();
    const email = document.getElementById('early-access-email').value;
    const form = document.getElementById('early-access-form');
    const btn = document.getElementById('early-access-btn');

    // Secret passphrase to view site
    if (email.toLowerCase().trim() === 'betty the best auctioneer') {
        document.getElementById('early-access-modal').style.display = 'none';
        return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('Please enter a valid email address.');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    const formData = new FormData();
    formData.append('email_address', email);

    fetch('https://app.kit.com/forms/9066752/subscriptions', {
        method: 'POST',
        body: formData,
        mode: 'no-cors'
    })
    .then(() => {
        form.innerHTML = `
            <div class="early-access-success">
                <div class="early-access-success-icon">&#10003;</div>
                <p>You're on the list! We'll notify you at <strong>${email}</strong> when TeaTrade Exchange launches.</p>
            </div>
        `;
    })
    .catch(() => {
        btn.disabled = false;
        btn.textContent = 'Get Early Access';
        alert('Something went wrong. Please try again.');
    });
}

// =============================================
// EMAIL VERIFICATION CHECK (C7 FIX)
// =============================================

/**
 * Check if the current user has verified their email.
 * Returns true if verified (or if running in dev/test mode).
 * Shows a toast and returns false if not verified.
 */
function isEmailVerified() {
    if (!state.currentUser) return false;
    if (state.currentUser.email_confirmed_at) return true;

    showToast('Email Not Verified',
        'Please verify your email address before trading. Check your inbox for a confirmation link.', true);
    return false;
}

// =============================================
// USER DROPDOWN MENU
// =============================================

function toggleUserDropdown(e) {
    e.stopPropagation();
    document.getElementById('user-dropdown').classList.toggle('visible');
}

function closeUserDropdown() {
    document.getElementById('user-dropdown').classList.remove('visible');
}

document.addEventListener('click', (e) => {
    const dd = document.getElementById('user-dropdown');
    if (dd && !e.target.closest('.user-avatar-wrapper')) {
        dd.classList.remove('visible');
    }
});

// =============================================
// MFA / 2FA (M1 FIX)
// =============================================

let _mfaFactorId = null;
let _mfaEnrollFactorId = null;

async function openMfaSetupModal() {
    const modal = document.getElementById('mfa-setup-modal');
    modal.classList.add('visible');

    document.getElementById('mfa-state-loading').style.display = 'block';
    document.getElementById('mfa-state-unenrolled').style.display = 'none';
    document.getElementById('mfa-state-enrolling').style.display = 'none';
    document.getElementById('mfa-state-enrolled').style.display = 'none';

    try {
        const { data, error } = await supabaseClient.auth.mfa.listFactors();
        if (error) throw error;

        const totpFactors = (data?.totp || []).filter(f => f.status === 'verified');

        if (totpFactors.length > 0) {
            _mfaFactorId = totpFactors[0].id;
            showMfaState('enrolled');
        } else {
            _mfaFactorId = null;
            showMfaState('unenrolled');
        }
    } catch (err) {
        console.error('MFA list factors error:', err);
        showMfaState('unenrolled');
    }
}

function closeMfaSetupModal() {
    document.getElementById('mfa-setup-modal').classList.remove('visible');
    _mfaEnrollFactorId = null;
}

function showMfaState(stateName) {
    ['loading', 'unenrolled', 'enrolling', 'enrolled'].forEach(s => {
        document.getElementById(`mfa-state-${s}`).style.display = s === stateName ? 'block' : 'none';
    });
}

async function startMfaEnroll() {
    const btn = document.getElementById('mfa-enroll-btn');
    btn.disabled = true;
    btn.textContent = 'Setting up...';

    try {
        const { data, error } = await supabaseClient.auth.mfa.enroll({
            factorType: 'totp',
            friendlyName: 'TeaTrade Authenticator'
        });

        if (error) throw error;

        _mfaEnrollFactorId = data.id;

        document.getElementById('mfa-qr-image').src = data.totp.qr_code;
        document.getElementById('mfa-secret-code').textContent = data.totp.secret;
        document.getElementById('mfa-enroll-code').value = '';
        document.getElementById('mfa-enroll-error').textContent = '';

        showMfaState('enrolling');
    } catch (err) {
        console.error('MFA enroll error:', err);
        showToast('2FA Setup Failed', err.message || 'Could not start 2FA enrollment', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enable Two-Factor Authentication';
    }
}

async function verifyMfaEnroll() {
    const code = document.getElementById('mfa-enroll-code').value.trim();
    const errorDiv = document.getElementById('mfa-enroll-error');
    const btn = document.getElementById('mfa-verify-enroll-btn');

    if (!/^\d{6}$/.test(code)) {
        errorDiv.textContent = 'Please enter a 6-digit code';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Verifying...';
    errorDiv.textContent = '';

    try {
        const { data: challenge, error: challengeErr } = await supabaseClient.auth.mfa.challenge({
            factorId: _mfaEnrollFactorId
        });
        if (challengeErr) throw challengeErr;

        const { error: verifyErr } = await supabaseClient.auth.mfa.verify({
            factorId: _mfaEnrollFactorId,
            challengeId: challenge.id,
            code
        });
        if (verifyErr) throw verifyErr;

        _mfaFactorId = _mfaEnrollFactorId;
        _mfaEnrollFactorId = null;

        showMfaState('enrolled');
        showToast('2FA Enabled', 'Two-factor authentication is now active on your account.');
    } catch (err) {
        console.error('MFA verify enroll error:', err);
        errorDiv.textContent = err.message || 'Invalid code. Please try again.';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm & Enable 2FA';
    }
}

async function cancelMfaEnroll() {
    if (_mfaEnrollFactorId) {
        try {
            await supabaseClient.auth.mfa.unenroll({ factorId: _mfaEnrollFactorId });
        } catch (_) {}
        _mfaEnrollFactorId = null;
    }
    showMfaState('unenrolled');
}

async function disableMfa() {
    if (!_mfaFactorId) return;
    if (!confirm('Are you sure you want to disable two-factor authentication? This will make your account less secure.')) return;

    const btn = document.getElementById('mfa-disable-btn');
    btn.disabled = true;
    btn.textContent = 'Disabling...';

    try {
        const { error } = await supabaseClient.auth.mfa.unenroll({ factorId: _mfaFactorId });
        if (error) throw error;

        _mfaFactorId = null;
        showMfaState('unenrolled');
        showToast('2FA Disabled', 'Two-factor authentication has been removed from your account.');
    } catch (err) {
        console.error('MFA unenroll error:', err);
        showToast('Error', err.message || 'Could not disable 2FA', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Disable Two-Factor Authentication';
    }
}

// MFA challenge during login
async function checkMfaRequired() {
    try {
        const { data, error } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error) return false;
        return data.currentLevel === 'aal1' && data.nextLevel === 'aal2';
    } catch (_) {
        return false;
    }
}

function showMfaChallengeModal() {
    document.getElementById('mfa-challenge-modal').classList.add('visible');
    document.getElementById('mfa-challenge-code').value = '';
    document.getElementById('mfa-challenge-error').textContent = '';
    document.getElementById('mfa-challenge-code').focus();
}

function cancelMfaChallenge() {
    document.getElementById('mfa-challenge-modal').classList.remove('visible');
    supabaseClient.auth.signOut();
    state.currentUser = null;
    state.userProfile = null;
    updateUIForLoggedOutUser();
    showToast('Login Cancelled', 'Two-factor verification was not completed.');
}

async function submitMfaChallenge() {
    const code = document.getElementById('mfa-challenge-code').value.trim();
    const errorDiv = document.getElementById('mfa-challenge-error');
    const btn = document.getElementById('mfa-challenge-btn');

    if (!/^\d{6}$/.test(code)) {
        errorDiv.textContent = 'Please enter a 6-digit code';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Verifying...';
    errorDiv.textContent = '';

    try {
        const { data: factors } = await supabaseClient.auth.mfa.listFactors();
        const totp = (factors?.totp || []).find(f => f.status === 'verified');
        if (!totp) throw new Error('No verified TOTP factor found');

        const { data: challenge, error: challengeErr } = await supabaseClient.auth.mfa.challenge({
            factorId: totp.id
        });
        if (challengeErr) throw challengeErr;

        const { error: verifyErr } = await supabaseClient.auth.mfa.verify({
            factorId: totp.id,
            challengeId: challenge.id,
            code
        });
        if (verifyErr) throw verifyErr;

        document.getElementById('mfa-challenge-modal').classList.remove('visible');

        await loadUserProfile();
        updateUIForLoggedInUser();
        if (typeof startUserSubscriptions === 'function') startUserSubscriptions(state.currentUser.id);
        showToast('Welcome back!', `Good to see you, ${state.userProfile?.username || 'trader'}!`);
    } catch (err) {
        console.error('MFA challenge error:', err);
        errorDiv.textContent = err.message || 'Invalid code. Please try again.';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Verify';
    }
}

// =============================================
// ACCESSIBILITY: FOCUS TRAP & KEYBOARD NAV
// =============================================

/**
 * Trap focus within `containerEl` while modal is open.
 * Returns a cleanup function to remove the listener.
 */
function trapFocus(containerEl) {
    const focusable = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    function handler(e) {
        const els = Array.from(containerEl.querySelectorAll(focusable)).filter(el => !el.closest('[style*="display: none"]') && !el.closest('[style*="display:none"]'));
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.key === 'Tab') {
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }
    containerEl.addEventListener('keydown', handler);
    return () => containerEl.removeEventListener('keydown', handler);
}

// Escape key closes open modals
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const authModal = document.getElementById('auth-modal');
    if (authModal?.classList.contains('visible')) { closeAuthModal(); return; }
    const mfaChallenge = document.getElementById('mfa-challenge-modal');
    if (mfaChallenge?.classList.contains('visible')) { cancelMfaChallenge(); return; }
    const mfaSetup = document.getElementById('mfa-setup-modal');
    if (mfaSetup?.classList.contains('visible')) { closeMfaSetupModal(); return; }
});

// Wire focus traps when modals open
const _openAuthModal = openAuthModal;
openAuthModal = function() {
    _openAuthModal();
    const content = document.querySelector('#auth-modal .auth-content');
    if (content) {
        const cleanup = trapFocus(content);
        const observer = new MutationObserver(() => {
            if (!document.getElementById('auth-modal').classList.contains('visible')) {
                cleanup(); observer.disconnect();
            }
        });
        observer.observe(document.getElementById('auth-modal'), { attributes: true, attributeFilter: ['class'] });
        // Move focus to first input
        setTimeout(() => content.querySelector('input')?.focus(), 50);
    }
};

// MFA code input: auto-submit on 6 digits + Enter key support
document.addEventListener('DOMContentLoaded', () => {
    ['mfa-challenge-code', 'mfa-enroll-code'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            el.value = el.value.replace(/\D/g, '').slice(0, 6);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (id === 'mfa-challenge-code') submitMfaChallenge();
                else verifyMfaEnroll();
            }
        });
    });
});

// =============================================
// AUTH-DEPENDENT UI
// =============================================

function updateUIForLoggedInUser() {
    document.getElementById('logged-out-ui').style.display = 'none';
    document.getElementById('logged-in-ui').style.display = 'flex';
    document.getElementById('portfolio-section').style.display = 'block';

    const balance = getActiveBalance();
    const formatted = '$' + balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('user-balance').textContent = formatted;
    document.getElementById('trade-balance').textContent = formatted;

    // Quick-quote balances (may not exist on every page state)
    const qqBal = document.getElementById('qq-balance');
    if (qqBal) qqBal.textContent = formatted;
    const qqMobileBal = document.getElementById('qq-mobile-balance');
    if (qqMobileBal) qqMobileBal.textContent = formatted;

    // Update avatar with initials
    const initials = (state.userProfile?.username || 'TT').substring(0, 2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;

    // Unlock trade button
    const tradeBtn = document.getElementById('trade-execute-btn');
    tradeBtn.classList.remove('signin-prompt');
    tradeBtn.disabled = false;

    // Refresh trade button label and portfolio
    updateTradeButton();
    updatePortfolioDisplay();
}

function updateUIForLoggedOutUser() {
    document.getElementById('logged-out-ui').style.display = 'block';
    document.getElementById('logged-in-ui').style.display = 'none';
    document.getElementById('portfolio-section').style.display = 'none';

    document.getElementById('trade-balance').textContent = '$0.00';
    const tradeBtn = document.getElementById('trade-execute-btn');
    tradeBtn.textContent = 'Sign in to Trade';
    tradeBtn.disabled = false;
    tradeBtn.classList.add('signin-prompt');
}
