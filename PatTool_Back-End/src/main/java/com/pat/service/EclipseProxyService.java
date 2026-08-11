package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.config.RestTemplateConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Server-side proxy for eclipse data:
 * <ul>
 *   <li>USNO Astronomical Applications — solar eclipse year list + local circumstances</li>
 *   <li>OPALE / IMCCE — solar (NAIF 10) and lunar (NAIF 301) eclipses</li>
 * </ul>
 * Year payloads from OPALE are summarized (visibility paths stripped) to keep responses small.
 */
@Service
public class EclipseProxyService {

    private static final Logger log = LoggerFactory.getLogger(EclipseProxyService.class);

    private static final int MIN_YEAR = 1800;
    private static final int MAX_YEAR = 2050;
    private static final int BODY_SUN = 10;
    private static final int BODY_MOON = 301;
    private static final int DEFAULT_VISIBILITY_YEARS_AHEAD = 5;
    private static final int MAX_VISIBILITY_YEARS_AHEAD = 8;
    private static final int MAX_VISIBLE_RESULTS = 6;

    private static final Pattern OBSCURATION_PERCENT = Pattern.compile("([0-9]+(?:\\.[0-9]+)?)\\s*%");
    private static final DateTimeFormatter USNO_TIME = new DateTimeFormatterBuilder()
            .appendPattern("H:mm:ss")
            .optionalStart()
            .appendFraction(ChronoField.NANO_OF_SECOND, 1, 9, true)
            .optionalEnd()
            .toFormatter();

    /** Heavy GeoJSON fields dropped from OPALE day/year detail responses. */
    private static final Set<String> OPALE_STRIP_FIELDS = Set.of(
            "visibilityPaths", "visibilityLines", "link");

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${app.eclipse.usno-api-base:https://aa.usno.navy.mil/api}")
    private String usnoApiBase;

    @Value("${app.eclipse.opale-api-base:https://opale.imcce.fr/api/v1}")
    private String opaleApiBase;

    public EclipseProxyService(
            @Qualifier(RestTemplateConfig.ECLIPSE_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public JsonNode usnoSolarYear(int year) {
        validateYear(year);
        String url = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(usnoApiBase) + "/eclipses/solar/year")
                .queryParam("year", year)
                .toUriString();
        return fetchJson(url);
    }

    public JsonNode usnoSolarLocal(String date, double lat, double lon, int heightMeters) {
        validateDate(date);
        validateCoords(lat, lon);
        if (heightMeters < -500 || heightMeters > 9000) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_height");
        }
        // USNO accepts "lat,lon" (with or without space after the comma).
        String coords = String.format(Locale.ROOT, "%.6f,%.6f", lat, lon);
        String url = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(usnoApiBase) + "/eclipses/solar/date")
                .queryParam("date", date)
                .queryParam("coords", coords)
                .queryParam("height", heightMeters)
                .encode()
                .toUriString();
        return fetchJson(url);
    }

    public ObjectNode opaleYear(int body, int year) {
        validateBody(body);
        validateYear(year);
        String url = normalizeBase(opaleApiBase) + "/phenomena/eclipses/" + body + "/" + year;
        JsonNode root = fetchJson(url);
        ObjectNode out = objectMapper.createObjectNode();
        out.put("source", "opale");
        out.put("body", body);
        out.put("kind", body == BODY_SUN ? "solar" : "lunar");
        out.put("year", year);
        ArrayNode eclipses = out.putArray("eclipses");

        JsonNode response = root.path("response");
        JsonNode list = body == BODY_MOON ? response.path("lunareclipse") : response.path("data");
        if (list.isArray()) {
            for (JsonNode item : list) {
                eclipses.add(summarizeOpaleEclipse(item));
            }
        }
        return out;
    }

