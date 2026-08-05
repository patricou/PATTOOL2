package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArchiveFileDto;
import com.pat.controller.dto.ArchiveItemDetailDto;
import com.pat.controller.dto.ArchiveItemDto;
import com.pat.controller.dto.ArchiveSearchPageDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.mongodb.core.MongoTemplate;
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
 * Internet Archive catalog for archive-watcher: Advanced Search, metadata, files,
 * playable resolve and Wayback Machine. List/search always hits archive.org live
 * (no browse catalogue warm).
 */
@Service
public class InternetArchiveCatalogService {

    private static final Logger log = LoggerFactory.getLogger(InternetArchiveCatalogService.class);

    private static final String SEARCH_URL = "https://archive.org/advancedsearch.php";
    private static final String METADATA_BASE = "https://archive.org/metadata/";
    private static final String DETAILS_BASE = "https://archive.org/details/";
    private static final String DOWNLOAD_BASE = "https://archive.org/download/";
    private static final String IMAGE_BASE = "https://archive.org/services/img/";
    private static final String EMBED_BASE = "https://archive.org/embed/";
    private static final String WAYBACK_AVAILABLE = "https://archive.org/wayback/available";
    private static final String WAYBACK_CDX = "https://web.archive.org/cdx/search/cdx";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final Duration ITEM_CACHE_TTL = Duration.ofHours(24);
    private static final int ROWS_PER_PAGE = 40;
    private static final Pattern IDENTIFIER = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$");

    private static final Map<String, MediatypeDef> MEDIATYPES = new LinkedHashMap<>();
    private static final Map<String, Map<String, SectionDef>> SECTIONS_BY_TYPE = new LinkedHashMap<>();
    private static final Map<String, String> SORTS = new LinkedHashMap<>();

