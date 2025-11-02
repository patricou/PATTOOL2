# 🔒 Rapport de Sécurité - Front-End Angular (PatTool)

**Date:** $(date)  
**Version analysée:** Front-End Angular 17  
**Type:** Application Web SPA (Single Page Application)

---

## 📊 **RÉSUMÉ EXÉCUTIF**

**Score de Sécurité Global: 6.5/10** ⚠️

### Vue d'ensemble:
- ✅ **Points forts:** Authentification Keycloak bien implémentée, interceptor HTTP sécurisé, environnement séparé dev/prod
- ⚠️ **Points faibles:** Risques XSS, manque de validation côté client, exposition d'informations sensibles dans les logs, CDN sans intégrité

---

## ✅ **POINTS FORTS DE SÉCURITÉ**

### 1. **Authentification & Autorisation** ✅ (9/10)

#### Bonnes pratiques identifiées:
- ✅ **Keycloak intégré correctement** avec OAuth2/OIDC
- ✅ **HTTP Interceptor** (`KeycloakHttpInterceptor`) ajoute automatiquement les tokens Bearer
- ✅ **Login requis** au démarrage (`onLoad: 'login-required'`)
- ✅ **Gestion des tokens** avec refresh automatique (`updateToken(5)`)
- ✅ **Séparation des requêtes** - l'interceptor évite d'ajouter des tokens aux assets statiques
- ✅ **Gestion d'erreur** appropriée en cas d'échec de token

#### Points à améliorer:
- ⚠️ Pas de vérification explicite de l'expiration du token avant les requêtes critiques
- ⚠️ Les tokens sont stockés en mémoire (bon) mais pas de nettoyage explicite à la déconnexion

**Fichiers concernés:**
- `src/app/keycloak/keycloak.service.ts`
- `src/app/keycloak/keycloak.http.ts`

---

### 2. **Configuration des Environnements** ✅ (8/10)

- ✅ **Séparation dev/prod** avec fichiers `environment.ts` et `environment.prod.ts`
- ✅ **URLs relatives en production** (bonne pratique)
- ✅ **Source maps désactivés en production** (`sourceMap: false`)
- ✅ **Optimisation activée en production** (`optimization: true`)

**Fichiers concernés:**
- `src/environments/environment.ts`
- `src/environments/environment.prod.ts`
- `angular.json`

---

### 3. **Architecture Angular** ✅ (8/10)

- ✅ **TypeScript strict mode** activé (`strict: true`)
- ✅ **Strict templates** activés pour la sécurité des templates
- ✅ **HashLocationStrategy** utilisé (évite les problèmes de routing en production)
- ✅ **Modules bien organisés** (lazy loading possible)

**Fichiers concernés:**
- `tsconfig.json`
- `src/app/app.module.ts`

---

## 🔴 **PROBLÈMES CRITIQUES**

### 1. **Risque XSS (Cross-Site Scripting)** 🔴 **CRITIQUE**

#### Problème 1.1: Utilisation de `innerHTML` sans sanitization

**Localisation:** `src/app/evenements/home-evenements/home-evenements.component.html:149`

```html
<div class="compact-date" [innerHTML]="formatEventDate(evenement.beginEventDate)"></div>
```

**Risque:** Si `formatEventDate()` retourne du HTML non sécurisé, cela peut permettre l'injection de scripts malveillants.

**Recommandation:**
```typescript
// Utiliser DomSanitizer pour sanitizer le HTML
import { DomSanitizer } from '@angular/platform-browser';

constructor(private sanitizer: DomSanitizer) {}

formatEventDate(date: Date): SafeHtml {
  // Sanitizer le HTML avant de le retourner
  return this.sanitizer.sanitize(SecurityContext.HTML, htmlString);
}
```

**OU** Utiliser l'interpolation Angular standard (recommandé):
```html
<div class="compact-date">{{ formatEventDate(evenement.beginEventDate) }}</div>
```

---

#### Problème 1.2: Décodage HTML non sécurisé

**Localisation:** `src/app/model/chat-response.ts:40-44`

```typescript
private decodeHtml(html: string): string {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;  // ⚠️ RISQUE XSS
    return txt.value;
}
```

**Risque:** Utilisation directe de `innerHTML` peut permettre l'exécution de scripts si le contenu HTML contient des balises `<script>`.

**Recommandation:**
```typescript
import { DomSanitizer } from '@angular/platform-browser';

constructor(private sanitizer: DomSanitizer) {}

private decodeHtml(html: string): string {
    // Utiliser DomSanitizer pour décoder de manière sécurisée
    const decoded = this.sanitizer.sanitize(SecurityContext.HTML, html);
    // OU utiliser une bibliothèque dédiée comme DOMPurify
    return decoded;
}
```

