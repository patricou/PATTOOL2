package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.IaProgramDto;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Internet Archive feature films via the public Advanced Search + Metadata APIs.
 * <p>
 * Virtual stream URLs use {@code ia:his_girl_friday}. Streams are progressive MP4
 * (not HLS); resolved HTTPS download URLs are returned for direct or proxied play.
 */
@Service
public class InternetArchiveReplayService {

    private static final Logger log = LoggerFactory.getLogger(InternetArchiveReplayService.class);

    public static final String SCHEME_PREFIX = "ia:";

    private static final String SEARCH_URL = "https://archive.org/advancedsearch.php";
    private static final String METADATA_BASE = "https://archive.org/metadata/";
    private static final String DETAILS_BASE = "https://archive.org/details/";
    private static final String DOWNLOAD_BASE = "https://archive.org/download/";
    private static final String IMAGE_BASE = "https://archive.org/services/img/";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final Duration STREAM_CACHE_TTL = Duration.ofMinutes(30);
    /** Listing pages: aligned with TV/radio catalog warm TTL (~60 min). */
    private static final Duration PAGE_CACHE_TTL = Duration.ofMinutes(60);
    /** Items per listing page (Archive.org Advanced Search {@code rows}). */
    private static final int ROWS_PER_PAGE = 50;
    private static final Pattern IDENTIFIER = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$");

    /** Curated collections / sorts for the TV watcher Archive.org tab. */
    private static final Map<String, SectionDef> SECTIONS = new LinkedHashMap<>();

