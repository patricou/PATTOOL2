/**
 * PatTool documentation — FR or EN from ?lang=, plus a Français / English toggle.
 */
(function () {
    'use strict';

    var SUPPORTED = ['fr', 'en'];
    var current = 'fr';

    function resolveLang() {
        try {
            var params = new URLSearchParams(window.location.search);
            var lang = (params.get('lang') || '').toLowerCase();
            if (SUPPORTED.indexOf(lang) >= 0) {
                return lang;
            }
        } catch (e) { /* ignore */ }
        var nav = (navigator.language || 'en').toLowerCase();
        return nav.indexOf('fr') === 0 ? 'fr' : 'en';
    }

    function swapLangSuffix(value, lang) {
        return value.replace(/-(fr|en)(?=$|&)/i, '-' + lang);
    }

    function applyLang(lang) {
        if (SUPPORTED.indexOf(lang) < 0) {
            lang = 'fr';
        }
        current = lang;
        document.documentElement.lang = lang;
        document.querySelectorAll('[data-doc-lang]').forEach(function (el) {
            el.hidden = el.getAttribute('data-doc-lang') !== lang;
        });
        document.querySelectorAll('a[href*="/assets/docs/"]').forEach(function (a) {
            try {
                var raw = a.getAttribute('href') || '';
                var hash = '';
                var hashAt = raw.indexOf('#');
                if (hashAt >= 0) {
                    hash = swapLangSuffix(raw.slice(hashAt), lang);
                    raw = raw.slice(0, hashAt);
                }
                var url = new URL(raw, window.location.origin);
                url.searchParams.set('lang', lang);
                a.setAttribute('href', url.pathname + url.search + hash);
            } catch (e) { /* ignore */ }
        });
        document.querySelectorAll('a[href^="#"]').forEach(function (a) {
            var href = a.getAttribute('href') || '';
            if (/-(fr|en)$/i.test(href)) {
                a.setAttribute('href', swapLangSuffix(href, lang));
            }
        });
        document.querySelectorAll('.doc-lang-switch button').forEach(function (btn) {
            var on = btn.getAttribute('data-set-lang') === lang;
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function scrollToHash() {
        var hash = window.location.hash;
        if (!hash || hash.length < 2) {
            return;
        }
        var el = document.getElementById(decodeURIComponent(hash.slice(1)));
        if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'start' });
        }
    }

    function setLang(lang) {
        applyLang(lang);
        try {
            var url = new URL(window.location.href);
            url.searchParams.set('lang', lang);
            var hash = url.hash ? swapLangSuffix(url.hash, lang) : '';
            history.replaceState(null, '', url.pathname + url.search + hash);
        } catch (e) { /* ignore */ }
        scrollToHash();
    }

    function mountSwitch() {
        if (document.querySelector('.doc-lang-switch')) {
            return;
        }
        var host = document.querySelector('.doc-toolbar-inner') || document.body;
        var group = document.createElement('div');
        group.className = 'doc-lang-switch';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Language');
        [
            { lang: 'fr', label: 'Français' },
            { lang: 'en', label: 'English' }
        ].forEach(function (item) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-set-lang', item.lang);
            btn.textContent = item.label;
            btn.addEventListener('click', function () {
                setLang(item.lang);
            });
            group.appendChild(btn);
        });
        host.appendChild(group);
    }

    function init() {
        mountSwitch();
        applyLang(resolveLang());
        scrollToHash();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