**OU** Utiliser une bibliothèque dédiée:
```bash
npm install dompurify
npm install --save-dev @types/dompurify
```

```typescript
import * as DOMPurify from 'dompurify';

private decodeHtml(html: string): string {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS: [] });
}
```

---

### 2. **Exposition d'Informations Sensibles dans les Logs** 🔴 **HAUTE PRIORITÉ**

#### Problème 2.1: `console.log` avec données sensibles

**Localisations multiples:**
- `src/app/app.component.ts:203, 217, 209-210`
- `src/app/evenements/home-evenements/home-evenements.component.ts:496-498`
- Et autres fichiers...

**Exemples:**
```typescript
console.log("File to upload:", file.name, "Size:", file.size, "Type:", file.type);
console.log('|--> Upload successful : ', response);
console.log(evenement.evenementName + " --> Author : " + JSON.stringify(evenement.author.id));
```

**Risque:** 
- Les `console.log` restent dans le code de production
- Peuvent exposer des informations sur la structure de l'application
- Peuvent révéler des données utilisateur dans la console du navigateur

**Recommandation:**
```typescript
// Créer un service de logging
@Injectable()
export class LoggingService {
  log(message: string, data?: any): void {
    if (!environment.production) {
      console.log(message, data);
    }
  }
  
  error(message: string, error?: any): void {
    if (!environment.production) {
      console.error(message, error);
    } else {
      // En production, envoyer à un service de logging externe (Sentry, etc.)
    }
  }
}
```

**OU** Utiliser des outils comme:
- **Sentry** pour le logging en production
- **Angular DevKit** pour gérer les logs selon l'environnement

---

#### Problème 2.2: Utilisation de `alert()` pour les erreurs

**Localisations:**
- `src/app/evenements/home-evenements/home-evenements.component.ts:155, 195, 202`
- `src/app/services/members.service.ts:50`

**Exemples:**
```typescript
alert("Error when getting Events " + JSON.stringify(this.user));
alert("Issue when deleting the event : " + err);
alert("Issue to get the Id of the user : " + error);
```

**Risque:**
- Expose des informations d'erreur détaillées à l'utilisateur
- Peut révéler la structure de l'API ou des endpoints
- Mauvaise expérience utilisateur

**Recommandation:**
```typescript
// Créer un service de notification utilisateur
@Injectable()
export class NotificationService {
  showError(message: string, details?: any): void {
    // Afficher un message générique à l'utilisateur
    // Logger les détails côté serveur/client (selon l'environnement)
  }
}
```

---

### 3. **Manque de Validation Côté Client** 🔴 **HAUTE PRIORITÉ**

#### Problème 3.1: Pas de validation de taille de fichier avant upload

**Localisation:** `src/app/app.component.ts:190-255`

```typescript
onSubmit() {
    if (this.selectedFiles.length === 0) {
        console.log('Aucun fichier sélectionné.');
        return;
    };
    
    const formData = new FormData();
    for (let file of this.selectedFiles) {
        // ⚠️ Pas de vérification de taille
        formData.append('files', file, file.name);
    }
    // ...
}
```

**Risque:**
- Upload de fichiers très volumineux peut saturer le serveur
- Pas de feedback à l'utilisateur avant l'upload
- Consommation inutile de bande passante

**Recommandation:**
```typescript
private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
private readonly ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

onSubmit() {
    if (this.selectedFiles.length === 0) {
        return;
    }
    
    // Valider chaque fichier
    for (let file of this.selectedFiles) {
        if (file.size > this.MAX_FILE_SIZE) {
            alert(`Le fichier ${file.name} est trop volumineux (max ${this.MAX_FILE_SIZE / 1024 / 1024} MB)`);
            return;
        }
        
        if (!this.ALLOWED_FILE_TYPES.includes(file.type)) {
            alert(`Type de fichier non autorisé: ${file.type}`);
            return;
        }
    }
    
    // Continuer avec l'upload...
}
```

---

#### Problème 3.2: Validation HTML5 basique uniquement

**Localisation:** `src/app/evenements/update-evenement/update-evenement.component.html:596`

```html
<input type="file" 
       accept="image/*,.pdf,.doc,.docx,.txt,.zip,.rar"
       (change)="onFileSelected($event)">
```

**Risque:**
- La validation `accept` peut être contournée
- Pas de validation JavaScript supplémentaire
- Pas de vérification de la taille

