# Rapport d'Audit des Memory Leaks - Backend PatTool

**Date:** 2025-01-27  
**Version:** 1.0  
**Statut:** Analyse complète - Aucune modification effectuée

---

## Résumé Exécutif

Cette analyse a identifié **8 problèmes potentiels de memory leaks** dans le backend, classés par niveau de criticité. Certains problèmes ont déjà été partiellement corrigés (notamment dans `EvenementRestController`), mais d'autres nécessitent une attention.

### Problèmes Identifiés

- **Critiques (3):** Nécessitent une correction immédiate
- **Modérés (3):** Devraient être corrigés prochainement
- **Faibles (2):** À surveiller mais moins urgents

---

## 1. Problèmes Critiques

### 1.1 DiscussionConnectionService - Map de Connexions Non Bornée

**Fichier:** `com.pat.service.DiscussionConnectionService.java`  
**Ligne:** 37  
**Criticité:** 🔴 CRITIQUE

#### Problème

La map `activeConnections` (ConcurrentHashMap) stocke toutes les connexions WebSocket actives sans limite de taille. Si des connexions ne sont pas correctement nettoyées (par exemple, en cas de déconnexion brutale), cette map peut grandir indéfiniment.

```java
private final Map<String, ConnectionInfo> activeConnections = new ConcurrentHashMap<>();
```

#### Impact

- **Mémoire:** Chaque connexion stocke un objet `ConnectionInfo` avec sessionId, userName, ipAddress, domain, location, connectedAt, discussionId
- **Scénario:** Si 1000 connexions "fantômes" restent dans la map, cela représente environ 1-2 MB de mémoire
- **Risque:** En cas de déconnexions non détectées, la map peut grandir jusqu'à plusieurs milliers d'entrées

#### Recommandations

1. **Ajouter une limite de taille** avec nettoyage automatique des entrées les plus anciennes
2. **Implémenter un nettoyage périodique** des connexions expirées (par exemple, toutes les 5 minutes)
3. **Ajouter un mécanisme de heartbeat** pour détecter les connexions mortes

#### Code Suggéré

```java
// Limite maximale de connexions
private static final int MAX_CONNECTIONS = 1000;

// Nettoyage périodique des connexions expirées
@Scheduled(fixedRate = 300000) // Toutes les 5 minutes
public void cleanupExpiredConnections() {
    long now = System.currentTimeMillis();
    long maxAge = 30 * 60 * 1000; // 30 minutes
    
    activeConnections.entrySet().removeIf(entry -> {
        ConnectionInfo info = entry.getValue();
        long age = now - info.connectedAt.toEpochMilli();
        return age > maxAge;
    });
    
    // Si toujours trop de connexions, supprimer les plus anciennes
    if (activeConnections.size() > MAX_CONNECTIONS) {
        List<Map.Entry<String, ConnectionInfo>> sorted = new ArrayList<>(activeConnections.entrySet());
        sorted.sort(Comparator.comparing(e -> e.getValue().connectedAt));
        
        int toRemove = activeConnections.size() - MAX_CONNECTIONS;
        for (int i = 0; i < toRemove; i++) {
            activeConnections.remove(sorted.get(i).getKey());
        }
    }
}
```

---

### 1.2 FileRestController - Upload Logs Sans Nettoyage Automatique

**Fichier:** `com.pat.controller.FileRestController.java`  
**Lignes:** 82-147  
**Criticité:** 🔴 CRITIQUE

#### Problème

La map `uploadLogs` stocke les logs d'upload par sessionId. Bien qu'il y ait une limite de taille (MAX_UPLOAD_SESSIONS = 100), le nettoyage n'est effectué que lors de l'ajout de nouveaux logs. Si aucune nouvelle session n'est créée, les anciennes sessions peuvent rester indéfiniment.

```java
private final Map<String, List<String>> uploadLogs = new ConcurrentHashMap<>();
private static final int MAX_UPLOAD_SESSIONS = 100;
```

#### Impact

- **Mémoire:** Chaque session stocke une liste de messages de log
- **Scénario:** Si 100 sessions avec 50 messages chacune restent en mémoire, cela représente environ 500 KB - 1 MB
- **Risque:** Les sessions peuvent s'accumuler si le nettoyage manuel (après 5 secondes) échoue

#### Recommandations

1. **Ajouter un nettoyage périodique** des logs expirés (par exemple, toutes les minutes)
2. **Utiliser un mécanisme de TTL** pour chaque session
3. **Améliorer le nettoyage automatique** après 5 secondes pour s'assurer qu'il fonctionne toujours

