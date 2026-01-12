# Guide de Sécurisation SMB (Port 445)

## ⚠️ Risques Même en Réseau Local

**Question fréquente :** *"Mon port 445 n'est pas ouvert sur Internet, y a-t-il un danger ?"*

**Réponse : OUI, il y a toujours des risques même en réseau local !**

### 🔴 Pourquoi SMB reste dangereux en réseau local :

1. **Propagation de Malware**
   - Les ransomwares comme **WannaCry** et **NotPetya** se propagent via SMB sur le réseau local
   - Un seul appareil compromis peut infecter tous les autres via SMB
   - Aucun accès Internet nécessaire pour la propagation

2. **Attaques Internes (Insider Threats)**
   - Utilisateurs malveillants ou compromis sur le réseau
   - Accès non autorisé aux partages de fichiers
   - Vol de données sensibles

3. **Compromission en Chaîne**
   - Si un appareil du réseau est compromis (phishing, malware), l'attaquant peut utiliser SMB pour se propager
   - Escalade de privilèges via SMB
   - Accès latéral (lateral movement) dans le réseau

4. **Attaques Man-in-the-Middle (MITM)**
   - Sur un réseau local non sécurisé (WiFi public, réseau partagé)
   - Interception des credentials SMB
   - Modification des données en transit

5. **Accès via VPN ou Accès Distant**
   - Si un utilisateur se connecte via VPN, il devient "local" au réseau
   - Un attaquant compromettant le VPN peut accéder à SMB
   - Risque de compromission depuis l'extérieur

6. **Appareils IoT et Non Gérés**
   - Appareils compromis sur le même réseau local
   - Caméras IP, imprimantes, etc. peuvent servir de point d'entrée

### ✅ Conclusion
**Même si le port 445 n'est pas exposé directement sur Internet, il doit être sécurisé car :**
- Les vulnérabilités SMB (EternalBlue, SMBGhost) fonctionnent en réseau local
- La propagation de malware via SMB est un risque majeur
- Les attaques internes sont une réalité
- La compromission d'un seul appareil peut mettre en danger tout le réseau

**Recommandation :** Appliquez les mesures de sécurisation ci-dessous même pour un réseau local.

---

## 🔴 Vulnérabilités SMB Courantes

Le protocole SMB (Server Message Block) sur le port 445 est exposé à plusieurs vulnérabilités critiques :

### 1. **EternalBlue (MS17-010)**
- **CVE-2017-0144** : Exploit utilisé par WannaCry et NotPetya
- Affecte SMBv1 sur Windows non patchés
- Permet l'exécution de code à distance

### 2. **SMBGhost (CVE-2020-0796)**
- Vulnérabilité dans SMBv3.1.1
- Permet l'exécution de code à distance
- Affecte Windows 10 version 1903 et 1909

### 3. **SMBleed (CVE-2020-1206)**
- Fuite d'informations mémoire via SMB
- Peut révéler des données sensibles

### 4. **Attaques Man-in-the-Middle**
- SMB sans signature permet l'interception et la modification des données
- Vol de credentials possible

---

## ✅ Mesures de Sécurisation

### 1. **Appliquer les Correctifs Windows**

```powershell
# Vérifier les mises à jour installées
Get-HotFix | Where-Object {$_.HotFixID -like "*MS17-010*" -or $_.HotFixID -like "*KB4551762*"}

# Installer les mises à jour critiques
# Windows Update > Rechercher les mises à jour
```

**Correctifs essentiels :**
- **MS17-010** : Correctif EternalBlue (mars 2017)
- **KB4551762** : Correctif SMBGhost (mars 2020)
- **KB5005394** : Correctifs SMB supplémentaires (2021)

---

### 2. **Désactiver SMBv1**

SMBv1 est obsolète et vulnérable. Désactivez-le si non nécessaire :

#### Via PowerShell (Recommandé)
```powershell
# Vérifier l'état de SMBv1
Get-WindowsOptionalFeature -Online -FeatureName SMB1Protocol

# Désactiver SMBv1
Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart

# Redémarrer si nécessaire
Restart-Computer
```

#### Via Gestionnaire de serveur (Windows Server)
1. Gestionnaire de serveur > Fonctionnalités > Désinstaller
2. Décocher "Support du client SMB 1.0/CIFS"

#### Via Registre Windows
```powershell
# Désactiver SMBv1 côté serveur
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" -Name "SMB1" -Value 0 -Type DWord

# Désactiver SMBv1 côté client
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\mrxsmb10" -Name "Start" -Value 4 -Type DWord

# Redémarrer les services
Restart-Service LanmanServer -Force
```

---

### 3. **Activer SMB Signing**

SMB Signing prévient les attaques man-in-the-middle en signant les paquets SMB :

#### Via Stratégie de groupe (GPO)
1. **Gestionnaire de stratégie de groupe** > Modifier la stratégie
2. **Configuration ordinateur** > Stratégies > Modèles d'administration > Réseau > Client réseau Microsoft
3. Activer :
   - **"Signer numériquement les communications (client)"** : Activé
   - **"Signer numériquement les communications (serveur)"** : Activé

