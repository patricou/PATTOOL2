package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.BookItemDto;
import com.pat.controller.dto.BookSearchPageDto;
import com.pat.controller.dto.BookSectionDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Catalog + content helpers for Open Library, Project Gutenberg (Gutendex) and LibriVox.
 */
@Service
public class BookCatalogService {

    private static final Logger log = LoggerFactory.getLogger(BookCatalogService.class);
    private static final String USER_AGENT = "PatTool/1.0 (book-watcher; https://github.com)";
    private static final int MAX_CONTENT_BYTES = 4 * 1024 * 1024;

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    @Value("${app.book.openlibrary-base-url:https://openlibrary.org}")
    private String openLibraryBaseUrl;

    @Value("${app.book.gutendex-base-url:https://gutendex.com}")
    private String gutendexBaseUrl;

    @Value("${app.book.librivox-base-url:https://librivox.org}")
    private String librivoxBaseUrl;

    @Value("${app.book.search-cache-minutes:15}")
    private int searchCacheMinutes;

    private final ConcurrentHashMap<String, CacheEntry<BookSearchPageDto>> searchCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CacheEntry<BookItemDto>> detailCache = new ConcurrentHashMap<>();

    public BookCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public BookSearchPageDto searchOpenLibrary(String q, int limit, int offset, String language) {
        return searchOpenLibrary(q, limit, offset, language, null);
    }

