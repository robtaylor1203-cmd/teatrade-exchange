/**
 * TeaTrade Exchange - Live Chat System (chat.js)
 * ================================================
 * Public chat, private DMs (@username syntax), real-time subscription,
 * notification badges, demo message simulation, and blast messages.
 *
 * Globals from config.js : supabaseClient, state
 * Globals from api.js    : apiFetchPublicChatMessages, apiFetchPrivateChatMessages,
 *                          apiInsertChatMessage, apiLookupUserByUsername
 * Globals from utils.js  : showToast, escapeHtml
 * Globals from auth.js   : openAuthModal
 */

// =============================================
// CHAT TIER / BADGE CACHE
// =============================================

const _chatTierCache = {};
const _chatFundedCache = {};
const _chatBadgesCache = {};

async function _populateChatTierCache(messages) {
    const emails = [...new Set(messages.map(m => m.sender_email).filter(Boolean))];
    if (emails.length === 0) return;
    try {
        const { data } = await supabaseClient
            .from('profiles')
            .select('email, tier, combine_badge, badges')
            .in('email', emails);
        if (data) {
            data.forEach(p => {
                _chatTierCache[p.email] = p.tier || 'FREE';
                _chatFundedCache[p.email] = p.combine_badge === true;
                let b = p.badges;
                if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = []; } }
                _chatBadgesCache[p.email] = Array.isArray(b) ? b : [];
            });
        }
    } catch (_) {}
}

// =============================================
// VISIBILITY & NOTIFICATIONS
// =============================================

function isChatVisible() {
    const chatSection = document.getElementById('chat-section-sidebar');
    if (!chatSection) return false;

    const rect = chatSection.getBoundingClientRect();
    const windowHeight = window.innerHeight || document.documentElement.clientHeight;
    const windowWidth = window.innerWidth || document.documentElement.clientWidth;

    // Check if element is visible (at least partially)
    return (
        rect.top < windowHeight &&
        rect.bottom > 0 &&
        rect.left < windowWidth &&
        rect.right > 0 &&
        chatSection.offsetParent !== null
    );
}

function updateChatNotificationBadge() {
    const badge = document.getElementById('chat-notification-badge');
    const countEl = document.getElementById('chat-notification-count');
    if (!badge || !countEl) return;

    if (state.unreadChatCount > 0) {
        badge.classList.add('visible');
        countEl.textContent = state.unreadChatCount > 99 ? '99+' : state.unreadChatCount;
    } else {
        badge.classList.remove('visible');
    }
}

function clearChatNotifications() {
    state.unreadChatCount = 0;
    updateChatNotificationBadge();
}

function scrollToChatSection() {
    const chatSection = document.getElementById('chat-section-sidebar');
    if (!chatSection) return;

    // If on mobile, open sidebar first then scroll to chat
    if (window.innerWidth <= 1200) {
        const sidebar = document.getElementById('mobile-sidebar');
        const overlay = document.getElementById('mobile-overlay');

        if (sidebar && !sidebar.classList.contains('mobile-open')) {
            sidebar.classList.add('mobile-open');
            if (overlay) overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        // Wait for sidebar animation then scroll to chat
        setTimeout(() => {
            chatSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const input = document.getElementById('chat-input');
            if (input) input.focus();
        }, 350);
    } else {
        chatSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    clearChatNotifications();
}

// =============================================
// INITIALISATION
// =============================================

async function initChat() {
    if (state.chatSubscription) return;

    // Seed own tier into chat cache
    if (state.currentUser?.email && state.userProfile) {
        _chatTierCache[state.currentUser.email] = state.userProfile.tier || 'FREE';
        _chatFundedCache[state.currentUser.email] = state.userProfile.combine_badge === true;
    }

    await loadChatMessages();
    setupChatSubscription();
    setupChatInputListeners();
    updateOnlineCount();

    // Simulate some users being online
    setInterval(updateOnlineCount, 30000);

    // Set up intersection observer to clear notifications when chat is visible
    const chatSection = document.getElementById('chat-section-sidebar');
    if (chatSection && 'IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && state.unreadChatCount > 0) {
                    clearChatNotifications();
                }
            });
        }, { threshold: 0.3 });
        observer.observe(chatSection);
    }

    // Demo: simulate incoming messages periodically
    simulateDemoMessages();
}

