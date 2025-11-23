# Configuration Backend pour MongoDB Atlas

## ✅ Modifications effectuées

### 1. Fichier `application.properties`
Le fichier de configuration a été mis à jour pour utiliser MongoDB Atlas au lieu de la base de données locale.

**Changement principal :**
```properties
# Avant (base locale)
spring.data.mongodb.host=192.168.1.33
spring.data.mongodb.port=27018
spring.data.mongodb.database=rando2

# Après (MongoDB Atlas)
spring.data.mongodb.uri=mongodb+srv://patricou:xxxxx@rando.ieagq.mongodb.net/rando2?retryWrites=true&w=majority
```

### 2. Fichier `MongoConfig.java`
La classe de configuration a été mise à jour pour :
- Détecter si on utilise une URI (Atlas) ou host/port (local)
- Afficher la configuration de manière sécurisée dans les logs (masquage du mot de passe)
- Améliorer les messages de log

---

## ⚠️ ACTION REQUISE

### Étape 1 : Mettre à jour le mot de passe
**IMPORTANT :** Vous devez remplacer `xxxxx` dans le fichier `application.properties` par votre vrai mot de passe MongoDB Atlas.

Fichier à modifier : `PatTool_Back-End/src/main/resources/application.properties`

Ligne à modifier :
```properties
spring.data.mongodb.uri=mongodb+srv://patricou:VOTRE_MOT_DE_PASSE_ICI@rando.ieagq.mongodb.net/rando2?retryWrites=true&w=majority
```

### Étape 2 : Vérifier que la base de données est restaurée
Assurez-vous que vous avez bien restauré votre backup dans MongoDB Atlas :
- Base de données : `rando2`
- Collections restaurées : evenements, members, urllink, categorylink, etc.

Si vous ne l'avez pas encore fait, exécutez :
```powershell
.\restore_mongodb_secure.ps1
```

### Étape 3 : Vérifier les permissions réseau MongoDB Atlas
Pour que votre backend puisse se connecter à MongoDB Atlas, vous devez :

1. Aller sur [MongoDB Atlas Console](https://cloud.mongodb.com/)
2. Cliquer sur "Network Access"
3. Ajouter votre adresse IP (ou `0.0.0.0/0` pour permettre toutes les IP - moins sécurisé mais pratique pour le développement)

### Étape 4 : Redémarrer votre backend
Après avoir modifié le fichier `application.properties` :

1. Arrêtez votre application Spring Boot si elle tourne
2. Redémarrez-la
3. Vérifiez les logs pour confirmer la connexion :
   ```
   MongoDB Connection Verification
   Connection Type: MongoDB Atlas (URI)
   Connected to MongoDB database: rando2
   MongoDB connection verified successfully
   ```

---

## 📋 Configuration complète

### Connection String
Format utilisé :
```
mongodb+srv://[username]:[password]@[cluster].mongodb.net/[database]?retryWrites=true&w=majority
```

Paramètres :
- `retryWrites=true` : Réessaie automatiquement les écritures en cas d'échec
- `w=majority` : Attend que la majorité des répliques confirment l'écriture

### Base de données
- **Nom de la base de données** : `rando2`
- **Cluster** : `rando.ieagq.mongodb.net`
- **Utilisateur** : `patricou`

---

## 🔄 Retour à la configuration locale (si nécessaire)

Si vous voulez revenir à la base de données locale, décommentez ces lignes dans `application.properties` :

```properties
# Configuration locale
spring.data.mongodb.host=192.168.1.33
spring.data.mongodb.port=27018
spring.data.mongodb.database=rando2

# Et commentez la ligne URI
# spring.data.mongodb.uri=mongodb+srv://...
```

---

## 🐛 Dépannage

### Erreur : "Unable to connect to MongoDB Atlas"
- Vérifiez que votre IP est autorisée dans Network Access
- Vérifiez le mot de passe dans l'URI
- Vérifiez que le cluster MongoDB Atlas est actif

### Erreur : "Authentication failed"
- Vérifiez le nom d'utilisateur et le mot de passe
- Assurez-vous que l'utilisateur a les droits sur la base de données `rando2`

### Erreur : "Database does not exist"
- Vérifiez que le backup a été restauré avec succès
- Vérifiez le nom de la base de données dans l'URI (devrait être `rando2`)

---

## 📝 Notes

- L'ancienne configuration locale est conservée mais commentée
- Les logs masquent automatiquement le mot de passe pour la sécurité
- La configuration supporte maintenant à la fois les connexions Atlas (URI) et locales (host/port)