    static {
        MEDIATYPES.put("all", new MediatypeDef("Tout", null));
        MEDIATYPES.put("movies", new MediatypeDef("Vidéos", "movies"));
        MEDIATYPES.put("texts", new MediatypeDef("Textes", "texts"));
        MEDIATYPES.put("audio", new MediatypeDef("Audio", "audio"));
        MEDIATYPES.put("etree", new MediatypeDef("Concerts (etree)", "etree"));
        MEDIATYPES.put("software", new MediatypeDef("Logiciels", "software"));
        MEDIATYPES.put("image", new MediatypeDef("Images", "image"));
        MEDIATYPES.put("data", new MediatypeDef("Données", "data"));
        MEDIATYPES.put("web", new MediatypeDef("Web archives", "web"));
        MEDIATYPES.put("collection", new MediatypeDef("Collections", "collection"));

        SORTS.put("downloads", "downloads desc");
        SORTS.put("recent", "publicdate desc");
        SORTS.put("title", "titleSorter asc");
        SORTS.put("creator", "creatorSorter asc");
        SORTS.put("rating", "avg_rating desc");
        SORTS.put("date", "date desc");

        Map<String, SectionDef> all = new LinkedHashMap<>();
        all.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        all.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        all.put("TOP_RATED", new SectionDef("Mieux notés", "avg_rating:[3 TO 5]", "avg_rating desc"));
        SECTIONS_BY_TYPE.put("all", all);

        Map<String, SectionDef> movies = new LinkedHashMap<>();
        movies.put("RECENT", new SectionDef(
                "Ajouts récents",
                "format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "publicdate desc"));
        movies.put("FEATURE_FILMS", new SectionDef(
                "Feature films",
                "collection:feature_films AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        movies.put("CLASSIC_FILMS", new SectionDef(
                "Classiques",
                "collection:classic_films AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        movies.put("FILM_NOIR", new SectionDef(
                "Film noir",
                "collection:Film_Noir AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        movies.put("SCIFI_HORROR", new SectionDef(
                "SF & horreur",
                "collection:SciFi_Horror AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        movies.put("SILENT", new SectionDef(
                "Films muets",
                "collection:silent_films AND format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        movies.put("MOST_DOWNLOADED", new SectionDef(
                "Les plus téléchargés",
                "format:(MPEG4 OR \"h.264\" OR \"512Kb MPEG4\")",
                "downloads desc"));
        SECTIONS_BY_TYPE.put("movies", movies);

        Map<String, SectionDef> texts = new LinkedHashMap<>();
        texts.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        texts.put("GUTENBERG", new SectionDef("Project Gutenberg", "collection:gutenberg", "downloads desc"));
        texts.put("OPENLIBRARY", new SectionDef("Open Library", "collection:openlibrary", "downloads desc"));
        texts.put("AMERICANA", new SectionDef("Americana", "collection:americana", "downloads desc"));
        texts.put("MAGAZINES", new SectionDef("Magazines", "collection:magazine_rack", "downloads desc"));
        texts.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("texts", texts);

        Map<String, SectionDef> audio = new LinkedHashMap<>();
        audio.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        audio.put("OLD_TIME_RADIO", new SectionDef("Old Time Radio", "collection:oldtimeradio", "downloads desc"));
        audio.put("AUDIOBOOKS", new SectionDef("Livres audio", "collection:audio_bookspoetry", "downloads desc"));
        audio.put("NETLABELS", new SectionDef("Netlabels", "collection:netlabels", "downloads desc"));
        audio.put("PODCASTS", new SectionDef("Podcasts", "collection:podcasts", "downloads desc"));
        audio.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("audio", audio);

        Map<String, SectionDef> etree = new LinkedHashMap<>();
        etree.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        etree.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("etree", etree);

        Map<String, SectionDef> software = new LinkedHashMap<>();
        software.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        software.put("CLASSIC_PC", new SectionDef("PC classiques", "collection:classicpcgames", "downloads desc"));
        software.put("INTERNET_ARCADE", new SectionDef("Internet Arcade", "collection:internetarcade", "downloads desc"));
        software.put("CONSOLE", new SectionDef("Consoles", "collection:consolelivingroom", "downloads desc"));
        software.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("software", software);

        Map<String, SectionDef> image = new LinkedHashMap<>();
        image.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        image.put("NASA", new SectionDef("NASA", "collection:nasa", "downloads desc"));
        image.put("MET", new SectionDef("Metropolitan Museum", "collection:metropolitanmuseumofart-gallery", "downloads desc"));
        image.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("image", image);

        Map<String, SectionDef> data = new LinkedHashMap<>();
        data.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        data.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("data", data);

        Map<String, SectionDef> web = new LinkedHashMap<>();
        web.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        web.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("web", web);

        Map<String, SectionDef> collection = new LinkedHashMap<>();
        collection.put("RECENT", new SectionDef("Ajouts récents", "", "publicdate desc"));
        collection.put("MOST_DOWNLOADED", new SectionDef("Les plus téléchargés", "", "downloads desc"));
        SECTIONS_BY_TYPE.put("collection", collection);
    }

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ObjectMapper objectMapper;
    private final MongoTemplate mongoTemplate;
    /** Item metadata/files cache only (not browse listings). */
    private final ConcurrentHashMap<String, CachedItem> itemCache = new ConcurrentHashMap<>();

    public InternetArchiveCatalogService(ObjectMapper objectMapper, MongoTemplate mongoTemplate) {
        this.objectMapper = objectMapper;
        this.mongoTemplate = mongoTemplate;
    }

    /** Drop the abandoned full Mongo catalogue collection if present. */
    @EventListener(ApplicationReadyEvent.class)
    public void dropLegacyMongoCatalog() {
        try {
            if (mongoTemplate.collectionExists("archive_catalog")) {
                mongoTemplate.dropCollection("archive_catalog");
                log.info("Dropped legacy archive_catalog Mongo collection");
            }
        } catch (Exception e) {
            log.warn("Could not drop legacy archive_catalog: {}", e.toString());
        }
    }

    public boolean isValidIdentifier(String identifier) {
        return StringUtils.hasText(identifier) && IDENTIFIER.matcher(identifier.trim()).matches();
    }

    public List<Map<String, String>> mediatypes() {
        List<Map<String, String>> out = new ArrayList<>();
        for (Map.Entry<String, MediatypeDef> e : MEDIATYPES.entrySet()) {
            out.add(Map.of("code", e.getKey(), "label", e.getValue().label()));
        }
        return out;
    }

    public List<Map<String, String>> sorts() {
        List<Map<String, String>> out = new ArrayList<>();
        out.add(Map.of("code", "downloads", "label", "Téléchargements"));
        out.add(Map.of("code", "recent", "label", "Plus récents"));
        out.add(Map.of("code", "title", "label", "Titre"));
        out.add(Map.of("code", "creator", "label", "Créateur"));
        out.add(Map.of("code", "rating", "label", "Note"));
        out.add(Map.of("code", "date", "label", "Date"));
        return out;
    }

    public List<Map<String, String>> sections(String mediatype) {
        String type = normalizeMediatype(mediatype);
        Map<String, SectionDef> sections = SECTIONS_BY_TYPE.getOrDefault(type, SECTIONS_BY_TYPE.get("all"));
        List<Map<String, String>> out = new ArrayList<>();
        for (Map.Entry<String, SectionDef> e : sections.entrySet()) {
            out.add(Map.of("code", e.getKey(), "label", e.getValue().label()));
        }
        return out;
    }

    public String normalizeMediatype(String mediatype) {
        if (!StringUtils.hasText(mediatype)) {
            return "all";
        }
        String code = mediatype.trim().toLowerCase(Locale.ROOT);
        return MEDIATYPES.containsKey(code) ? code : "all";
    }

    public String normalizeSection(String mediatype, String section) {
        Map<String, SectionDef> sections = SECTIONS_BY_TYPE.getOrDefault(
                normalizeMediatype(mediatype), SECTIONS_BY_TYPE.get("all"));
        if (!StringUtils.hasText(section)) {
            return sections.keySet().iterator().next();
        }
        String code = section.trim().toUpperCase(Locale.ROOT);
        return sections.containsKey(code) ? code : sections.keySet().iterator().next();
    }

    public String normalizeSort(String sort) {
        if (!StringUtils.hasText(sort)) {
            return "downloads";
        }
        String code = sort.trim().toLowerCase(Locale.ROOT);
        return SORTS.containsKey(code) ? code : "downloads";
    }

    public ArchiveSearchPageDto search(
            String mediatype,
            String section,
            String query,
            String creator,
            String language,
            String sort,
            int page) {
        int requestedPage = Math.max(1, page <= 0 ? 1 : page);
        String type = normalizeMediatype(mediatype);
        String q = query != null ? query.trim() : "";
        String creatorQ = creator != null ? creator.trim() : "";
        String lang = language != null ? language.trim() : "";

        // Always live against archive.org (no browse catalogue warm).
        if (q.length() >= 2 || creatorQ.length() >= 2) {
            return searchLive(type, q, creatorQ, lang, sort, requestedPage);
        }

        String sectionCode = normalizeSection(type, section);
        SectionDef def = SECTIONS_BY_TYPE.get(type).get(sectionCode);
        String sortCode = StringUtils.hasText(sort) ? normalizeSort(sort) : inferSortCode(def.sort());
        return searchLiveSection(type, sectionCode, def, lang, sortCode, requestedPage);
    }

    /** No browse catalogue to warm — clears item metadata cache only. */
    public boolean startCatalogRefresh() {
        return startCatalogRefresh(false);
    }

    public boolean startCatalogRefresh(boolean force) {
        invalidateAll();
        return true;
    }

    public Map<String, Object> catalogCacheStatus() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("busy", false);
        out.put("lastStartedAt", null);
        out.put("lastCompletedAt", null);
        out.put("lastDurationMs", null);
        out.put("lastError", null);
        out.put("lastPhase", "live-only");
        out.putAll(cacheStats());
        return out;
    }

    public Map<String, Object> cacheStats() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("archiveCatalogTypes", 0);
        out.put("archiveCatalogEntries", 0);
        out.put("archiveItemCache", itemCache.size());
        out.put("archiveCatalogPerType", Map.of());
        out.put("mode", "live");
        return out;
    }