#### Code Suggéré

```java
// Ajouter un Scheduled task pour nettoyage périodique
@Scheduled(fixedRate = 60000) // Toutes les minutes
public void cleanupExpiredUploadLogs() {
    long now = System.currentTimeMillis();
    long maxAge = 60000; // 1 minute
    
    // Supposer qu'on stocke aussi un timestamp avec chaque session
    // Si ce n'est pas le cas, nettoyer les plus anciennes
    if (uploadLogs.size() > MAX_UPLOAD_SESSIONS) {
        // Supprimer les sessions les plus anciennes
        int toRemove = uploadLogs.size() - MAX_UPLOAD_SESSIONS;
        Iterator<String> iterator = uploadLogs.keySet().iterator();
        for (int i = 0; i < toRemove && iterator.hasNext(); i++) {
            iterator.next();
            iterator.remove();
        }
    }
}
```

---

### 1.3 VideoCompressionService - Process FFmpeg Non Nettoyé en Cas d'Erreur

**Fichier:** `com.pat.service.VideoCompressionService.java`  
**Lignes:** 121-175  
**Criticité:** 🔴 CRITIQUE

#### Problème

Le processus FFmpeg est créé mais peut ne pas être correctement nettoyé en cas d'exception ou de timeout. Bien que `destroyForcibly()` soit appelé en cas de timeout, il n'y a pas de garantie que les ressources système soient libérées.

```java
Process process = processBuilder.start();
// ... traitement ...
if (!finished) {
    process.destroyForcibly();
    // Mais les ressources peuvent ne pas être immédiatement libérées
}
```

#### Impact

- **Ressources système:** Chaque processus FFmpeg consomme de la mémoire système et des descripteurs de fichiers
- **Scénario:** Si plusieurs compressions échouent simultanément, les processus peuvent s'accumuler
- **Risque:** En cas de charge élevée, cela peut épuiser les ressources système

#### Recommandations

1. **Utiliser try-with-resources** ou un mécanisme de nettoyage garanti
2. **Ajouter un timeout plus court** et un nettoyage forcé
3. **Limiter le nombre de compressions simultanées** avec un Semaphore (comme pour ImageCompressionService)

#### Code Suggéré

```java
// Ajouter un Semaphore pour limiter les compressions simultanées
private final Semaphore compressionSemaphore = new Semaphore(2); // Max 2 compressions simultanées

public CompressionResult compressVideo(...) {
    boolean permitAcquired = false;
    Process process = null;
    try {
        compressionSemaphore.acquire();
        permitAcquired = true;
        
        process = processBuilder.start();
        // ... traitement ...
        
    } finally {
        if (process != null) {
            if (process.isAlive()) {
                process.destroyForcibly();
                try {
                    process.waitFor(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        if (permitAcquired) {
            compressionSemaphore.release();
        }
    }
}
```

---

## 2. Problèmes Modérés

### 2.1 ImageCompressionService - Cache Peut Grandir Excessivement

**Fichier:** `com.pat.service.ImageCompressionService.java`  
**Lignes:** 48-50, 608-661  
**Criticité:** 🟡 MODÉRÉ

#### Problème

Le cache de compression d'images a des limites (maxEntries, maxSizeBytes) et un mécanisme de nettoyage, mais en cas de charge élevée, le cache peut temporairement dépasser ces limites avant le nettoyage. De plus, le nettoyage agressif n'est déclenché que lorsque la mémoire est critique (≥85%).

#### Impact

- **Mémoire:** Le cache peut stocker jusqu'à 200 MB (configurable) d'images compressées
- **Scénario:** Si le nettoyage ne se déclenche pas assez rapidement, le cache peut consommer plus de mémoire que prévu
- **Risque:** En cas de slideshow avec beaucoup d'images, le cache peut grandir rapidement

#### Recommandations

1. **Améliorer le nettoyage proactif** - déclencher le nettoyage avant d'atteindre les limites
2. **Ajouter un nettoyage périodique** en plus du nettoyage à l'ajout
3. **Réduire la taille du cache** si la mémoire est limitée

#### Code Suggéré

```java
// Ajouter un nettoyage périodique
@Scheduled(fixedRate = 300000) // Toutes les 5 minutes
public void cleanupCachePeriodically() {
    long now = System.currentTimeMillis();
    cleanupExpiredEntries(now);
    enforceCacheLimit();
}
```

---

### 2.2 ChatService - Historique de Chat Sans Limite de Taille

