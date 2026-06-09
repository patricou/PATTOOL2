/**
 * Merges PATTOOL_PARAMS.PARAM descriptions into en.json / fr.json.
 * Run: node scripts/merge-pattool-param-i18n.js
 */
const fs = require('fs');
const path = require('path');

const i18nDir = path.join(__dirname, '..', 'src', 'assets', 'i18n');

function sk(key) {
  return key.replace(/\./g, '_').replace(/-/g, '_');
}

/** @type {Record<string, { en: string, fr: string }>} */
const DESC = {
  'spring.application.name': {
    en: 'Internal Spring Boot application name used in logs, health checks and service identification.',
    fr: 'Nom interne de l\'application Spring Boot, utilisé dans les journaux, les contrôles de santé et l\'identification du service.'
  },
  'server.port': {
    en: 'TCP port on which the PatTool API listens for HTTP requests (Angular frontend calls this port).',
    fr: 'Port TCP sur lequel l\'API PatTool écoute les requêtes HTTP (le frontend Angular appelle ce port).'
  },
  'spring.data.mongodb.host': {
    en: 'MongoDB server hostname when not using a full connection URI (events, members, appParameters, etc.).',
    fr: 'Nom d\'hôte du serveur MongoDB si vous n\'utilisez pas d\'URI complète (événements, membres, appParameters, etc.).'
  },
  'spring.data.mongodb.port': {
    en: 'MongoDB TCP port (default 27017) used with spring.data.mongodb.host.',
    fr: 'Port TCP MongoDB (27017 par défaut), utilisé avec spring.data.mongodb.host.'
  },
  'spring.data.mongodb.database': {
    en: 'MongoDB database name where PatTool stores all collections (evenements, members, discussions…).',
    fr: 'Nom de la base MongoDB où PatTool stocke toutes les collections (événements, membres, discussions…).'
  },
  'spring.data.mongodb.uri': {
    en: 'Full MongoDB connection string; when set, it typically overrides host/port and may embed credentials.',
    fr: 'Chaîne de connexion MongoDB complète ; si renseignée, elle remplace en général hôte/port et peut contenir des identifiants.'
  },
  'spring.servlet.multipart.max-file-size': {
    en: 'Maximum size of a single uploaded file (photos, videos, attachments) accepted by Spring.',
    fr: 'Taille maximale d\'un fichier uploadé (photos, vidéos, pièces jointes) acceptée par Spring.'
  },
  'spring.servlet.multipart.max-request-size': {
    en: 'Maximum total size of a multipart HTTP request (all files + fields combined).',
    fr: 'Taille totale maximale d\'une requête HTTP multipart (tous les fichiers et champs réunis).'
  },
  'app.uploaddir': {
    en: 'Temporary directory on the server where uploaded files are written before processing or storage.',
    fr: 'Répertoire temporaire sur le serveur où les fichiers uploadés sont écrits avant traitement ou stockage.'
  },
  'file.storage.base-path': {
    en: 'Root folder on disk for persisted event images and related media served by PatTool.',
    fr: 'Dossier racine sur disque pour les images d\'événements et médias associés servis par PatTool.'
  },
  'app.imagemaxsizekb': {
    en: 'Threshold (KB) above which the UI may prompt users to compress images before upload.',
    fr: 'Seuil (Ko) au-delà duquel l\'interface peut proposer de compresser les images avant envoi.'
  },
  'keycloak.realm': {
    en: 'Keycloak realm name used to validate JWT tokens and resolve user roles for PatTool.',
    fr: 'Nom du realm Keycloak utilisé pour valider les jetons JWT et résoudre les rôles utilisateur PatTool.'
  },
  'keycloak.auth-server-url': {
    en: 'Base URL of the Keycloak server (login, token, admin endpoints) trusted by the backend.',
    fr: 'URL de base du serveur Keycloak (connexion, jetons, admin) approuvée par le backend.'
  },
  'keycloak.resource': {
    en: 'Keycloak client/resource identifier configured for the backend resource server adapter.',
    fr: 'Identifiant client/ressource Keycloak configuré pour l\'adaptateur resource server du backend.'
  },
  'keycloak.bearer-only': {
    en: 'When true, the API accepts only bearer tokens and does not initiate browser login flows itself.',
    fr: 'Si vrai, l\'API n\'accepte que les jetons bearer et n\'initie pas elle-même le flux de connexion navigateur.'
  },
  'keycloak.client-id': {
    en: 'OAuth2 client id used by PatTool when talking to Keycloak (often matches the frontend client).',
    fr: 'Identifiant client OAuth2 utilisé par PatTool pour communiquer avec Keycloak (souvent le client frontend).'
  },
  'keycloak.credentials.secret': {
    en: 'Client secret for confidential Keycloak clients; required for server-side token validation.',
    fr: 'Secret client pour les clients Keycloak confidentiels ; requis pour la validation côté serveur.'
  },
  'app.cors.allowed-origins': {
    en: 'Comma-separated list of frontend origins allowed to call the API with credentials (CORS).',
    fr: 'Liste d\'origines frontend (séparées par des virgules) autorisées à appeler l\'API avec credentials (CORS).'
  },
  'pat.security-awareness.scanner-dashboard-url': {
    en: 'Link shown on the Security Awareness page to your internal vulnerability scanner dashboard.',
    fr: 'Lien affiché sur la page Sensibilisation sécurité vers votre tableau de bord scanner interne.'
  },
  'pat.security-awareness.internal-runbook-url': {
    en: 'Link to an internal security runbook/playbook referenced from the Security Awareness tools.',
    fr: 'Lien vers un runbook sécurité interne référencé depuis les outils de sensibilisation.'
  },
  'pat.passive-probe.allow-private-targets': {
    en: 'Allows the admin passive HTTP probe to target private/LAN IPs (disabled by default for safety).',
    fr: 'Autorise la sonde HTTP passive admin à cibler des IP privées/LAN (désactivé par défaut par sécurité).'
  },
  'pat.passive-probe.max-redirects': {
    en: 'Maximum number of HTTP redirects followed when running a passive probe.',
    fr: 'Nombre maximal de redirections HTTP suivies lors d\'une sonde passive.'
  },
  'pat.passive-probe.connect-timeout-seconds': {
    en: 'TCP connect timeout for passive probe outbound HTTP calls.',
    fr: 'Délai de connexion TCP pour les appels HTTP sortants de la sonde passive.'
  },
  'pat.passive-probe.request-timeout-seconds': {
    en: 'Overall read/request timeout for passive probe HTTP responses.',
    fr: 'Délai global de lecture/requête pour les réponses HTTP de la sonde passive.'
  },
  'app.mailsentfrom': {
    en: 'From address used when PatTool sends outbound emails (reminders, shares, notifications).',
    fr: 'Adresse expéditeur utilisée quand PatTool envoie des e-mails (rappels, partages, notifications).'
  },
  'app.mailsentto': {
    en: 'Default recipient address for server-triggered emails when no explicit recipient is provided.',
    fr: 'Destinataire par défaut des e-mails déclenchés par le serveur sans destinataire explicite.'
  },
  'app.sendmail': {
    en: 'Master switch to enable or disable all outbound mail sending from the backend.',
    fr: 'Interrupteur principal pour activer ou désactiver tout envoi d\'e-mail depuis le backend.'
  },
  'app.connection.email.enabled': {
    en: 'Sends an email to admins when a user signs in (connection notification).',
    fr: 'Envoie un e-mail aux admins lors de la connexion d\'un utilisateur (notification de connexion).'
  },
  'app.connection.email.min-interval-minutes': {
    en: 'Minimum minutes between duplicate connection-notification emails for the same user.',
    fr: 'Délai minimum (minutes) entre deux e-mails de notification de connexion pour le même utilisateur.'
  },
  'assistant.provider': {
    en: 'Default AI provider for the in-app assistant: openai, anthropic or gemini.',
    fr: 'Fournisseur IA par défaut de l\'assistant intégré : openai, anthropic ou gemini.'
  },
  'assistant.billing.openai-billing-url': {
    en: 'External link opened from the assistant UI to manage OpenAI billing.',
    fr: 'Lien externe ouvert depuis l\'assistant pour gérer la facturation OpenAI.'
  },
  'assistant.billing.openai-usage-url': {
    en: 'External link to OpenAI usage dashboard shown in assistant billing hints.',
    fr: 'Lien vers le tableau d\'usage OpenAI affiché dans l\'assistant.'
  },
  'assistant.billing.anthropic-url': {
    en: 'External link to Anthropic plans/billing page from the assistant UI.',
    fr: 'Lien vers la page forfaits/facturation Anthropic depuis l\'assistant.'
  },
  'assistant.billing.gemini-rate-limit-url': {
    en: 'External link explaining Gemini rate limits, shown to users in the assistant.',
    fr: 'Lien expliquant les limites Gemini, affiché aux utilisateurs dans l\'assistant.'
  },
  'assistant.billing.gemini-api-keys-url': {
    en: 'External link to Google AI Studio / API keys page for Gemini setup.',
    fr: 'Lien vers Google AI Studio / gestion des clés API Gemini.'
  },
  'openai.api': {
    en: 'Base URL for OpenAI chat/completions API calls made by OpenAiAssistantService.',
    fr: 'URL de base des appels API chat/completions OpenAI effectués par OpenAiAssistantService.'
  },
  'openai.key': {
    en: 'Secret API key authenticating PatTool to OpenAI for assistant and billing calls.',
    fr: 'Clé API secrète authentifiant PatTool auprès d\'OpenAI (assistant, facturation).'
  },
  'openai.assistant.model': {
    en: 'Default OpenAI model id (e.g. gpt-4o) used for assistant conversations.',
    fr: 'Identifiant du modèle OpenAI par défaut (ex. gpt-4o) pour les conversations assistant.'
  },
  'openai.assistant.max-tokens': {
    en: 'Upper bound on completion tokens returned per OpenAI assistant request.',
    fr: 'Plafond de tokens de complétion renvoyés par requête assistant OpenAI.'
  },
  'openai.provider': {
    en: 'Display label for OpenAI in assistant provider lists and UI badges.',
    fr: 'Libellé affiché pour OpenAI dans les listes de fournisseurs de l\'assistant.'
  },
  'openai.http.connect-timeout-seconds': {
    en: 'HTTP connect timeout for outbound OpenAI REST calls.',
    fr: 'Délai de connexion HTTP des appels REST sortants vers OpenAI.'
  },
  'openai.http.read-timeout-seconds': {
    en: 'HTTP read timeout for long OpenAI assistant streaming or completion responses.',
    fr: 'Délai de lecture HTTP pour les réponses longues OpenAI (streaming ou complétion).'
  },
  'openai.billing.credit-grants-url': {
    en: 'OpenAI billing endpoint URL used server-side to fetch credit grant information.',
    fr: 'URL de facturation OpenAI utilisée côté serveur pour récupérer les crédits accordés.'
  },
  'openai.responses.api': {
    en: 'Optional override URL for OpenAI Responses API (advanced assistant features).',
    fr: 'URL optionnelle de l\'API Responses OpenAI (fonctions assistant avancées).'
  },
  'openai.mcp.server-label': {
    en: 'Label identifying the MCP tool server exposed to OpenAI assistant requests.',
    fr: 'Libellé identifiant le serveur d\'outils MCP exposé aux requêtes assistant OpenAI.'
  },
  'openai.mcp.server-url': {
    en: 'URL of the MCP server PatTool registers as a tool for OpenAI assistant.',
    fr: 'URL du serveur MCP enregistré comme outil pour l\'assistant OpenAI.'
  },
  'openai.mcp.authorization': {
    en: 'Authorization header value sent when PatTool calls the configured MCP server.',
    fr: 'Valeur d\'en-tête Authorization envoyée lors des appels PatTool vers le serveur MCP.'
  },
  'anthropic.key': {
    en: 'Secret Anthropic API key for Claude assistant requests.',
    fr: 'Clé API secrète Anthropic pour les requêtes assistant Claude.'
  },
  'anthropic.api': {
    en: 'Anthropic Messages API endpoint used by AnthropicAssistantService.',
    fr: 'Point d\'accès API Messages Anthropic utilisé par AnthropicAssistantService.'
  },
  'anthropic.model': {
    en: 'Default Claude model id for assistant chat (e.g. claude-sonnet).',
    fr: 'Modèle Claude par défaut pour l\'assistant (ex. claude-sonnet).'
  },
  'anthropic.max-tokens': {
    en: 'Maximum output tokens per Anthropic assistant response.',
    fr: 'Nombre maximal de tokens de sortie par réponse assistant Anthropic.'
  },
  'anthropic.provider-label': {
    en: 'Human-readable provider name shown in the assistant UI for Anthropic.',
    fr: 'Nom du fournisseur affiché dans l\'assistant pour Anthropic.'
  },
  'anthropic.version': {
    en: 'Value of the anthropic-version HTTP header sent with API requests.',
    fr: 'Valeur de l\'en-tête HTTP anthropic-version envoyée aux requêtes API.'
  },
  'anthropic.web-search-tool-type': {
    en: 'Tool type id enabling Anthropic built-in web search in assistant calls.',
    fr: 'Identifiant du type d\'outil activant la recherche web intégrée Anthropic.'
  },
  'anthropic.web-search-max-uses': {
    en: 'Cap on web search tool invocations per request (0 leaves API default).',
    fr: 'Plafond d\'invocations recherche web par requête (0 = défaut API).'
  },
  'anthropic.http.connect-timeout-seconds': {
    en: 'HTTP connect timeout for Anthropic API calls.',
    fr: 'Délai de connexion HTTP des appels API Anthropic.'
  },
  'anthropic.http.read-timeout-seconds': {
    en: 'HTTP read timeout for Anthropic assistant responses.',
    fr: 'Délai de lecture HTTP des réponses assistant Anthropic.'
  },
  'gemini.key': {
    en: 'Google Gemini API key for assistant and image generation features.',
    fr: 'Clé API Google Gemini pour l\'assistant et la génération d\'images.'
  },
  'gemini.api': {
    en: 'Base URL of the Gemini Generative Language API.',
    fr: 'URL de base de l\'API Generative Language Gemini.'
  },
  'gemini.model': {
    en: 'Default Gemini text model for assistant conversations.',
    fr: 'Modèle texte Gemini par défaut pour l\'assistant.'
  },
  'gemini.image-generation-model': {
    en: 'Gemini model used when the assistant generates images.',
    fr: 'Modèle Gemini utilisé quand l\'assistant génère des images.'
  },
  'gemini.max-output-tokens': {
    en: 'Maximum output tokens per Gemini assistant completion.',
    fr: 'Nombre maximal de tokens de sortie par complétion Gemini.'
  },
  'gemini.thinking-budget': {
    en: 'Thinking budget for Gemini reasoning models (-1 omit, 0 disable extended thinking).',
    fr: 'Budget de réflexion pour les modèles Gemini (-1 = omis, 0 = réflexion étendue désactivée).'
  },
  'gemini.provider-label': {
    en: 'Display label for Google Gemini in assistant provider selection.',
    fr: 'Libellé affiché pour Google Gemini dans le choix du fournisseur assistant.'
  },
  'gemini.web-search-legacy-model-prefixes': {
    en: 'Comma-separated model prefixes still using legacy Gemini web search behavior.',
    fr: 'Préfixes de modèles (séparés par virgules) utilisant encore l\'ancienne recherche web Gemini.'
  },
  'gemini.http.connect-timeout-seconds': {
    en: 'HTTP connect timeout for Gemini API requests.',
    fr: 'Délai de connexion HTTP des requêtes API Gemini.'
  },
  'gemini.http.read-timeout-seconds': {
    en: 'HTTP read timeout for Gemini assistant responses.',
    fr: 'Délai de lecture HTTP des réponses assistant Gemini.'
  },
  'globe.proxy.http.connect-timeout-seconds': {
    en: 'Connect timeout when the Globe module proxies external HTTP APIs (ISS, flights…).',
    fr: 'Délai de connexion quand le module Globe fait proxy d\'API externes (ISS, vols…).'
  },
  'globe.proxy.http.read-timeout-seconds': {
    en: 'Read timeout for Globe proxy calls to slow third-party services.',
    fr: 'Délai de lecture des appels proxy Globe vers des services tiers lents.'
  },
  'globe.iss.trace.retention.days': {
    en: 'How many days of ISS position history are kept in MongoDB for the Globe trace.',
    fr: 'Nombre de jours d\'historique de position ISS conservés en MongoDB pour la trace Globe.'
  },
  'globe.iss.trace.sample-interval.seconds': {
    en: 'Minimum seconds between two ISS trace samples stored from live tracking.',
    fr: 'Intervalle minimum (secondes) entre deux échantillons ISS enregistrés en temps réel.'
  },
  'globe.iss.trace.max-display-points': {
    en: 'Hard cap on ISS trace points loaded for rendering the 3D globe path.',
    fr: 'Plafond de points ISS chargés pour afficher la trajectoire sur le globe 3D.'
  },
  'globe.iss.trace.display.limit.points': {
    en: 'Number of ISS points shown when the display limit feature is enabled.',
    fr: 'Nombre de points ISS affichés quand la limite d\'affichage est activée.'
  },
  'globe.iss.trace.display.limit.enabled': {
    en: 'Mongo-stored toggle to cap ISS trace points on the Globe (overrides properties default).',
    fr: 'Interrupteur MongoDB pour limiter les points ISS sur le Globe (prioritaire sur properties).'
  },
  'globe.iss.trace.background.enabled-default': {
    en: 'Default whether background ISS sampling runs when no Mongo override exists.',
    fr: 'Valeur par défaut de l\'échantillonnage ISS en arrière-plan sans surcharge MongoDB.'
  },
  'globe.iss.trace.background.enabled': {
    en: 'Mongo override to enable/disable scheduled ISS background sampling.',
    fr: 'Surcharge MongoDB pour activer/désactiver l\'échantillonnage ISS planifié.'
  },
  'globe.iss.trace.background.interval.seconds': {
    en: 'Target interval between ISS background samples when sampling is enabled.',
    fr: 'Intervalle cible entre échantillons ISS en arrière-plan quand l\'échantillonnage est actif.'
  },
  'globe.iss.trace.background.fixed-rate-ms': {
    en: 'Spring scheduler fixed rate (ms) triggering ISS background sampling jobs.',
    fr: 'Fréquence fixe (ms) du planificateur Spring déclenchant l\'échantillonnage ISS.'
  },
  'globe.iss.alert.lead-minutes': {
    en: 'Minutes before an ISS pass when email alerts are sent to subscribed users.',
    fr: 'Minutes avant un passage ISS pour l\'envoi des alertes e-mail aux abonnés.'
  },
  'globe.iss.alert.zone': {
    en: 'IANA timezone used to compute ISS pass times for alerts and reminders.',
    fr: 'Fuseau horaire IANA pour calculer les heures de passage ISS (alertes et rappels).'
  },
  'globe.iss.alert.reminder-mail.ui-base-url': {
    en: 'Public PatTool base URL embedded in ISS alert emails (links back to the app).',
    fr: 'URL publique PatTool insérée dans les e-mails d\'alerte ISS (lien retour vers l\'app).'
  },
  'app.arduino.ip': {
    en: 'LAN IP of the Arduino / gate controller polled by Home IoT features.',
    fr: 'IP LAN de l\'Arduino / contrôleur portail interrogé par les fonctions IoT maison.'
  },
  'app.esp32.1.ip': {
    en: 'LAN IP of the primary ESP32 device used by Home IoT integrations.',
    fr: 'IP LAN du premier ESP32 utilisé par les intégrations IoT maison.'
  },
  'govee.api.base.url': {
    en: 'Base URL of the Govee OpenAPI for thermometer and smart device queries.',
    fr: 'URL de base de l\'OpenAPI Govee pour thermomètres et appareils connectés.'
  },
  'govee.api.key': {
    en: 'Govee developer API key required to fetch device state and history.',
    fr: 'Clé développeur Govee requise pour l\'état et l\'historique des appareils.'
  },
  'govee.thermometer.auto.refresh.enabled': {
    en: 'Enables the scheduled job that refreshes Govee thermometer readings.',
    fr: 'Active la tâche planifiée qui rafraîchit les relevés thermomètre Govee.'
  },
  'govee.thermometer.auto.refresh.cron': {
    en: 'Cron expression controlling how often Govee thermometers are polled.',
    fr: 'Expression cron définissant la fréquence de interrogation des thermomètres Govee.'
  },
  'govee.thermometer.history.retention.days': {
    en: 'Days of Govee temperature history kept in MongoDB before purge.',
    fr: 'Jours d\'historique température Govee conservés en MongoDB avant purge.'
  },
  'app.iot-proxy.max-response-bytes': {
    en: 'Maximum bytes read from a proxied IoT device HTTP response (DoS protection).',
    fr: 'Octets maximum lus dans une réponse HTTP d\'appareil IoT via proxy (protection DoS).'
  },
  'app.iot-proxy.max-request-body-bytes': {
    en: 'Maximum request body size accepted by the IoT reverse proxy.',
    fr: 'Taille maximale du corps de requête acceptée par le proxy inverse IoT.'
  },
  'app.iot-proxy.max-rewrite-body-bytes': {
    en: 'Maximum HTML/JS body size rewritten when proxy injects PatTool scripts.',
    fr: 'Taille max du corps HTML/JS réécrit quand le proxy injecte des scripts PatTool.'
  },
  'app.iot-proxy.redirect-max-hops': {
    en: 'Maximum HTTP redirects followed when proxying IoT device pages.',
    fr: 'Nombre maximal de redirections HTTP suivies lors du proxy IoT.'
  },
  'app.iot-proxy.open-token-hmac-secret': {
    en: 'HMAC secret signing short-lived tokens that open IoT proxy URLs without full login.',
    fr: 'Secret HMAC signant les jetons courte durée ouvrant des URL proxy IoT sans connexion complète.'
  },
  'app.iot-proxy.open-token-validity-seconds': {
    en: 'Lifetime in seconds of signed IoT proxy open tokens.',
    fr: 'Durée de validité (secondes) des jetons signés d\'ouverture proxy IoT.'
  },
  'app.router.ip': {
    en: 'IP of the home router queried during local network scan (Wi‑Fi/LAN tools).',
    fr: 'IP de la box/routeur interrogée lors du scan réseau local (outils Wi‑Fi/LAN).'
  },
  'app.router.username': {
    en: 'Admin username used to log into the router for advanced network scans.',
    fr: 'Identifiant admin pour se connecter à la box lors des scans réseau avancés.'
  },
  'app.router.password': {
    en: 'Admin password for router login during local network discovery.',
    fr: 'Mot de passe admin box pour la découverte réseau local.'
  },
  'app.macvendor.api.url': {
    en: 'External API URL used to resolve MAC addresses to vendor names in network scan.',
    fr: 'URL d\'API externe pour résoudre les adresses MAC en noms de fabricant (scan réseau).'
  },
  'app.network.scan.scheduler.enabled': {
    en: 'Enables periodic automated local network scans on the server.',
    fr: 'Active les scans réseau local automatiques périodiques sur le serveur.'
  },
  'app.network.scan.scheduler.cron': {
    en: 'Cron schedule for automated network scan jobs.',
    fr: 'Planification cron des tâches de scan réseau automatique.'
  },
  'openweathermap.api.key': {
    en: 'API key for OpenWeatherMap forecasts shown in weather widgets and maps.',
    fr: 'Clé API OpenWeatherMap pour prévisions météo et cartes.'
  },
  'openweathermap.api.base.url': {
    en: 'Base URL of OpenWeatherMap REST API used by OpenWeatherService.',
    fr: 'URL de base de l\'API REST OpenWeatherMap utilisée par OpenWeatherService.'
  },
  'thunderforest.api.key': {
    en: 'Thunderforest API key for OpenCycleMap / outdoor map tile layers.',
    fr: 'Clé API Thunderforest pour les fonds de carte OpenCycleMap / outdoor.'
  },
  'ign.api.key': {
    en: 'IGN Géoportail API key for French official map layers.',
    fr: 'Clé API IGN Géoportail pour les fonds de carte officiels français.'
  },
  'loto.archive.base-url': {
    en: 'Base URL of lesbonsnumeros.com used to sync French Loto draw archives.',
    fr: 'URL de base de lesbonsnumeros.com pour synchroniser les tirages Loto.'
  },
  'euromillions.import.directory': {
    en: 'Server directory where EuroMillions CSV files are dropped for import.',
    fr: 'Répertoire serveur où déposer les CSV EuroMillions pour import.'
  },
  'euromillions.fdj.historique-url': {
    en: 'FDJ web page URL scraped to discover EuroMillions historical draw downloads.',
    fr: 'URL de la page FDJ utilisée pour découvrir les téléchargements historiques EuroMillions.'
  },
  'euromillions.fdj.archive-download-attribute': {
    en: 'HTML data attribute identifying the FDJ archive download link on the historique page.',
    fr: 'Attribut HTML identifiant le lien de téléchargement archive sur la page FDJ historique.'
  },
  'euromillions.ai.min-draw-date': {
    en: 'Mongo override: earliest draw date fed to the EuroMillions AI assistant (filters history).',
    fr: 'Surcharge MongoDB : date minimale des tirages pour l\'assistant IA EuroMillions.'
  },
  'opensky.base-url': {
    en: 'OpenSky Network API base URL for live aircraft state vectors on the Globe.',
    fr: 'URL de base de l\'API OpenSky pour les positions d\'avions en direct sur le Globe.'
  },
  'opensky.token-url': {
    en: 'OAuth2 token endpoint for authenticated OpenSky API access (higher rate limits).',
    fr: 'Point d\'accès OAuth2 pour l\'API OpenSky authentifiée (quotas plus élevés).'
  },
  'opensky.client-id': {
    en: 'OpenSky OAuth client id when using authenticated API mode.',
    fr: 'Identifiant client OAuth OpenSky en mode API authentifiée.'
  },
  'opensky.client-secret': {
    en: 'OpenSky OAuth client secret paired with opensky.client-id.',
    fr: 'Secret client OAuth OpenSky associé à opensky.client-id.'
  },
  'opensky.all-states-cache-seconds': {
    en: 'TTL in seconds for caching OpenSky global aircraft state snapshots.',
    fr: 'Durée (secondes) du cache des instantanés OpenSky de tous les avions.'
  },
  'opensky.all-states-stale-max-seconds': {
    en: 'Maximum age before a cached OpenSky snapshot is considered too stale to serve.',
    fr: 'Âge maximum avant qu\'un cache OpenSky soit jugé trop ancien pour être servi.'
  },
  'flight.adsbdb.enabled': {
    en: 'Enables adsbdb.com lookups to enrich flight routes with planned origin/destination.',
    fr: 'Active les requêtes adsbdb.com pour enrichir les vols avec origine/destination prévues.'
  },
  'flight.adsbdb.base-url': {
    en: 'Base URL of the adsbdb.com API used for flight route enrichment.',
    fr: 'URL de base de l\'API adsbdb.com pour l\'enrichissement des routes de vol.'
  },
  'app.cern.opendata-api-base': {
    en: 'CERN Open Data API base proxied for physics datasets in PatTool.',
    fr: 'Base API CERN Open Data proxifiée pour les jeux de données physique.'
  },
  'app.cern.opendata-portal-base': {
    en: 'Public CERN Open Data portal URL used for links in search results.',
    fr: 'URL du portail public CERN Open Data pour les liens dans les résultats.'
  },
  'app.cern.repository-api-base': {
    en: 'CERN CDS repository API base for document/metadata search.',
    fr: 'Base API dépôt CERN CDS pour recherche documents/métadonnées.'
  },
  'app.cern.zenodo-api-base': {
    en: 'Zenodo API base proxied for open research records.',
    fr: 'Base API Zenodo proxifiée pour les enregistrements de recherche ouverts.'
  },
  'app.nager.api-base': {
    en: 'Nager.Date API base for public holiday calendars in the agenda.',
    fr: 'Base API Nager.Date pour les jours fériés dans l\'agenda.'
  },
  'app.frankfurter.api-base': {
    en: 'Frankfurter API base for currency exchange rates proxied server-side.',
    fr: 'Base API Frankfurter pour les taux de change, proxifiée côté serveur.'
  },
  'app.ip.geolocation.cache.max-size': {
    en: 'Maximum entries in the in-memory IP geolocation cache (connection logs, maps).',
    fr: 'Nombre max d\'entrées du cache géolocalisation IP (journaux connexion, cartes).'
  },
  'app.ip.geolocation.cache.ttl-hours': {
    en: 'Hours before a cached IP geolocation entry expires.',
    fr: 'Heures avant expiration d\'une entrée de géolocalisation IP en cache.'
  },
  'app.chem.pubchem-rest-base': {
    en: 'PubChem PUG REST base URL for chemistry module (molecules, properties).',
    fr: 'URL de base PubChem PUG REST pour le module Chimie (molécules, propriétés).'
  },
  'app.chem.pubchem-autocomplete-base': {
    en: 'PubChem autocomplete API used for molecule name search in Chemistry UI.',
    fr: 'API autocomplétion PubChem pour la recherche de molécules dans Chimie.'
  },
  'app.stellarium.web-base': {
    en: 'Stellarium Web base URL proxied for sky map features.',
    fr: 'URL de base Stellarium Web proxifiée pour la carte du ciel.'
  },
  'app.stellarium.noctuasky-api-base': {
    en: 'NoctuaSky API base for advanced Stellarium data in PatTool.',
    fr: 'Base API NoctuaSky pour les données Stellarium avancées dans PatTool.'
  },
  'app.stellarium.freegeoip-base': {
    en: 'Geolocation service base used to center Stellarium on the user location.',
    fr: 'Base du service de géolocalisation pour centrer Stellarium sur l\'utilisateur.'
  },
  'app.stellarium.patool-viewer-base': {
    en: 'Optional public URL override for embedded Stellarium viewer links in emails/UI.',
    fr: 'URL publique optionnelle pour les liens du viewer Stellarium intégré (e-mails/UI).'
  },
  'app.twelvedata.api-base': {
    en: 'Twelve Data API base for stock/market quotes proxied by PatTool.',
    fr: 'Base API Twelve Data pour cotations boursières proxifiées par PatTool.'
  },
  'app.twelvedata.api-key': {
    en: 'Twelve Data API key (demo key works with limited symbols).',
    fr: 'Clé API Twelve Data (la clé demo fonctionne avec des symboles limités).'
  },
  'newsapi.api.base.url': {
    en: 'NewsAPI.org REST base URL for headline feeds and ticker.',
    fr: 'URL REST de base NewsAPI.org pour fil d\'actualités et ticker.'
  },
  'newsapi.api.key': {
    en: 'Single NewsAPI key (legacy); prefer newsapi.api.keys for failover.',
    fr: 'Clé NewsAPI unique (legacy) ; préférer newsapi.api.keys pour bascule.'
  },
  'newsapi.api.keys': {
    en: 'Comma-separated NewsAPI keys rotated when quota or rate limit is hit.',
    fr: 'Clés NewsAPI séparées par virgules, utilisées en bascule si quota dépassé.'
  },
  'newsapi.cache.ttl.minutes': {
    en: 'Minutes to cache successful NewsAPI responses before refetching.',
    fr: 'Minutes de cache des réponses NewsAPI réussies avant nouveau fetch.'
  },
  'newsapi.cache.ttl.empty.minutes': {
    en: 'Minutes to cache empty NewsAPI responses to avoid hammering the API.',
    fr: 'Minutes de cache des réponses NewsAPI vides pour éviter de surcharger l\'API.'
  },
  'newsapi.ticker.enabled.default': {
    en: 'Default on/off for the news ticker when user has no personal preference.',
    fr: 'État par défaut du ticker actualités sans préférence utilisateur.'
  },
  'newsapi.default.country': {
    en: 'Default country filter (ISO) for NewsAPI top-headlines requests.',
    fr: 'Filtre pays par défaut (ISO) pour les titres NewsAPI.'
  },
  'newsapi.default.language': {
    en: 'Default language filter for NewsAPI article requests.',
    fr: 'Filtre langue par défaut pour les articles NewsAPI.'
  },
  'newsapi.quota.daily': {
    en: 'Documented daily request budget for NewsAPI (informative for admins).',
    fr: 'Quota journalier documenté NewsAPI (informatif pour les admins).'
  },
  'newsdata.api.base.url': {
    en: 'NewsData.io API base URL for alternative news feeds.',
    fr: 'URL de base API NewsData.io pour fils d\'actualités alternatifs.'
  },
  'newsdata.api.key': {
    en: 'Single NewsData.io API key (legacy).',
    fr: 'Clé API NewsData.io unique (legacy).'
  },
  'newsdata.api.keys': {
    en: 'Comma-separated NewsData.io keys used with failover logic.',
    fr: 'Clés NewsData.io séparées par virgules avec logique de bascule.'
  },
  'newsdata.cache.ttl.minutes': {
    en: 'Cache TTL for successful NewsData.io responses.',
    fr: 'Durée de cache des réponses NewsData.io réussies.'
  },
  'newsdata.cache.ttl.empty.minutes': {
    en: 'Cache TTL when NewsData.io returns no articles.',
    fr: 'Durée de cache quand NewsData.io ne renvoie aucun article.'
  },
  'newsdata.ticker.enabled.default': {
    en: 'Default enabled state for NewsData-powered ticker.',
    fr: 'État par défaut du ticker alimenté par NewsData.'
  },
  'newsdata.default.country': {
    en: 'Default country for NewsData.io queries.',
    fr: 'Pays par défaut pour les requêtes NewsData.io.'
  },
  'newsdata.default.language': {
    en: 'Default language for NewsData.io queries.',
    fr: 'Langue par défaut pour les requêtes NewsData.io.'
  },
  'newsdata.quota.daily': {
    en: 'Documented daily NewsData.io quota (admin reference).',
    fr: 'Quota journalier NewsData.io documenté (référence admin).'
  },
  'app.cache.persistence.restore-on-startup': {
    en: 'Reloads persisted image compression cache from disk when the server starts.',
    fr: 'Recharge le cache de compression d\'images depuis le disque au démarrage serveur.'
  },
  'app.cache.persistence.dir': {
    en: 'Directory where image compression cache snapshots are stored.',
    fr: 'Répertoire de stockage des instantanés du cache de compression d\'images.'
  },
  'app.cache.persistence.filename': {
    en: 'Filename of the serialized image cache inside app.cache.persistence.dir.',
    fr: 'Nom du fichier de cache d\'images sérialisé dans app.cache.persistence.dir.'
  },
  'app.memory.warning-threshold': {
    en: 'JVM heap usage percent triggering warning logs and admin memory alerts.',
    fr: 'Pourcentage d\'utilisation heap JVM déclenchant alertes mémoire (avertissement).'
  },
  'app.memory.critical-threshold': {
    en: 'JVM heap usage percent considered critical in monitoring endpoints.',
    fr: 'Pourcentage heap JVM considéré comme critique dans le monitoring.'
  },
  'app.image.compression.max-concurrency': {
    en: 'Max parallel image compression tasks to avoid CPU spikes on upload.',
    fr: 'Nombre max de compressions d\'images en parallèle pour limiter les pics CPU.'
  },
  'app.image.compression.cache.max-entries': {
    en: 'Maximum number of compressed image variants kept in memory cache.',
    fr: 'Nombre max de variantes d\'images compressées en cache mémoire.'
  },
  'app.image.compression.cache.max-size-mb': {
    en: 'Maximum megabytes for the in-memory image compression cache.',
    fr: 'Mégaoctets maximum du cache mémoire de compression d\'images.'
  },
  'app.image.compression.cache.ttl': {
    en: 'ISO-8601 duration after which cached compressed images expire (e.g. PT2H).',
    fr: 'Durée ISO-8601 d\'expiration des images compressées en cache (ex. PT2H).'
  },
  'app.video.ffmpeg.path': {
    en: 'Filesystem path to the ffmpeg binary used for server-side video compression.',
    fr: 'Chemin du binaire ffmpeg pour la compression vidéo côté serveur.'
  },
  'app.video.compression.enabled': {
    en: 'Master switch to enable FFmpeg-based video transcoding/compression.',
    fr: 'Interrupteur principal pour la compression/transcodage vidéo FFmpeg.'
  },
  'app.video.compression.tempdir': {
    en: 'Temporary directory for FFmpeg intermediate files during video processing.',
    fr: 'Répertoire temporaire pour les fichiers intermédiaires FFmpeg.'
  },
  'app.video.compression.max-concurrency': {
    en: 'Max simultaneous video compression jobs (FFmpeg is CPU-heavy).',
    fr: 'Nombre max de jobs de compression vidéo simultanés (FFmpeg est gourmand).'
  },
  'app.exception.tracking.retention-hours': {
    en: 'Hours to retain captured API exception details per client IP.',
    fr: 'Heures de conservation des détails d\'exceptions API par IP client.'
  },
  'app.exception.tracking.max-entries-per-ip': {
    en: 'Cap on stored exception events per IP to limit memory abuse.',
    fr: 'Plafond d\'événements d\'exception stockés par IP (anti-abus mémoire).'
  },
  'app.calendar.morning-reminder.enabled': {
    en: 'Enables scheduled morning emails summarizing today\'s calendar appointments.',
    fr: 'Active les e-mails matinaux récapitulant les rendez-vous du jour.'
  },
  'app.calendar.morning-reminder.zone': {
    en: 'Timezone for deciding when morning calendar reminders are sent.',
    fr: 'Fuseau horaire pour l\'envoi des rappels matinaux agenda.'
  },
  'app.calendar.reminder-mail.ui-base-url': {
    en: 'Public PatTool URL linked from calendar reminder emails.',
    fr: 'URL publique PatTool liée depuis les e-mails de rappel agenda.'
  },
  'app.holiday-ui-translate.enabled': {
    en: 'Enables automatic translation of public holiday names in the UI.',
    fr: 'Active la traduction automatique des noms de jours fériés dans l\'interface.'
  },
  'app.holiday-ui-translate.cache-ttl-hours': {
    en: 'Hours to cache translated holiday labels before retranslation.',
    fr: 'Heures de cache des libellés de jours fériés traduits.'
  },
  'app.discussion.default.id': {
    en: 'MongoDB ObjectId of the default discussion room opened for new users.',
    fr: 'ObjectId MongoDB de la discussion ouverte par défaut pour les nouveaux utilisateurs.'
  },
  'app.websocket.max-connections': {
    en: 'Maximum concurrent WebSocket connections for live discussion/chat.',
    fr: 'Nombre max de connexions WebSocket simultanées (discussion/chat temps réel).'
  },
  'app.websocket.connection-max-age-minutes': {
    en: 'Minutes before an idle WebSocket connection is closed server-side.',
    fr: 'Minutes avant fermeture côté serveur d\'une connexion WebSocket inactive.'
  },
  'app.connection-logs.excluded-users': {
    en: 'Comma-separated usernames excluded from connection audit logs (e.g. service accounts).',
    fr: 'Noms d\'utilisateurs (CSV) exclus des journaux de connexion (ex. comptes de service).'
  }
};

function merge(lang) {
  const file = path.join(i18nDir, lang + '.json');
  const root = JSON.parse(fs.readFileSync(file, 'utf8'));
  const param = {};
  for (const [key, val] of Object.entries(DESC)) {
    param[sk(key)] = val[lang];
  }
  root.PATTOOL_PARAMS.PARAM = param;
  root.PATTOOL_PARAMS.DESC.UNKNOWN = lang === 'en'
    ? 'No detailed description is available for this parameter key.'
    : 'Aucune description détaillée n\'est disponible pour cette clé.';
  root.PATTOOL_PARAMS.DESC.EXTRA_PROPERTY = lang === 'en'
    ? 'Property present in application.properties but not listed in the curated catalog; effect depends on Spring or custom code reading this key.'
    : 'Propriété présente dans application.properties mais absente du catalogue ; effet selon le code Spring ou métier qui lit cette clé.';
  fs.writeFileSync(file, JSON.stringify(root, null, 4) + '\n', 'utf8');
  console.log(lang + ': merged ' + Object.keys(param).length + ' parameter descriptions');
}

merge('en');
merge('fr');