// =============================================
// LOAD MESSAGES
// =============================================

async function loadChatMessages() {
    try {
        const userEmail = state.currentUser?.email;
        let data, error;

        if (userEmail) {
            // Fetch public messages and private messages involving this user
            const { data: publicMsgs } = await apiFetchPublicChatMessages(50);
            const { data: privateMsgs } = await apiFetchPrivateChatMessages(userEmail, 50);

            // Merge and sort
            const allMsgs = [...(publicMsgs || []), ...(privateMsgs || [])];
            allMsgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            data = allMsgs;
            error = null;
        } else {
            const result = await apiFetchPublicChatMessages(50);
            data = result.data;
            error = result.error;
        }

        if (error) {
            // Table might not exist yet - show demo messages
            console.log('Chat table not found, using demo messages');
            loadDemoChatMessages();
            return;
        }

        state.chatMessages = data || [];
        await _populateChatTierCache(state.chatMessages);
        renderChatMessages();
    } catch (err) {
        console.error('Error loading chat:', err);
        loadDemoChatMessages();
    }
}

function loadDemoChatMessages() {
    const now = new Date();
    state.chatMessages = [
        { id: 1, sender_email: 'k.muthoni@ktda.co.ke', sender_name: 'TEALEAF_KE', message: 'New lots arriving from Kericho highlands tomorrow. Premium quality expected.', created_at: new Date(now - 35 * 60000).toISOString(), is_private: false },
        { id: 2, sender_email: 'm.wong@ekaterra.com', sender_name: 'WONG_TRADER', message: 'Any visibility on Ceylon OP availability next week?', created_at: new Date(now - 22 * 60000).toISOString(), is_private: false },
        { id: 3, sender_email: 'system', sender_name: 'SYSTEM', message: 'Trade alert: Lot #24608 has been matched.', created_at: new Date(now - 15 * 60000).toISOString(), is_private: false, is_system: true },
        { id: 4, sender_email: 'r.patel@tata.com', sender_name: 'PATEL_TEA', message: 'Can offer 10MT Kenya BP1 at 3.45. Interested?', created_at: new Date(now - 8 * 60000).toISOString(), is_private: true, recipient_email: 'demo@user.com', recipient_name: 'DEMO_USER' },
        { id: 5, sender_email: 'j.harrison@finlays.com', sender_name: 'FINLAY_JH', message: 'Looking for 20MT BP1 Mombasa. Can you source?', created_at: new Date(now - 2 * 60000).toISOString(), is_private: false }
    ];
    renderChatMessages();
}

// =============================================
// REALTIME SUBSCRIPTION
// =============================================

function setupChatSubscription() {
    subscribeToChatMessages((payload) => {
        const newMessage = payload.new;
        if (newMessage.is_private && newMessage.recipient_email !== state.currentUser?.email && newMessage.sender_email !== state.currentUser?.email) {
            return;
        }
        state.chatMessages.push(newMessage);
        renderChatMessages();

        if (!isChatVisible() && newMessage.sender_email !== state.currentUser?.email) {
            state.unreadChatCount++;
            updateChatNotificationBadge();
        }
    });
}

// =============================================
// RENDER MESSAGES
// =============================================

function renderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const currentEmail = state.currentUser?.email || '';

    container.innerHTML = state.chatMessages.map(msg => {
        const isOwn = msg.sender_email === currentEmail;
        const isPrivate = msg.is_private;
        const isSystem = msg.is_system || msg.sender_name === 'SYSTEM';

        let msgClass = 'chat-message';
        if (isOwn) msgClass += ' own';
        if (isPrivate) msgClass += ' private';

        let senderClass = 'chat-sender';
        if (isSystem) senderClass += ' system';

        const senderTier = msg.sender_tier || _chatTierCache[msg.sender_email] || '';
        const senderFunded = msg.sender_funded || _chatFundedCache[msg.sender_email] || false;
        if (senderTier === 'PRO') senderClass += ' pro';

        const time = formatChatTime(msg.created_at);
        const senderDisplay = isOwn ? 'YOU' : (msg.sender_name || 'ANON').toUpperCase();

        let badgeHtml = '';
        if (senderTier === 'PRO') badgeHtml += '<span class="badge-pro">PRO</span>';
        if (senderFunded) badgeHtml += '<span class="badge-funded">FUNDED</span>';

        const senderBadgesArr = _chatBadgesCache[msg.sender_email] || [];
        if (senderBadgesArr.length > 0 && typeof BADGE_DEFINITIONS !== 'undefined' && typeof BADGE_PRIORITY !== 'undefined') {
            const topTwo = BADGE_PRIORITY.filter(id => senderBadgesArr.includes(id)).slice(0, 2);
            if (topTwo.length > 0) {
                badgeHtml += '<span class="chat-badge-icons">' + topTwo.map(id => {
                    const d = BADGE_DEFINITIONS[id];
                    if (!d) return '';
                    return `<span class="badge-icon-inline" style="background:${d.bg};color:${d.color}"><span class="badge-tooltip">${d.name}</span>${d.svg}</span>`;
                }).join('') + '</span>';
            }
        }

        let recipientTag = '';
        if (isPrivate && (msg.recipient_email || msg.recipient_name)) {
            const recipientName = (msg.recipient_name || msg.recipient_email?.split('@')[0] || 'ANON').toUpperCase();
            recipientTag = ` <span class="chat-sender dm-target">\u2192 @${escapeHtml(recipientName)}</span>`;
        }

        const lockIcon = isPrivate ? '<span style="font-size:10px; margin-right:4px;">\uD83D\uDD12</span>' : '';

        return `
            <div class="${msgClass}">
                <div class="chat-message-header">
                    <span class="${senderClass}">${escapeHtml(senderDisplay)}${badgeHtml}${recipientTag}</span>
                    <span class="chat-time">${escapeHtml(time)}</span>
                </div>
                <div class="chat-text">${lockIcon}${escapeHtml(msg.message)}</div>
            </div>
        `;
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// =============================================
// TIMESTAMP FORMATTING
// =============================================

function formatChatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m ago`;

    // Show time if today
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    // Show date if older
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// =============================================
// INPUT LISTENERS
// =============================================

function setupChatInputListeners() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
}

// =============================================
// SEND MESSAGE
// =============================================

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    // Check if user is logged in
    if (!state.currentUser) {
        showToast('Login Required', 'Please log in to send messages');
        openAuthModal();
        return;
    }

    // Parse for @username (private message)
    let isPrivate = false;
    let recipientEmail = null;
    let actualMessage = message;

    const dmMatch = message.match(/^@(\S+)(?:\s+(.*))?$/);
    if (dmMatch) {
        const recipientHandle = dmMatch[1].toLowerCase();
        const dmMessage = dmMatch[2]?.trim();

        if (!dmMessage) {
            showToast('DM Format', 'Use: @username your message');
            return;
        }

        // Look up recipient by username in profiles table
        try {
            const { data: recipientProfile, error: lookupError } = await apiLookupUserByUsername(recipientHandle);

            if (lookupError || !recipientProfile) {
                showToast('User Not Found', `No user found with username "${dmMatch[1]}". Check spelling.`, true);
                input.value = message;
                return;
            }

            isPrivate = true;
            actualMessage = dmMessage;
            recipientEmail = recipientProfile.email;
            var recipientName = recipientProfile.username.toUpperCase();
        } catch (lookupErr) {
            console.error('Error looking up recipient:', lookupErr);
            showToast('Error', 'Could not look up user. Try again.', true);
            input.value = message;
            return;
        }
    }

    // Clear input immediately for responsiveness
    input.value = '';

    // Get sender username (not email for privacy)
    const senderUsername = (state.userProfile?.username || 'trader').toUpperCase();

    try {
        const insertData = {
            sender_email: state.currentUser.email,
            sender_name: senderUsername,
            message: actualMessage,
            is_private: isPrivate,
            recipient_email: recipientEmail
        };
        if (isPrivate && typeof recipientName !== 'undefined') {
            insertData.recipient_name = recipientName;
        }
        const { error } = await apiInsertChatMessage(insertData);

        if (error) {
            // Table might not exist - add locally for demo
            console.log('Chat insert error (table may not exist), adding locally');
            addLocalChatMessage(senderUsername, actualMessage, isPrivate, recipientEmail);
        }
    } catch (err) {
        console.error('Error sending message:', err);
        addLocalChatMessage(senderUsername, actualMessage, isPrivate, recipientEmail);
    }
}

// =============================================
// BLAST MESSAGE
// =============================================

function sendBlastMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    const message = input.value.trim();
    if (!message) {
        showToast('Empty Message', 'Type a message to blast');
        return;
    }

    if (!state.currentUser) {
        showToast('Login Required', 'Please log in to send blasts');
        openAuthModal();
        return;
    }

    // Blast is just a highlighted global message
    input.value = `🔥 BLAST: ${message}`;
    sendChatMessage();
}

// =============================================
// LOCAL / OPTIMISTIC MESSAGE
// =============================================

function addLocalChatMessage(senderName, message, isPrivate, recipientEmail) {
    const newMsg = {
        id: Date.now(),
        sender_email: state.currentUser?.email || 'demo@user.com',
        sender_name: senderName,
        message: message,
        created_at: new Date().toISOString(),
        is_private: isPrivate,
        recipient_email: recipientEmail
    };
    state.chatMessages.push(newMsg);
    renderChatMessages();
}

// =============================================
// ONLINE COUNT
// =============================================

function updateOnlineCount() {
    const countEl = document.getElementById('chat-online-count');
    if (!countEl) return;

    // Simulate random online count (2-8)
    const count = 2 + Math.floor(Math.random() * 7);
    countEl.textContent = `${count} online`;
}

// =============================================
// DEMO MESSAGE SIMULATION
// =============================================

function simulateDemoMessages() {
    const demoMessages = [
        { sender: 'TRADER_KE', message: 'Looking for premium Assam, any availability?' },
        { sender: 'CEYLON_PRO', message: 'Just got fresh lots from Nuwara Eliya estate.' },
        { sender: 'TEA_MASTER', message: 'Price alert: Kenya BP1 trending up.' },
        { sender: 'AUCTION_BOT', message: 'New auction starting in 10 minutes.' },
        { sender: 'MOMBASA_TEA', message: 'Can anyone confirm current Mombasa rates?' }
    ];

    // Send a demo message every 45-90 seconds if not viewing chat
    setInterval(() => {
        if (!isChatVisible() && Math.random() > 0.5) {
            const demo = demoMessages[Math.floor(Math.random() * demoMessages.length)];
            const newMsg = {
                id: Date.now(),
                sender_email: 'demo@teatrade.exchange',
                sender_name: demo.sender,
                message: demo.message,
                created_at: new Date().toISOString(),
                is_private: false
            };
            state.chatMessages.push(newMsg);
            renderChatMessages();
            state.unreadChatCount++;
            updateChatNotificationBadge();
        }
    }, 60000);
}

// Initialisation is handled by app.js — no auto-init here to avoid
// double-subscribing to the Realtime channel.
