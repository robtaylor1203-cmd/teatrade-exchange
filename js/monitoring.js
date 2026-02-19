/**
 * TeaTrade Exchange — Monitoring & Error Tracking (Phase 4-19)
 * =============================================================
 * Initialises Sentry error tracking and provides a health check
 * that runs at startup. No user PII is ever sent to Sentry —
 * only anonymous error payloads and sanitised breadcrumbs.
 *
 * SETUP:
 *   1. Create a free Sentry project at https://sentry.io
 *   2. Copy the DSN from Project Settings → Client Keys
 *   3. Replace the SENTRY_DSN constant below with your DSN
 *   4. Leave blank ('') to disable Sentry (errors still log to console)
 */

// =============================================
// CONFIGURATION
// =============================================

const SENTRY_DSN = '';  // Set to your Sentry DSN to enable, e.g. 'https://xxx@o123.ingest.sentry.io/456'
const APP_VERSION = '1.0.0';
const HEALTH_CHECK_URL = 'https://uznxzyuknigzlxecjgtb.supabase.co/functions/v1/health';

// =============================================
// SENTRY INITIALISATION
// =============================================

function initMonitoring() {
    if (!SENTRY_DSN || typeof Sentry === 'undefined') {
        if (SENTRY_DSN) console.warn('[Monitoring] Sentry SDK not loaded — error tracking disabled');
        return;
    }

    Sentry.init({
        dsn: SENTRY_DSN,
        release: `teatrade@${APP_VERSION}`,
        environment: window.location.hostname === 'localhost' || window.location.protocol === 'file:' ? 'development' : 'production',
        tracesSampleRate: 0.1,
        beforeSend(event) {
            // Strip any accidental PII from breadcrumb URLs
            if (event.breadcrumbs?.values) {
                event.breadcrumbs.values.forEach(b => {
                    if (b.data?.url) {
                        try {
                            const u = new URL(b.data.url);
                            u.search = '';
                            b.data.url = u.toString();
                        } catch (_) {}
                    }
                });
            }
            return event;
        }
    });

    console.log('[Monitoring] Sentry initialised');
}

// =============================================
// GLOBAL ERROR BOUNDARY
// =============================================

window.addEventListener('error', (e) => {
    console.error('[Error]', e.message, e.filename, e.lineno);
    if (typeof Sentry !== 'undefined' && SENTRY_DSN) {
        Sentry.captureException(e.error || new Error(e.message), {
            extra: { filename: e.filename, lineno: e.lineno, colno: e.colno }
        });
    }
});

window.addEventListener('unhandledrejection', (e) => {
    console.error('[Unhandled Promise Rejection]', e.reason);
    if (typeof Sentry !== 'undefined' && SENTRY_DSN) {
        Sentry.captureException(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
    }
});

// =============================================
// STARTUP HEALTH CHECK
// =============================================

async function runStartupHealthCheck() {
    const indicator = document.getElementById('health-status-indicator');

    try {
        const res = await fetch(HEALTH_CHECK_URL, {
            method: 'GET',
            headers: { 'apikey': typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '' }
        });

        if (!res.ok) throw new Error(`Health endpoint returned HTTP ${res.status}`);

        const data = await res.json();

        if (data.status === 'ok' || data.healthy) {
            console.log('[Health] System healthy:', data);
            if (indicator) {
                indicator.title = `System healthy — checked ${new Date().toLocaleTimeString()}`;
                indicator.classList.add('healthy');
                indicator.classList.remove('degraded', 'down');
            }
        } else {
            throw new Error('Unhealthy response: ' + JSON.stringify(data));
        }
    } catch (err) {
        console.warn('[Health] Health check failed:', err.message);
        if (indicator) {
            indicator.title = `Health check failed: ${err.message}`;
            indicator.classList.add('degraded');
            indicator.classList.remove('healthy', 'down');
        }
        if (typeof Sentry !== 'undefined' && SENTRY_DSN) {
            Sentry.captureMessage('Startup health check failed: ' + err.message, 'warning');
        }
    }
}

// =============================================
// NAMED ERROR CAPTURE (for use throughout app)
// =============================================

/**
 * Report a named error to Sentry (if configured) and console.
 * @param {string} context - E.g. 'executeTradeError', 'realtimeDisconnect'
 * @param {Error|string} err
 * @param {object} [extras]
 */
function captureError(context, err, extras) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[${context}]`, error.message, extras || '');
    if (typeof Sentry !== 'undefined' && SENTRY_DSN) {
        Sentry.captureException(error, { tags: { context }, extra: extras });
    }
}

/**
 * Add a Sentry breadcrumb for tracing user actions.
 * @param {string} category
 * @param {string} message
 * @param {object} [data]
 */
function addBreadcrumb(category, message, data) {
    if (typeof Sentry !== 'undefined' && SENTRY_DSN) {
        Sentry.addBreadcrumb({ category, message, data, level: 'info' });
    }
}

// Run health check on load (non-blocking)
document.addEventListener('DOMContentLoaded', () => {
    initMonitoring();
    // Delay health check slightly to not compete with initial data load
    setTimeout(runStartupHealthCheck, 3000);
});