    public int catalogEntryCount() {
        return 0;
    }

    public void warmCatalog() {
        // No-op: browse listings are always fetched live from archive.org.
    }

    private ArchiveSearchPageDto searchLive(
            String type,
            String q,
            String creatorQ,
            String lang,
            String sort,
            int requestedPage) {
        String sortCode = normalizeSort(sort);
        String sortClause = SORTS.get(sortCode);
        String lucene = buildSearchLucene(type, q, creatorQ, lang);
        return buildLivePage(type, "SEARCH", q, sortCode, lucene, sortClause, requestedPage);
    }

    private ArchiveSearchPageDto searchLiveSection(
            String type,
            String sectionCode,
            SectionDef def,
            String lang,
            String sortCode,
            int requestedPage) {
        String sortClause = SORTS.getOrDefault(sortCode, def.sort());
        String lucene = buildSectionLucene(type, def.query(), lang);
        return buildLivePage(type, sectionCode, "", sortCode, lucene, sortClause, requestedPage);
    }

    private ArchiveSearchPageDto buildLivePage(
            String type,
            String sectionCode,
            String q,
            String sortCode,
            String lucene,
            String sortClause,
            int requestedPage) {
        JsonNode response = fetchSearchPage(lucene, sortClause, requestedPage, ROWS_PER_PAGE);
        int total = 0;
        int pages = 1;
        if (response != null) {
            total = Math.max(0, response.path("numFound").asInt(0));
            pages = Math.max(1, (int) Math.ceil(total / (double) ROWS_PER_PAGE));
        }
        int safePage = Math.min(requestedPage, pages);
        if (safePage != requestedPage) {
            response = fetchSearchPage(lucene, sortClause, safePage, ROWS_PER_PAGE);
        }

        List<ArchiveItemDto> items = new ArrayList<>();
        if (response != null) {
            JsonNode docs = response.path("docs");
            if (docs.isArray()) {
                for (JsonNode doc : docs) {
                    toListItem(doc).ifPresent(items::add);
                }
            }
        }

        ArchiveSearchPageDto pageDto = new ArchiveSearchPageDto();
        pageDto.setMediatype(type);
        pageDto.setSection(sectionCode);
        pageDto.setQuery(q);
        pageDto.setSort(sortCode);
        pageDto.setPage(safePage);
        pageDto.setPages(pages);
        pageDto.setPageSize(ROWS_PER_PAGE);
        pageDto.setTotal(total);
        pageDto.setItems(items);
        return pageDto;
    }