**Recommandation:**
```typescript
onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    
    const files = Array.from(input.files);
    
    // Valider chaque fichier
    const validFiles = files.filter(file => {
        // Vérifier la taille
        if (file.size > this.MAX_FILE_SIZE) {
            this.showError(`Fichier ${file.name} trop volumineux`);
            return false;
        }
        
        // Vérifier le type MIME (plus sûr que l'extension)
        if (!this.isValidFileType(file)) {
            this.showError(`Type de fichier non autorisé: ${file.name}`);
            return false;
        }
        
        return true;
    });
    
    this.selectedFiles = [...this.selectedFiles, ...validFiles];
}

private isValidFileType(file: File): boolean {
    const validMimeTypes = [
        'image/jpeg', 'image/png', 'image/gif',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'application/zip',
        'application/x-rar-compressed'
    ];
    
    return validMimeTypes.includes(file.type);
}
```

---

### 4. **Ressources Externes sans Intégrité (SRI)** 🔴 **HAUTE PRIORITÉ**

**Localisation:** `src/index.html:16-20, 27-28`

```html
<link href="https://fonts.googleapis.com/css?family=Open+Sans" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
<link rel="stylesheet" type="text/css"
    href="https://maxcdn.bootstrapcdn.com/font-awesome/4.7.0/css/font-awesome.min.css" />
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/exif-js@2.3.0/exif.js"></script>
```

**Risque:**
- Si un CDN est compromis, du code malveillant peut être injecté
- Pas de vérification d'intégrité des ressources chargées
- Vulnérable aux attaques de chaîne d'approvisionnement

**Recommandation:**

1. **Ajouter Subresource Integrity (SRI):**
```html
<link href="https://fonts.googleapis.com/css?family=Open+Sans" 
      rel="stylesheet" 
      integrity="sha384-..." 
      crossorigin="anonymous">

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"
        integrity="sha384-..."
        crossorigin="anonymous"></script>
```

2. **OU mieux: Bundle les dépendances localement:**
```bash
npm install bootstrap font-awesome
```

Puis dans `angular.json`:
```json
"styles": [
  "node_modules/bootstrap/dist/css/bootstrap.min.css",
  "node_modules/font-awesome/css/font-awesome.min.css"
]
```

---

### 5. **Manque de Content Security Policy (CSP)** 🔴 **HAUTE PRIORITÉ**

**Localisation:** `src/index.html`

**Problème:** Aucune méta-tag CSP définie.

**Risque:**
- Pas de protection contre l'injection de scripts
- Pas de contrôle sur les sources de ressources externes
- Vulnérable aux attaques XSS

**Recommandation:**
```html
<head>
    <meta http-equiv="Content-Security-Policy" 
          content="default-src 'self'; 
                   script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; 
                   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maxcdn.bootstrapcdn.com https://cdn.jsdelivr.net; 
                   font-src 'self' https://fonts.gstatic.com https://maxcdn.bootstrapcdn.com https://cdn.jsdelivr.net; 
                   img-src 'self' data: https:; 
                   connect-src 'self' https://www.patrickdeschamps.com:8543 http://localhost:8080 http://localhost:8000;">
</head>
```

**Note:** Ajuster selon vos besoins réels. Commencer en mode "report-only" pour tester:
```html
<meta http-equiv="Content-Security-Policy-Report-Only" content="...">
```

---

## 🟡 **PROBLÈMES MOYENS**

### 6. **Clés API Firebase Exposées** 🟡 **MOYENNE PRIORITÉ**

**Localisation:** `src/environments/environment.ts:23-31` et `environment.prod.ts:20-27`

```typescript
firebase: {
    apiKey: "AIzaSyBJFAKMyDO_lmqBYUwW6CWjBIMTHyFGZKc",
    authDomain: "sportpat-5e155.firebaseapp.com",
    // ...
}
```

**Contexte:** Les clés API Firebase sont **publiques par design** - elles sont exposées dans le code client. C'est normal pour Firebase.

**Risque:** Relativement faible, MAIS:
- ⚠️ Assurez-vous que les **règles de sécurité Firebase** sont correctement configurées
- ⚠️ Limitez les accès selon les rôles utilisateurs
- ⚠️ Surveillez l'utilisation de l'API Firebase pour détecter les abus

**Recommandation:**
- ✅ Vérifier que les règles Firebase Realtime Database sont restrictives
- ✅ Activer l'authentification requise pour les opérations sensibles
- ✅ Surveiller les quotas et l'utilisation dans la console Firebase
- ✅ Utiliser Firebase App Check pour limiter les appels aux applications autorisées