**Fichier:** `com.pat.service.ChatService.java`  
**Lignes:** 95-127  
**Criticité:** 🟡 MODÉRÉ

#### Problème

La méthode `buildContext()` crée plusieurs `StringBuilder` et listes qui peuvent grandir si l'historique de chat est volumineux. Bien qu'il y ait une limite sur le nombre d'enregistrements chargés (maxHistoryRecords), la construction du contexte peut créer des objets temporaires volumineux.

```java
StringBuilder contextBuilder = new StringBuilder();
StringBuilder contextBuilder2 = new StringBuilder();
List<ChatRequest> chatHistory2 = new ArrayList<ChatRequest>();
```

#### Impact

- **Mémoire:** Les StringBuilder peuvent grandir jusqu'à maxContextSize (10000 caractères par défaut)
- **Scénario:** Si plusieurs requêtes de chat sont traitées simultanément, la mémoire temporaire peut s'accumuler
- **Risque:** En cas de contexte très long, les StringBuilder peuvent consommer plus de mémoire que nécessaire

#### Recommandations

1. **Limiter la taille des StringBuilder** avec une capacité initiale
2. **Réutiliser les objets** si possible
3. **Nettoyer explicitement** les références après utilisation

#### Code Suggéré

```java
// Limiter la capacité initiale des StringBuilder
StringBuilder contextBuilder = new StringBuilder(maxContextSize);
StringBuilder contextBuilder2 = new StringBuilder(maxContextSize);

// Nettoyer après utilisation
contextBuilder.setLength(0);
contextBuilder2.setLength(0);
chatHistory2.clear();
```

---

### 2.3 FileRestController - InputStream Non Fermé dans Certains Cas

**Fichier:** `com.pat.controller.FileRestController.java`  
**Lignes:** 426, 778  
**Criticité:** 🟡 MODÉRÉ

#### Problème

L'`InputStream` retourné par `gridFsResource.getInputStream()` dans `getFile()` est encapsulé dans un `InputStreamResource` qui devrait être géré par Spring, mais il n'y a pas de garantie explicite de fermeture. De même, l'`InputStream` utilisé dans `postFile()` pour `gridFsTemplate.store()` peut ne pas être fermé en cas d'exception.

#### Impact

- **Ressources:** Les InputStream non fermés peuvent garder des descripteurs de fichiers ouverts
- **Scénario:** Si de nombreux fichiers sont servis simultanément, les descripteurs peuvent s'épuiser
- **Risque:** En cas de charge élevée, cela peut causer des erreurs "too many open files"

#### Recommandations

1. **Utiliser try-with-resources** pour garantir la fermeture
2. **Vérifier que Spring ferme correctement** les InputStreamResource
3. **Ajouter un mécanisme de nettoyage** pour les InputStream en cas d'erreur

#### Code Suggéré

```java
// Pour getFile()
try (InputStream inputStream = gridFsResource.getInputStream()) {
    return ResponseEntity.ok()
        .headers(headers)
        .body(new InputStreamResource(inputStream));
}

// Pour postFile()
try (InputStream inputStream = ...) {
    String fieldId = gridFsTemplate.store(inputStream, ...).toString();
    // ...
} // InputStream fermé automatiquement
```

---

## 3. Problèmes Faibles

### 3.1 CachePersistenceService - Fichiers Temporaires Non Nettoyés en Cas d'Erreur

**Fichier:** `com.pat.service.CachePersistenceService.java`  
**Lignes:** 75-102, 131-170  
**Criticité:** 🟢 FAIBLE

#### Problème

Les `ObjectInputStream` et `ObjectOutputStream` sont utilisés avec try-with-resources, ce qui est correct. Cependant, si une exception survient pendant l'écriture, le fichier de cache peut être corrompu et rester sur le disque.

#### Impact

- **Disque:** Les fichiers corrompus peuvent s'accumuler
- **Scénario:** Si plusieurs sauvegardes échouent, les fichiers peuvent s'accumuler
- **Risque:** Faible, mais peut consommer de l'espace disque

#### Recommandations

1. **Ajouter un nettoyage des fichiers corrompus** lors du chargement
2. **Valider l'intégrité** du fichier avant de le charger
3. **Ajouter un mécanisme de backup** avant d'écraser le fichier existant

---

### 3.2 EvenementRestController - SseEmitter Non Nettoyé en Cas d'Erreur

**Fichier:** `com.pat.controller.EvenementRestController.java`  
**Lignes:** 137-464  
**Criticité:** 🟢 FAIBLE

