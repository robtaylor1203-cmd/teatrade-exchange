/**
 * TeaTrade Exchange - Shared Utilities
 * Toast notifications, HTML escaping, formatters, and small helpers.
 */

function showToast(title, message, isError = false) {
    const toast = document.getElementById('trade-toast');
    if (!toast) return;
    document.getElementById('toast-title').textContent = title;
    document.getElementById('toast-message').textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 4000);
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatVolume(vol) {
    if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
    if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
    return vol.toString();
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
    const days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
}

function formatIndexPrice(price, currency, symbol) {
    if (!price || isNaN(price)) return currency + '0.00';
    if (symbol === 'FUTURES') return currency + price.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (price >= 100) return currency + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency + price.toFixed(2);
}

function closeAllDropdowns() {
    document.querySelectorAll('.timeframe-dropdown.visible, .studies-dropdown.visible, .hub-timeframe-dropdown.visible, .hub-studies-dropdown.visible').forEach(el => el.classList.remove('visible'));
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash);
}