    public Optional<ArchiveItemDetailDto> getItem(String identifier) {
        if (!isValidIdentifier(identifier)) {
            return Optional.empty();
        }
        String id = identifier.trim();
        Instant now = Instant.now();
        CachedItem cached = itemCache.get(id);
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return Optional.of(cached.item);
        }
        try {
            JsonNode root = fetchMetadata(id);
            if (root == null) {
                return Optional.empty();
            }
            ArchiveItemDetailDto detail = toDetail(id, root);
            itemCache.put(id, new CachedItem(detail, now.plus(ITEM_CACHE_TTL)));
            return Optional.of(detail);
        } catch (Exception e) {
            log.debug("IA item {} failed: {}", id, e.getMessage());
            return Optional.empty();
        }
    }

    public Optional<Map<String, Object>> resolvePlayable(String identifier, boolean forceRefresh) {
        Optional<ArchiveItemDetailDto> item = getItem(identifier);
        if (item.isEmpty()) {
            return Optional.empty();
        }
        ArchiveItemDetailDto detail = item.get();
        if (forceRefresh) {
            itemCache.remove(identifier.trim());
            item = getItem(identifier);
            if (item.isEmpty()) {
                return Optional.empty();
            }
            detail = item.get();
        }
        if (!StringUtils.hasText(detail.getPlayUrl())) {
            return Optional.empty();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("identifier", detail.getIdentifier());
        out.put("streamUrl", detail.getPlayUrl());
        out.put("playKind", detail.getPlayKind());
        out.put("mediatype", detail.getMediatype());
        out.put("title", detail.getTitle());
        out.put("progressive", true);
        out.put("expiresAtEpoch", Instant.now().plus(Duration.ofMinutes(30)).getEpochSecond());
        return Optional.of(out);
    }

    public Map<String, Object> waybackAvailable(String url) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("url", url);
        out.put("available", false);
        if (!StringUtils.hasText(url)) {
            out.put("error", "empty_url");
            return out;
        }
        String trimmed = url.trim();
        if (trimmed.length() > 2000) {
            out.put("error", "url_too_long");
            return out;
        }
        try {
            String api = WAYBACK_AVAILABLE + "?url=" + URLEncoder.encode(trimmed, StandardCharsets.UTF_8);
            HttpRequest request = HttpRequest.newBuilder(URI.create(api))
                    .timeout(Duration.ofSeconds(20))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
                out.put("error", "wayback_http_" + response.statusCode());
                return out;
            }
            JsonNode root = objectMapper.readTree(response.body());
            JsonNode closest = root.path("archived_snapshots").path("closest");
            if (closest.isObject() && closest.path("available").asBoolean(false)) {
                out.put("available", true);
                out.put("snapshotUrl", textOrNull(closest.path("url")));
                out.put("timestamp", textOrNull(closest.path("timestamp")));
                out.put("status", textOrNull(closest.path("status")));
            }
            return out;
        } catch (Exception e) {
            log.debug("Wayback available failed: {}", e.getMessage());
            out.put("error", "wayback_failed");
            return out;
        }
    }

    public Map<String, Object> waybackCdx(String url, int limit) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("url", url);
        List<Map<String, String>> snapshots = new ArrayList<>();
        out.put("snapshots", snapshots);
        if (!StringUtils.hasText(url)) {
            out.put("error", "empty_url");
            return out;
        }
        String trimmed = url.trim();
        if (trimmed.length() > 2000) {
            out.put("error", "url_too_long");
            return out;
        }
        int safeLimit = Math.min(50, Math.max(1, limit <= 0 ? 20 : limit));
        try {
            String api = WAYBACK_CDX
                    + "?url=" + URLEncoder.encode(trimmed, StandardCharsets.UTF_8)
                    + "&output=json&fl=timestamp,original,statuscode,mimetype,length"
                    + "&filter=statuscode:200"
                    + "&collapse=timestamp:8"
                    + "&limit=" + safeLimit;
            HttpRequest request = HttpRequest.newBuilder(URI.create(api))
                    .timeout(Duration.ofSeconds(25))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
                out.put("error", "cdx_http_" + response.statusCode());
                return out;
            }
            JsonNode root = objectMapper.readTree(response.body());
            if (!root.isArray() || root.size() < 2) {
                return out;
            }
            for (int i = 1; i < root.size(); i++) {
                JsonNode row = root.get(i);
                if (!row.isArray() || row.size() < 3) {
                    continue;
                }
                String ts = row.get(0).asText("");
                String original = row.get(1).asText("");
                String status = row.get(2).asText("");
                String mime = row.size() > 3 ? row.get(3).asText("") : "";
                String length = row.size() > 4 ? row.get(4).asText("") : "";
                if (!StringUtils.hasText(ts)) {
                    continue;
                }
                Map<String, String> snap = new LinkedHashMap<>();
                snap.put("timestamp", ts);
                snap.put("original", original);
                snap.put("status", status);
                snap.put("mimetype", mime);
                snap.put("length", length);
                snap.put("snapshotUrl", "https://web.archive.org/web/" + ts + "/" + original);
                snapshots.add(snap);
            }
            return out;
        } catch (Exception e) {
            log.debug("Wayback CDX failed: {}", e.getMessage());
            out.put("error", "cdx_failed");
            return out;
        }
    }

    public int invalidateAll() {
        int n = itemCache.size();
        itemCache.clear();
        try {
            if (mongoTemplate.collectionExists("archive_catalog")) {
                mongoTemplate.dropCollection("archive_catalog");
            }
        } catch (Exception e) {
            log.debug("archive_catalog drop on invalidate: {}", e.toString());
        }
        return n;
    }

    private String buildSearchLucene(String type, String q, String creator, String language) {
        StringBuilder sb = new StringBuilder();
        MediatypeDef def = MEDIATYPES.get(type);
        if (def != null && StringUtils.hasText(def.luceneMediatype())) {
            sb.append("mediatype:").append(def.luceneMediatype());
        }
        if (StringUtils.hasText(q)) {
            String escaped = escapeLucene(q);
            appendAnd(sb, "(title:(" + escaped + ") OR description:(" + escaped
                    + ") OR creator:(" + escaped + ") OR identifier:(" + escaped
                    + ") OR subject:(" + escaped + "))");
        }
        if (StringUtils.hasText(creator)) {
            appendAnd(sb, "creator:(" + escapeLucene(creator) + ")");
        }
        if (StringUtils.hasText(language)) {
            appendAnd(sb, "language:(" + escapeLucene(language) + ")");
        }
        return sb.length() == 0 ? "*:*" : sb.toString();
    }

    private String buildSectionLucene(String type, String sectionQuery, String language) {
        StringBuilder sb = new StringBuilder();
        MediatypeDef def = MEDIATYPES.get(type);
        if (def != null && StringUtils.hasText(def.luceneMediatype())) {
            sb.append("mediatype:").append(def.luceneMediatype());
        }
        if (StringUtils.hasText(sectionQuery)) {
            appendAnd(sb, "(" + sectionQuery + ")");
        }
        if (StringUtils.hasText(language)) {
            appendAnd(sb, "language:(" + escapeLucene(language) + ")");
        }
        return sb.length() == 0 ? "*:*" : sb.toString();
    }

    private static void appendAnd(StringBuilder sb, String clause) {
        if (sb.length() > 0) {
            sb.append(" AND ");
        }
        sb.append(clause);
    }

    private static String inferSortCode(String sortClause) {
        if (!StringUtils.hasText(sortClause)) {
            return "downloads";
        }
        String s = sortClause.toLowerCase(Locale.ROOT);
        if (s.startsWith("publicdate")) {
            return "recent";
        }
        if (s.startsWith("title")) {
            return "title";
        }
        if (s.startsWith("creator")) {
            return "creator";
        }
        if (s.startsWith("avg_rating")) {
            return "rating";
        }
        if (s.startsWith("date")) {
            return "date";
        }
        return "downloads";
    }

    private Optional<ArchiveItemDto> toListItem(JsonNode doc) {
        if (doc == null || doc.isMissingNode()) {
            return Optional.empty();
        }
        String identifier = textOrNull(doc.path("identifier"));
        if (!isValidIdentifier(identifier)) {
            return Optional.empty();
        }
        ArchiveItemDto dto = new ArchiveItemDto();
        dto.setId("ia-" + identifier);
        dto.setIdentifier(identifier);
        String title = firstText(doc.path("title"));
        dto.setTitle(StringUtils.hasText(title) ? title : identifier);
        String year = firstText(doc.path("year"));
        String creator = firstText(doc.path("creator"));
        dto.setCreator(creator);
        dto.setYear(year);
        dto.setSubtitle(joinNonEmpty(" · ", year, creator));
        dto.setDescription(firstText(doc.path("description")));
        dto.setMediatype(firstText(doc.path("mediatype")));
        dto.setDate(firstText(doc.path("date")));
        dto.setLanguage(firstText(doc.path("language")));
        dto.setSubject(firstText(doc.path("subject")));
        dto.setCollection(firstText(doc.path("collection")));
        if (doc.path("downloads").canConvertToLong()) {
            dto.setDownloads(doc.path("downloads").asLong());
        }
        if (doc.path("avg_rating").isNumber()) {
            dto.setAvgRating(doc.path("avg_rating").asDouble());
        }
        dto.setImageUrl(IMAGE_BASE + identifier);
        dto.setDetailsUrl(DETAILS_BASE + identifier);
        dto.setEmbedUrl(EMBED_BASE + identifier);
        String mt = dto.getMediatype() != null ? dto.getMediatype().toLowerCase(Locale.ROOT) : "";
        dto.setPlayable("movies".equals(mt) || "audio".equals(mt) || "etree".equals(mt)
                || "texts".equals(mt) || "image".equals(mt) || "software".equals(mt));
        return Optional.of(dto);
    }

    private ArchiveItemDetailDto toDetail(String identifier, JsonNode root) {
        JsonNode meta = root.path("metadata");
        ArchiveItemDetailDto dto = new ArchiveItemDetailDto();
        dto.setId("ia-" + identifier);
        dto.setIdentifier(identifier);
        String title = firstText(meta.path("title"));
        dto.setTitle(StringUtils.hasText(title) ? title : identifier);
        dto.setDescription(firstText(meta.path("description")));
        dto.setCreator(firstText(meta.path("creator")));
        dto.setMediatype(firstText(meta.path("mediatype")));
        dto.setYear(firstText(meta.path("year")));
        dto.setDate(firstText(meta.path("date")));
        dto.setLanguage(firstText(meta.path("language")));
        dto.setRuntime(firstText(meta.path("runtime")));
        dto.setPublisher(firstText(meta.path("publisher")));
        dto.setLicenseUrl(firstText(meta.path("licenseurl")));
        dto.setSubtitle(joinNonEmpty(" · ", dto.getYear(), dto.getCreator()));
        dto.setCollections(allTexts(meta.path("collection")));
        dto.setSubjects(allTexts(meta.path("subject")));
        dto.setSubject(dto.getSubjects().isEmpty() ? null : dto.getSubjects().get(0));
        dto.setCollection(dto.getCollections().isEmpty() ? null : dto.getCollections().get(0));
        if (root.path("item_size").canConvertToLong()) {
            dto.setItemSize(root.path("item_size").asLong());
        }
        if (meta.path("downloads").canConvertToLong()) {
            dto.setDownloads(meta.path("downloads").asLong());
        } else if (root.path("downloads").canConvertToLong()) {
            dto.setDownloads(root.path("downloads").asLong());
        }
        JsonNode reviews = root.path("reviews");
        if (reviews.isObject() && reviews.path("avg_rating").isNumber()) {
            dto.setAvgRating(reviews.path("avg_rating").asDouble());
        }
        dto.setDark(root.path("is_dark").asBoolean(false));
        dto.setImageUrl(IMAGE_BASE + identifier);
        dto.setDetailsUrl(DETAILS_BASE + identifier);
        dto.setEmbedUrl(EMBED_BASE + identifier);

        List<ArchiveFileDto> files = new ArrayList<>();
        ArchiveFileDto bestVideo = null;
        int bestVideoScore = Integer.MIN_VALUE;
        ArchiveFileDto bestAudio = null;
        int bestAudioScore = Integer.MIN_VALUE;
        ArchiveFileDto bestImage = null;
        int bestImageScore = Integer.MIN_VALUE;
        ArchiveFileDto bestText = null;
        int bestTextScore = Integer.MIN_VALUE;

        JsonNode filesNode = root.path("files");
        if (filesNode.isArray()) {
            for (JsonNode file : filesNode) {
                ArchiveFileDto f = toFile(identifier, file);
                if (f == null) {
                    continue;
                }
                files.add(f);
                String kind = f.getKind();
                if ("video".equals(kind)) {
                    int score = scoreVideoFile(file);
                    if (score > bestVideoScore) {
                        bestVideoScore = score;
                        bestVideo = f;
                    }
                } else if ("audio".equals(kind)) {
                    int score = scoreAudioFile(file);
                    if (score > bestAudioScore) {
                        bestAudioScore = score;
                        bestAudio = f;
                    }
                } else if ("image".equals(kind)) {
                    int score = scoreImageFile(file);
                    if (score > bestImageScore) {
                        bestImageScore = score;
                        bestImage = f;
                    }
                } else if ("text".equals(kind) || "pdf".equals(kind)) {
                    int score = scoreTextFile(file);
                    if (score > bestTextScore) {
                        bestTextScore = score;
                        bestText = f;
                    }
                }
            }
        }
        dto.setFiles(files);

        String mt = dto.getMediatype() != null ? dto.getMediatype().toLowerCase(Locale.ROOT) : "";
        if (!dto.isDark()) {
            if (("movies".equals(mt) || bestVideo != null) && bestVideo != null && bestVideoScore >= 50) {
                dto.setPlayUrl(bestVideo.getDownloadUrl());
                dto.setPlayKind("video");
                dto.setPlayable(true);
            } else if (("audio".equals(mt) || "etree".equals(mt) || bestAudio != null)
                    && bestAudio != null && bestAudioScore >= 40) {
                dto.setPlayUrl(bestAudio.getDownloadUrl());
                dto.setPlayKind("audio");
                dto.setPlayable(true);
            } else if (("image".equals(mt) || bestImage != null) && bestImage != null) {
                dto.setPlayUrl(bestImage.getDownloadUrl());
                dto.setPlayKind("image");
                dto.setPlayable(true);
            } else if (("texts".equals(mt) || bestText != null) && bestText != null) {
                dto.setPlayUrl(bestText.getDownloadUrl());
                dto.setPlayKind(bestText.getKind());
                dto.setPlayable(true);
            } else if ("texts".equals(mt) || "software".equals(mt) || "movies".equals(mt)
                    || "audio".equals(mt) || "etree".equals(mt)) {
                // Embed player / reader still useful even without a direct file.
                dto.setPlayable(true);
                dto.setPlayKind("embed");
            }
        }
        return dto;
    }

    private ArchiveFileDto toFile(String identifier, JsonNode file) {
        String name = textOrNull(file.path("name"));
        if (!StringUtils.hasText(name)) {
            return null;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith("_files.xml") || lower.endsWith("_meta.xml") || lower.endsWith("_meta.sqlite")
                || lower.endsWith(".torrent") || lower.contains("__ia_thumb")) {
            return null;
        }
        ArchiveFileDto dto = new ArchiveFileDto();
        dto.setName(name);
        dto.setFormat(textOrNull(file.path("format")));
        if (file.path("size").canConvertToLong()) {
            dto.setSize(file.path("size").asLong());
        }
        dto.setLength(textOrNull(file.path("length")));
        if (file.path("width").canConvertToInt()) {
            dto.setWidth(file.path("width").asInt());
        }
        if (file.path("height").canConvertToInt()) {
            dto.setHeight(file.path("height").asInt());
        }
        dto.setDownloadUrl(DOWNLOAD_BASE + identifier + "/" + encodePathSegment(name));
        String kind = classifyFile(lower, dto.getFormat());
        dto.setKind(kind);
        dto.setPlayable("video".equals(kind) || "audio".equals(kind) || "image".equals(kind)
                || "text".equals(kind) || "pdf".equals(kind));
        return dto;
    }

    private static String classifyFile(String lowerName, String format) {
        String fmt = format != null ? format.toLowerCase(Locale.ROOT) : "";
        if (lowerName.endsWith(".mp4") || lowerName.endsWith(".webm") || lowerName.endsWith(".ogv")
                || lowerName.endsWith(".m3u8") || lowerName.endsWith(".mpeg") || lowerName.endsWith(".mpg")
                || lowerName.endsWith(".avi") || lowerName.endsWith(".mkv") || lowerName.endsWith(".mov")
                || fmt.contains("mpeg4") || fmt.contains("h.264") || fmt.contains("512kb")
                || fmt.contains("ogg video") || fmt.contains("matroska")) {
            return "video";
        }
        if (lowerName.endsWith(".mp3") || lowerName.endsWith(".ogg") || lowerName.endsWith(".flac")
                || lowerName.endsWith(".wav") || lowerName.endsWith(".m4a") || lowerName.endsWith(".aac")
                || lowerName.endsWith(".opus") || fmt.contains("vbr mp3") || fmt.contains("mp3")
                || fmt.contains("flac") || fmt.contains("ogg vorbis") || fmt.contains("64kbps mp3")
                || fmt.contains("128kbps mp3")) {
            return "audio";
        }
        if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg") || lowerName.endsWith(".png")
                || lowerName.endsWith(".gif") || lowerName.endsWith(".webp") || lowerName.endsWith(".tif")
                || lowerName.endsWith(".tiff") || fmt.contains("jpeg") || fmt.contains("png")
                || fmt.contains("gif")) {
            return "image";
        }
        if (lowerName.endsWith(".pdf") || fmt.contains("pdf")) {
            return "pdf";
        }
        if (lowerName.endsWith(".txt") || lowerName.endsWith(".epub") || lowerName.endsWith(".djvu")
                || lowerName.endsWith(".html") || lowerName.endsWith(".htm")
                || lowerName.endsWith("_djvu.txt") || fmt.contains("epub") || fmt.contains("djvu")
                || fmt.contains("text")) {
            return "text";
        }
        return "other";
    }

    private static int scoreVideoFile(JsonNode file) {
        String name = textOrNull(file.path("name"));
        if (!StringUtils.hasText(name)) {
            return Integer.MIN_VALUE;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        String format = Optional.ofNullable(textOrNull(file.path("format"))).orElse("").toLowerCase(Locale.ROOT);
        boolean mp4 = lower.endsWith(".mp4");
        boolean m3u8 = lower.endsWith(".m3u8");
        boolean webm = lower.endsWith(".webm");
        boolean ogv = lower.endsWith(".ogv");
        if (!mp4 && !m3u8 && !webm && !ogv && !format.contains("mpeg4") && !format.contains("h.264")
                && !format.contains("512kb")) {
            return 10;
        }
        int score = 0;
        if (mp4) {
            score += 100;
        }
        if (m3u8) {
            score += 90;
        }
        if (webm) {
            score += 50;
        }
        if (ogv) {
            score += 25;
        }
        if (format.contains("512kb")) {
            score += 40;
        }
        if (format.contains("h.264")) {
            score += 30;
        }
        if (lower.contains("trailer") || lower.contains("sample") || lower.contains("preview")) {
            score -= 120;
        }
        long size = file.path("size").asLong(0);
        if (size > 0 && size < 20_000_000L) {
            score -= 50;
        } else if (size >= 80_000_000L && size <= 900_000_000L) {
            score += 35;
        }
        return score;
    }

    private static int scoreAudioFile(JsonNode file) {
        String name = textOrNull(file.path("name"));
        if (!StringUtils.hasText(name)) {
            return Integer.MIN_VALUE;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        String format = Optional.ofNullable(textOrNull(file.path("format"))).orElse("").toLowerCase(Locale.ROOT);
        int score = 0;
        if (lower.endsWith(".mp3") || format.contains("mp3")) {
            score += 100;
        }
        if (lower.endsWith(".ogg") || format.contains("ogg")) {
            score += 70;
        }
        if (lower.endsWith(".m4a") || lower.endsWith(".aac")) {
            score += 80;
        }
        if (lower.endsWith(".flac")) {
            score += 40;
        }
        if (format.contains("vbr")) {
            score += 15;
        }
        if (lower.contains("64kb") || format.contains("64kb")) {
            score += 10;
        }
        long size = file.path("size").asLong(0);
        if (size > 500_000L) {
            score += 10;
        }
        return score;
    }

    private static int scoreImageFile(JsonNode file) {
        String name = textOrNull(file.path("name"));
        if (!StringUtils.hasText(name)) {
            return Integer.MIN_VALUE;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        int score = 20;
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            score += 40;
        }
        if (lower.endsWith(".png")) {
            score += 30;
        }
        if (lower.contains("thumb") || lower.contains("__ia")) {
            score -= 50;
        }
        int w = file.path("width").asInt(0);
        int h = file.path("height").asInt(0);
        if (w >= 800 || h >= 800) {
            score += 30;
        }
        return score;
    }

    private static int scoreTextFile(JsonNode file) {
        String name = textOrNull(file.path("name"));
        if (!StringUtils.hasText(name)) {
            return Integer.MIN_VALUE;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        String format = Optional.ofNullable(textOrNull(file.path("format"))).orElse("").toLowerCase(Locale.ROOT);
        int score = 10;
        if (lower.endsWith(".pdf") || format.contains("pdf")) {
            score += 80;
        }
        if (lower.endsWith(".epub") || format.contains("epub")) {
            score += 70;
        }
        if (lower.endsWith(".txt") || lower.endsWith("_djvu.txt")) {
            score += 60;
        }
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            score += 40;
        }
        return score;
    }

    private JsonNode fetchMetadata(String identifier) throws Exception {
        String url = METADATA_BASE + URLEncoder.encode(identifier, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(25))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
            return null;
        }
        return objectMapper.readTree(response.body());
    }

    private JsonNode fetchSearchPage(String lucene, String sort, int page, int rows) {
        StringBuilder url = new StringBuilder(SEARCH_URL)
                .append("?q=").append(URLEncoder.encode(lucene, StandardCharsets.UTF_8))
                .append("&fl[]=identifier&fl[]=title&fl[]=description&fl[]=year&fl[]=date")
                .append("&fl[]=creator&fl[]=subject&fl[]=mediatype&fl[]=language")
                .append("&fl[]=collection&fl[]=avg_rating&fl[]=downloads&fl[]=format")
                .append("&sort[]=").append(URLEncoder.encode(sort, StandardCharsets.UTF_8))
                .append("&rows=").append(Math.max(1, Math.min(rows, 500)))
                .append("&page=").append(page)
                .append("&output=json");
        String requestUrl = url.toString();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(requestUrl))
                    .timeout(Duration.ofSeconds(25))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200 || !StringUtils.hasText(response.body())) {
                log.debug("IA catalog search HTTP {}", response.statusCode());
                return null;
            }
            JsonNode root = objectMapper.readTree(response.body());
            JsonNode resp = root.path("response");
            if (!resp.isObject()) {
                return null;
            }
            return resp;
        } catch (Exception e) {
            log.debug("IA catalog search failed: {}", e.getMessage());
            return null;
        }
    }

    private static String encodePathSegment(String name) {
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

    private static List<String> allTexts(JsonNode node) {
        List<String> out = new ArrayList<>();
        if (node == null || node.isMissingNode() || node.isNull()) {
            return out;
        }
        if (node.isArray()) {
            for (JsonNode child : node) {
                String v = textOrNull(child);
                if (StringUtils.hasText(v) && !out.contains(v)) {
                    out.add(v);
                }
            }
            return out;
        }
        String v = textOrNull(node);
        if (StringUtils.hasText(v)) {
            out.add(v);
        }
        return out;
    }

    private static String firstText(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        if (node.isArray()) {
            for (JsonNode child : node) {
                String v = textOrNull(child);
                if (StringUtils.hasText(v)) {
                    return v.length() > 400 ? v.substring(0, 397) + "…" : v;
                }
            }
            return null;
        }
        String v = textOrNull(node);
        if (v != null && v.length() > 400) {
            return v.substring(0, 397) + "…";
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

    private record MediatypeDef(String label, String luceneMediatype) {
    }

    private record SectionDef(String label, String query, String sort) {
    }

    private record CachedItem(ArchiveItemDetailDto item, Instant expiresAt) {
    }
}
