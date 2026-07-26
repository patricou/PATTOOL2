package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArteProgramDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * ARTE replay / live via public EMAC v4 + Player v2 APIs (same surface as arte.tv).
 * <p>
 * Virtual stream URLs use {@code arte:122736-000-A} or {@code arte:LIVE}.
 * Catalog and stream resolution are proxied server-side (no browser CORS / tokens).
 */
@Service
public class ArteReplayService {

    private static final Logger log = LoggerFactory.getLogger(ArteReplayService.class);

    public static final String SCHEME_PREFIX = "arte:";

    private static final String EMAC_BASE = "https://api.arte.tv/api/emac/v4";
    private static final String PLAYER_BASE = "https://api.arte.tv/api/player/v2";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final String IMAGE_SIZE = "440x248";
    private static final Duration HLS_CACHE_TTL = Duration.ofMinutes(8);
    private static final Duration PAGE_CACHE_TTL = Duration.ofMinutes(3);
    private static final int MAX_PAGE = 20;
    private static final Pattern PROGRAM_ID = Pattern.compile("(?i)^(?:LIVE|\\d{6}-\\d{3}-[AF])$");

    private static final Set<String> LANGS = Set.of("fr", "de", "en", "es", "it", "pl", "ro");

    /** Curated sections exposed in the TV watcher ARTE tab. */
    private static final Map<String, String> SECTIONS = new LinkedHashMap<>();