---

### 7. **Utilisation de `bypassSecurityTrustUrl`** 🟡 **MOYENNE PRIORITÉ**

**Localisations:**
- `src/app/evenements/home-evenements/home-evenements.component.ts:531, 536, 549, 559`
- `src/app/evenements/element-evenement/element-evenement.component.ts:1022`
- `src/app/evenements/details-evenement/details-evenement.component.ts:177, 202, 222`

**Contexte:** Utilisé pour créer des URLs blob à partir de fichiers téléchargés.

**Risque:** Modéré - les URLs sont créées localement, mais:
- ⚠️ Assurez-vous que les URLs blob proviennent toujours de sources fiables
- ⚠️ Validez que les fichiers téléchargés sont bien ceux attendus

**Recommandation:**
```typescript
// Valider que l'URL blob provient bien d'un fichier téléchargé
private createSafeBlobUrl(blob: Blob, expectedType?: string): SafeUrl {
    // Vérifier le type MIME si spécifié
    if (expectedType && !blob.type.startsWith(expectedType)) {
        throw new Error('Type de fichier invalide');
    }
    
    const objectUrl = URL.createObjectURL(blob);
    return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
}

// N'oubliez pas de révoquer les URLs blob quand elles ne sont plus utilisées
ngOnDestroy() {
    this.eventThumbnails.forEach(url => {
        if (url instanceof SafeUrl) {
            URL.revokeObjectURL(url.toString());
        }
    });
}
```

---

### 8. **Manque de Gestion d'Erreur HTTP Globale** 🟡 **MOYENNE PRIORITÉ**

**Problème:** Pas d'interceptor d'erreur global pour gérer les erreurs HTTP de manière cohérente.

**Recommandation:**
```typescript
@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
    constructor(
        private notificationService: NotificationService,
        private keycloakService: KeycloakService
    ) {}
    
    intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        return next.handle(req).pipe(
            catchError((error: HttpErrorResponse) => {
                // Gérer les erreurs de manière centralisée
                if (error.status === 401) {
                    // Token expiré ou invalide
                    this.keycloakService.logout();
                } else if (error.status === 403) {
                    this.notificationService.showError('Accès refusé');
                } else if (error.status >= 500) {
                    this.notificationService.showError('Erreur serveur. Veuillez réessayer plus tard.');
                }
                
                return throwError(() => error);
            })
        );
    }
}
```

---

### 9. **Headers HTTP Personnalisés** 🟡 **MOYENNE PRIORITÉ**

**Localisation:** `src/app/services/members.service.ts:35-36`

```typescript
'Author': 'Zeus himself',
'User': JSON.stringify(this.user)
```

**Risque:**
- Envoi d'informations utilisateur dans les headers (peut être loggé côté serveur)
- Headers personnalisés non nécessaires

**Recommandation:**
- ✅ Retirer les headers non essentiels
- ✅ Ne pas envoyer d'informations utilisateur dans les headers si ce n'est pas nécessaire
- ✅ Utiliser uniquement les headers standard (`Authorization`, `Content-Type`, etc.)

---

## 🟢 **RECOMMANDATIONS GÉNÉRALES**

### 10. **Amélioration Continue**

#### 10.1. **Tests de Sécurité**
- ⚠️ Ajouter des tests unitaires pour la validation des entrées
- ⚠️ Ajouter des tests d'intégration pour les flux d'authentification
- ⚠️ Utiliser des outils comme **OWASP ZAP** ou **Burp Suite** pour les tests de pénétration

#### 10.2. **Monitoring & Logging**
- ⚠️ Intégrer un service de monitoring (Sentry, LogRocket, etc.)
- ⚠️ Logger les erreurs côté serveur plutôt que dans la console
- ⚠️ Surveiller les tentatives d'authentification échouées

#### 10.3. **Dépendances**
- ✅ Vérifier régulièrement les vulnérabilités avec `npm audit`
- ✅ Mettre à jour les dépendances régulièrement
- ✅ Utiliser `npm audit fix` pour corriger les vulnérabilités connues

#### 10.4. **Configuration Production**
- ✅ S'assurer que les source maps ne sont pas déployés en production
- ✅ Minifier et obfusquer le code JavaScript
- ✅ Activer la compression gzip/brotli sur le serveur
- ✅ Utiliser HTTPS uniquement en production

---

## 📋 **CHECKLIST DE SÉCURITÉ**