    public BookSearchPageDto searchOpenLibrary(String q, int limit, int offset, String language, String genre) {
        String query = q != null ? q.trim() : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        if (query.length() < 2 && terms == null) {
            return emptyPage("openlibrary", query, limit, offset);
        }
        int safeLimit = clamp(limit, 1, 40, 20);
        int safeOffset = Math.max(0, offset);
        String lang = language != null ? language.trim().toLowerCase(Locale.ROOT) : "";
        String cacheKey = "ol|" + query.toLowerCase(Locale.ROOT) + "|" + safeLimit + "|" + safeOffset
                + "|" + lang + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            StringBuilder searchQ = new StringBuilder();
            if (query.length() >= 2) {
                searchQ.append(query);
            }
            if (terms != null) {
                if (searchQ.length() > 0) {
                    searchQ.append(' ');
                }
                searchQ.append("subject:\"").append(terms.openLibrarySubject()).append('"');
            }
            if (StringUtils.hasText(lang)) {
                // Open Library filter syntax: language:eng
                if (searchQ.length() > 0) {
                    searchQ.append(' ');
                }
                searchQ.append("language:").append(lang);
            }
            StringBuilder url = new StringBuilder(trimSlash(openLibraryBaseUrl))
                    .append("/search.json?q=")
                    .append(enc(searchQ.toString()))
                    .append("&limit=").append(safeLimit)
                    .append("&offset=").append(safeOffset)
                    .append("&fields=key,title,author_name,first_publish_year,cover_i,language,subject,")
                    .append("has_fulltext,public_scan_b,ia,edition_count,number_of_pages_median");
            JsonNode root = getJson(url.toString());
            int total = root.path("numFound").asInt(root.path("num_found").asInt(0));
            List<BookItemDto> books = new ArrayList<>();
            JsonNode docs = root.path("docs");
            if (docs.isArray()) {
                for (JsonNode doc : docs) {
                    books.add(mapOpenLibraryDoc(doc, lang));
                }
            }
            BookSearchPageDto page = new BookSearchPageDto("openlibrary",
                    query.length() >= 2 ? query : genreKey, total, safeLimit, safeOffset, books);
            searchCache.put(cacheKey, new CacheEntry<>(page));
            return page;
        } catch (Exception e) {
            log.warn("Open Library search failed for '{}': {}", query, e.toString());
            return emptyPage("openlibrary", query, safeLimit, safeOffset);
        }
    }

    public Optional<BookItemDto> getOpenLibraryWork(String workKey) {
        String key = normalizeOlKey(workKey);
        if (!StringUtils.hasText(key)) {
            return Optional.empty();
        }
        String cacheKey = "ol-detail|" + key;
        BookItemDto cached = getCachedDetail(cacheKey);
        if (cached != null) {
            return Optional.of(cached);
        }
        try {
            String url = trimSlash(openLibraryBaseUrl) + key + ".json";
            JsonNode work = getJson(url);
            BookItemDto item = mapOpenLibraryWork(work, key);
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("Open Library work fetch failed for {}: {}", key, e.toString());
            return Optional.empty();
        }
    }

    public BookSearchPageDto searchGutenberg(String q, String languages, int page) {
        return searchGutenberg(q, languages, page, null);
    }

    public BookSearchPageDto searchGutenberg(String q, String languages, int page, String genre) {
        String query = q != null ? q.trim() : "";
        int safePage = Math.max(1, page);
        String langs = languages != null ? languages.trim().toLowerCase(Locale.ROOT) : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        String cacheKey = "gb|" + query.toLowerCase(Locale.ROOT) + "|" + langs + "|" + safePage + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            StringBuilder url = new StringBuilder(trimSlash(gutendexBaseUrl)).append("/books/?");
            boolean first = true;
            if (query.length() >= 2) {
                url.append("search=").append(enc(query));
                first = false;
            }
            if (StringUtils.hasText(langs)) {
                url.append(first ? "" : "&").append("languages=").append(enc(langs));
                first = false;
            }
            if (terms != null) {
                url.append(first ? "" : "&").append("topic=").append(enc(terms.gutendexTopic()));
                first = false;
            }
            url.append(first ? "" : "&").append("page=").append(safePage);

            JsonNode root = getJson(url.toString());
            int total = root.path("count").asInt(0);
            List<BookItemDto> books = new ArrayList<>();
            JsonNode results = root.path("results");
            if (results.isArray()) {
                for (JsonNode node : results) {
                    books.add(mapGutenbergBook(node));
                }
            }
            // Gutendex page size is typically 32
            int offset = (safePage - 1) * 32;
            BookSearchPageDto pageDto = new BookSearchPageDto("gutenberg",
                    query.length() >= 2 ? query : genreKey, total, 32, offset, books);
            searchCache.put(cacheKey, new CacheEntry<>(pageDto));
            return pageDto;
        } catch (Exception e) {
            log.warn("Gutendex search failed for '{}': {}", query, e.toString());
            return emptyPage("gutenberg", query, 32, (safePage - 1) * 32);
        }
    }

    public Optional<BookItemDto> getGutenbergBook(int id) {
        if (id <= 0) {
            return Optional.empty();
        }
        String cacheKey = "gb-detail|" + id;
        BookItemDto cached = getCachedDetail(cacheKey);
        if (cached != null) {
            return Optional.of(cached);
        }
        try {
            JsonNode node = getJson(trimSlash(gutendexBaseUrl) + "/books/" + id);
            BookItemDto item = mapGutenbergBook(node);
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("Gutendex book fetch failed for {}: {}", id, e.toString());
            return Optional.empty();
        }
    }

    public BookSearchPageDto searchLibriVox(String title, String author, int limit, int offset) {
        return searchLibriVox(title, author, limit, offset, null);
    }

    public BookSearchPageDto searchLibriVox(String title, String author, int limit, int offset, String genre) {
        String t = title != null ? title.trim() : "";
        String a = author != null ? author.trim() : "";
        int safeLimit = clamp(limit, 1, 50, 25);
        int safeOffset = Math.max(0, offset);
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        String lvGenre = terms != null ? terms.librivoxGenre() : "";
        // Allow browse (no query) or search with ≥2 chars or genre filter
        boolean browsing = t.length() < 2 && a.length() < 2 && !StringUtils.hasText(lvGenre);
        String queryLabel = browsing ? "" : (t.isEmpty() ? (a.isEmpty() ? genreKey : a) : t);
        String cacheKey = "lv|" + t.toLowerCase(Locale.ROOT) + "|" + a.toLowerCase(Locale.ROOT)
                + "|" + safeLimit + "|" + safeOffset + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            // LibriVox returns HTTP 500 whenever title AND author are both sent — never combine them.
            // Genre can be combined with title OR author.
            boolean hasTitle = t.length() >= 2;
            boolean hasAuthor = a.length() >= 2;
            List<BookItemDto> books;
            if (hasTitle && hasAuthor) {
                books = fetchLibriVoxBooks(t, null, lvGenre, safeLimit, safeOffset);
                books = filterLibriVoxByAuthor(books, a);
                if (books.isEmpty()) {
                    books = fetchLibriVoxBooks(null, a, lvGenre, Math.min(50, Math.max(safeLimit * 3, safeLimit)), 0);
                    books = filterLibriVoxByTitle(books, t);
                    books = slicePage(books, safeOffset, safeLimit);
                }
            } else if (hasTitle) {
                books = fetchLibriVoxBooks(t, null, lvGenre, safeLimit, safeOffset);
            } else if (hasAuthor) {
                books = fetchLibriVoxBooks(null, a, lvGenre, safeLimit, safeOffset);
            } else {
                books = fetchLibriVoxBooks(null, null, lvGenre, safeLimit, safeOffset);
            }

            int total = books.size() < safeLimit ? safeOffset + books.size() : safeOffset + books.size() + 1;
            BookSearchPageDto page = new BookSearchPageDto("librivox", queryLabel, total, safeLimit, safeOffset, books);
            searchCache.put(cacheKey, new CacheEntry<>(page));
            return page;
        } catch (Exception e) {
            log.warn("LibriVox search failed: {}", e.toString());
            return emptyPage("librivox", queryLabel, safeLimit, safeOffset);
        }
    }

    /**
     * Calls LibriVox with at most one of title/author. Trailing slash is required; title needs {@code ^} prefix.
     * Genre may be combined with title or author.
     */
    private List<BookItemDto> fetchLibriVoxBooks(String title, String author, String genre, int limit, int offset)
            throws Exception {
        StringBuilder url = new StringBuilder(trimSlash(librivoxBaseUrl))
                .append("/api/feed/audiobooks/?format=json&extended=1&coverart=1")
                .append("&limit=").append(limit)
                .append("&offset=").append(Math.max(0, offset));
        if (StringUtils.hasText(title) && title.trim().length() >= 2) {
            url.append("&title=").append(enc(librivoxPrefixQuery(title.trim())));
        } else if (StringUtils.hasText(author) && author.trim().length() >= 2) {
            url.append("&author=").append(enc(librivoxPrefixQuery(author.trim())));
        }
        if (StringUtils.hasText(genre)) {
            url.append("&genre=").append(enc(genre.trim()));
        }
        Optional<JsonNode> rootOpt = getJsonAllowingNotFound(url.toString());
        if (rootOpt.isEmpty()) {
            return List.of();
        }
        return mapLibriVoxBooks(rootOpt.get());
    }

    private List<BookItemDto> mapLibriVoxBooks(JsonNode root) {
        List<BookItemDto> books = new ArrayList<>();
        JsonNode booksNode = root.path("books");
        if (booksNode.isArray()) {
            for (JsonNode node : booksNode) {
                books.add(mapLibriVoxBook(node));
            }
        } else if (booksNode.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = booksNode.fields();
            while (fields.hasNext()) {
                books.add(mapLibriVoxBook(fields.next().getValue()));
            }
        }
        return books;
    }

    private static List<BookItemDto> filterLibriVoxByAuthor(List<BookItemDto> books, String author) {
        String needle = author.trim().toLowerCase(Locale.ROOT);
        List<BookItemDto> out = new ArrayList<>();
        for (BookItemDto b : books) {
            String authors = b.getAuthors() != null ? b.getAuthors().toLowerCase(Locale.ROOT) : "";
            if (authors.contains(needle)) {
                out.add(b);
            }
        }
        return out;
    }

    private static List<BookItemDto> filterLibriVoxByTitle(List<BookItemDto> books, String title) {
        String needle = title.trim().toLowerCase(Locale.ROOT);
        List<BookItemDto> out = new ArrayList<>();
        for (BookItemDto b : books) {
            String bookTitle = b.getTitle() != null ? b.getTitle().toLowerCase(Locale.ROOT) : "";
            if (bookTitle.contains(needle)) {
                out.add(b);
            }
        }
        return out;
    }

    private static List<BookItemDto> slicePage(List<BookItemDto> books, int offset, int limit) {
        if (books.isEmpty() || offset >= books.size()) {
            return List.of();
        }
        int from = Math.max(0, offset);
        int to = Math.min(books.size(), from + limit);
        return new ArrayList<>(books.subList(from, to));
    }

    public Optional<BookItemDto> getLibriVoxBook(String id) {
        if (!StringUtils.hasText(id)) {
            return Optional.empty();
        }
        String cleanId = id.trim();
        String cacheKey = "lv-detail|" + cleanId;
        BookItemDto cached = getCachedDetail(cacheKey);
        if (cached != null) {
            return Optional.of(cached);
        }
        try {
            String url = trimSlash(librivoxBaseUrl)
                    + "/api/feed/audiobooks/?format=json&extended=1&coverart=1&id=" + enc(cleanId);
            Optional<JsonNode> rootOpt = getJsonAllowingNotFound(url);
            if (rootOpt.isEmpty()) {
                return Optional.empty();
            }
            JsonNode root = rootOpt.get();
            JsonNode booksNode = root.path("books");
            JsonNode book = null;
            if (booksNode.isArray() && booksNode.size() > 0) {
                book = booksNode.get(0);
            } else if (booksNode.isObject()) {
                book = booksNode.path(cleanId);
                if (book.isMissingNode()) {
                    Iterator<JsonNode> it = booksNode.elements();
                    if (it.hasNext()) {
                        book = it.next();
                    }
                }
            }
            if (book == null || book.isMissingNode()) {
                return Optional.empty();
            }
            BookItemDto item = mapLibriVoxBook(book);
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("LibriVox detail failed for {}: {}", cleanId, e.toString());
            return Optional.empty();
        }
    }

    /**
     * Fetch remote text/html content through the backend (CORS + SSRF checks).
     */
    public Optional<FetchedContent> fetchContent(String upstreamUrl) {
        if (!StringUtils.hasText(upstreamUrl)) {
            return Optional.empty();
        }
        String url = upstreamUrl.trim();
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            return Optional.empty();
        }
        URI uri;
        try {
            uri = URI.create(url);
        } catch (Exception e) {
            return Optional.empty();
        }
        if (uri.getHost() == null || isBlockedHost(uri.getHost())) {
            return Optional.empty();
        }
        // Allowlist content hosts we actually use
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (!isAllowedContentHost(host)) {
            log.warn("Blocked book content host: {}", host);
            return Optional.empty();
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(45))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "text/plain, text/html, application/xhtml+xml, */*;q=0.1")
                    .GET()
                    .build();
            HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return Optional.empty();
            }
            byte[] body = response.body();
            if (body == null || body.length == 0 || body.length > MAX_CONTENT_BYTES) {
                if (body != null && body.length > MAX_CONTENT_BYTES) {
                    log.warn("Book content too large ({} bytes) for {}", body.length, url);
                }
                return Optional.empty();
            }
            String contentType = response.headers().firstValue("Content-Type").orElse("text/plain; charset=utf-8");
            String charset = charsetFromContentType(contentType);
            String text = new String(body, charset);
            return Optional.of(new FetchedContent(contentType, text));
        } catch (Exception e) {
            log.warn("Book content fetch failed for {}: {}", url, e.toString());
            return Optional.empty();
        }
    }

    public void invalidateCaches() {
        searchCache.clear();
        detailCache.clear();
    }

    // --- mappers ---

    private BookItemDto mapOpenLibraryDoc(JsonNode doc, String preferredLang) {
        BookItemDto item = new BookItemDto();
        item.setSource("openlibrary");
        String key = text(doc, "key");
        item.setId(key);
        item.setTitle(text(doc, "title"));
        item.setAuthors(joinArray(doc.path("author_name")));
        if (doc.has("first_publish_year") && doc.get("first_publish_year").canConvertToInt()) {
            item.setYear(doc.get("first_publish_year").asInt());
        }
        item.setLanguage(preferLanguage(doc.path("language"), preferredLang));
        item.setSubjects(joinArrayLimited(doc.path("subject"), 8));
        boolean hasFull = doc.path("has_fulltext").asBoolean(false)
                || doc.path("public_scan_b").asBoolean(false);
        item.setHasFulltext(hasFull);
        String ia = firstArray(doc.path("ia"));
        if (StringUtils.hasText(ia)) {
            item.setIaId(ia);
            item.setHasFulltext(true);
            // Prefer Archive.org embed reader (stream/..._djvu.txt often returns HTML/CSS, not plain text).
            item.setHtmlUrl("https://archive.org/embed/" + ia);
            item.setHomepage("https://archive.org/details/" + ia);
            // Direct download when available — never the /stream/ HTML wrapper.
            item.setTextUrl("https://archive.org/download/" + ia + "/" + ia + "_djvu.txt");
        } else if (StringUtils.hasText(key)) {
            item.setHomepage(trimSlash(openLibraryBaseUrl) + key);
        }
        int coverId = doc.path("cover_i").asInt(0);
        if (coverId > 0) {
            item.setCoverUrl("https://covers.openlibrary.org/b/id/" + coverId + "-M.jpg");
        }
        return item;
    }

    private BookItemDto mapOpenLibraryWork(JsonNode work, String key) {
        BookItemDto item = new BookItemDto();
        item.setSource("openlibrary");
        item.setId(key);
        item.setTitle(text(work, "title"));
        item.setDescription(extractDescription(work.path("description")));
        item.setSubjects(joinArrayLimited(work.path("subjects"), 12));
        item.setHomepage(trimSlash(openLibraryBaseUrl) + key);
        JsonNode covers = work.path("covers");
        if (covers.isArray() && covers.size() > 0) {
            item.setCoverUrl("https://covers.openlibrary.org/b/id/" + covers.get(0).asInt() + "-L.jpg");
        }
        return item;
    }

    private BookItemDto mapGutenbergBook(JsonNode node) {
        BookItemDto item = new BookItemDto();
        item.setSource("gutenberg");
        int id = node.path("id").asInt(0);
        item.setId(String.valueOf(id));
        item.setTitle(text(node, "title"));
        item.setAuthors(joinPersons(node.path("authors")));
        item.setLanguage(joinArray(node.path("languages")));
        item.setSubjects(joinArrayLimited(node.path("subjects"), 10));
        item.setDescription(firstArray(node.path("summaries")));
        item.setHomepage(id > 0 ? "https://www.gutenberg.org/ebooks/" + id : null);
        item.setHasFulltext(true);

        JsonNode formats = node.path("formats");
        if (formats.isObject()) {
            item.setTextUrl(pickFormat(formats,
                    "text/plain; charset=utf-8",
                    "text/plain; charset=us-ascii",
                    "text/plain"));
            item.setHtmlUrl(pickFormat(formats,
                    "text/html; charset=utf-8",
                    "text/html"));
            item.setEpubUrl(pickFormat(formats,
                    "application/epub+zip"));
            // Cover from image formats if present
            String cover = pickFormat(formats, "image/jpeg", "image/png");
            if (StringUtils.hasText(cover)) {
                item.setCoverUrl(cover);
            }
        }
        if (!StringUtils.hasText(item.getCoverUrl()) && id > 0) {
            item.setCoverUrl("https://www.gutenberg.org/cache/epub/" + id + "/pg" + id + ".cover.medium.jpg");
        }
        return item;
    }

    private BookItemDto mapLibriVoxBook(JsonNode node) {
        BookItemDto item = new BookItemDto();
        item.setSource("librivox");
        item.setId(text(node, "id"));
        item.setTitle(text(node, "title"));
        item.setAuthors(joinLibriVoxAuthors(node.path("authors")));
        item.setLanguage(text(node, "language"));
        item.setDescription(stripHtml(text(node, "description")));
        item.setSubjects(joinLibriVoxGenres(node.path("genres")));
        item.setHomepage(firstNonBlank(text(node, "url_librivox"), text(node, "url_project")));
        item.setTotalTime(text(node, "totaltime"));
        if (node.path("totaltimesecs").canConvertToInt()) {
            item.setTotalTimeSecs(node.path("totaltimesecs").asInt());
        }
        String cover = firstNonBlank(
                text(node, "url_iarchive"),
                text(node, "url_cover"),
                text(node.path("coverart_jpg"), "url"),
                text(node, "coverart_jpg"));
        // Prefer dedicated cover fields when present
        if (node.has("url_coverart") && StringUtils.hasText(text(node, "url_coverart"))) {
            cover = text(node, "url_coverart");
        }
        JsonNode coverJpg = node.path("coverart_jpg");
        if (coverJpg.isTextual() && StringUtils.hasText(coverJpg.asText())) {
            cover = coverJpg.asText();
        } else if (coverJpg.isObject() && StringUtils.hasText(text(coverJpg, "url"))) {
            cover = text(coverJpg, "url");
        }
        if (StringUtils.hasText(cover) && cover.contains("archive.org/details/")) {
            // Not a direct image — leave blank
            cover = null;
        }
        item.setCoverUrl(cover);
        item.setHasFulltext(false);

        List<BookSectionDto> sections = new ArrayList<>();
        JsonNode sectionsNode = node.path("sections");
        if (sectionsNode.isArray()) {
            for (JsonNode s : sectionsNode) {
                BookSectionDto sec = new BookSectionDto();
                sec.setId(text(s, "id"));
                sec.setTitle(text(s, "title"));
                if (s.path("section_number").canConvertToInt()) {
                    sec.setSectionNumber(s.path("section_number").asInt());
                }
                sec.setListenUrl(text(s, "listen_url"));
                if (s.path("playtime").canConvertToInt()) {
                    sec.setDurationSecs(s.path("playtime").asInt());
                } else if (s.path("playtime").isTextual()) {
                    sec.setDurationSecs(parsePlaytime(s.path("playtime").asText()));
                }
                sec.setReaders(joinLibriVoxReaders(s.path("readers")));
                if (StringUtils.hasText(sec.getListenUrl())) {
                    sections.add(sec);
                }
            }
        }
        item.setSections(sections);
        return item;
    }

    // --- HTTP / utils ---

    private JsonNode getJson(String url) throws Exception {
        Optional<JsonNode> node = getJsonAllowingNotFound(url);
        if (node.isEmpty()) {
            throw new IllegalStateException("HTTP 404 for " + url);
        }
        return node.get();
    }

    /**
     * GET JSON. LibriVox returns HTTP 404 with {@code {"error":"..."}} when a search has no hits —
     * that is treated as empty ({@link Optional#empty()}), not a hard failure.
     * HTTP 500 from LibriVox (known when title+author are combined) is also treated as empty.
     */
    private Optional<JsonNode> getJsonAllowingNotFound(String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        int code = response.statusCode();
        if (code == 404) {
            return Optional.empty();
        }
        // LibriVox occasionally returns 500 (e.g. combined title+author); treat as no hits.
        if (code == 500 && url.contains("librivox.org")) {
            return Optional.empty();
        }
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("HTTP " + code + " for " + url);
        }
        String body = response.body();
        if (!StringUtils.hasText(body)) {
            return Optional.empty();
        }
        JsonNode root = objectMapper.readTree(body);
        if (root != null && root.hasNonNull("error") && !root.has("books")) {
            return Optional.empty();
        }
        return Optional.ofNullable(root);
    }

    /** LibriVox title/author search is prefix-based and expects a leading {@code ^}. */
    private static String librivoxPrefixQuery(String raw) {
        String q = raw != null ? raw.trim() : "";
        if (q.isEmpty()) {
            return q;
        }
        if (q.startsWith("^")) {
            return q;
        }
        return "^" + q;
    }

    private static String normalizeGenreKey(String genre) {
        if (!StringUtils.hasText(genre)) {
            return "";
        }
        return genre.trim().toLowerCase(Locale.ROOT).replace(' ', '_').replace('-', '_');
    }

    private static GenreTerms resolveGenre(String genreKey) {
        if (!StringUtils.hasText(genreKey)) {
            return null;
        }
        return GENRE_TERMS.get(genreKey);
    }

    /**
     * Unified genre keys → source-specific subject/topic/genre strings (English catalogue terms).
     */
    private record GenreTerms(String openLibrarySubject, String gutendexTopic, String librivoxGenre) {
    }

    private static final Map<String, GenreTerms> GENRE_TERMS = Map.ofEntries(
            Map.entry("adventure", new GenreTerms("Adventure", "adventure", "Action & Adventure")),
            Map.entry("mystery", new GenreTerms("Detective and mystery stories", "detective", "Detective Fiction")),
            Map.entry("crime", new GenreTerms("Crime", "crime", "Detective Fiction")),
            Map.entry("scifi", new GenreTerms("Science Fiction", "science fiction", "Science fiction")),
            Map.entry("fantasy", new GenreTerms("Fantasy", "fantasy", "Fantasy")),
            Map.entry("romance", new GenreTerms("Love stories", "romance", "Romance")),
            Map.entry("horror", new GenreTerms("Horror tales", "horror", "Horror")),
            Map.entry("thriller", new GenreTerms("Thrillers", "thriller", "Thrillers")),
            Map.entry("history", new GenreTerms("History", "history", "History")),
            Map.entry("historical", new GenreTerms("Historical fiction", "historical fiction", "Historical Fiction")),
            Map.entry("poetry", new GenreTerms("Poetry", "poetry", "Poetry")),
            Map.entry("children", new GenreTerms("Juvenile fiction", "juvenile", "Children's Fiction")),
            Map.entry("biography", new GenreTerms("Biography", "biography", "Biography")),
            Map.entry("philosophy", new GenreTerms("Philosophy", "philosophy", "Philosophy")),
            Map.entry("humor", new GenreTerms("Humor", "humor", "Humor")),
            Map.entry("war", new GenreTerms("War stories", "war", "War & Military")),
            Map.entry("western", new GenreTerms("Western stories", "western", "Westerns")),
            Map.entry("drama", new GenreTerms("Drama", "drama", "Dramatic Readings")),
            Map.entry("fairy", new GenreTerms("Fairy tales", "fairy tales", "Fairy tales")),
            Map.entry("mythology", new GenreTerms("Mythology", "mythology", "Myths, Legends & Fairy Tales"))
    );

    private BookSearchPageDto getCachedSearch(String key) {
        CacheEntry<BookSearchPageDto> entry = searchCache.get(key);
        if (entry != null && !entry.isExpired(searchCacheMinutes)) {
            return entry.value;
        }
        return null;
    }

    private BookItemDto getCachedDetail(String key) {
        CacheEntry<BookItemDto> entry = detailCache.get(key);
        if (entry != null && !entry.isExpired(searchCacheMinutes)) {
            return entry.value;
        }
        return null;
    }

    private static BookSearchPageDto emptyPage(String source, String query, int limit, int offset) {
        return new BookSearchPageDto(source, query, 0, limit, offset, List.of());
    }

    private static String normalizeOlKey(String workKey) {
        if (!StringUtils.hasText(workKey)) {
            return null;
        }
        String k = workKey.trim();
        if (!k.startsWith("/")) {
            k = "/" + k;
        }
        if (!k.startsWith("/works/") && !k.startsWith("/books/")) {
            if (k.contains("OL") && k.toUpperCase(Locale.ROOT).endsWith("W")) {
                k = "/works/" + k.replace("/", "");
            } else {
                return null;
            }
        }
        return k;
    }

    private static String pickFormat(JsonNode formats, String... mimeKeys) {
        for (String mime : mimeKeys) {
            JsonNode n = formats.path(mime);
            if (n.isTextual() && StringUtils.hasText(n.asText())) {
                return n.asText();
            }
        }
        // Soft match: any key starting with the prefix
        for (String mime : mimeKeys) {
            String prefix = mime.contains(";") ? mime.substring(0, mime.indexOf(';')) : mime;
            Iterator<Map.Entry<String, JsonNode>> it = formats.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                if (e.getKey().toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT))
                        && e.getValue().isTextual() && StringUtils.hasText(e.getValue().asText())) {
                    return e.getValue().asText();
                }
            }
        }
        return null;
    }

    private static String joinPersons(JsonNode authors) {
        if (!authors.isArray()) {
            return "";
        }
        List<String> names = new ArrayList<>();
        for (JsonNode a : authors) {
            String name = text(a, "name");
            if (StringUtils.hasText(name)) {
                names.add(name);
            }
        }
        return String.join(", ", names);
    }

    private static String joinLibriVoxAuthors(JsonNode authors) {
        if (!authors.isArray()) {
            return "";
        }
        List<String> names = new ArrayList<>();
        for (JsonNode a : authors) {
            String first = text(a, "first_name");
            String last = text(a, "last_name");
            String full = (first + " " + last).trim();
            if (StringUtils.hasText(full)) {
                names.add(full);
            }
        }
        return String.join(", ", names);
    }

    private static String joinLibriVoxGenres(JsonNode genres) {
        if (genres == null || genres.isMissingNode() || genres.isNull()) {
            return "";
        }
        List<String> names = new ArrayList<>();
        if (genres.isArray()) {
            for (JsonNode g : genres) {
                String name = firstNonBlank(text(g, "name"), g.isTextual() ? g.asText() : "");
                if (StringUtils.hasText(name) && names.size() < 8) {
                    names.add(name.trim());
                }
            }
        } else if (genres.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = genres.fields();
            while (fields.hasNext() && names.size() < 8) {
                JsonNode g = fields.next().getValue();
                String name = firstNonBlank(text(g, "name"), g.isTextual() ? g.asText() : "");
                if (StringUtils.hasText(name)) {
                    names.add(name.trim());
                }
            }
        }
        return String.join(", ", names);
    }

    private static String joinLibriVoxReaders(JsonNode readers) {
        if (!readers.isArray()) {
            return "";
        }
        List<String> names = new ArrayList<>();
        for (JsonNode r : readers) {
            String name = text(r, "display_name");
            if (StringUtils.hasText(name)) {
                names.add(name);
            }
        }
        return String.join(", ", names);
    }

    private static String joinArray(JsonNode arr) {
        return joinArrayLimited(arr, Integer.MAX_VALUE);
    }

    private static String joinArrayLimited(JsonNode arr, int max) {
        if (!arr.isArray()) {
            return "";
        }
        List<String> parts = new ArrayList<>();
        int n = 0;
        for (JsonNode v : arr) {
            if (n >= max) {
                break;
            }
            if (v.isTextual() && StringUtils.hasText(v.asText())) {
                parts.add(v.asText());
                n++;
            }
        }
        return String.join(", ", parts);
    }

    private static String firstArray(JsonNode arr) {
        if (arr.isArray() && arr.size() > 0 && arr.get(0).isTextual()) {
            return arr.get(0).asText();
        }
        return "";
    }

    /**
     * Open Library works list every edition language. Prefer the active filter code when present,
     * otherwise the first code (so a French filter does not display "amh" for Hamlet).
     */
    private static String preferLanguage(JsonNode languages, String preferred) {
        if (!languages.isArray() || languages.size() == 0) {
            return "";
        }
        String want = preferred != null ? preferred.trim().toLowerCase(Locale.ROOT) : "";
        if (StringUtils.hasText(want)) {
            for (JsonNode n : languages) {
                if (n.isTextual() && want.equals(n.asText().trim().toLowerCase(Locale.ROOT))) {
                    return n.asText();
                }
            }
        }
        return firstArray(languages);
    }

    private static String extractDescription(JsonNode desc) {
        if (desc == null || desc.isMissingNode() || desc.isNull()) {
            return "";
        }
        if (desc.isTextual()) {
            return desc.asText();
        }
        if (desc.isObject()) {
            return text(desc, "value");
        }
        return "";
    }

    private static String stripHtml(String html) {
        if (!StringUtils.hasText(html)) {
            return "";
        }
        return html.replaceAll("(?s)<[^>]*>", " ").replaceAll("\\s+", " ").trim();
    }

    private static Integer parsePlaytime(String playtime) {
        if (!StringUtils.hasText(playtime)) {
            return null;
        }
        try {
            return Integer.parseInt(playtime.trim());
        } catch (NumberFormatException ignored) {
            String[] parts = playtime.trim().split(":");
            try {
                if (parts.length == 3) {
                    return Integer.parseInt(parts[0]) * 3600
                            + Integer.parseInt(parts[1]) * 60
                            + Integer.parseInt(parts[2]);
                }
                if (parts.length == 2) {
                    return Integer.parseInt(parts[0]) * 60 + Integer.parseInt(parts[1]);
                }
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private static String text(JsonNode node, String field) {
        JsonNode n = node.path(field);
        return n.isTextual() || n.isNumber() ? n.asText() : "";
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String v : values) {
            if (StringUtils.hasText(v)) {
                return v;
            }
        }
        return null;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String trimSlash(String base) {
        if (base == null) {
            return "";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static int clamp(int value, int min, int max, int fallback) {
        if (value <= 0) {
            return fallback;
        }
        return Math.max(min, Math.min(max, value));
    }

    private static boolean isAllowedContentHost(String host) {
        return host.equals("www.gutenberg.org")
                || host.equals("gutenberg.org")
                || host.endsWith(".gutenberg.org")
                || host.equals("archive.org")
                || host.endsWith(".archive.org")
                || host.equals("openlibrary.org")
                || host.endsWith(".openlibrary.org")
                || host.equals("gutendex.com")
                || host.endsWith(".gutendex.com");
    }

    private static boolean isBlockedHost(String host) {
        if (host == null || host.isBlank()) {
            return true;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(h) || h.endsWith(".localhost") || h.endsWith(".local")) {
            return true;
        }
        try {
            InetAddress addr = InetAddress.getByName(h);
            if (addr.isAnyLocalAddress() || addr.isLoopbackAddress() || addr.isLinkLocalAddress()
                    || addr.isSiteLocalAddress()) {
                return true;
            }
        } catch (UnknownHostException e) {
            return true;
        }
        return false;
    }

    private static String charsetFromContentType(String contentType) {
        if (contentType == null) {
            return "UTF-8";
        }
        String lower = contentType.toLowerCase(Locale.ROOT);
        int idx = lower.indexOf("charset=");
        if (idx >= 0) {
            String cs = contentType.substring(idx + 8).trim();
            int semi = cs.indexOf(';');
            if (semi >= 0) {
                cs = cs.substring(0, semi).trim();
            }
            cs = cs.replace("\"", "");
            try {
                return java.nio.charset.Charset.forName(cs).name();
            } catch (Exception ignored) {
                // fall through
            }
        }
        return "UTF-8";
    }

    public static final class FetchedContent {
        private final String contentType;
        private final String body;

        public FetchedContent(String contentType, String body) {
            this.contentType = contentType;
            this.body = body;
        }

        public String getContentType() {
            return contentType;
        }

        public String getBody() {
            return body;
        }
    }

    private static final class CacheEntry<T> {
        private final T value;
        private final Instant loadedAt = Instant.now();

        private CacheEntry(T value) {
            this.value = value;
        }

        private boolean isExpired(int minutes) {
            return Instant.now().isAfter(loadedAt.plus(Duration.ofMinutes(Math.max(1, minutes))));
        }
    }
}