    static {
        SECTIONS.put("RECENT", new SectionDef(
                "Ajouts récents",
                "mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "publicdate desc"));
        SECTIONS.put("FEATURE_FILMS", new SectionDef(
                "Films (feature films)",
                "collection:feature_films AND mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        SECTIONS.put("CLASSIC_FILMS", new SectionDef(
                "Classiques",
                "collection:classic_films AND mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        SECTIONS.put("FILM_NOIR", new SectionDef(
                "Film noir",
                "collection:Film_Noir AND mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        SECTIONS.put("SCIFI_HORROR", new SectionDef(
                "SF & horreur",
                "collection:SciFi_Horror AND mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        SECTIONS.put("SILENT", new SectionDef(
                "Films muets",
                "collection:silent_films AND mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        SECTIONS.put("MOST_DOWNLOADED", new SectionDef(
                "Les plus téléchargés",
                "mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final ConcurrentHashMap<String, CachedUrl> streamCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedPage> pageCache = new ConcurrentHashMap<>();

    public InternetArchiveReplayService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public static boolean isVirtualUrl(String url) {
        return url != null && url.regionMatches(true, 0, SCHEME_PREFIX, 0, SCHEME_PREFIX.length());
    }

    public static Optional<String> identifierFromVirtualUrl(String url) {
        if (!isVirtualUrl(url)) {
            return Optional.empty();
        }
        String id = url.substring(SCHEME_PREFIX.length()).trim();
        if (id.isEmpty() || !IDENTIFIER.matcher(id).matches()) {
            return Optional.empty();
        }
        return Optional.of(id);
    }

    public static String virtualUrl(String identifier) {
        return SCHEME_PREFIX + identifier;
    }

    public Map<String, String> sections() {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, SectionDef> e : SECTIONS.entrySet()) {
            out.put(e.getKey(), e.getValue().label());
        }
        return out;
    }

    /**
     * Prefetch curated section pages (page 1) into {@link #pageCache} for the media catalog warm.
     * Also warms the French-language RECENT listing used by the global country filter.
     */
    public void warmCatalog() {
        int ok = 0;
        for (String section : SECTIONS.keySet()) {
            try {
                listPrograms(section, "", 1, null);
                ok++;
            } catch (Exception e) {
                log.warn("IA warm section {} failed: {}", section, e.toString());
            }
        }
        try {
            listPrograms("RECENT", "", 1, "fr");
            ok++;
        } catch (Exception e) {
            log.warn("IA warm RECENT/fr failed: {}", e.toString());
        }
        log.info("IA catalog warm finished ({} listings cached, pageCacheSize={})", ok, pageCache.size());
    }

    public Map<String, Object> cacheStats() {
        Instant now = Instant.now();
        int pageEntries = 0;
        int cachedDocs = 0;
        long maxNumFound = 0;
        for (CachedPage cached : pageCache.values()) {
            if (cached == null || cached.json == null) {
                continue;
            }
            if (cached.expiresAt != null && cached.expiresAt.isBefore(now)) {
                continue;
            }
            pageEntries++;
            long found = cached.json.path("numFound").asLong(0);
            if (found > maxNumFound) {
                maxNumFound = found;
            }
            JsonNode docs = cached.json.path("docs");
            if (docs.isArray()) {
                cachedDocs += docs.size();
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("iaPageCacheEntries", pageCache.size());
        out.put("iaStreamCacheEntries", streamCache.size());
        out.put("iaCachedPageEntries", pageEntries);
        out.put("iaCachedDocs", cachedDocs);
        out.put("iaMaxNumFound", maxNumFound);
        // Prefer upstream total from last cached searches (e.g. ~16M movies); else docs in memory.
        out.put("iaRecordCount", maxNumFound > 0 ? maxNumFound : cachedDocs);
        return out;
    }

    public String normalizeSection(String section) {
        if (!StringUtils.hasText(section)) {
            return "RECENT";
        }
        String code = section.trim().toUpperCase(Locale.ROOT);
        return SECTIONS.containsKey(code) ? code : "RECENT";
    }

    public boolean isValidIdentifier(String identifier) {
        return StringUtils.hasText(identifier) && IDENTIFIER.matcher(identifier.trim()).matches();
    }

    public IaCatalogResult listPrograms(String section, String query, int page) {
        return listPrograms(section, query, page, null);
    }

    public IaCatalogResult listPrograms(String section, String query, int page, String country) {
        int requestedPage = Math.max(1, page <= 0 ? 1 : page);
        String q = query != null ? query.trim() : "";
        String sectionCode;
        String lucene;
        String sort;
        if (q.length() >= 2) {
            sectionCode = "SEARCH";
            String escaped = escapeLucene(q);
            lucene = "mediatype:movies AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\") AND ("
                    + "title:(" + escaped + ") OR description:(" + escaped + ") OR creator:(" + escaped + ")"
                    + " OR identifier:(" + escaped + "))";
            sort = "downloads desc";
        } else {
            sectionCode = normalizeSection(section);
            SectionDef def = SECTIONS.get(sectionCode);
            lucene = def.query();
            sort = def.sort();
        }
        String languageClause = languageClauseForCountry(country);
        if (StringUtils.hasText(languageClause)) {
            lucene = "(" + lucene + ") AND (" + languageClause + ")";
        }

        JsonNode response = fetchSearchPage(lucene, sort, requestedPage);
        int total = 0;
        int pages = 1;
        if (response != null) {
            total = Math.max(0, response.path("numFound").asInt(0));
            pages = Math.max(1, (int) Math.ceil(total / (double) ROWS_PER_PAGE));
        }
        int safePage = Math.min(requestedPage, pages);
        if (safePage != requestedPage) {
            response = fetchSearchPage(lucene, sort, safePage);
        }

        List<IaProgramDto> programs = new ArrayList<>();
        if (response != null) {
            JsonNode docs = response.path("docs");
            if (docs.isArray()) {
                for (JsonNode doc : docs) {
                    toProgram(doc).ifPresent(programs::add);
                }
            }
        }
        return new IaCatalogResult(sectionCode, safePage, pages, ROWS_PER_PAGE, total, programs);
    }

    /**
     * Map ISO country codes from the TV catalog filter to Archive.org {@code language:} Lucene clauses.
     * {@code all} / unknown → no language restriction.
     */
    static String languageClauseForCountry(String country) {
        if (!StringUtils.hasText(country)) {
            return null;
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        if ("all".equals(code) || "*".equals(code)) {
            return null;
        }
        return switch (code) {
            case "fr" -> "language:(fra OR fre OR french OR français OR francais)";
            case "be" -> "language:(fra OR fre OR french OR français OR dut OR nld OR dutch OR belgian)";
            case "ch" -> "language:(fra OR fre OR french OR ger OR deu OR german OR ita OR italian)";
            case "de", "at" -> "language:(ger OR deu OR german OR deutsch)";
            case "es", "mx", "ar", "cl", "co", "pe", "ve" -> "language:(spa OR spanish OR español OR espanol OR castellano)";
            case "it" -> "language:(ita OR italian OR italiano)";
            case "pt", "br" -> "language:(por OR portuguese OR português OR portugues)";
            case "en", "gb", "uk", "us", "au", "nz", "ie", "ca" -> "language:(eng OR english)";
            case "ru" -> "language:(rus OR russian)";
            case "jp" -> "language:(jpn OR japanese)";
            case "cn", "tw", "hk" -> "language:(chi OR zho OR chinese OR cmn)";
            case "sa", "eg", "ma", "dz", "tn", "ae", "qa", "kw" -> "language:(ara OR arabic)";
            case "in" -> "language:(hin OR hindi OR eng OR english OR tam OR tel OR ben)";
            case "nl" -> "language:(dut OR nld OR dutch OR flemish)";
            case "pl" -> "language:(pol OR polish)";
            case "el", "gr" -> "language:(gre OR ell OR greek)";
            case "he", "il" -> "language:(heb OR hebrew)";
            case "se" -> "language:(swe OR swedish)";
            case "no" -> "language:(nor OR norwegian)";
            case "dk" -> "language:(dan OR danish)";
            case "fi" -> "language:(fin OR finnish)";
            case "tr" -> "language:(tur OR turkish)";
            case "ro" -> "language:(rum OR ron OR romanian)";
            case "cz", "cs" -> "language:(cze OR ces OR czech)";
            case "hu" -> "language:(hun OR hungarian)";
            case "kr" -> "language:(kor OR korean)";
            case "th" -> "language:(tha OR thai)";
            case "vn" -> "language:(vie OR vietnamese)";
            case "id" -> "language:(ind OR indonesian)";
            case "ua" -> "language:(ukr OR ukrainian)";
            default -> null;
        };
    }

    public Optional<String> resolveStreamUrl(String identifier) {
        return resolveStreamUrl(identifier, false);
    }

    public Optional<String> resolveStreamUrl(String identifier, boolean forceRefresh) {
        if (!isValidIdentifier(identifier)) {
            return Optional.empty();
        }
        String id = identifier.trim();
        Instant now = Instant.now();
        if (!forceRefresh) {
            CachedUrl cached = streamCache.get(id);
            if (cached != null && cached.expiresAt.isAfter(now)) {
                return Optional.of(cached.url);
            }
        } else {
            streamCache.remove(id);
        }
        try {
            Optional<String> stream = fetchBestStream(id);
            if (stream.isPresent() && StringUtils.hasText(stream.get())) {
                streamCache.put(id, new CachedUrl(stream.get(), now.plus(STREAM_CACHE_TTL)));
                return stream;
            }
        } catch (Exception e) {
            log.debug("Internet Archive resolve failed for {}: {}", id, e.getMessage());
        }
        return Optional.empty();
    }

    public void invalidate(String identifier) {
        if (!isValidIdentifier(identifier)) {
            return;
        }
        streamCache.remove(identifier.trim());
    }

    public int invalidateAll() {
        int n = pageCache.size() + streamCache.size();
        pageCache.clear();
        streamCache.clear();
        return n;
    }

    public Optional<String> resolveVirtualOrPassthrough(String url) {
        return resolveVirtualOrPassthrough(url, false);
    }

    public Optional<String> resolveVirtualOrPassthrough(String url, boolean forceRefresh) {
        Optional<String> id = identifierFromVirtualUrl(url);
        if (id.isEmpty()) {
            return Optional.ofNullable(url);
        }
        return resolveStreamUrl(id.get(), forceRefresh);
    }

    private Optional<IaProgramDto> toProgram(JsonNode doc) {
        if (doc == null || doc.isMissingNode()) {
            return Optional.empty();
        }
        String identifier = textOrNull(doc.path("identifier"));
        if (!isValidIdentifier(identifier)) {
            return Optional.empty();
        }
        String title = textOrNull(doc.path("title"));
        if (!StringUtils.hasText(title)) {
            title = identifier;
        }
        IaProgramDto dto = new IaProgramDto();
        dto.setId("ia-" + identifier);
        dto.setProgramId(identifier);
        dto.setTitle(title);
        String year = firstText(doc.path("year"));
        String creator = firstText(doc.path("creator"));
        dto.setSubtitle(joinNonEmpty(" · ", year, creator));
        dto.setDescription(firstText(doc.path("description")));
        dto.setImageUrl(IMAGE_BASE + identifier);
        String runtime = firstText(doc.path("runtime"));
        dto.setDurationLabel(runtime);
        dto.setDurationSec(parseRuntimeSec(runtime));
        dto.setKind("MOVIE");
        dto.setGenre(firstText(doc.path("subject")));
        dto.setWebpageUrl(DETAILS_BASE + identifier);
        dto.setStreamUrl(virtualUrl(identifier));
        dto.setPlayable(true);
        return Optional.of(dto);
    }

    private Optional<String> fetchBestStream(String identifier) throws Exception {
        String url = METADATA_BASE + URLEncoder.encode(identifier, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(25))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
            log.debug("IA metadata {} -> HTTP {}", identifier, response.statusCode());
            return Optional.empty();
        }
        JsonNode root = objectMapper.readTree(response.body());
        if (root.path("is_dark").asBoolean(false)) {
            return Optional.empty();
        }
        JsonNode files = root.path("files");
        if (!files.isArray() || files.isEmpty()) {
            return Optional.empty();
        }
        JsonNode best = null;
        int bestScore = Integer.MIN_VALUE;
        for (JsonNode file : files) {
            int score = scoreVideoFile(file);
            if (score > bestScore) {
                bestScore = score;
                best = file;
            }
        }
        if (best == null || bestScore < 50) {
            return Optional.empty();
        }
        String name = textOrNull(best.path("name"));
        if (!StringUtils.hasText(name)) {
            return Optional.empty();
        }
        return Optional.of(DOWNLOAD_BASE + identifier + "/" + encodePathSegment(name));
    }

    private static int scoreVideoFile(JsonNode file) {
        String name = textOrNull(file.path("name"));
        if (!StringUtils.hasText(name)) {
            return Integer.MIN_VALUE;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        String format = Optional.ofNullable(textOrNull(file.path("format"))).orElse("").toLowerCase(Locale.ROOT);
        if (lower.endsWith(".torrent") || lower.contains("_files.xml") || lower.endsWith(".xml")
                || lower.endsWith(".sqlite") || lower.endsWith(".jpg") || lower.endsWith(".png")
                || lower.endsWith(".gif") || lower.endsWith(".vtt") || lower.endsWith(".srt")
                || lower.endsWith(".txt") || lower.endsWith(".pdf")) {
            return Integer.MIN_VALUE;
        }
        boolean mp4 = lower.endsWith(".mp4");
        boolean m3u8 = lower.endsWith(".m3u8");
        boolean ogv = lower.endsWith(".ogv") || lower.endsWith(".ogg");
        boolean webm = lower.endsWith(".webm");
        boolean mpeg2 = lower.endsWith(".mpeg") || lower.endsWith(".mpg") || format.contains("mpeg2");
        if (!mp4 && !m3u8 && !ogv && !webm && !format.contains("mpeg4") && !format.contains("h.264")
                && !format.contains("512kb") && !format.contains("ogg video")) {
            return Integer.MIN_VALUE;
        }
        if (mpeg2 && !mp4) {
            return 10;
        }
        int score = 0;
        if (mp4) {
            score += 100;
        }
        if (m3u8) {
            score += 90;
        }
        if (format.contains("512kb")) {
            score += 40;
        }
        if (format.contains("h.264")) {
            score += 30;
        }
        if (format.contains("mpeg4")) {
            score += 20;
        }
        if (webm) {
            score += 50;
        }
        if (ogv) {
            score += 25;
        }
        // Skip extras / trailers / sample clips — prefer the main feature.
        if (lower.contains("/bonus/") || lower.contains("/extras/") || lower.contains("/sample")
                || lower.contains("trailer") || lower.contains("/preview") || lower.contains("teaser")) {
            score -= 120;
        }
        long size = file.path("size").asLong(0);
        // Feature-length streams: prefer ~80–900 MB; tiny files are usually extras.
        if (size > 0 && size < 20_000_000L) {
            score -= 50;
        } else if (size > 0 && size < 80_000_000L) {
            score -= 10;
        } else if (size >= 80_000_000L && size <= 900_000_000L) {
            score += 35;
        } else if (size > 900_000_000L && size <= 1_800_000_000L) {
            score += 10;
        } else if (size > 1_800_000_000L) {
            score -= 40;
        }
        int height = file.path("height").asInt(0);
        if (height >= 360 && height <= 720) {
            score += 20;
        } else if (height > 720 && height <= 1080) {
            score += 10;
        } else if (height > 0 && height < 240) {
            score -= 10;
        }
        if (lower.contains("512kb")) {
            score += 15;
        }
        if (lower.contains(".ia.") || lower.contains("_dash") || lower.contains("thumb")) {
            score -= 30;
        }
        // Fewer path segments ≈ main item file.
        int depth = 0;
        for (int i = 0; i < name.length(); i++) {
            if (name.charAt(i) == '/') {
                depth++;
            }
        }
        if (depth == 0) {
            score += 25;
        } else if (depth == 1) {
            score += 10;
        } else if (depth >= 3) {
            score -= 20;
        }
        return score;
    }

    private JsonNode fetchSearchPage(String lucene, String sort, int page) {
        StringBuilder url = new StringBuilder(SEARCH_URL)
                .append("?q=").append(URLEncoder.encode(lucene, StandardCharsets.UTF_8))
                .append("&fl[]=identifier&fl[]=title&fl[]=description&fl[]=year&fl[]=runtime")
                .append("&fl[]=creator&fl[]=subject&fl[]=avg_rating&fl[]=downloads")
                .append("&sort[]=").append(URLEncoder.encode(sort, StandardCharsets.UTF_8))
                .append("&rows=").append(ROWS_PER_PAGE)
                .append("&page=").append(page)
                .append("&output=json");
        String cacheKey = url.toString();
        Instant now = Instant.now();
        CachedPage cached = pageCache.get(cacheKey);
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.json;
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(cacheKey))
                    .timeout(Duration.ofSeconds(25))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
                log.debug("IA search HTTP {}", response.statusCode());
                return null;
            }
            JsonNode root = objectMapper.readTree(response.body());
            JsonNode resp = root.path("response");
            if (!resp.isObject()) {
                return null;
            }
            pageCache.put(cacheKey, new CachedPage(resp, now.plus(PAGE_CACHE_TTL)));
            return resp;
        } catch (Exception e) {
            log.debug("IA search failed: {}", e.getMessage());
            return null;
        }
    }

    private static String encodePathSegment(String name) {
        // Keep path separators out; encode spaces and reserved chars but preserve structure archive.org expects.
        String[] parts = name.split("/");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) {
                out.append('/');
            }
            out.append(URLEncoder.encode(parts[i], StandardCharsets.UTF_8).replace("+", "%20"));
        }
        return out.toString();
    }

    private static String escapeLucene(String raw) {
        String trimmed = raw.trim();
        if (trimmed.length() > 120) {
            trimmed = trimmed.substring(0, 120);
        }
        // IA tokenizes on hyphens; escaping "-" as \- looks for a literal token that
        // is never indexed (e.g. "jean-luc godard" → 0 hits). Treat "-" as a space.
        String normalized = trimmed.replace('-', ' ').replaceAll("\\s+", " ").trim();
        return normalized.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace(":", "\\:")
                .replace("(", "\\(")
                .replace(")", "\\)")
                .replace("[", "\\[")
                .replace("]", "\\]")
                .replace("{", "\\{")
                .replace("}", "\\}")
                .replace("+", "\\+")
                .replace("!", "\\!")
                .replace("^", "\\^")
                .replace("~", "\\~")
                .replace("*", "\\*")
                .replace("?", "\\?")
                .replace("|", "\\|")
                .replace("&", "\\&");
    }

    private static Integer parseRuntimeSec(String runtime) {
        if (!StringUtils.hasText(runtime)) {
            return null;
        }
        String s = runtime.trim();
        // "1:31:44" or "91 min" or "20:33"
        if (s.matches("\\d{1,2}:\\d{2}(:\\d{2})?")) {
            String[] parts = s.split(":");
            try {
                if (parts.length == 3) {
                    return Integer.parseInt(parts[0]) * 3600
                            + Integer.parseInt(parts[1]) * 60
                            + Integer.parseInt(parts[2]);
                }
                if (parts.length == 2) {
                    return Integer.parseInt(parts[0]) * 60 + Integer.parseInt(parts[1]);
                }
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        java.util.regex.Matcher m = Pattern.compile("(\\d+)\\s*min", Pattern.CASE_INSENSITIVE).matcher(s);
        if (m.find()) {
            try {
                return Integer.parseInt(m.group(1)) * 60;
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static String firstText(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        if (node.isArray()) {
            for (JsonNode child : node) {
                String v = textOrNull(child);
                if (StringUtils.hasText(v)) {
                    return v.length() > 280 ? v.substring(0, 277) + "…" : v;
                }
            }
            return null;
        }
        String v = textOrNull(node);
        if (v != null && v.length() > 280) {
            return v.substring(0, 277) + "…";
        }
        return v;
    }

    private static String textOrNull(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        String v = node.asText(null);
        return StringUtils.hasText(v) ? v.trim() : null;
    }

    private static String joinNonEmpty(String sep, String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (!StringUtils.hasText(p)) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(sep);
            }
            sb.append(p.trim());
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    public record IaCatalogResult(
            String section,
            int page,
            int pages,
            int pageSize,
            int total,
            List<IaProgramDto> programs
    ) {
    }

    private record SectionDef(String label, String query, String sort) {
    }

    private record CachedUrl(String url, Instant expiresAt) {
    }

    private record CachedPage(JsonNode json, Instant expiresAt) {
    }
}