#### Problème

Les `SseEmitter` sont créés et gérés avec des callbacks `onCompletion`, `onTimeout`, et `onError`, ce qui est correct. Cependant, en cas d'exception non gérée dans le `CompletableFuture`, l'emitter peut ne pas être correctement nettoyé.

#### Impact

- **Mémoire:** Les SseEmitter non nettoyés peuvent garder des références aux objets
- **Scénario:** Si plusieurs streams échouent simultanément, les emitters peuvent s'accumuler
- **Risque:** Faible, car les callbacks devraient gérer la plupart des cas

#### Recommandations

1. **Ajouter un nettoyage explicite** dans le bloc finally du CompletableFuture
2. **Vérifier que tous les chemins d'exception** appellent `emitter.complete()` ou `emitter.completeWithError()`
3. **Ajouter un timeout** plus court pour forcer le nettoyage

---

## 4. Problèmes Déjà Corrigés

### 4.1 EvenementRestController - ExecutorService

**Fichier:** `com.pat.controller.EvenementRestController.java`  
**Lignes:** 112-118, 1597-1618  
**Statut:** ✅ CORRIGÉ

Le `ExecutorService` utilise maintenant un `ThreadPoolExecutor` borné avec un `@PreDestroy` pour le nettoyage. C'est correct.

### 4.2 EvenementRestController - Accumulation d'Événements Null-Dated

**Fichier:** `com.pat.controller.EvenementRestController.java`  
**Lignes:** 233, 262-284  
**Statut:** ✅ CORRIGÉ

La liste `nullDateEvents` est limitée à 1000 éléments avec un envoi immédiat si la limite est atteinte. C'est correct.

---

## 5. Recommandations Générales

### 5.1 Monitoring et Alertes

1. **Ajouter des métriques** pour surveiller:
   - Taille des maps/caches en mémoire
   - Nombre de processus FFmpeg actifs
   - Nombre de connexions WebSocket actives
   - Nombre de descripteurs de fichiers ouverts

2. **Configurer des alertes** lorsque:
   - La mémoire dépasse 85%
   - Le nombre de connexions dépasse un seuil
   - Le cache dépasse 80% de sa taille maximale

### 5.2 Tests de Charge

1. **Effectuer des tests de charge** pour identifier les memory leaks sous charge
2. **Utiliser des outils de profilage** (VisualVM, JProfiler, Eclipse MAT) pour analyser les heap dumps
3. **Surveiller la mémoire** sur une période prolongée (plusieurs heures/jours)

### 5.3 Configuration

1. **Ajuster les limites** selon la capacité du serveur:
   - `MAX_CONNECTIONS` dans DiscussionConnectionService
   - `MAX_UPLOAD_SESSIONS` dans FileRestController
   - `cacheMaxSizeMB` dans ImageCompressionService

2. **Configurer les timeouts** appropriés:
   - Timeout pour les processus FFmpeg
   - Timeout pour les connexions WebSocket
   - TTL pour les caches

---

## 6. Plan d'Action Recommandé

### Priorité 1 (Immédiat)
1. ✅ Corriger DiscussionConnectionService - ajouter nettoyage périodique
2. ✅ Corriger FileRestController - améliorer nettoyage des upload logs
3. ✅ Corriger VideoCompressionService - ajouter Semaphore et nettoyage garanti

### Priorité 2 (Court terme)
4. Améliorer ImageCompressionService - nettoyage périodique
5. Optimiser ChatService - limiter taille des StringBuilder
6. Vérifier fermeture des InputStream dans FileRestController

### Priorité 3 (Moyen terme)
7. Améliorer CachePersistenceService - nettoyage fichiers corrompus
8. Vérifier nettoyage SseEmitter dans EvenementRestController

---

## 7. Conclusion

Le backend présente plusieurs problèmes potentiels de memory leaks, mais la plupart sont gérables avec des corrections ciblées. Les problèmes critiques doivent être corrigés en priorité, notamment:

1. **DiscussionConnectionService** - risque de croissance illimitée de la map de connexions
2. **FileRestController** - logs d'upload qui peuvent s'accumuler
3. **VideoCompressionService** - processus FFmpeg non nettoyés

Les problèmes modérés et faibles peuvent être traités progressivement, mais ne représentent pas un risque immédiat pour la stabilité de l'application.

**Note:** Cette analyse est basée sur une revue statique du code. Des tests de charge et un profilage en conditions réelles sont recommandés pour confirmer et quantifier les problèmes identifiés.

---

**Fin du Rapport**

