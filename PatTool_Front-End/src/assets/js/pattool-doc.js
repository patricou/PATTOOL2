/**
 * PatTool documentation — show FR or EN from ?lang= (set by the app menu).
 * No manual language switcher.
 */
(function () {
    'use strict';

    var SUPPORTED = ['fr', 'en'];

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

    function applyLang(lang) {
        if (SUPPORTED.indexOf(lang) < 0) {
            lang = 'fr';
        }
        document.documentElement.lang = lang;
        document.querySelectorAll('[data-doc-lang]').forEach(function (el) {
            el.hidden = el.getAttribute('data-doc-lang') !== lang;
        });
        document.querySelectorAll('.doc-nav-links a[href*="/assets/docs/"]').forEach(function (a) {
            try {
                var url = new URL(a.getAttribute('href'), window.location.origin);
                url.searchParams.set('lang', lang);
                a.setAttribute('href', url.pathname + url.search);
            } catch (e) { /* ignore */ }
        });
    }

    function init() {
        applyLang(resolveLang());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
