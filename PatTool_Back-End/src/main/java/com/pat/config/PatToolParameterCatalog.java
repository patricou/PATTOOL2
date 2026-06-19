package com.pat.config;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Curated list of application.properties keys exposed read-only on the admin
 * « PATTOOL Parameters » page. Secrets are flagged for masking at display time.
 * Human descriptions are i18n keys under {@code PATTOOL_PARAMS.PARAM.<key>}.
 */
public final class PatToolParameterCatalog {

    private PatToolParameterCatalog() {}

    public record ParameterDef(String key, String description, boolean sensitive, boolean mongoOverride) {}

    public record SectionDef(String id, String labelKey, List<ParameterDef> parameters) {}

    public static final Set<String> MONGO_USER_KEY_PREFIXES = Set.of(
            "assistant.routing.",
            "globe.flight.tracking.",
            "globe.iss.compass.calibration."
    );

    public static final List<SectionDef> SECTIONS = List.of(
            section("server", "PATTOOL_PARAMS.SECTION.SERVER",
                    def("spring.application.name", false),
                    def("server.port", false)
            ),
            section("mongodb", "PATTOOL_PARAMS.SECTION.MONGODB",
                    def("spring.data.mongodb.host", false),
                    def("spring.data.mongodb.port", false),
                    def("spring.data.mongodb.database", false),
                    defSensitive("spring.data.mongodb.uri")
            ),
            section("files", "PATTOOL_PARAMS.SECTION.FILES",
                    def("spring.servlet.multipart.max-file-size", false),
                    def("spring.servlet.multipart.max-request-size", false),
                    def("app.uploaddir", false),
                    def("file.storage.base-path", false),
                    def("app.imagemaxsizekb", false)
            ),
            section("keycloak", "PATTOOL_PARAMS.SECTION.KEYCLOAK",
                    def("keycloak.realm", false),
                    def("keycloak.auth-server-url", false),
                    def("keycloak.resource", false),
                    def("keycloak.bearer-only", false),
                    def("keycloak.client-id", false),
                    defSensitive("keycloak.credentials.secret")
            ),
            section("cors", "PATTOOL_PARAMS.SECTION.CORS",
                    def("app.cors.allowed-origins", false)
            ),
            section("security-awareness", "PATTOOL_PARAMS.SECTION.SECURITY_AWARENESS",
                    def("pat.security-awareness.scanner-dashboard-url", false),
                    def("pat.security-awareness.internal-runbook-url", false)
            ),
            section("passive-probe", "PATTOOL_PARAMS.SECTION.PASSIVE_PROBE",
                    def("pat.passive-probe.allow-private-targets", false),
                    def("pat.passive-probe.max-redirects", false),
                    def("pat.passive-probe.connect-timeout-seconds", false),
                    def("pat.passive-probe.request-timeout-seconds", false)
            ),
            section("mail", "PATTOOL_PARAMS.SECTION.MAIL",
                    def("app.mailsentfrom", false),
                    def("app.mailsentto", false),
                    def("app.sendmail", false),
                    def("app.connection.email.enabled", false),
                    def("app.connection.email.min-interval-minutes", false)
            ),
            section("assistant", "PATTOOL_PARAMS.SECTION.ASSISTANT",
                    def("assistant.provider", false),
                    def("assistant.billing.openai-billing-url", false),
                    def("assistant.billing.openai-usage-url", false),
                    def("assistant.billing.anthropic-url", false),
                    def("assistant.billing.gemini-rate-limit-url", false),
                    def("assistant.billing.gemini-api-keys-url", false),
                    def("assistant.billing.mistral-url", false)
            ),
            section("openai", "PATTOOL_PARAMS.SECTION.OPENAI",
                    def("openai.api", false),
                    defSensitive("openai.key"),
                    def("openai.assistant.model", false),
                    def("openai.assistant.max-tokens", false),
                    def("openai.provider", false),
                    def("openai.http.connect-timeout-seconds", false),
                    def("openai.http.read-timeout-seconds", false),
                    def("openai.billing.credit-grants-url", false),
                    def("openai.responses.api", false),
                    def("openai.mcp.server-label", false),
                    def("openai.mcp.server-url", false),
                    defSensitive("openai.mcp.authorization")
            ),
            section("anthropic", "PATTOOL_PARAMS.SECTION.ANTHROPIC",
                    defSensitive("anthropic.key"),
                    def("anthropic.api", false),
                    def("anthropic.model", false),
                    def("anthropic.max-tokens", false),
                    def("anthropic.provider-label", false),
                    def("anthropic.version", false),
                    def("anthropic.web-search-tool-type", false),
                    def("anthropic.web-search-max-uses", false),
                    def("anthropic.http.connect-timeout-seconds", false),
                    def("anthropic.http.read-timeout-seconds", false)
            ),
            section("gemini", "PATTOOL_PARAMS.SECTION.GEMINI",
                    defSensitive("gemini.key"),
                    def("gemini.api", false),
                    def("gemini.model", false),
                    def("gemini.image-generation-model", false),
                    def("gemini.max-output-tokens", false),
                    def("gemini.thinking-budget", false),
                    def("gemini.provider-label", false),
                    def("gemini.web-search-legacy-model-prefixes", false),
                    def("gemini.http.connect-timeout-seconds", false),
                    def("gemini.http.read-timeout-seconds", false)
            ),
            section("mistral", "PATTOOL_PARAMS.SECTION.MISTRAL",
                    defSensitive("mistral.key"),
                    def("mistral.api", false),
                    def("mistral.model", false),
                    def("mistral.max-tokens", false),
                    def("mistral.provider-label", false),
                    def("mistral.http.connect-timeout-seconds", false),
                    def("mistral.http.read-timeout-seconds", false)
            ),
            section("globe", "PATTOOL_PARAMS.SECTION.GLOBE",
                    def("globe.proxy.http.connect-timeout-seconds", false),
                    def("globe.proxy.http.read-timeout-seconds", false),
                    def("globe.iss.trace.retention.days", false),
                    def("globe.iss.trace.sample-interval.seconds", false),
                    def("globe.iss.trace.max-display-points", false),
                    def("globe.iss.trace.display.limit.points", false),
                    defMongo("globe.iss.trace.display.limit.enabled", false),
                    def("globe.iss.trace.background.enabled-default", false),
                    defMongo("globe.iss.trace.background.enabled", false),
                    def("globe.iss.trace.background.interval.seconds", false),
                    def("globe.iss.trace.background.fixed-rate-ms", false),
                    def("globe.iss.alert.lead-minutes", false),
                    def("globe.iss.alert.zone", false),
                    def("globe.iss.alert.reminder-mail.ui-base-url", false)
            ),
            section("iot", "PATTOOL_PARAMS.SECTION.IOT",
                    def("app.arduino.ip", false),
                    def("app.esp32.1.ip", false),
                    def("govee.api.base.url", false),
                    defSensitive("govee.api.key"),
                    def("govee.thermometer.auto.refresh.enabled", false),
                    def("govee.thermometer.auto.refresh.cron", false),
                    def("govee.thermometer.history.retention.days", false),
                    def("app.iot-proxy.max-response-bytes", false),
                    def("app.iot-proxy.max-request-body-bytes", false),
                    def("app.iot-proxy.max-rewrite-body-bytes", false),
                    def("app.iot-proxy.redirect-max-hops", false),
                    defSensitive("app.iot-proxy.open-token-hmac-secret"),
                    def("app.iot-proxy.open-token-validity-seconds", false)
            ),
            section("local-network", "PATTOOL_PARAMS.SECTION.LOCAL_NETWORK",
                    def("app.router.ip", false),
                    def("app.router.username", false),
                    defSensitive("app.router.password"),
                    def("app.macvendor.api.url", false),
                    def("app.network.scan.scheduler.enabled", false),
                    def("app.network.scan.scheduler.cron", false)
            ),
            section("weather-maps", "PATTOOL_PARAMS.SECTION.WEATHER_MAPS",
                    defSensitive("openweathermap.api.key"),
                    def("openweathermap.api.base.url", false),
                    defSensitive("thunderforest.api.key"),
                    defSensitive("ign.api.key")
            ),
            section("loto-euromillions", "PATTOOL_PARAMS.SECTION.LOTO_EUROMILLIONS",
                    def("loto.archive.base-url", false),
                    def("euromillions.import.directory", false),
                    def("euromillions.fdj.historique-url", false),
                    def("euromillions.fdj.archive-download-attribute", false),
                    defMongo("euromillions.ai.min-draw-date", false)
            ),
            section("flight", "PATTOOL_PARAMS.SECTION.FLIGHT",
                    def("opensky.base-url", false),
                    def("opensky.token-url", false),
                    def("opensky.client-id", false),
                    defSensitive("opensky.client-secret"),
                    def("opensky.all-states-cache-seconds", false),
                    def("opensky.all-states-stale-max-seconds", false),
                    def("flight.adsbdb.enabled", false),
                    def("flight.adsbdb.base-url", false)
            ),
            section("external-proxies", "PATTOOL_PARAMS.SECTION.EXTERNAL_PROXIES",
                    def("app.cern.opendata-api-base", false),
                    def("app.cern.opendata-portal-base", false),
                    def("app.cern.repository-api-base", false),
                    def("app.cern.zenodo-api-base", false),
                    def("app.nager.api-base", false),
                    def("app.frankfurter.api-base", false),
                    def("app.ip.geolocation.cache.max-size", false),
                    def("app.ip.geolocation.cache.ttl-hours", false),
                    def("app.chem.pubchem-rest-base", false),
                    def("app.chem.pubchem-autocomplete-base", false),
                    def("app.stellarium.web-base", false),
                    def("app.stellarium.noctuasky-api-base", false),
                    def("app.stellarium.freegeoip-base", false),
                    def("app.stellarium.patool-viewer-base", false),
                    def("app.twelvedata.api-base", false),
                    defSensitive("app.twelvedata.api-key")
            ),
            section("news", "PATTOOL_PARAMS.SECTION.NEWS",
                    def("newsapi.api.base.url", false),
                    defSensitive("newsapi.api.key"),
                    defSensitive("newsapi.api.keys"),
                    def("newsapi.cache.ttl.minutes", false),
                    def("newsapi.cache.ttl.empty.minutes", false),
                    def("newsapi.ticker.enabled.default", false),
                    def("newsapi.default.country", false),
                    def("newsapi.default.language", false),
                    def("newsapi.quota.daily", false),
                    def("newsdata.api.base.url", false),
                    defSensitive("newsdata.api.key"),
                    defSensitive("newsdata.api.keys"),
                    def("newsdata.cache.ttl.minutes", false),
                    def("newsdata.cache.ttl.empty.minutes", false),
                    def("newsdata.ticker.enabled.default", false),
                    def("newsdata.default.country", false),
                    def("newsdata.default.language", false),
                    def("newsdata.quota.daily", false)
            ),
            section("cache-memory", "PATTOOL_PARAMS.SECTION.CACHE_MEMORY",
                    def("app.cache.persistence.restore-on-startup", false),
                    def("app.cache.persistence.dir", false),
                    def("app.cache.persistence.filename", false),
                    def("app.memory.warning-threshold", false),
                    def("app.memory.critical-threshold", false),
                    def("app.image.compression.max-concurrency", false),
                    def("app.image.compression.cache.max-entries", false),
                    def("app.image.compression.cache.max-size-mb", false),
                    def("app.image.compression.cache.ttl", false),
                    def("app.video.ffmpeg.path", false),
                    def("app.video.compression.enabled", false),
                    def("app.video.compression.tempdir", false),
                    def("app.video.compression.max-concurrency", false),
                    def("app.exception.tracking.retention-hours", false),
                    def("app.exception.tracking.max-entries-per-ip", false)
            ),
            section("calendar-discussion", "PATTOOL_PARAMS.SECTION.CALENDAR_DISCUSSION",
                    def("app.calendar.morning-reminder.enabled", false),
                    def("app.calendar.morning-reminder.zone", false),
                    def("app.calendar.reminder-mail.ui-base-url", false),
                    def("app.holiday-ui-translate.enabled", false),
                    def("app.holiday-ui-translate.cache-ttl-hours", false),
                    def("app.discussion.default.id", false),
                    def("app.websocket.max-connections", false),
                    def("app.websocket.connection-max-age-minutes", false),
                    def("app.connection-logs.excluded-users", false)
            )
    );

