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
        // 1) Respect the language the user picked in SillyTavern's UI
        //    (User Settings -> Language). ST stores it in localStorage under
        //    "language"; empty/"default" means "follow the browser".
        try {
            const stored = localStorage.getItem('language');
            if (stored && stored.toLowerCase() !== 'default') {
                return stored.toLowerCase().slice(0, 2);
            }
        } catch (_) { /* noop */ }

        // 2) Fall back to anything the context exposes.
        try {
            const c = ctx();
            const fromCtx = (typeof c.getLocale === 'function' && c.getLocale())
                || c.locale || c.language;
            if (fromCtx) return String(fromCtx).toLowerCase().slice(0, 2);
        } catch (_) { /* noop */ }

        // 3) Last resort: the browser language.
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

    // Touch / coarse-pointer devices need a different toolbar placement: the
    // OS-level text-selection menu (Copy / Select all / …) is an overlay that
    // always sits above page content and steals taps, so floating our popup
    // *over* the selection is unusable on phones. On these devices we dock the
    // toolbar to the bottom of the screen, well clear of the native menu.
    const IS_TOUCH = (() => {
        try {
            const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
            const touchPoints = (navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0) > 0;
            const hasTouchEvt = 'ontouchstart' in window || 'ontouchstart' in document.documentElement;
            const narrow = window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
            // Any single touch signal is enough; we'd rather dock the toolbar
            // unnecessarily on a small desktop window than leave it broken on a
            // phone where one of these checks happens to fail.
            return !!(coarse || noHover || touchPoints || hasTouchEvt || narrow);
        } catch (_) {
            return 'ontouchstart' in window;
        }
    })();

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
        const dockedCls = IS_TOUCH ? ' stq-sel-docked' : '';
        $selPopup = $(`
            <div id="stq-sel-popup" class="stq-sel-popup stq-hidden${dockedCls}" role="menu">
                <div class="stq-sel-arrow"></div>
                <button class="stq-sel-close" title="${escapeHtml(t('action.close') || 'Close')}" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
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

        // Explicit close (mainly for the docked mobile bar).
        $selPopup.on('click', '.stq-sel-close', function (e) {
            e.preventDefault();
            e.stopPropagation();
            try { window.getSelection()?.removeAllRanges(); } catch (_) { /* noop */ }
            hideSelPopup();
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

    // TEMP DEBUG: shows on-screen toasts so we can diagnose the mobile popup
    // without a desktop devtools connection. Set back to false once fixed.
    const SEL_DEBUG = true;
    let _lastSelLog = '';
    let _lastSelLogAt = 0;
    function selLog() {
        if (!SEL_DEBUG) return;
        const msg = Array.prototype.join.call(arguments, ' ');
        const now = Date.now();
        // de-spam: skip identical messages fired within 1.2s of each other
        if (msg === _lastSelLog && (now - _lastSelLogAt) < 1200) return;
        _lastSelLog = msg; _lastSelLogAt = now;
        try { console.log(LOG_PREFIX, '[sel]', msg); } catch (_) { /* noop */ }
        try {
            const toastr = ctx().toastr || window.toastr;
            if (toastr && toastr.info) toastr.info(msg, 'Quotes/sel', { timeOut: 2500, preventDuplicates: true });
        } catch (_) { /* noop */ }
    }

    // Resolve the .mes_text element a node lives in. Handles text nodes and the
    // case where the selection boundary is the .mes / .mes_text element itself.
    function closestMesText(node) {
        let el = node && node.nodeType === 3 ? node.parentElement : node;
        if (!el || !el.closest) return null;
        const direct = el.closest('.mes_text');
        if (direct) return direct;
        const mes = el.closest('.mes');
        return mes ? mes.querySelector('.mes_text') : null;
    }

    function showSelPopupForSelection() {
        selLog('run; IS_TOUCH=' + IS_TOUCH);
        const s = getSettings();
        if (!s.enabled) { selLog('ext disabled in settings'); return; }
        // Don't disturb the popup while the user is typing a note.
        if (noteFieldActive()) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            // On touch a collapsed selection often just means the native menu /
            // a swatch tap cleared it — keep the docked bar if it's already armed.
            if (IS_TOUCH && pendingSelection) return;
            selLog('collapsed/empty selection');
            hideSelPopup();
            return;
        }

        const text = sel.toString().trim();
        selLog('text len=' + text.length);
        if (text.length < 2) { hideSelPopup(); return; }

        const range = sel.getRangeAt(0);
        // Only react to selections inside a chat message's text body. On mobile
        // the selection boundary may be the element node itself (not a text
        // node), and start/end can differ, so check several anchors.
        const anchor = range.startContainer;
        const inText = closestMesText(anchor)
            || closestMesText(range.endContainer)
            || closestMesText(range.commonAncestorContainer);
        if (!inText) { selLog('not in mes_text'); hideSelPopup(); return; }

        const info = mesInfoFromNode(inText);
        if (!info) { selLog('no mes info'); hideSelPopup(); return; }

        selLog('SHOWING popup, mesId=' + info.mesId);
        pendingSelection = { text, mesId: info.mesId, msgName: info.msgName, isUser: info.isUser };
        lastSelRect = range.getBoundingClientRect();

        buildSelPopup().removeClass('stq-hidden');
        refreshSelPopupTitles();
        repositionSelPopup();

        if (SEL_DEBUG) {
            setTimeout(() => {
                try {
                    const el = $selPopup && $selPopup[0];
                    if (!el) { selLog('popup el missing'); return; }
                    const r = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    selLog('rect ' + Math.round(r.left) + ',' + Math.round(r.top)
                        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                        + ' disp=' + cs.display + ' vis=' + cs.visibility
                        + ' op=' + cs.opacity + ' z=' + cs.zIndex
                        + ' pos=' + cs.position
                        + ' vw=' + window.innerWidth + 'x' + window.innerHeight);
                } catch (e) { selLog('rect err ' + e.message); }
            }, 60);
        }
    }

    function repositionSelPopup() {
        if (!$selPopup) return;
        const $p = $selPopup;

        // Mobile / touch: dock to the bottom of the viewport so we never sit
        // under (and fight with) the native selection menu. No anchoring math
        // needed — CSS handles the layout via the .stq-sel-docked class.
        if (IS_TOUCH) {
            $p.removeClass('stq-below');
            $p.css({ left: '', top: '' });
            return;
        }

        if (!lastSelRect) return;
        const rect = lastSelRect;

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
            // Native tooltip (desktop hover) shows the comment if present,
            // otherwise the color's label. Tap/click opens a richer popover.
            mark.title = quote.comment ? quote.comment : colorLabel(quote.color);
            mark.setAttribute('role', 'button');
            if (quote.comment) mark.classList.add('stq-has-note');
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

    // ---------------------------------------------------------------------
    // Mark popover — tap/click a highlight in chat to read its note (works on
    // mobile too) and remove the quote if you marked the wrong thing.
    // ---------------------------------------------------------------------
    let $markPop = null;
    function hideMarkPop() { if ($markPop) $markPop.addClass('stq-hidden'); }

    function buildMarkPop() {
        if ($markPop) return $markPop;
        $markPop = $(`
            <div id="stq-mark-pop" class="stq-mark-pop stq-hidden">
                <div class="stq-mark-arrow"></div>
                <div class="stq-mark-note"></div>
                <div class="stq-mark-actions">
                    <button class="stq-text-btn stq-mark-edit"><i class="fa-solid fa-pen"></i> ${escapeHtml(t('sel.addNote'))}</button>
                    <button class="stq-text-btn stq-danger stq-mark-remove"><i class="fa-solid fa-trash"></i> ${escapeHtml(t('action.delete'))}</button>
                </div>
            </div>`);
        $('body').append($markPop);
        $markPop.on('mousedown touchstart', (e) => e.stopPropagation());
        $markPop.on('click', '.stq-mark-remove', async function (e) {
            e.preventDefault(); e.stopPropagation();
            const qid = $markPop.data('qid');
            hideMarkPop();
            if (await confirmDialog(t('confirm.delQuote'))) {
                deleteQuote(qid);
                toast(t('toast.removed'), 'success');
                if (drawerOpen) renderPanel();
            }
        });
        $markPop.on('click', '.stq-mark-edit', async function (e) {
            e.preventDefault(); e.stopPropagation();
            const qid = $markPop.data('qid');
            const q = findQuote(qid);
            hideMarkPop();
            if (!q) return;
            const note = await promptDialog(t('placeholder.comment'), q.comment || '');
            if (note === null) return;
            q.comment = note.trim();
            save();
            refreshHighlight(qid);
            if (drawerOpen) renderPanel();
        });
        return $markPop;
    }

    function showMarkPop(markEl) {
        const qid = markEl.dataset.qid;
        const q = findQuote(qid);
        if (!q) return;
        const $p = buildMarkPop();
        $p.data('qid', qid);
        const noteText = q.comment && q.comment.trim()
            ? q.comment
            : colorLabel(q.color);
        $p.find('.stq-mark-note')
            .toggleClass('stq-mark-note-empty', !(q.comment && q.comment.trim()))
            .text(noteText);
        $p.css('--stq-c', colorHex(q.color));
        $p.removeClass('stq-hidden');

        const rect = markEl.getBoundingClientRect();
        const pw = $p.outerWidth() || 240;
        const ph = $p.outerHeight() || 80;
        let left = rect.left + rect.width / 2 - pw / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
        let top = rect.top - ph - 10;
        let below = false;
        if (top < 8) { top = rect.bottom + 10; below = true; }
        $p.toggleClass('stq-below', below);
        $p.css({ left: left + 'px', top: top + 'px' });
        const arrowX = Math.max(14, Math.min(rect.left + rect.width / 2 - left, pw - 14));
        $p.find('.stq-mark-arrow').css('left', arrowX + 'px');
    }

    // Delegated: tap/click a highlight mark in the chat.
    function onMarkClick(e) {
        const mark = e.target instanceof Element ? e.target.closest('.stq-mark') : null;
        if (!mark || !mark.closest('#chat')) return;
        e.preventDefault();
        e.stopPropagation();
        // toggle if same mark
        if ($markPop && !$markPop.hasClass('stq-hidden') && $markPop.data('qid') === mark.dataset.qid) {
            hideMarkPop();
        } else {
            showMarkPop(mark);
        }
    }

    async function promptDialog(title, value) {
        try {
            const c = ctx();
            if (c.Popup?.show?.input) {
                const r = await c.Popup.show.input(t('app.title'), title, value || '');
                return (r === null || r === undefined) ? null : String(r);
            }
        } catch (_) { /* noop */ }
        const r = window.prompt(title, value || '');
        return r;
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
            <div class="stq_set_label_row" style="--stq-c:${c.hex}">
                <span class="stq_color_chip"><span class="stq_color_dot"></span></span>
                <input type="text" class="text_pole stq-label-input" data-color="${c.id}"
                    placeholder="${escapeHtml(t('color.' + c.id))}" value="${escapeHtml(s.colorLabels[c.id] || '')}">
            </div>`).join('');
        const html = `
        <div id="stq-settings" class="stq-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-bookmark"></i> ${t('app.title')}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="stq_settings_card">
                        <div class="stq_settings_intro">${escapeHtml(t('set.intro'))}</div>

                        <div class="stq_settings_primary stq-open-panel" role="button" tabindex="0">
                            <i class="fa-solid fa-bookmark"></i> <span>${escapeHtml(t('set.openPanel'))}</span>
                        </div>

                        <div class="stq_set_row stq_set_toggle">
                            <div class="stq_set_text">
                                <div class="stq_set_label">${escapeHtml(t('set.enabled'))}</div>
                                <div class="stq_set_desc">${escapeHtml(t('set.enabledDesc'))}</div>
                            </div>
                            <input type="checkbox" id="stq-set-enabled" ${s.enabled ? 'checked' : ''}>
                        </div>

                        <div class="stq_set_row stq_set_toggle">
                            <div class="stq_set_text">
                                <div class="stq_set_label">${escapeHtml(t('set.highlight'))}</div>
                                <div class="stq_set_desc">${escapeHtml(t('set.highlightDesc'))}</div>
                            </div>
                            <input type="checkbox" id="stq-set-highlight" ${s.highlightInChat ? 'checked' : ''}>
                        </div>

                        <div class="stq_settings_section">
                            <div class="stq_settings_heading">${escapeHtml(t('set.labels'))}</div>
                            ${labelRows}
                            <div class="stq_settings_foot">${escapeHtml(t('set.labelsHint'))}</div>
                        </div>
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
        // Click anywhere on a toggle row flips its checkbox.
        $set.on('click', '.stq_set_toggle', function (e) {
            if (e.target.tagName === 'INPUT') return;
            const cb = this.querySelector('input[type="checkbox"]');
            if (cb) { cb.checked = !cb.checked; $(cb).trigger('change'); }
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

    // Selection events (mouse + touch + keyboard).
    // We drive everything off `selectionchange` (fires on every device,
    // including while dragging the native selection handles on mobile) plus
    // mouseup/touchend as a fast path on desktop. A debounce lets the
    // selection settle before we read it.
    const triggerSelPopup = (e) => {
        if (noteFieldActive()) return; // don't disturb the note being typed
        if (SEL_DEBUG) { try { console.log(LOG_PREFIX, '[sel] event', e && e.type); } catch (_) { /* noop */ } }
        clearTimeout(triggerSelPopup._t);
        triggerSelPopup._t = setTimeout(showSelPopupForSelection, 200);
    };
    const onSelectionChange = triggerSelPopup; // kept name for dispose()
    document.addEventListener('mouseup', triggerSelPopup);
    document.addEventListener('touchend', triggerSelPopup);
    const onSelectionChangeEvt = triggerSelPopup;
    document.addEventListener('selectionchange', triggerSelPopup);
    const onDocPointerDown = (e) => {
        // Close the mark popover when clicking outside it (but not when clicking
        // another mark — onMarkClick handles that).
        if ($markPop && !$markPop.hasClass('stq-hidden')
            && !$markPop[0].contains(e.target)
            && !(e.target instanceof Element && e.target.closest('.stq-mark'))) {
            hideMarkPop();
        }
        // A click outside the selection popup closes it (incl. while a note is open).
        // On touch the docked bar is dismissed only via its close button, by
        // picking a color, or when a fresh selection replaces it — a stray tap
        // while text is selected must not nuke it (the native menu causes those).
        if ($selPopup && !$selPopup.hasClass('stq-hidden') && !$selPopup[0].contains(e.target)) {
            if (IS_TOUCH) return;
            if (noteFieldActive()) { hideSelPopup(); return; }
            // let the selection settle; if collapsed it'll hide via selectionchange
            setTimeout(() => {
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed) hideSelPopup();
            }, 0);
        }
    };
    document.addEventListener('mousedown', onDocPointerDown);
    // Tap/click a highlight mark to open its note popover.
    document.addEventListener('click', onMarkClick, true);
    const onScrollHide = () => {
        // The docked mobile bar is pinned to the viewport, so scrolling (which
        // is constant on touch) must not dismiss it; it stays until the user acts.
        if (!IS_TOUCH && !noteFieldActive()) hideSelPopup();
        hideMarkPop();
    };
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
    if (SEL_DEBUG) {
        try {
            const toastr = ctx().toastr || window.toastr;
            if (toastr && toastr.success) toastr.success('loaded; IS_TOUCH=' + IS_TOUCH, 'Quotes/debug', { timeOut: 4000 });
        } catch (_) { /* noop */ }
    }

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
            document.removeEventListener('click', onMarkClick, true);
            document.removeEventListener('click', onTopBarClick, true);
            window.removeEventListener('scroll', onScrollHide, true);
            clearInterval(wandTimer);
            clearAllHighlights();
            hideMarkPop();
            $('#stq-modal, #stq-sel-popup, #stq-mark-pop, #stq_wand_button, #stq-settings').remove();
            document.body.classList.remove('stq-modal-open');
        } catch (e) { console.error(`${LOG_PREFIX} dispose error`, e); }
        window.__stQuotesInitialized = false;
    };
});

