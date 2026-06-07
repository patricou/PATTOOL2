package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.pat.controller.MailController;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * E-mail alerts for upcoming <em>visible</em> ISS passes over a configured city/country.
 *
 * <p>The observed place (and recipient e-mail) are stored in MongoDB {@code appParameters} so the
 * configuration survives restarts and can be edited from the UI. A scheduler polls visible-pass
 * predictions (CDN Space, via {@link GlobeProxyService}) and sends one e-mail roughly
 * {@code globe.iss.alert.lead-minutes} minutes (default 30) before each pass, with date/time,
 * duration, rise/max/set direction (azimuth), peak elevation, brightness and visibility quality.</p>
 */
@Service
public class IssPassAlertService {

    private static final Logger log = LoggerFactory.getLogger(IssPassAlertService.class);

    /** MongoDB {@code appParameters} keys (survive restarts). */
    public static final String PARAM_ENABLED = "globe.iss.alert.enabled";
    public static final String PARAM_EMAIL = "globe.iss.alert.email";
    public static final String PARAM_PLACE = "globe.iss.alert.place";
    public static final String PARAM_PLACE_LABEL = "globe.iss.alert.placeLabel";
    public static final String PARAM_LAT = "globe.iss.alert.lat";
    public static final String PARAM_LON = "globe.iss.alert.lon";
    public static final String PARAM_MIN_QUALITY = "globe.iss.alert.minQuality";
    /** JSON array of rise times (epoch ms) already e-mailed, to avoid duplicate alerts. */
    public static final String PARAM_NOTIFIED = "globe.iss.alert.notified";

    private static final DateTimeFormatter MAIL_DATE =
            DateTimeFormatter.ofPattern("EEEE d MMMM yyyy", Locale.FRENCH);
    private static final DateTimeFormatter MAIL_TIME =
            DateTimeFormatter.ofPattern("HH:mm:ss", Locale.FRENCH);

    /** French 16-point compass labels (N / E / S / O). */
    private static final String[] COMPASS_16 = {
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"
    };

    private final GlobeProxyService globeProxyService;
    private final GeocodeService geocodeService;
    private final AppParameterService appParameterService;
    private final MailController mailController;
    private final ObjectMapper objectMapper;

    @Value("${globe.iss.alert.lead-minutes:30}")
    private int leadMinutes;

    @Value("${globe.iss.alert.zone:Europe/Paris}")
    private String zoneId;

    @Value("${globe.iss.alert.reminder-mail.ui-base-url:https://www.patrickdeschamps.com}")
    private String uiBaseUrl;