    public ObjectNode opaleDay(int body, String date, Double lat, Double lon, Integer heightMeters) {
        validateBody(body);
        validateDate(date);
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(opaleApiBase) + "/phenomena/eclipses/" + body + "/" + date)
                .queryParam("format", "json");
        if (lat != null && lon != null) {
            validateCoords(lat, lon);
            int h = heightMeters != null ? heightMeters : 0;
            if (h < -500 || h > 9000) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_height");
            }
            builder.queryParam("observer", String.format(Locale.ROOT, "%.6f,%.6f,%d", lat, lon, h));
        }
        JsonNode root = fetchJson(builder.encode().toUriString());
        ObjectNode out = objectMapper.createObjectNode();
        out.put("source", "opale");
        out.put("body", body);
        out.put("kind", body == BODY_SUN ? "solar" : "lunar");
        out.put("date", date);
        out.set("request", root.path("request"));
        out.set("eclipses", slimOpaleList(
                body == BODY_MOON ? root.path("response").path("lunareclipse") : root.path("response").path("data")));
        return out;
    }

    /**
     * For a given observer position, finds whether a solar eclipse is visible now / next,
     * with local type (partial / annular / total), magnitude and obscuration percent.
     * Scans USNO year lists then local circumstances; non-visible dates are skipped.
     */
    public ObjectNode visibilityAtLocation(double lat, double lon, int heightMeters, Integer yearsAheadParam) {
        validateCoords(lat, lon);
        if (heightMeters < -500 || heightMeters > 9000) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_height");
        }
        int yearsAhead = yearsAheadParam == null ? DEFAULT_VISIBILITY_YEARS_AHEAD : yearsAheadParam;
        yearsAhead = Math.max(1, Math.min(MAX_VISIBILITY_YEARS_AHEAD, yearsAhead));

        Instant now = Instant.now();
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        int startYear = today.getYear();
        int endYear = Math.min(MAX_YEAR, startYear + yearsAhead);

        List<ObjectNode> visible = new ArrayList<>();
        int checked = 0;
        int notVisible = 0;

        for (int year = startYear; year <= endYear && visible.size() < MAX_VISIBLE_RESULTS; year++) {
            JsonNode yearData;
            try {
                yearData = usnoSolarYear(year);
            } catch (ResponseStatusException e) {
                log.warn("USNO year list failed for {}: {}", year, e.getReason());
                continue;
            }
            JsonNode list = yearData.path("eclipses_in_year");
            if (!list.isArray()) {
                continue;
            }
            for (JsonNode entry : list) {
                if (visible.size() >= MAX_VISIBLE_RESULTS) {
                    break;
                }
                if (!entry.has("year") || !entry.has("month") || !entry.has("day")) {
                    continue;
                }
                LocalDate date = LocalDate.of(
                        entry.get("year").asInt(),
                        entry.get("month").asInt(),
                        entry.get("day").asInt());
                if (date.isBefore(today)) {
                    continue;
                }
                checked++;
                String dateIso = date.toString();
                JsonNode local = fetchUsnoLocalSoft(dateIso, lat, lon, heightMeters);
                if (local == null || hasUsnoError(local) || !local.has("properties")) {
                    notVisible++;
                    continue;
                }
                ObjectNode item = buildSolarVisibilityItem(entry, local.path("properties"), date, now);
                if (item != null) {
                    visible.add(item);
                } else {
                    notVisible++;
                }
            }
        }

        ObjectNode current = null;
        ObjectNode next = null;
        ArrayNode upcoming = objectMapper.createArrayNode();
        for (ObjectNode item : visible) {
            if (item.path("inProgress").asBoolean(false) && current == null) {
                current = item;
            } else if (next == null) {
                next = item;
            } else {
                upcoming.add(item);
            }
        }
        // If an eclipse is in progress, it is also the "next" for countdown=0.
        if (current != null && next == null) {
            next = current.deepCopy();
            next.put("millisecondsUntil", 0L);
            next.put("daysUntil", 0L);
            next.put("hoursUntil", 0.0);
        }

        ObjectNode out = objectMapper.createObjectNode();
        out.put("source", "usno");
        out.put("kind", "solar");
        out.put("lat", lat);
        out.put("lon", lon);
        out.put("height", heightMeters);
        out.put("asOf", now.toString());
        out.put("yearsScanned", endYear - startYear + 1);
        out.put("candidatesChecked", checked);
        out.put("candidatesNotVisible", notVisible);
        out.put("visibleFromHere", current != null || next != null);
        if (current != null) {
            out.set("current", current);
        } else {
            out.putNull("current");
        }
        if (next != null) {
            out.set("next", next);
        } else {
            out.putNull("next");
        }
        out.set("upcoming", upcoming);

        ObjectNode nextLunar = findNextLunar(today, Math.min(endYear, today.getYear() + 1), now);
        if (nextLunar != null) {
            out.set("nextLunar", nextLunar);
        } else {
            out.putNull("nextLunar");
        }
        return out;
    }

    private ObjectNode findNextLunar(LocalDate today, int endYear, Instant now) {
        for (int year = today.getYear(); year <= endYear; year++) {
            ObjectNode yearData;
            try {
                yearData = opaleYear(BODY_MOON, year);
            } catch (ResponseStatusException e) {
                continue;
            }
            JsonNode list = yearData.path("eclipses");
            if (!list.isArray()) {
                continue;
            }
            for (JsonNode item : list) {
                String calendarDate = textOrEmpty(item, "calendarDate");
                if (!StringUtils.hasText(calendarDate)) {
                    continue;
                }
                LocalDate date;
                try {
                    date = LocalDate.parse(calendarDate);
                } catch (Exception e) {
                    continue;
                }
                if (date.isBefore(today)) {
                    continue;
                }
                ObjectNode lunar = objectMapper.createObjectNode();
                lunar.put("kind", "lunar");
                lunar.put("date", calendarDate);
                lunar.put("type", textOrEmpty(item, "type"));
                if (item.has("magnitude") && item.get("magnitude").isNumber()) {
                    lunar.put("magnitude", item.get("magnitude").asDouble());
                }
                Instant begins = date.atStartOfDay().toInstant(ZoneOffset.UTC);
                long msUntil = Math.max(0L, ChronoUnit.MILLIS.between(now, begins));
                lunar.put("millisecondsUntil", msUntil);
                lunar.put("daysUntil", ChronoUnit.DAYS.between(today, date));
                lunar.put("hoursUntil", msUntil / 3_600_000.0);
                lunar.put("note", "lunar_global_night_side");
                return lunar;
            }
        }
        return null;
    }

    private ObjectNode buildSolarVisibilityItem(
            JsonNode yearEntry, JsonNode properties, LocalDate date, Instant now) {
        Double magnitude = parseDouble(properties, "magnitude");
        Double obscurationPercent = parseObscurationPercent(properties.path("obscuration"));
        if ((magnitude == null || magnitude <= 0.0)
                && (obscurationPercent == null || obscurationPercent <= 0.0)) {
            return null;
        }

        String description = textOrEmpty(properties, "description");
        String event = textOrEmpty(properties, "event");
        if (!StringUtils.hasText(event)) {
            event = textOrEmpty(yearEntry, "event");
        }
        String visibilityType = classifySolarVisibility(description, properties, magnitude);

        Instant begins = parseLocalPhenomenonInstant(properties, date, "Eclipse Begins");
        Instant maximum = parseLocalPhenomenonInstant(properties, date, "Maximum Eclipse");
        Instant ends = parseLocalPhenomenonInstant(properties, date, "Eclipse Ends");
        if (begins == null && maximum != null) {
            begins = maximum;
        }
        Instant countdownTarget = begins != null ? begins : (maximum != null ? maximum : date.atStartOfDay().toInstant(ZoneOffset.UTC));
        boolean inProgress = begins != null && ends != null
                && !now.isBefore(begins) && !now.isAfter(ends);

        long msUntil = inProgress ? 0L : Math.max(0L, ChronoUnit.MILLIS.between(now, countdownTarget));
        long daysUntil = ChronoUnit.DAYS.between(LocalDate.now(ZoneOffset.UTC), date);

        ObjectNode item = objectMapper.createObjectNode();
        item.put("kind", "solar");
        item.put("date", date.toString());
        item.put("event", event);
        item.put("description", description);
        item.put("visibilityType", visibilityType);
        if (magnitude != null) {
            item.put("magnitude", magnitude);
        }
        if (obscurationPercent != null) {
            item.put("obscurationPercent", obscurationPercent);
        }
        String obscurationRaw = textOrEmpty(properties, "obscuration");
        if (StringUtils.hasText(obscurationRaw)) {
            item.put("obscuration", obscurationRaw);
        }
        String duration = textOrEmpty(properties, "duration");
        if (StringUtils.hasText(duration)) {
            item.put("duration", duration);
        }
        String totality = textOrEmpty(properties, "duration_of_totality");
        if (StringUtils.hasText(totality)) {
            item.put("durationOfTotality", totality);
        }
        if (begins != null) {
            item.put("begins", begins.toString());
        }
        if (maximum != null) {
            item.put("maximum", maximum.toString());
        }
        if (ends != null) {
            item.put("ends", ends.toString());
        }
        item.put("inProgress", inProgress);
        item.put("millisecondsUntil", msUntil);
        item.put("daysUntil", Math.max(0L, daysUntil));
        item.put("hoursUntil", msUntil / 3_600_000.0);
        return item;
    }

    private static String classifySolarVisibility(String description, JsonNode properties, Double magnitude) {
        String totality = textOrEmpty(properties, "duration_of_totality");
        String lower = description == null ? "" : description.toLowerCase(Locale.ROOT);
        if (StringUtils.hasText(totality) || lower.contains("total eclipse")) {
            return "total";
        }
        if (lower.contains("annular")) {
            return "annular";
        }
        if (lower.contains("partial")) {
            return "partial";
        }
        if (magnitude != null && magnitude >= 1.0) {
            return "total";
        }
        return "partial";
    }

    private Instant parseLocalPhenomenonInstant(JsonNode properties, LocalDate date, String phenomenon) {
        JsonNode localData = properties.path("local_data");
        if (!localData.isArray()) {
            return null;
        }
        for (JsonNode row : localData) {
            if (!phenomenon.equalsIgnoreCase(textOrEmpty(row, "phenomenon"))) {
                continue;
            }
            String time = textOrEmpty(row, "time");
            String dayText = textOrEmpty(row, "day");
            if (!StringUtils.hasText(time)) {
                return null;
            }
            LocalDate eventDate = date;
            if (StringUtils.hasText(dayText)) {
                try {
                    int day = Integer.parseInt(dayText.trim());
                    if (day >= 1 && day <= 31) {
                        eventDate = date.withDayOfMonth(Math.min(day, date.lengthOfMonth()));
                        // Eclipse can spill to next calendar day in UT.
                        if (day < date.getDayOfMonth() - 10) {
                            eventDate = date.plusMonths(1).withDayOfMonth(Math.min(day, date.plusMonths(1).lengthOfMonth()));
                        }
                    }
                } catch (NumberFormatException ignored) {
                    // keep date
                }
            }
            try {
                LocalTime localTime = LocalTime.parse(time.trim(), USNO_TIME);
                return OffsetDateTime.of(eventDate, localTime, ZoneOffset.UTC).toInstant();
            } catch (Exception e) {
                log.debug("Could not parse USNO phenomenon time '{}' on {}: {}", time, date, e.getMessage());
                return null;
            }
        }
        return null;
    }

    private JsonNode fetchUsnoLocalSoft(String date, double lat, double lon, int heightMeters) {
        String coords = String.format(Locale.ROOT, "%.6f,%.6f", lat, lon);
        String url = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(usnoApiBase) + "/eclipses/solar/date")
                .queryParam("date", toUsnoDate(date))
                .queryParam("coords", coords)
                .queryParam("height", heightMeters)
                .encode()
                .toUriString();
        return fetchJsonAllowClientError(url);
    }

    private static String toUsnoDate(String isoDate) {
        // USNO accepts both 2026-08-12 and 2026-8-12; keep ISO.
        return isoDate;
    }

    private static boolean hasUsnoError(JsonNode node) {
        return node != null && node.has("error") && StringUtils.hasText(node.path("error").asText());
    }

    private static Double parseDouble(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            return null;
        }
        if (value.isNumber()) {
            return value.asDouble();
        }
        try {
            return Double.parseDouble(value.asText().trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static Double parseObscurationPercent(JsonNode obscuration) {
        if (obscuration == null || obscuration.isNull()) {
            return null;
        }
        if (obscuration.isNumber()) {
            return obscuration.asDouble();
        }
        String text = obscuration.asText("");
        Matcher matcher = OBSCURATION_PERCENT.matcher(text);
        if (matcher.find()) {
            try {
                return Double.parseDouble(matcher.group(1));
            } catch (NumberFormatException e) {
                return null;
            }
        }
        try {
            return Double.parseDouble(text.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static String textOrEmpty(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            return "";
        }
        String text = value.asText("");
        return text == null ? "" : text;
    }

    private ObjectNode summarizeOpaleEclipse(JsonNode item) {
        // Keep useful scalar/object fields; still drop multi-MB GeoJSON paths.
        JsonNode slim = stripHeavyFields(item.deepCopy());
        ObjectNode summary = objectMapper.createObjectNode();
        if (slim instanceof ObjectNode objectNode) {
            summary.setAll(objectNode);
        }
        // Events: keep date + a few key scalars only (year list must stay light).
        JsonNode events = item.path("events");
        if (events.isObject()) {
            ObjectNode slimEvents = objectMapper.createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> fields = events.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                JsonNode ev = entry.getValue();
                ObjectNode slimEv = objectMapper.createObjectNode();
                if (ev.has("date")) {
                    slimEv.put("date", ev.get("date").asText());
                }
                if (ev.has("p") && !ev.get("p").isNull()) {
                    slimEv.set("p", ev.get("p"));
                }
                if (ev.has("zenith") && !ev.get("zenith").isNull()) {
                    slimEv.set("zenith", ev.get("zenith"));
                }
                slimEvents.set(entry.getKey(), slimEv);
            }
            summary.set("events", slimEvents);
        }
        return summary;
    }

    private ArrayNode slimOpaleList(JsonNode list) {
        ArrayNode out = objectMapper.createArrayNode();
        if (!list.isArray()) {
            return out;
        }
        for (JsonNode item : list) {
            out.add(stripHeavyFields(item.deepCopy()));
        }
        return out;
    }

    private JsonNode stripHeavyFields(JsonNode node) {
        if (node instanceof ObjectNode objectNode) {
            for (String field : OPALE_STRIP_FIELDS) {
                objectNode.remove(field);
            }
            Iterator<Map.Entry<String, JsonNode>> fields = objectNode.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                stripHeavyFields(entry.getValue());
            }
        } else if (node instanceof ArrayNode arrayNode) {
            for (JsonNode child : arrayNode) {
                stripHeavyFields(child);
            }
        }
        return node;
    }

    private JsonNode fetchJson(String url) {
        try {
            String body = restTemplate.getForObject(url, String.class);
            if (body == null || body.isBlank()) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (RestClientException e) {
            log.warn("Eclipse proxy fetch failed for {}: {}", url, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_unavailable");
        } catch (Exception e) {
            log.warn("Eclipse proxy parse failed for {}: {}", url, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_invalid");
        }
    }

    /** Like {@link #fetchJson} but returns upstream JSON error bodies (e.g. USNO 400 not visible). */
    private JsonNode fetchJsonAllowClientError(String url) {
        try {
            String body = restTemplate.getForObject(url, String.class);
            if (body == null || body.isBlank()) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            String body = e.getResponseBodyAsString();
            if (StringUtils.hasText(body)) {
                try {
                    return objectMapper.readTree(body);
                } catch (Exception parseEx) {
                    ObjectNode err = objectMapper.createObjectNode();
                    err.put("error", body);
                    return err;
                }
            }
            ObjectNode err = objectMapper.createObjectNode();
            err.put("error", "upstream_http_" + e.getStatusCode().value());
            return err;
        } catch (RestClientException e) {
            log.warn("Eclipse soft fetch failed for {}: {}", url, e.getMessage());
            ObjectNode err = objectMapper.createObjectNode();
            err.put("error", "upstream_unavailable");
            return err;
        } catch (Exception e) {
            log.warn("Eclipse soft parse failed for {}: {}", url, e.getMessage());
            ObjectNode err = objectMapper.createObjectNode();
            err.put("error", "upstream_invalid");
            return err;
        }
    }

    private static void validateBody(int body) {
        if (body != BODY_SUN && body != BODY_MOON) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_body");
        }
    }

    private static void validateYear(int year) {
        if (year < MIN_YEAR || year > MAX_YEAR) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_year");
        }
    }

    private static void validateDate(String date) {
        if (date == null || !date.matches("^\\d{4}-\\d{1,2}-\\d{1,2}$")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_date");
        }
        String[] parts = date.split("-");
        int year = Integer.parseInt(parts[0]);
        validateYear(year);
        int month = Integer.parseInt(parts[1]);
        int day = Integer.parseInt(parts[2]);
        if (month < 1 || month > 12 || day < 1 || day > 31) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_date");
        }
    }

    private static void validateCoords(double lat, double lon) {
        if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_coords");
        }
    }

    private static void copyText(JsonNode from, ObjectNode to, String field) {
        JsonNode value = from.get(field);
        if (value != null && !value.isNull()) {
            to.put(field, value.asText());
        }
    }

    private static String normalizeBase(String base) {
        if (base == null) {
            return "";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }
}
