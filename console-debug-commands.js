// Commandes à copier-coller dans la console du navigateur pour déboguer les erreurs

// 1. Capturer toutes les erreurs et les afficher dans la console
window.addEventListener('error', function(e) {
    console.error('=== ERREUR CAPTURÉE ===');
    console.error('Message:', e.message);
    console.error('Fichier:', e.filename);
    console.error('Ligne:', e.lineno);
    console.error('Colonne:', e.colno);
    console.error('Erreur complète:', e.error);
    console.error('Stack:', e.error?.stack);
    console.error('========================');
    return false; // Empêche le comportement par défaut
}, true);

// 2. Capturer les erreurs de promesses non gérées
window.addEventListener('unhandledrejection', function(e) {
    console.error('=== PROMESSE REJETÉE NON GÉRÉE ===');
    console.error('Raison:', e.reason);
    console.error('Promesse:', e.promise);
    console.error('Erreur complète:', e);
    console.error('==================================');
    e.preventDefault(); // Empêche le comportement par défaut
});

// 3. Intercepter toutes les requêtes HTTP pour voir les erreurs
(function() {
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        return originalFetch.apply(this, args)
            .then(response => {
                if (!response.ok) {
                    console.error('=== ERREUR HTTP FETCH ===');
                    console.error('URL:', args[0]);
                    console.error('Status:', response.status);
                    console.error('Status Text:', response.statusText);
                    console.error('Headers:', [...response.headers.entries()]);
                    // Cloner la réponse pour lire le body sans la consommer
                    response.clone().text().then(body => {
                        console.error('Body:', body);
                    });
                    console.error('==========================');
                }
                return response;
            })
            .catch(error => {
                console.error('=== ERREUR FETCH ===');
                console.error('URL:', args[0]);
                console.error('Erreur:', error);
                console.error('====================');
                throw error;
            });
    };
})();

// 4. Intercepter les requêtes XMLHttpRequest (pour Angular HttpClient)
(function() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this._url = url;
        this._method = method;
        return originalOpen.apply(this, [method, url, ...args]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('error', function() {
            console.error('=== ERREUR XHR ===');
            console.error('Method:', this._method);
            console.error('URL:', this._url);
            console.error('Status:', this.status);
            console.error('Status Text:', this.statusText);
            console.error('Response:', this.responseText);
            console.error('==================');
        });
        
        this.addEventListener('load', function() {
            if (this.status >= 400) {
                console.error('=== ERREUR HTTP XHR ===');
                console.error('Method:', this._method);
                console.error('URL:', this._url);
                console.error('Status:', this.status);
                console.error('Status Text:', this.statusText);
                console.error('Response:', this.responseText);
                try {
                    const json = JSON.parse(this.responseText);
                    console.error('Response JSON:', json);
                } catch (e) {
                    console.error('Response (non-JSON):', this.responseText);
                }
                console.error('========================');
            }
        });
        
        return originalSend.apply(this, args);
    };
})();

// 5. Empêcher les redirects automatiques
window.addEventListener('beforeunload', function(e) {
    console.warn('=== TENTATIVE DE REDIRECT/NAVIGATION ===');
    console.warn('URL de destination:', window.location.href);
    console.warn('Stack trace:', new Error().stack);
    console.warn('========================================');
    // Décommenter la ligne suivante pour empêcher le redirect (à utiliser avec précaution)
    // e.preventDefault();
    // return e.returnValue = 'Êtes-vous sûr de vouloir quitter cette page ?';
});

// 6. Logger toutes les navigations
let lastUrl = window.location.href;
setInterval(function() {
    if (window.location.href !== lastUrl) {
        console.warn('=== NAVIGATION DÉTECTÉE ===');
        console.warn('Ancienne URL:', lastUrl);
        console.warn('Nouvelle URL:', window.location.href);
        console.warn('Stack trace:', new Error().stack);
        console.warn('===========================');
        lastUrl = window.location.href;
    }
}, 100);

// 7. Capturer les erreurs Angular (si disponibles)
if (window.ng && window.ng.probe) {
    const zone = window.ng.probe(document.body).injector.get(window.ng.coreTokens.NgZone);
    zone.onError.subscribe((error) => {
        console.error('=== ERREUR ANGULAR ===');
        console.error('Erreur:', error);
        console.error('======================');
    });
}

console.log('✅ Scripts de débogage activés ! Toutes les erreurs seront maintenant capturées et affichées.');