    public IssPassAlertService(
            GlobeProxyService globeProxyService,
            GeocodeService geocodeService,
            AppParameterService appParameterService,
            MailController mailController,
            ObjectMapper objectMapper) {
        this.globeProxyService = globeProxyService;
        this.geocodeService = geocodeService;
        this.appParameterService = appParameterService;
        this.mailController = mailController;
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() {
        log.info("ISS visible-pass alert: enabled={}, place='{}', leadMinutes={}, zone={}",
                appParameterService.getBoolean(PARAM_ENABLED, false),
                appParameterService.getString(PARAM_PLACE, ""),
                getLeadMinutes(),
                zoneId);
    }

    public int getLeadMinutes() {
        return Math.max(5, Math.min(180, leadMinutes));
    }

    // ---------------------------------------------------------------------
    // Configuration (read / write)
    // ---------------------------------------------------------------------

    /** Visibility quality threshold: passes at or above this are eligible for alerts. */
    public enum Quality {
        ANY(0), FAIR(1), GOOD(2);

        private final int rank;

        Quality(int rank) {
            this.rank = rank;
        }

        static Quality fromString(String s, Quality fallback) {
            if (s == null) {
                return fallback;
            }
            switch (s.trim().toLowerCase(Locale.ROOT)) {
                case "any":
                    return ANY;
                case "fair":
                    return FAIR;
                case "good":
                    return GOOD;
                default:
                    return fallback;
            }
        }

        static int rankOf(String cdnQuality) {
            if (cdnQuality == null) {
                return 0;
            }
            switch (cdnQuality.trim().toLowerCase(Locale.ROOT)) {
                case "good":
                    return 2;
                case "fair":
                    return 1;
                default:
                    return 0; // poor / unknown
            }
        }
    }

    public record AlertConfig(
            boolean enabled,
            String email,
            String place,
            String placeLabel,
            Double lat,
            Double lon,
            String minQuality,
            int leadMinutes) {
    }

    public AlertConfig getConfig() {
        Double lat = parseNullableDouble(appParameterService.getString(PARAM_LAT, null));
        Double lon = parseNullableDouble(appParameterService.getString(PARAM_LON, null));
        return new AlertConfig(
                appParameterService.getBoolean(PARAM_ENABLED, false),
                appParameterService.getString(PARAM_EMAIL, ""),
                appParameterService.getString(PARAM_PLACE, ""),
                appParameterService.getString(PARAM_PLACE_LABEL, ""),
                lat,
                lon,
                appParameterService.getString(PARAM_MIN_QUALITY, "fair"),
                getLeadMinutes());
    }

    /**
     * Update the alert configuration. When {@code place} changes (or coordinates are missing),
     * the place is geocoded server-side and the resolved coordinates / display name are stored.
     *
     * @return the updated configuration (with resolved coordinates)
     * @throws IllegalArgumentException when the place cannot be geocoded
     */
    public AlertConfig updateConfig(Boolean enabled, String email, String place, String minQuality) {
        if (enabled != null) {
            appParameterService.setBoolean(PARAM_ENABLED, enabled,
                    "Send an e-mail before the ISS becomes visible over the configured place.");
        }
        if (email != null) {
            appParameterService.setString(PARAM_EMAIL, email.trim(),
                    "Recipient e-mail for ISS visible-pass alerts (blank = default app recipient).");
        }
        if (minQuality != null) {
            Quality q = Quality.fromString(minQuality, Quality.FAIR);
            appParameterService.setString(PARAM_MIN_QUALITY, q.name().toLowerCase(Locale.ROOT),
                    "Minimum visibility quality for ISS pass alerts (any/fair/good).");
        }
        if (place != null) {
            String trimmed = place.trim();
            String previous = appParameterService.getString(PARAM_PLACE, "");
            boolean coordsMissing = parseNullableDouble(appParameterService.getString(PARAM_LAT, null)) == null
                    || parseNullableDouble(appParameterService.getString(PARAM_LON, null)) == null;
            if (!trimmed.isEmpty() && (!trimmed.equalsIgnoreCase(previous) || coordsMissing)) {
                List<Map<String, Object>> hits = geocodeService.search(trimmed);
                if (hits.isEmpty()) {
                    throw new IllegalArgumentException("no_geocode_results");
                }
                Map<String, Object> best = hits.get(0);
                double lat = toDouble(best.get("lat"));
                double lon = toDouble(best.get("lon"));
                String displayName = best.get("displayName") != null ? best.get("displayName").toString() : trimmed;
                appParameterService.setString(PARAM_PLACE, trimmed, "Place watched for ISS visible-pass alerts.");
                appParameterService.setString(PARAM_PLACE_LABEL, displayName, "Resolved display name of the watched place.");
                appParameterService.setString(PARAM_LAT, Double.toString(lat), "Latitude of the watched place.");
                appParameterService.setString(PARAM_LON, Double.toString(lon), "Longitude of the watched place.");
                // A new place invalidates the de-dup history.
                appParameterService.setString(PARAM_NOTIFIED, "[]", "ISS pass rise times already e-mailed.");
            } else if (trimmed.isEmpty()) {
                appParameterService.setString(PARAM_PLACE, "", "Place watched for ISS visible-pass alerts.");
            }
        }
        return getConfig();
    }

    // ---------------------------------------------------------------------
    // Visible-pass prediction
    // ---------------------------------------------------------------------

    public record VisiblePass(
            long riseTimeMs,
            double riseAzimuthDeg,
            long maxTimeMs,
            double maxElevationDeg,
            long setTimeMs,
            double setAzimuthDeg,
            double magnitude,
            String quality) {

        public long durationSeconds() {
            long d = (setTimeMs - riseTimeMs) / 1000L;
            return d > 0 ? d : 0;
        }
    }

    /** Upcoming visible passes (future only), filtered by quality, sorted by rise time. */
    public List<VisiblePass> fetchUpcomingVisiblePasses(double lat, double lon, int days, Quality minQuality, int limit) {
        List<VisiblePass> out = new ArrayList<>();
        try {
            byte[] raw = globeProxyService.fetchIssVisiblePassesRaw(lat, lon, days);
            JsonNode root = objectMapper.readTree(raw);
            if (!root.isArray()) {
                return out;
            }
            long now = Instant.now().toEpochMilli();
            int minRank = minQuality == null ? 0 : minQuality.rank;
            List<VisiblePass> all = new ArrayList<>();
            for (JsonNode p : root) {
                long rise = p.path("riseTime").asLong(0);
                if (rise <= 0) {
                    continue;
                }
                if (rise <= now) {
                    continue; // past pass
                }
                String quality = p.path("quality").asText("");
                if (Quality.rankOf(quality) < minRank) {
                    continue;
                }
                all.add(new VisiblePass(
                        rise,
                        p.path("riseAzimuth").asDouble(Double.NaN),
                        p.path("maxTime").asLong(rise),
                        p.path("maxElevation").asDouble(Double.NaN),
                        p.path("setTime").asLong(rise),
                        p.path("setAzimuth").asDouble(Double.NaN),
                        p.path("magnitude").asDouble(Double.NaN),
                        quality));
            }
            all.sort((a, b) -> Long.compare(a.riseTimeMs(), b.riseTimeMs()));
            for (VisiblePass vp : all) {
                if (out.size() >= limit) {
                    break;
                }
                out.add(vp);
            }
        } catch (Exception e) {
            log.warn("ISS visible-pass fetch failed for ({}, {}): {}", lat, lon, e.getMessage());
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // Scheduler + notification
    // ---------------------------------------------------------------------

    /** Every 5 minutes by default ({@code globe.iss.alert.check.fixed-rate-ms}). */
    @Scheduled(fixedRateString = "${globe.iss.alert.check.fixed-rate-ms:300000}",
            initialDelayString = "${globe.iss.alert.check.initial-delay-ms:60000}")
    public void scheduledCheck() {
        try {
            checkAndNotify();
        } catch (Exception e) {
            log.warn("ISS pass alert check failed: {}", e.getMessage());
        }
    }

    /**
     * Core loop: e-mail any not-yet-notified future pass whose rise time is within the lead window.
     *
     * @return number of alert e-mails sent in this run
     */
    public int checkAndNotify() {
        AlertConfig cfg = getConfig();
        if (!cfg.enabled()) {
            return 0;
        }
        if (cfg.lat() == null || cfg.lon() == null) {
            log.debug("ISS pass alert: enabled but no place coordinates set.");
            return 0;
        }
        Quality minQuality = Quality.fromString(cfg.minQuality(), Quality.FAIR);
        List<VisiblePass> passes = fetchUpcomingVisiblePasses(cfg.lat(), cfg.lon(), 2, minQuality, 20);
        if (passes.isEmpty()) {
            return 0;
        }
        long now = Instant.now().toEpochMilli();
        long leadMs = getLeadMinutes() * 60_000L;
        Set<Long> notified = loadNotified();
        // Prune entries older than 6 h to keep the parameter small.
        notified.removeIf(t -> t < now - 6L * 3_600_000L);

        int sent = 0;
        for (VisiblePass p : passes) {
            long remaining = p.riseTimeMs() - now;
            if (remaining <= 0 || remaining > leadMs) {
                continue;
            }
            if (notified.contains(p.riseTimeMs())) {
                continue;
            }
            if (sendAlertEmail(cfg, p)) {
                notified.add(p.riseTimeMs());
                sent++;
            }
        }
        saveNotified(notified);
        if (sent > 0) {
            log.info("ISS pass alert: sent {} e-mail(s) for place '{}'.", sent, cfg.placeLabel());
        }
        return sent;
    }

    /**
     * Send an alert e-mail for the next upcoming visible pass (manual test from the UI), ignoring timing.
     *
     * @return a short status: "sent", "no_place", "no_pass" or "mail_failed"
     */
    public String sendTestForNextPass() {
        AlertConfig cfg = getConfig();
        if (cfg.lat() == null || cfg.lon() == null) {
            return "no_place";
        }
        Quality minQuality = Quality.fromString(cfg.minQuality(), Quality.FAIR);
        List<VisiblePass> passes = fetchUpcomingVisiblePasses(cfg.lat(), cfg.lon(), 5, minQuality, 1);
        if (passes.isEmpty()) {
            return "no_pass";
        }
        return sendAlertEmail(cfg, passes.get(0)) ? "sent" : "mail_failed";
    }

    private boolean sendAlertEmail(AlertConfig cfg, VisiblePass pass) {
        try {
            String recipient = StringUtils.hasText(cfg.email()) ? cfg.email().trim() : mailController.getMailSentTo();
            if (!StringUtils.hasText(recipient)) {
                log.warn("ISS pass alert: no recipient e-mail configured, skipping.");
                return false;
            }
            ZoneId zone = parseZone(zoneId);
            String subject = buildSubject(cfg, pass, zone);
            String html = buildHtml(cfg, pass, zone);
            mailController.sendMailToRecipient(recipient, subject, html, true);
            return true;
        } catch (Exception e) {
            log.warn("ISS pass alert e-mail failed: {}", e.getMessage());
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // E-mail content (French, HTML)
    // ---------------------------------------------------------------------

    private String buildSubject(AlertConfig cfg, VisiblePass pass, ZoneId zone) {
        ZonedDateTime rise = Instant.ofEpochMilli(pass.riseTimeMs()).atZone(zone);
        String place = StringUtils.hasText(cfg.placeLabel()) ? shortPlace(cfg.placeLabel()) : cfg.place();
        return "PatTool — ISS visible " + (StringUtils.hasText(place) ? "à " + place + " " : "")
                + "à " + MAIL_TIME.format(rise).substring(0, 5);
    }

    private String buildHtml(AlertConfig cfg, VisiblePass pass, ZoneId zone) {
        ZonedDateTime rise = Instant.ofEpochMilli(pass.riseTimeMs()).atZone(zone);
        ZonedDateTime max = Instant.ofEpochMilli(pass.maxTimeMs()).atZone(zone);
        ZonedDateTime set = Instant.ofEpochMilli(pass.setTimeMs()).atZone(zone);
        long durationSec = pass.durationSeconds();
        String durationLabel = (durationSec / 60) + " min " + String.format(Locale.FRENCH, "%02d", durationSec % 60) + " s";
        String fontStack = "'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
        String place = StringUtils.hasText(cfg.placeLabel()) ? cfg.placeLabel() : cfg.place();

        StringBuilder rows = new StringBuilder();
        rows.append(row("Lieu", escapeHtml(place)));
        rows.append(row("Date", capitalize(MAIL_DATE.format(rise))));
        rows.append(row("Début (apparition)", MAIL_TIME.format(rise) + " — " + directionLabel(pass.riseAzimuthDeg())));
        rows.append(row("Maximum", MAIL_TIME.format(max) + " — " + elevationLabel(pass.maxElevationDeg())
                + " · " + directionFromAzimuth(azimuthAtMax(pass))));
        rows.append(row("Fin (disparition)", MAIL_TIME.format(set) + " — " + directionLabel(pass.setAzimuthDeg())));
        rows.append(row("Durée", durationLabel));
        rows.append(row("Élévation max", elevationLabel(pass.maxElevationDeg())));
        rows.append(row("Luminosité (magnitude)", magnitudeLabel(pass.magnitude())));
        rows.append(row("Qualité de visibilité", qualityLabel(pass.quality())));

        String href = uiHref();
        String linkRow = "";
        if (StringUtils.hasText(href)) {
            String hrefEsc = escapeHtmlAttr(href);
            linkRow = "<tr><td colspan=\"2\" style=\"padding:14px 18px 18px 18px;font-family:" + fontStack + ";\">"
                    + "<a href=\"" + hrefEsc + "\" style=\"display:inline-block;padding:8px 16px;background:#2563eb;"
                    + "color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px;\">"
                    + "Ouvrir le globe PatTool</a></td></tr>";
        }

        return "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"UTF-8\"/>"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/></head>"
                + "<body style=\"margin:0;padding:0;background-color:#e2e8f0;\">"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"background-color:#e2e8f0;padding:28px 14px;\"><tr><td align=\"center\">"
                + "<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;"
                + "box-shadow:0 12px 40px rgba(15,23,42,0.12);\">"
                + "<tr><td style=\"background-image:linear-gradient(135deg,#0c1326 0%,#1f2d52 55%,#2563eb 100%);"
                + "padding:24px 28px;\">"
                + "<div style=\"font-family:" + fontStack + ";font-size:22px;font-weight:700;color:#ffffff;\">"
                + "🛰️ Passage ISS visible</div>"
                + "<div style=\"font-family:" + fontStack + ";font-size:13px;color:rgba(255,255,255,0.9);margin-top:6px;\">"
                + "La Station spatiale internationale " + visibilityLeadPhrase(pass.riseTimeMs(), rise) + "</div>"
                + "</td></tr>"
                + "<tr><td style=\"padding:18px 18px 4px 18px;\">"
                + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" "
                + "style=\"border-collapse:separate;border-spacing:0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;\">"
                + rows
                + "</table></td></tr>"
                + linkRow
                + "<tr><td colspan=\"2\" style=\"padding:6px 18px 22px 18px;font-family:" + fontStack + ";font-size:12px;"
                + "color:#94a3b8;line-height:1.5;\">Astuce : regardez vers la direction d’apparition et levez les yeux "
                + "jusqu’à l’élévation maximale indiquée. Message automatique envoyé par <strong style=\"color:#64748b;\">"
                + "PatTool</strong> — module globe / ISS.</td></tr>"
                + "</table></td></tr></table></body></html>";
    }

    private static String row(String key, String value) {
        return "<tr>"
                + "<td style=\"padding:11px 16px;border-bottom:1px solid #eef2f7;background:#f8fafc;width:200px;"
                + "font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#64748b;font-weight:600;\">" + key + "</td>"
                + "<td style=\"padding:11px 16px;border-bottom:1px solid #eef2f7;"
                + "font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#0f172a;font-weight:600;\">" + value + "</td>"
                + "</tr>";
    }

    /** Human phrase describing how far ahead the pass is (accurate for both alerts and test e-mails). */
    private static String visibilityLeadPhrase(long riseTimeMs, ZonedDateTime rise) {
        long remainingMin = Math.round((riseTimeMs - System.currentTimeMillis()) / 60_000.0);
        if (remainingMin <= 1) {
            return "sera bientôt visible (dans moins d’une minute).";
        }
        if (remainingMin < 90) {
            return "sera visible dans environ " + remainingMin + " minutes.";
        }
        long hours = remainingMin / 60;
        long minutes = remainingMin % 60;
        String when = capitalize(MAIL_DATE.format(rise)) + " à " + MAIL_TIME.format(rise).substring(0, 5);
        if (hours < 24) {
            String approx = minutes == 0
                    ? "dans environ " + hours + " h"
                    : "dans environ " + hours + " h " + minutes + " min";
            return "sera visible " + approx + " (" + when + ").";
        }
        return "sera visible le " + when + ".";
    }

    /** Azimuth most representative of where to look at culmination (mid of rise/set). */
    private static double azimuthAtMax(VisiblePass pass) {
        double a = pass.riseAzimuthDeg();
        double b = pass.setAzimuthDeg();
        if (Double.isNaN(a)) {
            return b;
        }
        if (Double.isNaN(b)) {
            return a;
        }
        // Circular mean of the two horizon azimuths (rough heading toward culmination).
        double ar = Math.toRadians(a);
        double br = Math.toRadians(b);
        double x = Math.cos(ar) + Math.cos(br);
        double y = Math.sin(ar) + Math.sin(br);
        double mean = Math.toDegrees(Math.atan2(y, x));
        return (mean + 360.0) % 360.0;
    }

    private static String directionLabel(double azimuthDeg) {
        if (Double.isNaN(azimuthDeg)) {
            return "—";
        }
        return directionFromAzimuth(azimuthDeg) + " (" + Math.round(azimuthDeg) + "°)";
    }

    private static String directionFromAzimuth(double azimuthDeg) {
        if (Double.isNaN(azimuthDeg)) {
            return "—";
        }
        double a = ((azimuthDeg % 360.0) + 360.0) % 360.0;
        int idx = (int) Math.round(a / 22.5) % 16;
        return COMPASS_16[idx];
    }

    private static String elevationLabel(double elevationDeg) {
        if (Double.isNaN(elevationDeg)) {
            return "—";
        }
        return Math.round(elevationDeg) + "° au-dessus de l’horizon";
    }

    private static String magnitudeLabel(double magnitude) {
        if (Double.isNaN(magnitude)) {
            return "—";
        }
        return String.format(Locale.FRENCH, "%.1f", magnitude) + " (plus c’est bas, plus c’est brillant)";
    }

    private static String qualityLabel(String quality) {
        if (quality == null) {
            return "—";
        }
        switch (quality.trim().toLowerCase(Locale.ROOT)) {
            case "good":
                return "Bonne";
            case "fair":
                return "Moyenne";
            case "poor":
                return "Faible";
            default:
                return quality;
        }
    }

    // ---------------------------------------------------------------------
    // De-dup history persistence
    // ---------------------------------------------------------------------

    private Set<Long> loadNotified() {
        Set<Long> set = new TreeSet<>();
        String raw = appParameterService.getString(PARAM_NOTIFIED, "[]");
        try {
            JsonNode node = objectMapper.readTree(raw);
            if (node.isArray()) {
                for (JsonNode n : node) {
                    long v = n.asLong(0);
                    if (v > 0) {
                        set.add(v);
                    }
                }
            }
        } catch (Exception ignore) {
            // corrupt value -> start fresh
        }
        return set;
    }

    private void saveNotified(Set<Long> notified) {
        try {
            ArrayNode arr = objectMapper.createArrayNode();
            for (Long t : notified) {
                arr.add(t);
            }
            appParameterService.setJson(PARAM_NOTIFIED, objectMapper.writeValueAsString(arr),
                    "ISS pass rise times already e-mailed (de-dup).");
        } catch (Exception e) {
            log.warn("ISS pass alert: failed to persist notified set: {}", e.getMessage());
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private String uiHref() {
        if (!StringUtils.hasText(uiBaseUrl)) {
            return null;
        }
        String base = uiBaseUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            base = "https://" + base;
        }
        return base + "/#/world-globe";
    }

    static ZoneId parseZone(String id) {
        if (!StringUtils.hasText(id)) {
            return ZoneId.of("Europe/Paris");
        }
        try {
            return ZoneId.of(id.trim());
        } catch (Exception ex) {
            return ZoneId.of("Europe/Paris");
        }
    }

    private static String shortPlace(String displayName) {
        if (displayName == null) {
            return "";
        }
        int comma = displayName.indexOf(',');
        return comma > 0 ? displayName.substring(0, comma).trim() : displayName.trim();
    }

    private static String capitalize(String s) {
        if (s == null || s.isEmpty()) {
            return s;
        }
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    private static Double parseNullableDouble(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            double v = Double.parseDouble(s.trim());
            return Double.isFinite(v) ? v : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static double toDouble(Object v) {
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        return Double.parseDouble(String.valueOf(v));
    }

    private static String escapeHtml(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static String escapeHtmlAttr(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;").replace("\"", "&quot;").replace("'", "&#39;");
    }
}