    public static final Set<String> CATALOG_KEYS = SECTIONS.stream()
            .flatMap(s -> s.parameters().stream())
            .map(ParameterDef::key)
            .collect(Collectors.toUnmodifiableSet());

    public static final Set<String> MONGO_OVERRIDE_KEYS = SECTIONS.stream()
            .flatMap(s -> s.parameters().stream())
            .filter(ParameterDef::mongoOverride)
            .map(ParameterDef::key)
            .collect(Collectors.toUnmodifiableSet());

    /** i18n key for a property description ({@code PATTOOL_PARAMS.PARAM.<sanitized_key>}). */
    public static String paramDescKey(String propertyKey) {
        if (propertyKey == null || propertyKey.isBlank()) {
            return "PATTOOL_PARAMS.DESC.UNKNOWN";
        }
        return "PATTOOL_PARAMS.PARAM." + propertyKey.replace('.', '_').replace('-', '_');
    }

    /** Prefixes for auto-discovered keys from application.properties. */
    public static boolean isPatToolPropertyKey(String key) {
        if (key == null || key.isBlank()) {
            return false;
        }
        return key.startsWith("app.")
                || key.startsWith("pat.")
                || key.startsWith("assistant.")
                || key.startsWith("openai.")
                || key.startsWith("anthropic.")
                || key.startsWith("gemini.")
                || key.startsWith("keycloak.")
                || key.startsWith("spring.application.")
                || key.startsWith("spring.data.mongodb.")
                || key.startsWith("spring.servlet.")
                || key.startsWith("server.")
                || key.startsWith("file.")
                || key.startsWith("euromillions.")
                || key.startsWith("loto.")
                || key.startsWith("globe.")
                || key.startsWith("govee.")
                || key.startsWith("opensky.")
                || key.startsWith("flight.")
                || key.startsWith("newsapi.")
                || key.startsWith("newsdata.")
                || key.startsWith("openweathermap.")
                || key.startsWith("thunderforest.")
                || key.startsWith("ign.");
    }

    private static SectionDef section(String id, String labelKey, ParameterDef... parameters) {
        return new SectionDef(id, labelKey, List.of(parameters));
    }

    private static ParameterDef def(String key, boolean sensitive) {
        return new ParameterDef(key, paramDescKey(key), sensitive, false);
    }

    private static ParameterDef defSensitive(String key) {
        return def(key, true);
    }

    private static ParameterDef defMongo(String key, boolean sensitive) {
        return new ParameterDef(key, paramDescKey(key), sensitive, true);
    }

    public static boolean isUserScopedMongoKey(String paramKey) {
        if (paramKey == null) {
            return true;
        }
        return MONGO_USER_KEY_PREFIXES.stream().anyMatch(paramKey::startsWith);
    }

    public static boolean isSensitiveKey(String key) {
        if (key == null) {
            return true;
        }
        String lower = key.toLowerCase();
        return lower.contains("secret")
                || lower.contains("password")
                || lower.contains("credentials")
                || lower.endsWith(".key")
                || lower.endsWith(".keys")
                || lower.contains("authorization")
                || "spring.data.mongodb.uri".equals(key);
    }
}