#### Via Registre Windows
```powershell
# Activer SMB Signing côté client
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" -Name "RequireSecuritySignature" -Value 1 -Type DWord

# Activer SMB Signing côté serveur
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" -Name "RequireSecuritySignature" -Value 1 -Type DWord

# Redémarrer les services
Restart-Service LanmanWorkstation -Force
Restart-Service LanmanServer -Force
```

#### Vérifier l'état
```powershell
# Vérifier la configuration SMB Signing
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" | Select-Object RequireSecuritySignature
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" | Select-Object RequireSecuritySignature
```

---

### 4. **Configurer le Pare-feu Windows**

**Pour un réseau local uniquement :** Restreindre l'accès SMB aux appareils autorisés :

#### Via PowerShell - Réseau Local Sécurisé
```powershell
# Autoriser SMB uniquement depuis le réseau local spécifique
# Remplacez 192.168.1.0/24 par votre plage réseau
New-NetFirewallRule -DisplayName "Allow SMB from Local Network Only" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 445 `
    -Action Allow `
    -RemoteAddress 192.168.1.0/24,10.0.0.0/8,172.16.0.0/12

# Bloquer SMB depuis toutes les autres adresses (sécurité défensive)
New-NetFirewallRule -DisplayName "Block SMB from Other Networks" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 445 `
    -Action Block `
    -RemoteAddress Internet
```

**Note :** Même en réseau local, configurez le pare-feu pour limiter l'accès aux sous-réseaux autorisés uniquement.

#### Via PowerShell
```powershell
# Bloquer SMB depuis Internet (port 445)
New-NetFirewallRule -DisplayName "Block SMB from Internet" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 445 `
    -Action Block `
    -RemoteAddress Internet

# Autoriser SMB uniquement depuis le réseau local
New-NetFirewallRule -DisplayName "Allow SMB from Local Network" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 445 `
    -Action Allow `
    -RemoteAddress 192.168.0.0/16,10.0.0.0/8,172.16.0.0/12
```

#### Via Interface graphique
1. **Pare-feu Windows Defender** > Paramètres avancés
2. **Règles de trafic entrant** > Nouvelle règle
3. **Port** > TCP > Port spécifique : **445**
4. **Bloquer la connexion**
5. Appliquer à tous les profils
6. Nom : "Block SMB from Internet"

---

### 5. **Utiliser SMBv3 avec Chiffrement**

SMBv3 offre un chiffrement natif. Activez-le pour les partages sensibles :

#### Activer le chiffrement SMBv3
```powershell
# Activer le chiffrement pour un partage spécifique
Set-SmbShare -Name "ShareName" -EncryptData $true

# Activer le chiffrement pour tous les nouveaux partages
Set-SmbServerConfiguration -EncryptData $true

# Vérifier la configuration
Get-SmbServerConfiguration | Select-Object EncryptData
```

#### Forcer SMBv3 uniquement
```powershell
# Désactiver SMBv2 (forcer SMBv3)
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" -Name "SMB2" -Value 0 -Type DWord

# Note : SMBv3 nécessite SMBv2, donc cette option limite à SMBv2 et SMBv3
# Pour forcer uniquement SMBv3, utilisez la stratégie de groupe
```

---

### 6. **Désactiver l'Accès Anonyme SMB**

#### Via Stratégie de groupe
1. **Configuration ordinateur** > Stratégies > Paramètres Windows > Paramètres de sécurité > Stratégies locales > Options de sécurité
2. **Accès réseau : Partage nommé et canaux nommés pouvant être accessibles anonymement** : Désactivé
3. **Accès réseau : Partage nommé pouvant être accessibles anonymement** : Aucun

#### Via Registre
```powershell
# Désactiver l'accès anonyme
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" -Name "RestrictAnonymous" -Value 1 -Type DWord
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" -Name "RestrictAnonymousSam" -Value 1 -Type DWord

# Redémarrer le service
Restart-Service LanmanServer -Force
```

---

### 7. **Limiter les Partages SMB**

#### Auditer les partages existants
```powershell
# Lister tous les partages SMB
Get-SmbShare

# Vérifier les permissions
Get-SmbShareAccess -Name "ShareName"

# Supprimer les partages non nécessaires
Remove-SmbShare -Name "ShareName" -Force
```

#### Configurer des permissions strictes
```powershell
# Créer un partage avec permissions limitées
New-SmbShare -Name "SecureShare" -Path "C:\SecureData" -FullAccess "DOMAIN\SecurityGroup" -ReadAccess "DOMAIN\Users"
```

---

### 8. **Authentification et Mots de Passe**

- ✅ Utiliser des mots de passe forts (minimum 12 caractères, complexité)
- ✅ Activer l'authentification multi-facteurs (MFA) si possible
- ✅ Désactiver les comptes par défaut (Guest, Administrator)
- ✅ Utiliser des comptes de service avec privilèges minimaux
- ✅ Implémenter une politique de rotation des mots de passe

---

### 9. **Surveillance et Logging**

