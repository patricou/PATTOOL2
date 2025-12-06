/**
 * Angular i18n support - Required for @ngx-translate and other i18n features
 */
import '@angular/localize/init';

/**
 * Polyfill for Node.js 'global' variable used by SockJS and other libraries
 * In browsers, 'global' should reference 'window'
 */
(window as any).global = window;