# Configuration de l'envoi d'emails avec Keycloak

## Problème
Keycloak n'arrive pas à envoyer des emails (mot de passe oublié, validation d'email, etc.)

## Solution
Le problème est du côté du serveur Keycloak, pas de votre application Angular. Vous devez configurer les paramètres SMTP dans Keycloak.

## Configuration via l'interface d'administration Keycloak

### Étapes pour configurer l'email

1. **Connectez-vous à la console d'administration Keycloak**
   - URL: `http://localhost:8080/auth` (dev) ou `https://www.patrickdeschamps.com:8543/auth` (prod)
   - Connexion avec un utilisateur administrateur

2. **Sélectionnez votre realm**
   - Le realm utilisé est: `pat-realm` (selon votre configuration dans `keycloak.service.ts`)

3. **Allez dans Realm Settings > Email**
   - Menu: Realm Settings → Email

4. **Configurez les paramètres SMTP**

   ### Exemple avec Gmail:
   - **Host**: `smtp.gmail.com`
   - **Port**: `587` (ou `465` pour SSL)
   - **Authentication**: activé
   - **Username**: votre adresse email Gmail
   - **Password**: mot de passe de l'application (Gmail App Password)
   - **SSL/TLS**: activé
   - **From**: adresse email d'expéditeur (ex: `pat-tool@example.com`)
   - **From Display Name**: nom affiché (ex: `Pat Tool`)

   ### Exemple avec Outlook/Office 365:
   - **Host**: `smtp.office365.com`
   - **Port**: `587`
   - **Authentication**: activé
   - **Username**: votre adresse email
   - **Password**: votre mot de passe
   - **StartTLS**: activé
   - **SSL/TLS**: activé

   ### Configuration générique SMTP:
   - **Host**: `smtp.example.com`
   - **Port**: `587` (ou le port approprié)
   - **Authentication**: activé (si requis)
   - **Username**: votre nom d'utilisateur
   - **Password**: votre mot de passe
   - **SSL/TLS**: activé ou désactivé selon votre fournisseur
   - **StartTLS**: activé ou désactivé selon votre fournisseur

5. **Testez la configuration**
   - Cliquez sur "Test connection" ou "Send test email"
   - Saisissez une adresse email pour tester
   - Vérifiez que l'email est bien reçu

## Configuration via Docker (si applicable)

Si Keycloak tourne dans un conteneur Docker, vous pouvez aussi configurer l'email via variables d'environnement ou fichiers de configuration.

### Variables d'environnement pour Docker:
```bash
KEYCLOAK_SMTP_HOST=smtp.gmail.com
KEYCLOAK_SMTP_PORT=587
KEYCLOAK_SMTP_AUTH=true
KEYCLOAK_SMTP_USER=votre@email.com
KEYCLOAK_SMTP_PASSWORD=votre_mot_de_passe
KEYCLOAK_SMTP_SSL=true
KEYCLOAK_SMTP_FROM=noreply@example.com
KEYCLOAK_SMTP_FROM_DISPLAY_NAME=Pat Tool
```

### Fichier de configuration (keycloak.conf):
```properties
smtp.host=smtp.gmail.com
smtp.port=587
smtp.auth=true
smtp.user=votre@email.com
smtp.password=votre_mot_de_passe
smtp.ssl=true
smtp.starttls=true
smtp.from=noreply@example.com
```

## Configuration des emails dans le realm

En plus de la configuration SMTP générale, vous devez également configurer les templates d'emails pour votre realm:

1. **Allez dans Realm Settings > Email**
2. **Configurez les templates d'emails personnalisés** si nécessaire:
   - Email de vérification
   - Email de réinitialisation de mot de passe
   - Email de bienvenue
   - etc.

## Activer la vérification d'email

Pour que les emails soient envoyés lors de la création de compte:

1. **Allez dans Realm Settings > Login**
2. **Activez**:
   - "Require Email Verification" 
   - "Email as Username" (si vous voulez utiliser l'email comme nom d'utilisateur)

## Troubleshooting

### Les emails ne sont pas envoyés
1. Vérifiez les logs de Keycloak pour les erreurs SMTP
2. Vérifiez que le port SMTP n'est pas bloqué par le pare-feu
3. Vérifiez vos identifiants SMTP
4. Pour Gmail, utilisez un "App Password" et non le mot de passe principal
5. Vérifiez que "From" est correctement configuré

### Erreur "Authentication failed"
- Vérifiez vos identifiants
- Pour Gmail, activez "Accès aux applications moins sécurisées" ou utilisez un App Password
- Vérifiez que l'authentification SMTP est activée

### Erreur "Connection timeout"
- Vérifiez que le port SMTP est correct (587 pour TLS, 465 pour SSL)
- Vérifiez que le serveur SMTP est accessible
- Vérifiez les paramètres firewall

## Pour Gmail spécifiquement

1. **Créez un App Password**:
   - Allez sur votre compte Google
   - Sécurité → Mots de passe des applications
   - Créez un nouveau mot de passe pour "Mail"
   - Utilisez ce mot de passe dans la configuration SMTP de Keycloak

2. **Ou activez "Accès aux applications moins sécurisées"**:
   - Paramètres de sécurité Google
   - Activez l'accès aux applications moins sécurisées

## URLs de connexion

- **Dev**: http://localhost:8080/auth/admin
- **Prod**: https://www.patrickdeschamps.com:8543/auth/admin
- **Realm**: pat-realm

## Références

- Documentation Keycloak SMTP: https://www.keycloak.org/docs/latest/server_admin/#_email
- Configuration Gmail SMTP: https://support.google.com/mail/answer/7126229


