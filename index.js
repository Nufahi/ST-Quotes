const MODULE_NAME = 'ST-Quotes';
const LOG_PREFIX = '[Quotes]';
const SETTINGS_KEY = 'stQuotes';

jQuery(async function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Prevent double initialization (hot-reload safe)
    // ---------------------------------------------------------------------
    if (window.__stQuotesInitialized) {
        console.warn(`${LOG_PREFIX} Already initialized, disposing previous instance.`);
        if (typeof window.__stQuotesDispose === 'function') {
            try { window.__stQuotesDispose(); } catch (e) { console.error(`${LOG_PREFIX} Dispose error:`, e); }
        }
    }
    window.__stQuotesInitialized = true;

    function ctx() { return SillyTavern.getContext(); }

    const eventSource = ctx().eventSource;
    const event_types = ctx().eventTypes || ctx().event_types || {};

    // ---------------------------------------------------------------------
    // i18n (lightweight, fetched JSON with fallback)
    // ---------------------------------------------------------------------
    let I18N = {};
    function detectLocale() {
        try {
            const c = ctx();
            const fromCtx = (typeof c.getLocale === 'function' && c.getLocale())
                || c.locale || c.language;
            if (fromCtx) return String(fromCtx).toLowerCase().slice(0, 2);
        } catch (_) { /* noop */ }
        return (navigator.language || 'en').toLowerCase().slice(0, 2);
    }
    async function loadI18n() {
        const loc = detectLocale();
        const base = `scripts/extensions/third-party/${MODULE_NAME}/i18n`;
        for (const code of [loc, 'en']) {
            try {
                const res = await fetch(`${base}/${code}.json`, { cache: 'no-cache' });
                if (res.ok) { I18N = await res.json(); return; }
            } catch (_) { /* try next */ }
        }
        I18N = {};
    }
    function t(key, vars) {
        let s = (I18N && I18N[key]) || key;
        if (vars) for (const k in vars) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
        return s;
    }

    // ---------------------------------------------------------------------
    // Marker colors (Yandex.Books style) + meaning labels
    // ---------------------------------------------------------------------
    const COLORS = [
        { id: 'pink', hex: '#ff6fae' },
        { id: 'blue', hex: '#5aa9ff' },
        { id: 'green', hex: '#3fd17a' },
        { id: 'yellow', hex: '#ffd23f' },
    ];
    const COLOR_IDS = COLORS.map(c => c.id);
    function colorHex(id) { return (COLORS.find(c => c.id === id) || COLORS[3]).hex; }
    function colorLabel(id) {
        const s = getSettings();
        const custom = s.colorLabels && s.colorLabels[id];
        if (custom && custom.trim()) return custom.trim();
        return t('color.' + id);
    }

    // ---------------------------------------------------------------------
    // Settings + storage
    // ---------------------------------------------------------------------
    // Data shape:
    // settings.quotes = {
    //   [botKey]: {
    //     name: 'Char Name',
    //     chats: {
    //       [chatId]: { name: 'chatId', items: [ quote, ... ] }
    //     }
    //   }
    // }
    // quote = { id, text, color, comment, mesId, msgName, isUser, time }
    const DEFAULT_SETTINGS = {
        enabled: true,
        highlightInChat: true,
        colorLabels: { pink: '', blue: '', green: '', yellow: '' },
        defaultColor: 'yellow',
        quotes: {},
    };

    function getSettings() {
        const c = ctx();
        if (!c.extensionSettings[SETTINGS_KEY] || typeof c.extensionSettings[SETTINGS_KEY] !== 'object') {
            c.extensionSettings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
        }
        const s = c.extensionSettings[SETTINGS_KEY];
        if (typeof s.enabled !== 'boolean') s.enabled = true;
        if (typeof s.highlightInChat !== 'boolean') s.highlightInChat = true;
        if (!s.colorLabels || typeof s.colorLabels !== 'object') s.colorLabels = { pink: '', blue: '', green: '', yellow: '' };
        if (!COLOR_IDS.includes(s.defaultColor)) s.defaultColor = 'yellow';
        if (!s.quotes || typeof s.quotes !== 'object') s.quotes = {};
        return s;
    }
    function save() { ctx().saveSettingsDebounced(); }

    // ---------------------------------------------------------------------
    // Bot / chat identity helpers
    // ---------------------------------------------------------------------
    function getBotKey() {
        const c = ctx();
        if (c.groupId) return 'group:' + c.groupId;
        if (c.characterId != null) {
            const char = c.characters?.[c.characterId];
            return char?.avatar || ('char_' + c.characterId);
        }
        return null;
    }
    function getBotName() {
        const c = ctx();
        if (c.groupId) {
            const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
            return g?.name || ('Group ' + c.groupId);
        }
        if (c.characterId != null) return c.characters?.[c.characterId]?.name || '?';
        return '?';
    }
    function getChatId() {
        try {
            const c = ctx();
            return c.getCurrentChatId?.() ?? c.chatId ?? null;
        } catch (_) { return null; }
    }
    function hasOpenChat() {
        const id = getChatId();
        return id !== undefined && id !== null && id !== '';
    }

    function getBotBucket(create) {
        const s = getSettings();
        const key = getBotKey();
        if (!key) return null;
        if (!s.quotes[key]) {
            if (!create) return null;
            s.quotes[key] = { name: getBotName(), chats: {} };
        }
        s.quotes[key].name = getBotName();
        return s.quotes[key];
    }
    function getChatBucket(create) {
        const bot = getBotBucket(create);
        if (!bot) return null;
        const chatId = getChatId();
        if (!chatId) return null;
        if (!bot.chats[chatId]) {
            if (!create) return null;
            bot.chats[chatId] = { name: chatId, items: [] };
        }
        if (!Array.isArray(bot.chats[chatId].items)) bot.chats[chatId].items = [];
        return bot.chats[chatId];
    }

    // ---------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------
    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function uid() {
        return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
    function fmtTime(ts) {
        try { return new Date(ts).toLocaleString(); } catch (_) { return ''; }
    }
    function toast(msg, type) {
        try {
            const toastr = ctx().toastr || window.toastr;
            if (toastr && typeof toastr[type || 'success'] === 'function') {
                toastr[type || 'success'](msg, 'Quotes', { timeOut: 2200 });
                return;
            }
        } catch (_) { /* noop */ }
        console.log(`${LOG_PREFIX} ${msg}`);
    }

    // =====================================================================
    // SELECTION POPUP (the "highlighter" toolbar)
    // =====================================================================
    let $selPopup = null;
    let pendingSelection = null; // { text, mesId, msgName, isUser }

    let selPopupChosenColor = null; // color picked while the note field is open

    function buildSelPopup() {
        if ($selPopup) return $selPopup;
        const swatches = COLORS.map(c => `
            <button class="stq-sel-color" data-color="${c.id}" title="${escapeHtml(colorLabel(c.id))}"
                style="--stq-c:${c.hex}"></button>`).join('');
        $selPopup = $(`
            <div id="stq-sel-popup" class="stq-sel-popup stq-hidden" role="menu">
                <div class="stq-sel-arrow"></div>
                <div class="stq-sel-row">
                    ${swatches}
                    <span class="stq-sel-sep"></span>
                    <button class="stq-sel-note-btn" title="${escapeHtml(t('sel.addNote'))}"><i class="fa-solid fa-pen"></i></button>
                </div>
                <div class="stq-sel-note stq-hidden">
                    <textarea class="stq-sel-note-input text_pole" rows="2" placeholder="${escapeHtml(t('placeholder.comment'))}"></textarea>
                    <button class="stq-sel-save menu_button"><i class="fa-solid fa-check"></i> ${escapeHtml(t('action.save'))}</button>
                </div>
            </div>`);
        $('body').append($selPopup);

        // Keep the text selection alive while interacting with the popup.
        // Only block default (which would clear the selection) for non-text
        // controls; the textarea must still receive focus & caret.
        $selPopup.on('mousedown touchstart', (e) => {
            e.stopPropagation();
            if (!$(e.target).closest('.stq-sel-note-input').length) e.preventDefault();
        });

        // Color swatch: if note field is open, just pick the color; otherwise
        // save instantly (the fast, Yandex.Books-style path).
        $selPopup.on('click', '.stq-sel-color', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const color = $(this).data('color');
            if ($selPopup.hasClass('stq-note-open')) {
                selPopupChosenColor = color;
                $selPopup.find('.stq-sel-color').removeClass('active');
                $(this).addClass('active');
            } else {
                saveSelectionAsQuote(color, '');
            }
        });

        // Toggle the note field.
        $selPopup.on('click', '.stq-sel-note-btn', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openSelNote();
        });

        // Save with the typed note.
        $selPopup.on('click', '.stq-sel-save', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const note = $selPopup.find('.stq-sel-note-input').val() || '';
            const color = selPopupChosenColor || getSettings().defaultColor;
            saveSelectionAsQuote(color, note);
        });

        // Ctrl/Cmd+Enter saves; Escape closes.
        $selPopup.on('keydown', '.stq-sel-note-input', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const note = this.value || '';
                const color = selPopupChosenColor || getSettings().defaultColor;
                saveSelectionAsQuote(color, note);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideSelPopup();
            }
        });

        return $selPopup;
    }

    function openSelNote() {
        if (!$selPopup) return;
        selPopupChosenColor = getSettings().defaultColor;
        $selPopup.addClass('stq-note-open');
        $selPopup.find('.stq-sel-note').removeClass('stq-hidden');
        $selPopup.find('.stq-sel-color').removeClass('active')
            .filter(`[data-color="${selPopupChosenColor}"]`).addClass('active');
        const $ta = $selPopup.find('.stq-sel-note-input');
        $ta.val('');
        // focus without losing the saved selection range
        setTimeout(() => { try { $ta[0].focus({ preventScroll: true }); } catch (_) { $ta.trigger('focus'); } }, 0);
        repositionSelPopup();
    }

    function refreshSelPopupTitles() {
        if (!$selPopup) return;
        $selPopup.find('.stq-sel-color').each(function () {
            $(this).attr('title', colorLabel($(this).data('color')));
        });
    }

    function hideSelPopup() {
        if ($selPopup) {
            $selPopup.addClass('stq-hidden').removeClass('stq-note-open');
            $selPopup.find('.stq-sel-note').addClass('stq-hidden');
            $selPopup.find('.stq-sel-note-input').val('');
            $selPopup.find('.stq-sel-color').removeClass('active');
        }
        selPopupChosenColor = null;
        pendingSelection = null;
    }

    // True while the user is typing a note in the selection popup — used to
    // stop selectionchange/pointer handlers from hiding the popup.
    function noteFieldActive() {
        return !!($selPopup && $selPopup.hasClass('stq-note-open'));
    }

    // Find the .mes element (and its mesid) that contains a node.
    function mesInfoFromNode(node) {
        let el = node && node.nodeType === 3 ? node.parentElement : node;
        while (el && el !== document.body) {
            if (el.classList && el.classList.contains('mes') && el.hasAttribute('mesid')) {
                const mesId = parseInt(el.getAttribute('mesid'), 10);
                const c = ctx();
                const msg = Array.isArray(c.chat) ? c.chat[mesId] : null;
                return {
                    mesId,
                    msgName: msg?.name || '',
                    isUser: !!msg?.is_user,
                };
            }
            el = el.parentElement;
        }
        return null;
    }

    let lastSelRect = null; // remembered selection rect for repositioning

    function showSelPopupForSelection() {
        const s = getSettings();
        if (!s.enabled) return;
        // Don't disturb the popup while the user is typing a note.
        if (noteFieldActive()) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelPopup(); return; }

        const text = sel.toString().trim();
        if (text.length < 2) { hideSelPopup(); return; }

        const range = sel.getRangeAt(0);
        // Only react to selections inside a chat message's text body.
        const anchor = range.startContainer;
        const inText = (anchor.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.('.mes_text');
        if (!inText) { hideSelPopup(); return; }

        const info = mesInfoFromNode(anchor);
        if (!info) { hideSelPopup(); return; }

        pendingSelection = { text, mesId: info.mesId, msgName: info.msgName, isUser: info.isUser };
        lastSelRect = range.getBoundingClientRect();

        buildSelPopup().removeClass('stq-hidden');
        refreshSelPopupTitles();
        repositionSelPopup();
    }

    function repositionSelPopup() {
        if (!$selPopup || !lastSelRect) return;
        const rect = lastSelRect;
        const $p = $selPopup;

        const pw = $p.outerWidth() || 200;
        const ph = $p.outerHeight() || 48;
        let left = rect.left + rect.width / 2 - pw / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
        let top = rect.top - ph - 12;
        let below = false;
        if (top < 8) { top = rect.bottom + 12; below = true; }

        $p.toggleClass('stq-below', below);
        $p.css({ left: left + 'px', top: top + 'px' });
        // arrow x position relative to popup
        const arrowX = Math.max(12, Math.min(rect.left + rect.width / 2 - left, pw - 12));
        $p.find('.stq-sel-arrow').css('left', arrowX + 'px');
    }

    function saveSelectionAsQuote(color, comment) {
        if (!pendingSelection) { hideSelPopup(); return; }
        if (!hasOpenChat() || !getBotKey()) {
            toast(t('toast.noChat'), 'warning');
            hideSelPopup();
            return;
        }
        const bucket = getChatBucket(true);
        if (!bucket) { hideSelPopup(); return; }

        const quote = {
            id: uid(),
            text: pendingSelection.text,
            color: COLOR_IDS.includes(color) ? color : getSettings().defaultColor,
            comment: (comment || '').trim(),
            mesId: pendingSelection.mesId,
            msgName: pendingSelection.msgName,
            isUser: pendingSelection.isUser,
            time: Date.now(),
        };
        bucket.items.unshift(quote);
        save();
        toast(t('toast.saved', { label: colorLabel(quote.color) }), 'success');

        // clear selection + highlight immediately
        try { window.getSelection()?.removeAllRanges(); } catch (_) { /* noop */ }
        hideSelPopup();
        if (getSettings().highlightInChat) highlightMessage(quote.mesId);
        if (drawerOpen) renderPanel();
    }

    // =====================================================================
    // IN-CHAT HIGHLIGHTING (mark quoted spans like a book highlighter)
    // =====================================================================
    function quotesForCurrentChat() {
        const bucket = getChatBucket(false);
        return bucket ? bucket.items : [];
    }

    // Wrap the first occurrence of `text` within a container in a highlight span.
    function wrapTextInElement(container, text, quote) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest('.stq-mark')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        // Try single-node match first (most common, keeps it simple & safe).
        let node;
        while ((node = walker.nextNode())) {
            const idx = node.nodeValue.indexOf(text);
            if (idx === -1) continue;
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + text.length);
            const mark = document.createElement('span');
            mark.className = 'stq-mark';
            mark.dataset.qid = quote.id;
            mark.dataset.color = quote.color;
            mark.style.setProperty('--stq-c', colorHex(quote.color));
            mark.title = quote.comment ? quote.comment : colorLabel(quote.color);
            try {
                range.surroundContents(mark);
                return true;
            } catch (_) {
                return false; // selection crossed element boundaries
            }
        }
        return false;
    }

    function highlightMessage(mesId) {
        if (!getSettings().highlightInChat) return;
        const block = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
        if (!block) return;
        const items = quotesForCurrentChat().filter(q => q.mesId === mesId);
        if (!items.length) return;
        // longest first so nested/overlapping shorter strings don't break wrapping
        items.slice().sort((a, b) => b.text.length - a.text.length).forEach((q) => {
            if (block.querySelector(`.stq-mark[data-qid="${q.id}"]`)) return;
            wrapTextInElement(block, q.text, q);
        });
    }

    function highlightAllVisible() {
        if (!getSettings().highlightInChat) return;
        const items = quotesForCurrentChat();
        if (!items.length) return;
        const ids = new Set(items.map(q => q.mesId));
        ids.forEach(highlightMessage);
    }

    function clearAllHighlights() {
        document.querySelectorAll('#chat .stq-mark').forEach((el) => {
            const parent = el.parentNode;
            if (!parent) return;
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
            parent.normalize();
        });
    }

    function removeHighlight(qid) {
        document.querySelectorAll(`#chat .stq-mark[data-qid="${qid}"]`).forEach((el) => {
            const parent = el.parentNode;
            if (!parent) return;
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            parent.removeChild(el);
            parent.normalize();
        });
    }

    function refreshHighlight(qid) {
        removeHighlight(qid);
        const q = quotesForCurrentChat().find(x => x.id === qid);
        if (q) highlightMessage(q.mesId);
    }

    function scrollToQuote(q) {
        const block = document.querySelector(`#chat .mes[mesid="${q.mesId}"]`);
        if (!block) { toast(t('toast.notInView'), 'info'); return; }
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const mark = block.querySelector(`.stq-mark[data-qid="${q.id}"]`);
        const target = mark || block;
        target.classList.add('stq-flash');
        setTimeout(() => target.classList.remove('stq-flash'), 1600);
    }

    // =====================================================================
    // PANEL (modal: bots -> chats -> quotes)
    // =====================================================================
    let drawerOpen = false;
    let $modal = null;
    // navigation state
    let view = 'bots';        // 'bots' | 'chats' | 'quotes'
    let curBotKey = null;
    let curChatId = null;
    let filterColor = 'all';
    let searchText = '';

    async function ensureModal() {
        if ($modal && $modal.length) return $modal;
        let html;
        try {
            html = await ctx().renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'manager');
        } catch (_) {
            try {
                const res = await fetch(`scripts/extensions/third-party/${MODULE_NAME}/manager.html`);
                html = await res.text();
            } catch (e) { console.error(`${LOG_PREFIX} template load failed`, e); return null; }
        }
        document.body.insertAdjacentHTML('beforeend', html);
        $modal = $('#stq-modal');
        wireModal();
        return $modal;
    }

    function wireModal() {
        $modal.on('click', '.stq-backdrop, [data-stq-close]', () => closePanel());
        $modal.on('click', '#stq-back', () => {
            if (view === 'quotes') { view = 'chats'; curChatId = null; }
            else if (view === 'chats') { view = 'bots'; curBotKey = null; }
            renderPanel();
        });
        $modal.on('input', '#stq-search', function () {
            searchText = this.value.toLowerCase();
            renderPanel();
        });
        $modal.on('click', '.stq-filter-chip', function () {
            filterColor = $(this).data('color');
            renderPanel();
        });

        // bot card
        $modal.on('click', '.stq-bot-card', function () {
            curBotKey = $(this).data('botkey');
            view = 'chats';
            searchText = ''; filterColor = 'all';
            renderPanel();
        });
        // chat card
        $modal.on('click', '.stq-chat-card', function () {
            curChatId = $(this).data('chatid');
            view = 'quotes';
            searchText = ''; filterColor = 'all';
            renderPanel();
        });
        // delete a bot
        $modal.on('click', '.stq-del-bot', async function (e) {
            e.stopPropagation();
            const key = $(this).closest('.stq-bot-card').data('botkey');
            if (await confirmDialog(t('confirm.delBot'))) {
                delete getSettings().quotes[key];
                save();
                renderPanel();
            }
        });
        // delete a chat
        $modal.on('click', '.stq-del-chat', async function (e) {
            e.stopPropagation();
            const cid = $(this).closest('.stq-chat-card').data('chatid');
            if (await confirmDialog(t('confirm.delChat'))) {
                const bot = getSettings().quotes[curBotKey];
                if (bot) delete bot.chats[cid];
                save();
                renderPanel();
            }
        });

        // quote actions
        $modal.on('click', '.stq-q-goto', function () {
            const q = findQuote($(this).closest('.stq-quote').data('qid'));
            if (q) { closePanel(); setTimeout(() => scrollToQuote(q), 250); }
        });
        $modal.on('click', '.stq-q-del', async function () {
            const id = $(this).closest('.stq-quote').data('qid');
            if (await confirmDialog(t('confirm.delQuote'))) {
                deleteQuote(id);
                renderPanel();
            }
        });
        $modal.on('click', '.stq-q-color .stq-sel-color', function () {
            const id = $(this).closest('.stq-quote').data('qid');
            const color = $(this).data('color');
            const q = findQuote(id);
            if (q) { q.color = color; save(); refreshHighlight(id); renderPanel(); }
        });
        $modal.on('input', '.stq-q-comment', function () {
            const id = $(this).closest('.stq-quote').data('qid');
            const q = findQuote(id);
            if (q) { q.comment = this.value; save(); }
        });
    }

    function findQuote(id) {
        // search within current chat context first, then globally
        const s = getSettings();
        for (const bk in s.quotes) {
            const chats = s.quotes[bk].chats || {};
            for (const cid in chats) {
                const found = (chats[cid].items || []).find(q => q.id === id);
                if (found) return found;
            }
        }
        return null;
    }
    function deleteQuote(id) {
        const s = getSettings();
        for (const bk in s.quotes) {
            const chats = s.quotes[bk].chats || {};
            for (const cid in chats) {
                const arr = chats[cid].items || [];
                const i = arr.findIndex(q => q.id === id);
                if (i !== -1) { arr.splice(i, 1); save(); removeHighlight(id); return; }
            }
        }
    }

    async function confirmDialog(text) {
        try {
            const c = ctx();
            if (c.Popup?.show?.confirm) {
                const r = await c.Popup.show.confirm(t('app.title'), text);
                return !!r;
            }
        } catch (_) { /* noop */ }
        return window.confirm(text);
    }

    function colorFilterChips(counts) {
        const chips = [`<button class="stq-filter-chip ${filterColor === 'all' ? 'active' : ''}" data-color="all">${t('filter.all')}</button>`];
        COLORS.forEach((c) => {
            const n = counts[c.id] || 0;
            chips.push(`<button class="stq-filter-chip ${filterColor === c.id ? 'active' : ''}" data-color="${c.id}" style="--stq-c:${c.hex}">
                <span class="stq-chip-dot"></span>${escapeHtml(colorLabel(c.id))}${n ? ` <span class="stq-chip-n">${n}</span>` : ''}
            </button>`);
        });
        return `<div class="stq-filters">${chips.join('')}</div>`;
    }

    function renderPanel() {
        if (!$modal) return;
        const $title = $modal.find('#stq-title');
        const $crumb = $modal.find('#stq-crumb');
        const $body = $modal.find('#stq-body');
        const $back = $modal.find('#stq-back');
        const $tools = $modal.find('#stq-tools');
        const s = getSettings();

        $back.toggleClass('stq-hidden', view === 'bots');

        if (view === 'bots') {
            $title.text(t('app.title'));
            $crumb.text('');
            $tools.addClass('stq-hidden');
            renderBots($body);
        } else if (view === 'chats') {
            const bot = s.quotes[curBotKey];
            $title.text(bot?.name || '?');
            $crumb.text(t('crumb.bot'));
            $tools.addClass('stq-hidden');
            renderChats($body, bot);
        } else {
            const bot = s.quotes[curBotKey];
            const chat = bot?.chats?.[curChatId];
            $title.text(chat?.name || curChatId || '?');
            $crumb.text((bot?.name || '') );
            $tools.removeClass('stq-hidden');
            renderQuotes($body, chat);
        }
    }

    function totalQuotes(bot) {
        let n = 0;
        const chats = bot?.chats || {};
        for (const cid in chats) n += (chats[cid].items || []).length;
        return n;
    }

    function renderBots($body) {
        const s = getSettings();
        const keys = Object.keys(s.quotes).filter(k => totalQuotes(s.quotes[k]) > 0);
        if (!keys.length) {
            $body.html(emptyState(t('empty.bots'), t('empty.botsHint')));
            return;
        }
        // sort by total quotes desc
        keys.sort((a, b) => totalQuotes(s.quotes[b]) - totalQuotes(s.quotes[a]));
        const curKey = getBotKey();
        const cards = keys.map((k) => {
            const bot = s.quotes[k];
            const n = totalQuotes(bot);
            const chatN = Object.keys(bot.chats || {}).filter(c => (bot.chats[c].items || []).length).length;
            const isCur = k === curKey;
            return `
            <div class="stq-bot-card stq-card" data-botkey="${escapeHtml(k)}">
                <div class="stq-card-main">
                    <div class="stq-card-title">${escapeHtml(bot.name || '?')} ${isCur ? `<span class="stq-badge-cur">${t('badge.current')}</span>` : ''}</div>
                    <div class="stq-card-sub">${t('stat.chats', { n: chatN })} &middot; ${t('stat.quotes', { n })}</div>
                </div>
                <button class="stq-icon-btn stq-del-bot" title="${t('action.delete')}"><i class="fa-solid fa-trash"></i></button>
                <i class="fa-solid fa-chevron-right stq-card-chevron"></i>
            </div>`;
        }).join('');
        $body.html(`<div class="stq-list">${cards}</div>`);
    }

    function renderChats($body, bot) {
        const chats = bot?.chats || {};
        const ids = Object.keys(chats).filter(c => (chats[c].items || []).length);
        if (!ids.length) {
            $body.html(emptyState(t('empty.chats'), ''));
            return;
        }
        ids.sort((a, b) => {
            const la = Math.max(...chats[a].items.map(q => q.time || 0), 0);
            const lb = Math.max(...chats[b].items.map(q => q.time || 0), 0);
            return lb - la;
        });
        const curCid = getChatId();
        const cards = ids.map((cid) => {
            const chat = chats[cid];
            const n = chat.items.length;
            const isCur = cid === curCid && curBotKey === getBotKey();
            // color dots summary
            const byColor = {};
            chat.items.forEach(q => { byColor[q.color] = (byColor[q.color] || 0) + 1; });
            const dots = COLORS.filter(c => byColor[c.id]).map(c =>
                `<span class="stq-dot" style="--stq-c:${c.hex}" title="${escapeHtml(colorLabel(c.id))}: ${byColor[c.id]}"></span>`).join('');
            return `
            <div class="stq-chat-card stq-card" data-chatid="${escapeHtml(cid)}">
                <div class="stq-card-main">
                    <div class="stq-card-title">${escapeHtml(chat.name || cid)} ${isCur ? `<span class="stq-badge-cur">${t('badge.current')}</span>` : ''}</div>
                    <div class="stq-card-sub"><span class="stq-dots">${dots}</span> ${t('stat.quotes', { n })}</div>
                </div>
                <button class="stq-icon-btn stq-del-chat" title="${t('action.delete')}"><i class="fa-solid fa-trash"></i></button>
                <i class="fa-solid fa-chevron-right stq-card-chevron"></i>
            </div>`;
        }).join('');
        $body.html(`<div class="stq-list">${cards}</div>`);
    }

    function renderQuotes($body, chat) {
        let items = (chat?.items || []).slice();
        const counts = {};
        items.forEach(q => { counts[q.color] = (counts[q.color] || 0) + 1; });

        if (filterColor !== 'all') items = items.filter(q => q.color === filterColor);
        if (searchText) items = items.filter(q =>
            (q.text || '').toLowerCase().includes(searchText) ||
            (q.comment || '').toLowerCase().includes(searchText));

        const filters = colorFilterChips(counts);

        if (!items.length) {
            $body.html(filters + emptyState(t('empty.quotes'), ''));
            return;
        }

        const isCurChat = curChatId === getChatId() && curBotKey === getBotKey();

        const cards = items.map((q) => {
            const swatches = COLORS.map(c => `
                <button class="stq-sel-color ${c.id === q.color ? 'active' : ''}" data-color="${c.id}"
                    title="${escapeHtml(colorLabel(c.id))}" style="--stq-c:${c.hex}"></button>`).join('');
            const who = q.msgName ? escapeHtml(q.msgName) : (q.isUser ? t('who.you') : t('who.bot'));
            return `
            <div class="stq-quote" data-qid="${q.id}" style="--stq-c:${colorHex(q.color)}">
                <div class="stq-quote-bar"></div>
                <div class="stq-quote-main">
                    <div class="stq-quote-text">${escapeHtml(q.text)}</div>
                    <div class="stq-quote-meta">
                        <span class="stq-quote-who">${who}</span>
                        <span class="stq-quote-time">${fmtTime(q.time)}</span>
                    </div>
                    <textarea class="stq-q-comment text_pole" rows="1" placeholder="${t('placeholder.comment')}">${escapeHtml(q.comment || '')}</textarea>
                    <div class="stq-quote-actions">
                        <div class="stq-q-color">${swatches}</div>
                        <div class="stq-quote-btns">
                            ${isCurChat ? `<button class="stq-text-btn stq-q-goto"><i class="fa-solid fa-location-crosshairs"></i> ${t('action.goto')}</button>` : ''}
                            <button class="stq-text-btn stq-danger stq-q-del"><i class="fa-solid fa-trash"></i> ${t('action.delete')}</button>
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');
        $body.html(filters + `<div class="stq-quotes-list">${cards}</div>`);
        autoGrowComments();
    }

    function autoGrowComments() {
        $modal.find('.stq-q-comment').each(function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 160) + 'px';
        }).off('input.grow').on('input.grow', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 160) + 'px';
        });
    }

    function emptyState(title, hint) {
        return `<div class="stq-empty">
            <i class="fa-solid fa-bookmark"></i>
            <div class="stq-empty-title">${escapeHtml(title)}</div>
            ${hint ? `<div class="stq-empty-hint">${escapeHtml(hint)}</div>` : ''}
        </div>`;
    }

    async function openPanel() {
        await ensureModal();
        if (!$modal) return;
        // open straight into the current chat's quotes if we have one
        const bk = getBotKey();
        const cid = getChatId();
        if (bk && cid && getSettings().quotes[bk]?.chats?.[cid]?.items?.length) {
            curBotKey = bk; curChatId = cid; view = 'quotes';
        } else if (bk && getSettings().quotes[bk] && totalQuotes(getSettings().quotes[bk])) {
            curBotKey = bk; view = 'chats';
        } else {
            view = 'bots'; curBotKey = null; curChatId = null;
        }
        filterColor = 'all'; searchText = '';
        $modal.removeClass('stq-hidden');
        document.body.classList.add('stq-modal-open');
        drawerOpen = true;
        renderPanel();
    }
    function closePanel() {
        if ($modal) $modal.addClass('stq-hidden');
        document.body.classList.remove('stq-modal-open');
        drawerOpen = false;
    }

    // =====================================================================
    // WAND BUTTON
    // =====================================================================
    let wandTimer = null;
    let wandTries = 0;
    let lastFire = 0;

    // Close the wand / extensions dropdown the same way SillyTavern does.
    // ST toggles these menus with jQuery (display:none / fadeOut), not a CSS
    // class, so we mirror that. Important on mobile, where the menu otherwise
    // stays open on top of the panel.
    function closeExtensionsMenu() {
        try {
            if (window.jQuery) {
                const $j = window.jQuery;
                $j('#extensionsMenu').fadeOut?.(150);
                $j('#extensionsMenu').hide?.();
                $j('.options-content, #extensionsMenuButton').trigger?.('mouseleave');
            }
        } catch (_) { /* noop */ }
        const menu = document.getElementById('extensionsMenu');
        if (menu) menu.style.display = 'none';
    }

    function addWandButton() {
        const container = document.getElementById('extensionsMenu')
            || document.getElementById('gallery_wand_container');
        if (!(container instanceof HTMLElement)) return false;
        if (document.getElementById('stq_wand_button')) return true;

        const btn = document.createElement('div');
        btn.id = 'stq_wand_button';
        btn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
        btn.tabIndex = 0;
        btn.setAttribute('role', 'button');
        btn.style.cursor = 'pointer';
        btn.title = t('app.title');

        const icon = document.createElement('div');
        icon.classList.add('fa-solid', 'fa-bookmark', 'extensionsMenuExtensionButton');
        const label = document.createElement('span');
        label.textContent = t('app.title');
        btn.append(icon, label);

        const fire = (e) => {
            // IMPORTANT: only preventDefault — do NOT stopPropagation here.
            // SillyTavern closes the wand/extensions dropdown via a delegated
            // click handler on `document`; if we stop the event from bubbling,
            // that handler never runs and the menu stays open. Letting the
            // click bubble lets ST auto-close it.
            e.preventDefault();
            const now = Date.now();
            if (now - lastFire < 400) return;
            lastFire = now;
            openPanel();
            // Belt-and-suspenders for builds/webviews where ST's handler
            // doesn't fire: explicitly hide the menu too.
            closeExtensionsMenu();
        };
        btn.addEventListener('click', fire);
        btn.addEventListener('touchend', fire, { passive: false });
        container.appendChild(btn);
        return true;
    }

    // Top-bar buttons that should auto-close the panel when tapped — mirrors
    // SillyTavern's top navigation in #top-settings-holder. Capture phase so we
    // react before ST opens its own drawer.
    function onTopBarClick(e) {
        if (!drawerOpen) return;
        const target = e.target;
        if (!(target instanceof Element)) return;
        // Ignore clicks inside our own panel / selection popup / wand button.
        if (target.closest('#stq-modal') || target.closest('#stq-sel-popup') || target.closest('#stq_wand_button')) return;

        const hit = target.closest(
            '#top-settings-holder .drawer-toggle, '
            + '#top-settings-holder .drawer-icon, '
            + '#extensionsMenuButton, '
            + '.fillLeft .drawer-toggle, '
            + '#sys-settings-button, #user-settings-button, #persona-management-button, '
            + '#advanced-formatting-button, #WIDrawerIcon, #rightNavDrawerIcon, '
            + '#leftNavDrawerIcon, #extensions-settings-button, #logo_block'
        );
        if (hit) closePanel();
    }
    document.addEventListener('click', onTopBarClick, true);

    // =====================================================================
    // SETTINGS CARD (Extensions tab) — color labels + toggles
    // =====================================================================
    async function addSettingsCard() {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host || document.getElementById('stq-settings')) return;
        const s = getSettings();
        const labelRows = COLORS.map(c => `
            <div class="stq-set-row">
                <span class="stq-dot" style="--stq-c:${c.hex}"></span>
                <input type="text" class="text_pole stq-label-input" data-color="${c.id}"
                    placeholder="${t('color.' + c.id)}" value="${escapeHtml(s.colorLabels[c.id] || '')}">
            </div>`).join('');
        const html = `
        <div id="stq-settings" class="stq-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-bookmark"></i> ${t('app.title')}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="stq-set-enabled" ${s.enabled ? 'checked' : ''}>
                        <span>${t('set.enabled')}</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="stq-set-highlight" ${s.highlightInChat ? 'checked' : ''}>
                        <span>${t('set.highlight')}</span>
                    </label>
                    <hr>
                    <div class="stq-set-caption">${t('set.labels')}</div>
                    ${labelRows}
                    <div class="stq-set-actions">
                        <div class="menu_button stq-open-panel"><i class="fa-solid fa-bookmark"></i> ${t('set.openPanel')}</div>
                    </div>
                </div>
            </div>
        </div>`;
        host.insertAdjacentHTML('beforeend', html);

        const $set = $('#stq-settings');
        $set.on('change', '#stq-set-enabled', function () { getSettings().enabled = this.checked; save(); });
        $set.on('change', '#stq-set-highlight', function () {
            getSettings().highlightInChat = this.checked; save();
            if (this.checked) highlightAllVisible(); else clearAllHighlights();
        });
        $set.on('input', '.stq-label-input', function () {
            getSettings().colorLabels[$(this).data('color')] = this.value; save();
            refreshSelPopupTitles();
        });
        $set.on('click', '.stq-open-panel', () => openPanel());
    }

    // =====================================================================
    // EVENT WIRING
    // =====================================================================
    const boundHandlers = [];
    function on(evt, fn) {
        if (!evt || !eventSource || typeof eventSource.on !== 'function') return;
        eventSource.on(evt, fn);
        boundHandlers.push([evt, fn]);
    }

    // Selection events (mouse + touch + keyboard)
    const onSelectionChange = () => {
        if (noteFieldActive()) return; // don't disturb the note being typed
        // debounce a touch so the popup follows the final selection
        clearTimeout(onSelectionChange._t);
        onSelectionChange._t = setTimeout(showSelPopupForSelection, 120);
    };
    document.addEventListener('mouseup', onSelectionChange);
    document.addEventListener('touchend', onSelectionChange);
    const onSelectionChangeEvt = () => {
        if (noteFieldActive()) return; // clicking into the note collapses the
        // chat selection — that's expected, keep the popup open.
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideSelPopup();
    };
    document.addEventListener('selectionchange', onSelectionChangeEvt);
    const onDocPointerDown = (e) => {
        // A click outside the popup closes it (incl. while a note is open).
        if ($selPopup && !$selPopup.hasClass('stq-hidden') && !$selPopup[0].contains(e.target)) {
            if (noteFieldActive()) { hideSelPopup(); return; }
            // let the selection settle; if collapsed it'll hide via selectionchange
            setTimeout(() => {
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed) hideSelPopup();
            }, 0);
        }
    };
    document.addEventListener('mousedown', onDocPointerDown);
    const onScrollHide = () => { if (!noteFieldActive()) hideSelPopup(); };
    window.addEventListener('scroll', onScrollHide, true);

    // Re-apply highlights as messages render / chat changes
    const reHighlightDebounced = (() => {
        let tmr = null;
        return () => { clearTimeout(tmr); tmr = setTimeout(highlightAllVisible, 80); };
    })();

    on(event_types.CHARACTER_MESSAGE_RENDERED, (idx) => { if (typeof idx === 'number') highlightMessage(idx); });
    on(event_types.USER_MESSAGE_RENDERED, (idx) => { if (typeof idx === 'number') highlightMessage(idx); });
    on(event_types.MESSAGE_SWIPED, reHighlightDebounced);
    on(event_types.MESSAGE_EDITED, reHighlightDebounced);
    on(event_types.MESSAGE_UPDATED, reHighlightDebounced);
    on(event_types.MORE_MESSAGES_LOADED, reHighlightDebounced);
    on(event_types.CHAT_CHANGED, () => {
        hideSelPopup();
        if (drawerOpen) { closePanel(); }
        reHighlightDebounced();
    });
    on(event_types.APP_READY, () => { reHighlightDebounced(); });

    // =====================================================================
    // SLASH COMMAND
    // =====================================================================
    try {
        const { SlashCommandParser, SlashCommand } = ctx();
        if (SlashCommandParser && SlashCommand) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'quotes',
                aliases: ['bookmarks'],
                callback: () => { openPanel(); return ''; },
                helpString: 'Open the Quotes & Bookmarks panel.',
            }));
        }
    } catch (_) { /* optional */ }

    // =====================================================================
    // INIT
    // =====================================================================
    await loadI18n();
    addSettingsCard();
    wandTimer = setInterval(() => {
        if (addWandButton() || ++wandTries > 40) clearInterval(wandTimer);
    }, 500);
    setTimeout(highlightAllVisible, 600);

    console.log(`${LOG_PREFIX} initialized.`);

    // =====================================================================
    // DISPOSE (hot-reload)
    // =====================================================================
    window.__stQuotesDispose = function () {
        try {
            boundHandlers.forEach(([evt, fn]) => {
                try { eventSource.removeListener?.(evt, fn); } catch (_) { /* noop */ }
            });
            document.removeEventListener('mouseup', onSelectionChange);
            document.removeEventListener('touchend', onSelectionChange);
            document.removeEventListener('selectionchange', onSelectionChangeEvt);
            document.removeEventListener('mousedown', onDocPointerDown);
            document.removeEventListener('click', onTopBarClick, true);
            window.removeEventListener('scroll', onScrollHide, true);
            clearInterval(wandTimer);
            clearAllHighlights();
            $('#stq-modal, #stq-sel-popup, #stq_wand_button, #stq-settings').remove();
            document.body.classList.remove('stq-modal-open');
        } catch (e) { console.error(`${LOG_PREFIX} dispose error`, e); }
        window.__stQuotesInitialized = false;
    };
});