    static {
        SECTIONS.put("MOST_RECENT", "Plus récentes");
        SECTIONS.put("MOST_VIEWED", "Plus vues");
        SECTIONS.put("LAST_CHANCE", "Dernière chance");
        SECTIONS.put("ACT", "Info & société");
        SECTIONS.put("DOR", "Documentaires");
        SECTIONS.put("SER", "Séries");
        SECTIONS.put("CIN", "Cinéma");
        SECTIONS.put("CPO", "Culture & pop");
        SECTIONS.put("HIS", "Histoire");
        SECTIONS.put("SCI", "Sciences");
        SECTIONS.put("DEC", "Découverte");
        SECTIONS.put("EMI", "Émissions");
        SECTIONS.put("ARTE_CONCERT", "Concerts");
        SECTIONS.put("MAGAZINES", "Émissions A-Z");
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> hlsCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedPage> pageCache = new ConcurrentHashMap<>();

    public ArteReplayService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public static boolean isVirtualUrl(String url) {
        return url != null && url.regionMatches(true, 0, SCHEME_PREFIX, 0, SCHEME_PREFIX.length());
    }

    public static Optional<String> programIdFromVirtualUrl(String url) {
        if (!isVirtualUrl(url)) {
            return Optional.empty();
        }
        String id = url.substring(SCHEME_PREFIX.length()).trim();
        if (id.isEmpty() || !PROGRAM_ID.matcher(id).matches()) {
            return Optional.empty();
        }
        return Optional.of(id.toUpperCase(Locale.ROOT).startsWith("LIVE") ? "LIVE" : id);
    }

    public static String virtualUrl(String programId) {
        return SCHEME_PREFIX + programId;
    }

    public Map<String, String> sections() {
        return SECTIONS;
    }

    public String normalizeLang(String lang) {
        if (!StringUtils.hasText(lang)) {
            return "fr";
        }
        String code = lang.trim().toLowerCase(Locale.ROOT);
        return LANGS.contains(code) ? code : "fr";
    }

    public String normalizeSection(String section) {
        if (!StringUtils.hasText(section)) {
            return "MOST_RECENT";
        }
        String code = section.trim().toUpperCase(Locale.ROOT);
        return SECTIONS.containsKey(code) ? code : "MOST_RECENT";
    }

    public boolean isValidProgramId(String programId) {
        return StringUtils.hasText(programId) && PROGRAM_ID.matcher(programId.trim()).matches();
    }

    /**
     * List playable ARTE programs for a section or search query.
     */
    public ArteCatalogResult listPrograms(String lang, String section, String query, int page) {
        String language = normalizeLang(lang);
        int safePage = Math.max(1, Math.min(page <= 0 ? 1 : page, MAX_PAGE));
        String q = query != null ? query.trim() : "";

        List<ArteProgramDto> programs = new ArrayList<>();
        if (safePage == 1 && q.length() < 2) {
            programs.add(liveTeaser(language));
        }

        JsonNode pageJson;
        if (q.length() >= 2) {
            pageJson = fetchEmacPage(language, "SEARCH", Map.of("query", q, "page", String.valueOf(safePage)));
        } else {
            String sec = normalizeSection(section);
            pageJson = fetchEmacPage(language, sec, Map.of("page", String.valueOf(safePage)));
        }

        int total = 0;
        int pages = 1;
        if (pageJson != null) {
            ListingExtract extract = extractPrograms(pageJson, language);
            for (ArteProgramDto p : extract.programs()) {
                if (programs.stream().noneMatch(x -> p.getProgramId().equalsIgnoreCase(x.getProgramId()))) {
                    programs.add(p);
                }
            }
            total = Math.max(extract.totalCount(), programs.size());
            pages = Math.max(1, extract.pages());
        }
        if (programs.size() > 120) {
            programs = new ArrayList<>(programs.subList(0, 120));
        }

        return new ArteCatalogResult(language, q.length() >= 2 ? "SEARCH" : normalizeSection(section),
                safePage, pages, total, programs);
    }

    public Optional<String> resolveHlsUrl(String programId, String lang) {
        return resolveHlsUrl(programId, lang, false);
    }

    public Optional<String> resolveHlsUrl(String programId, String lang, boolean forceRefresh) {
        if (!isValidProgramId(programId)) {
            return Optional.empty();
        }
        String id = "LIVE".equalsIgnoreCase(programId.trim()) ? "LIVE" : programId.trim();
        String language = normalizeLang(lang);
        String cacheKey = language + "|" + id;
        Instant now = Instant.now();
        if (!forceRefresh) {
            CachedUrl cached = hlsCache.get(cacheKey);
            if (cached != null && cached.expiresAt.isAfter(now)) {
                return Optional.of(cached.url);
            }
        } else {
            hlsCache.remove(cacheKey);
        }
        try {
            Optional<String> hls = fetchPlayerHls(id, language);
            if (hls.isPresent() && StringUtils.hasText(hls.get())) {
                hlsCache.put(cacheKey, new CachedUrl(hls.get(), now.plus(HLS_CACHE_TTL)));
                return hls;
            }
        } catch (Exception e) {
            log.debug("ARTE resolve failed for {}/{}: {}", language, id, e.getMessage());
        }
        return Optional.empty();
    }

    public void invalidate(String programId, String lang) {
        if (!isValidProgramId(programId)) {
            return;
        }
        String id = "LIVE".equalsIgnoreCase(programId.trim()) ? "LIVE" : programId.trim();
        hlsCache.remove(normalizeLang(lang) + "|" + id);
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        return resolveVirtualOrPassthrough(url, false);
    }

    public Optional<String> resolveVirtualOrPassthrough(String url, boolean forceRefresh) {
        Optional<String> programId = programIdFromVirtualUrl(url);
        if (programId.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveHlsUrl(programId.get(), "fr", forceRefresh);
    }

    private ArteProgramDto liveTeaser(String language) {
        ArteProgramDto dto = new ArteProgramDto();
        dto.setId("arte-LIVE");
        dto.setProgramId("LIVE");
        dto.setTitle("ARTE — Direct");
        dto.setSubtitle("Live");
        dto.setDescription("Direct ARTE (français / allemand selon le flux).");
        dto.setImageUrl("https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Arte_Logo_2017.svg/512px-Arte_Logo_2017.svg.png");
        dto.setDurationLabel("LIVE");
        dto.setKind("LIVE");
        dto.setGenre("Direct");
        dto.setWebpageUrl("https://www.arte.tv/" + language + "/");
        dto.setStreamUrl(virtualUrl("LIVE"));
        dto.setLive(true);
        dto.setPlayable(true);
        return dto;
    }

    private ListingExtract extractPrograms(JsonNode pageJson, String language) {
        List<ArteProgramDto> out = new ArrayList<>();
        int total = 0;
        int pages = 1;
        JsonNode zones = pageJson.path("zones");
        if (!zones.isArray()) {
            return new ListingExtract(out, 0, 1);
        }
        for (JsonNode zone : zones) {
            String zoneCode = zone.path("code").asText("");
            // Skip boutique / chatbot / event teasers
            if (zoneCode.toLowerCase(Locale.ROOT).contains("boutique")
                    || zoneCode.toLowerCase(Locale.ROOT).contains("chatbot")
                    || zoneCode.toLowerCase(Locale.ROOT).contains("newsletter")) {
                continue;
            }
            JsonNode content = zone.path("content");
            JsonNode pagination = content.path("pagination");
            if (pagination.isObject()) {
                total = Math.max(total, pagination.path("totalCount").asInt(0));
                pages = Math.max(pages, pagination.path("pages").asInt(1));
            }
            JsonNode data = content.path("data");
            if (!data.isArray()) {
                continue;
            }
            for (JsonNode item : data) {
                toProgram(item, language).ifPresent(out::add);
            }
        }
        return new ListingExtract(out, total, pages);
    }

    private Optional<ArteProgramDto> toProgram(JsonNode item, String language) {
        if (item == null || item.isMissingNode()) {
            return Optional.empty();
        }
        String kind = item.path("kind").path("code").asText("");
        String deeplink = item.path("deeplink").asText("");
        String programId = extractProgramId(item, deeplink);
        if (!StringUtils.hasText(programId) || !isValidProgramId(programId)) {
            return Optional.empty();
        }
        // Skip collections / seasons — only playable programs
        if ("TV_SERIES".equals(kind) || "COLLECTION".equals(kind) || "SEASON".equals(kind)
                || deeplink.startsWith("arte://collection/")) {
            return Optional.empty();
        }
        boolean hasStreams = item.path("availability").path("hasVideoStreams").asBoolean(false);
        boolean playableSticker = false;
        JsonNode stickers = item.path("stickers");
        if (stickers.isArray()) {
            for (JsonNode s : stickers) {
                String code = s.path("code").asText("");
                if ("PLAYABLE".equals(code) || "FULL_VIDEO".equals(code)) {
                    playableSticker = true;
                }
            }
        }
        if (!hasStreams && !playableSticker && !"SHOW".equals(kind) && !"BONUS".equals(kind)) {
            return Optional.empty();
        }

        ArteProgramDto dto = new ArteProgramDto();
        dto.setId("arte-" + programId);
        dto.setProgramId(programId);
        dto.setTitle(textOrNull(item.path("title")));
        dto.setSubtitle(textOrNull(item.path("subtitle")));
        dto.setDescription(textOrNull(item.path("shortDescription")));
        dto.setImageUrl(resolveImage(item.path("mainImage").path("url").asText(null)));
        dto.setDurationLabel(textOrNull(item.path("durationLabel")));
        if (item.path("duration").isNumber()) {
            dto.setDurationSec(item.path("duration").asInt());
        }
        JsonNode avail = item.path("availability");
        if (avail.isObject()) {
            dto.setAvailabilityLabel(textOrNull(avail.path("label")));
            if (avail.path("remainingDays").isNumber()) {
                dto.setRemainingDays(avail.path("remainingDays").asInt());
            }
        }
        dto.setKind(StringUtils.hasText(kind) ? kind : "SHOW");
        JsonNode genre = item.path("genre");
        if (genre.isObject()) {
            dto.setGenre(textOrNull(genre.path("label")));
        } else {
            dto.setGenre(textOrNull(item.path("teaserText")));
        }
        String url = textOrNull(item.path("url"));
        dto.setWebpageUrl(url != null ? url : "https://www.arte.tv/" + language + "/videos/" + programId + "/");
        dto.setStreamUrl(virtualUrl(programId));
        dto.setLive(false);
        dto.setPlayable(true);
        if (!StringUtils.hasText(dto.getTitle())) {
            return Optional.empty();
        }
        return Optional.of(dto);
    }

    private static String extractProgramId(JsonNode item, String deeplink) {
        String fromField = item.path("programId").asText(null);
        if (StringUtils.hasText(fromField) && PROGRAM_ID.matcher(fromField).matches()) {
            return fromField;
        }
        if (StringUtils.hasText(deeplink) && deeplink.startsWith("arte://program/")) {
            String id = deeplink.substring("arte://program/".length()).trim();
            if (PROGRAM_ID.matcher(id).matches()) {
                return id;
            }
        }
        String tracking = item.path("trackingPixel").asText("");
        int em = tracking.indexOf("em=");
        if (em >= 0) {
            String rest = tracking.substring(em + 3);
            int amp = rest.indexOf('&');
            String id = (amp >= 0 ? rest.substring(0, amp) : rest).trim();
            if (PROGRAM_ID.matcher(id).matches()) {
                return id;
            }
        }
        return null;
    }

    private static String resolveImage(String template) {
        if (!StringUtils.hasText(template)) {
            return null;
        }
        return template.replace("__SIZE__", IMAGE_SIZE);
    }

    private static String textOrNull(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        String v = node.asText(null);
        return StringUtils.hasText(v) ? v.trim() : null;
    }

    private JsonNode fetchEmacPage(String language, String pageCode, Map<String, String> query) {
        StringBuilder url = new StringBuilder(EMAC_BASE)
                .append('/').append(language)
                .append("/web/pages/")
                .append(pageCode)
                .append('/');
        if (query != null && !query.isEmpty()) {
            boolean first = true;
            for (Map.Entry<String, String> e : query.entrySet()) {
                url.append(first ? '?' : '&').append(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8))
                        .append('=').append(URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8));
                first = false;
            }
        }
        String cacheKey = url.toString();
        Instant now = Instant.now();
        CachedPage cached = pageCache.get(cacheKey);
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.json;
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(cacheKey))
                    .timeout(Duration.ofSeconds(20))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .header("Origin", "https://www.arte.tv")
                    .header("Referer", "https://www.arte.tv/")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
                log.debug("ARTE EMAC {} -> HTTP {}", cacheKey, response.statusCode());
                return null;
            }
            JsonNode json = objectMapper.readTree(response.body());
            pageCache.put(cacheKey, new CachedPage(json, now.plus(PAGE_CACHE_TTL)));
            return json;
        } catch (Exception e) {
            log.debug("ARTE EMAC fetch failed {}: {}", cacheKey, e.getMessage());
            return null;
        }
    }

    private Optional<String> fetchPlayerHls(String programId, String language) throws Exception {
        String url = PLAYER_BASE + "/config/" + language + "/" + programId;
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .header("Origin", "https://www.arte.tv")
                .header("Referer", "https://www.arte.tv/")
                .header("x-validated-age", "18")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
            log.debug("ARTE player {} -> HTTP {}", url, response.statusCode());
            return Optional.empty();
        }
        JsonNode root = objectMapper.readTree(response.body());
        JsonNode attrs = root.path("data").path("attributes");
        if (!attrs.path("rights").isObject() || attrs.path("rights").isEmpty()) {
            return Optional.empty();
        }
        JsonNode streams = attrs.path("streams");
        if (!streams.isArray() || streams.isEmpty()) {
            return Optional.empty();
        }
        return pickBestHls(streams, language);
    }

    private Optional<String> pickBestHls(JsonNode streams, String language) {
        String preferred = preferredVoiceHint(language);
        JsonNode best = null;
        int bestScore = Integer.MIN_VALUE;
        for (JsonNode stream : streams) {
            String protocol = stream.path("protocol").asText("");
            String streamUrl = stream.path("url").asText("");
            if (!StringUtils.hasText(streamUrl)) {
                continue;
            }
            boolean hls = protocol.toUpperCase(Locale.ROOT).contains("HLS");
            if (!hls && !streamUrl.contains(".m3u8") && !streamUrl.contains("/manifest/")) {
                continue;
            }
            JsonNode versions = stream.path("versions");
            JsonNode version = versions.isArray() && !versions.isEmpty() ? versions.get(0) : null;
            String label = version != null ? version.path("label").asText("") : "";
            String shortLabel = version != null ? version.path("shortLabel").asText("") : "";
            String ml5 = version != null ? version.path("eStat").path("ml5").asText("") : "";
            int score = 0;
            if (hls || streamUrl.contains("/manifest/")) {
                score += 100;
            }
            String blob = (label + " " + shortLabel + " " + ml5).toLowerCase(Locale.ROOT);
            if (preferred != null && blob.contains(preferred)) {
                score += 50;
            }
            if (blob.contains("audio desc") || blob.contains("audiodesc") || blob.contains("ad ")
                    || ml5.toUpperCase(Locale.ROOT).contains("AUD")) {
                score -= 40;
            }
            if ("LIVE".equalsIgnoreCase(shortLabel) || blob.contains("direct")) {
                score += 10;
            }
            // Prefer VF / original French for fr
            if ("fr".equals(language) && (blob.contains("vf") || blob.contains("français") || blob.contains("francais"))) {
                score += 20;
            }
            if ("de".equals(language) && (blob.contains("va") || blob.contains("deutsch") || blob.contains("allemand"))) {
                score += 20;
            }
            if (score > bestScore) {
                bestScore = score;
                best = stream;
            }
        }
        if (best == null) {
            // Fallback: first stream URL
            for (JsonNode stream : streams) {
                String streamUrl = stream.path("url").asText("");
                if (StringUtils.hasText(streamUrl)) {
                    return Optional.of(streamUrl);
                }
            }
            return Optional.empty();
        }
        return Optional.of(best.path("url").asText());
    }

    private static String preferredVoiceHint(String language) {
        return switch (language) {
            case "fr" -> "fr";
            case "de" -> "de";
            case "en" -> "en";
            case "es" -> "es";
            case "it" -> "it";
            case "pl" -> "pl";
            default -> null;
        };
    }

    public record ArteCatalogResult(
            String language,
            String section,
            int page,
            int pages,
            int total,
            List<ArteProgramDto> programs
    ) {
    }

    private record ListingExtract(List<ArteProgramDto> programs, int totalCount, int pages) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedPage(JsonNode json, Instant expiresAt) {
    }
}