### Authentification & Autorisation
- [x] Keycloak intégré correctement
- [x] Tokens ajoutés automatiquement aux requêtes
- [x] Refresh automatique des tokens
- [ ] Vérification de l'expiration avant requêtes critiques
- [ ] Gestion d'erreur 401/403 centralisée

### Protection XSS
- [ ] Tous les `innerHTML` sanitizés
- [ ] Décodage HTML sécurisé
- [ ] Content Security Policy configurée
- [ ] Validation des entrées utilisateur

### Protection CSRF
- [x] Stateless JWT (pas besoin de CSRF token)
- [ ] Vérifier la configuration CORS côté backend

### Gestion des Fichiers
- [ ] Validation de taille côté client
- [ ] Validation de type MIME côté client
- [ ] Nettoyage des URLs blob après utilisation

### Configuration
- [x] Environnements séparés dev/prod
- [x] Source maps désactivés en production
- [ ] Content Security Policy
- [ ] Subresource Integrity pour CDN

### Logging & Monitoring
- [ ] Pas de `console.log` en production
- [ ] Service de logging centralisé
- [ ] Monitoring d'erreurs (Sentry, etc.)
- [ ] Alertes sur activités suspectes

### Dépendances
- [ ] `npm audit` exécuté régulièrement
- [ ] Dépendances à jour
- [ ] Pas de vulnérabilités connues

---

## 🎯 **PLAN D'ACTION PRIORITAIRE**

### **Priorité 1 - CRITIQUE (À faire immédiatement)**
1. ✅ **Corriger les risques XSS**
   - Remplacer `innerHTML` par interpolation ou sanitizer
   - Sécuriser `decodeHtml()` dans `chat-response.ts`

2. ✅ **Ajouter Content Security Policy**
   - Ajouter méta-tag CSP dans `index.html`
   - Tester en mode report-only d'abord

3. ✅ **Ajouter Subresource Integrity**
   - Ajouter `integrity` et `crossorigin` aux ressources CDN
   - OU bundle les dépendances localement

### **Priorité 2 - HAUTE (À faire rapidement)**
4. ✅ **Nettoyer les logs de production**
   - Créer un service de logging
   - Retirer tous les `console.log` de production
   - Remplacer `alert()` par un service de notification

5. ✅ **Valider les uploads de fichiers**
   - Ajouter validation de taille
   - Ajouter validation de type MIME
   - Feedback utilisateur avant upload

6. ✅ **Intercepteur d'erreur global**
   - Créer `ErrorInterceptor`
   - Gérer 401/403/500 de manière centralisée

### **Priorité 3 - MOYENNE (Améliorations)**
7. ⚠️ **Review Firebase Security Rules**
   - Vérifier les règles de sécurité Firebase
   - Limiter les accès selon les rôles

8. ⚠️ **Nettoyer les headers HTTP**
   - Retirer les headers personnalisés non nécessaires
   - Ne pas envoyer d'infos utilisateur dans les headers

9. ⚠️ **Monitoring & Tests**
   - Intégrer Sentry ou équivalent
   - Ajouter des tests de sécurité
   - Mettre en place des alertes

---

## 📊 **SCORE DÉTAILLÉ PAR CATÉGORIE**

| Catégorie | Score | Commentaire |
|-----------|-------|-------------|
| **Authentification** | 9/10 | Keycloak bien implémenté, quelques améliorations possibles |
| **Protection XSS** | 4/10 | 🔴 Risques identifiés, corrections nécessaires |
| **Validation Entrées** | 5/10 | 🟡 Manque de validation côté client |
| **Gestion Erreurs** | 6/10 | 🟡 Logs exposés, pas d'intercepteur global |
| **Configuration** | 7/10 | ✅ Bonne séparation dev/prod, manque CSP |
| **Dépendances** | 7/10 | ✅ Angular 17 récent, vérifier vulnérabilités |
| **Ressources Externes** | 4/10 | 🔴 Pas de SRI, risques de chaîne d'approvisionnement |

**Score Global: 6.5/10** ⚠️

---

## 🔗 **RESSOURCES UTILES**

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Angular Security Guide](https://angular.io/guide/security)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
- [Keycloak Documentation](https://www.keycloak.org/documentation)

---

## 📝 **NOTES FINALES**

Ce rapport identifie les problèmes de sécurité dans le front-end Angular. Les problèmes critiques doivent être corrigés avant le déploiement en production. Les problèmes moyens peuvent être traités progressivement.

**Important:** Ce rapport couvre uniquement le front-end. Assurez-vous que le backend (Spring Boot) est également sécurisé (voir `SECURITY_REVIEW.md` pour le backend).

---

**Généré automatiquement - À réviser régulièrement**