#### Activer l'audit SMB
```powershell
# Activer l'audit des accès aux objets
auditpol /set /category:"Object Access" /success:enable /failure:enable

# Configurer l'audit des partages via Stratégie de groupe
# Configuration ordinateur > Stratégies > Paramètres Windows > Paramètres de sécurité > 
# Stratégies d'audit > Audit de l'accès aux objets
```

#### Surveiller les événements
```powershell
# Vérifier les tentatives d'accès SMB
Get-WinEvent -LogName Security | Where-Object {$_.Id -eq 5145 -or $_.Id -eq 5143} | Select-Object -First 10
```

---

### 10. **Sécurisation Réseau Local**

Même si SMB n'est pas exposé sur Internet, sécurisez votre réseau local :

#### Segmentation Réseau
- ✅ Isoler les appareils critiques dans un VLAN séparé
- ✅ Limiter la communication entre segments réseau
- ✅ Utiliser des règles de pare-feu entre sous-réseaux

#### Surveillance Réseau
- ✅ Détecter les tentatives d'exploitation SMB (EternalBlue, etc.)
- ✅ Monitorer les connexions SMB anormales
- ✅ Alerter en cas de propagation de malware

#### Authentification Renforcée
- ✅ Utiliser des comptes avec privilèges minimaux pour SMB
- ✅ Désactiver les comptes par défaut (Guest, Admin)
- ✅ Implémenter une politique de mots de passe stricte

### 11. **Alternative : Utiliser un VPN pour Accès Distant**

Pour l'accès distant, utilisez un VPN au lieu d'exposer SMB directement :

- ✅ Configurer un VPN (OpenVPN, WireGuard, ou VPN Windows intégré)
- ✅ Accéder aux partages SMB via le tunnel VPN
- ✅ Bloquer complètement le port 445 depuis Internet
- ⚠️ **Important :** Une fois connecté via VPN, l'utilisateur est "local" - sécurisez SMB comme décrit ci-dessus

---

## 🔍 Vérification de la Sécurisation

### Script de Vérification PowerShell

```powershell
# Vérifier l'état de SMBv1
$smb1 = Get-WindowsOptionalFeature -Online -FeatureName SMB1Protocol
Write-Host "SMBv1 Status: $($smb1.State)"

# Vérifier SMB Signing
$clientSigning = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters").RequireSecuritySignature
$serverSigning = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters").RequireSecuritySignature
Write-Host "SMB Client Signing: $clientSigning"
Write-Host "SMB Server Signing: $serverSigning"

# Vérifier les correctifs
$eternalBlue = Get-HotFix | Where-Object {$_.HotFixID -like "*MS17-010*"}
$smbGhost = Get-HotFix | Where-Object {$_.HotFixID -like "*KB4551762*"}
Write-Host "EternalBlue Patch: $($eternalBlue -ne $null)"
Write-Host "SMBGhost Patch: $($smbGhost -ne $null)"

# Vérifier les règles de pare-feu
$firewallRules = Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*SMB*" -or $_.DisplayName -like "*445*"}
$firewallRules | Format-Table DisplayName, Enabled, Direction, Action
```

---

## 📋 Checklist de Sécurisation SMB (Réseau Local)

**Même si le port 445 n'est pas exposé sur Internet, appliquez ces mesures :**

- [ ] Appliquer tous les correctifs Windows (MS17-010, KB4551762+) - **CRITIQUE pour réseau local**
- [ ] Désactiver SMBv1 si non nécessaire - **Protège contre WannaCry/NotPetya**
- [ ] Activer SMB Signing (client et serveur) - **Prévient MITM sur réseau local**
- [ ] Configurer le pare-feu pour limiter SMB aux sous-réseaux autorisés
- [ ] Activer le chiffrement SMBv3 pour les partages sensibles
- [ ] Désactiver l'accès anonyme SMB
- [ ] Auditer et limiter les partages SMB aux utilisateurs nécessaires
- [ ] Utiliser des mots de passe forts et MFA
- [ ] Activer l'audit et la surveillance SMB (détecter tentatives d'exploitation)
- [ ] Segmenter le réseau (VLAN) pour isoler les appareils critiques
- [ ] Surveiller les connexions SMB anormales
- [ ] Considérer l'utilisation d'un VPN pour l'accès distant (et sécuriser SMB même via VPN)

---

## 🚨 En Cas d'Incident

Si une vulnérabilité SMB est exploitée :

1. **Isoler immédiatement** le système compromis du réseau
2. **Changer tous les mots de passe** des comptes affectés
3. **Analyser les logs** pour identifier l'étendue de la compromission
4. **Appliquer les correctifs** manquants
5. **Réinitialiser les sessions** actives
6. **Notifier** l'équipe de sécurité et la direction

---

## 📚 Ressources Complémentaires

- [Microsoft Security Advisory MS17-010](https://docs.microsoft.com/en-us/security-updates/securitybulletins/2017/ms17-010)
- [CVE-2020-0796 (SMBGhost)](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2020-0796)
- [OWASP - SMB Security](https://owasp.org/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)

---

**Dernière mise à jour :** Décembre 2024
