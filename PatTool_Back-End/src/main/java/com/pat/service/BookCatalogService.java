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
 * Catalog + content helpers for Open Library, Project Gutenberg (Gutendex), LibriVox,
 * Internet Archive, Google Books (free ebooks) and Standard Ebooks.
 */
@Service
public class BookCatalogService {

    private static final Logger log = LoggerFactory.getLogger(BookCatalogService.class);
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/124.0.0.0 Safari/537.36";
    private static final int MAX_CONTENT_BYTES = 8 * 1024 * 1024;
    /** Pause Google Books calls after a 429 so we do not keep burning anonymous quota. */
    private static final long GOOGLE_BOOKS_BACKOFF_ON_429_MS = 120_000L;
    /** Prefer curated / book-like IA collections over court docs &amp; raw uploads. */
    private static final String IA_BOOK_SCOPE =
            "mediatype:texts AND (collection:gutenberg OR collection:americana"
                    + " OR collection:internetarchivebooks OR collection:inlibrary"
                    + " OR collection:opensource)";

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private volatile long googleBooksBackoffUntilMs = 0;

    @Value("${app.book.openlibrary-base-url:https://openlibrary.org}")
    private String openLibraryBaseUrl;

    @Value("${app.book.gutendex-base-url:https://gutendex.com}")
    private String gutendexBaseUrl;

    @Value("${app.book.librivox-base-url:https://librivox.org}")
    private String librivoxBaseUrl;

    @Value("${app.book.archive-base-url:https://archive.org}")
    private String archiveBaseUrl;

    @Value("${app.book.google-books-base-url:https://www.googleapis.com/books/v1}")
    private String googleBooksBaseUrl;

    /** Optional; without a key Google Books may throttle anonymous quota. */
    @Value("${app.book.google-api-key:}")
    private String googleBooksApiKey;

    @Value("${app.book.standardebooks-base-url:https://standardebooks.org}")
    private String standardEbooksBaseUrl;

    @Value("${app.book.search-cache-minutes:15}")
    private int searchCacheMinutes;

    private final ConcurrentHashMap<String, CacheEntry<BookSearchPageDto>> searchCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CacheEntry<BookItemDto>> detailCache = new ConcurrentHashMap<>();

    public BookCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public BookSearchPageDto searchOpenLibrary(String q, int limit, int offset, String language) {
        return searchOpenLibrary(q, limit, offset, language, null, null);
    }

    public BookSearchPageDto searchOpenLibrary(String q, int limit, int offset, String language, String genre) {
        return searchOpenLibrary(q, limit, offset, language, genre, null);
    }

    public BookSearchPageDto searchOpenLibrary(String q, int limit, int offset, String language, String genre,
                                               String author) {
        String query = q != null ? q.trim() : "";
        String authorQ = author != null ? author.trim() : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        if (query.length() < 2 && authorQ.length() < 2 && terms == null) {
            return emptyPage("openlibrary", query, limit, offset);
        }
        int safeLimit = clamp(limit, 1, 40, 20);
        int safeOffset = Math.max(0, offset);
        String lang = language != null ? language.trim().toLowerCase(Locale.ROOT) : "";
        String cacheKey = "ol|v2|" + query.toLowerCase(Locale.ROOT) + "|" + authorQ.toLowerCase(Locale.ROOT)
                + "|" + safeLimit + "|" + safeOffset + "|" + lang + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            StringBuilder searchQ = new StringBuilder();
            if (query.length() >= 2) {
                // Prefer title field when an author filter is also set
                if (authorQ.length() >= 2) {
                    searchQ.append(fieldedOlTerm("title", query));
                } else {
                    searchQ.append(query);
                }
            }
            if (authorQ.length() >= 2) {
                if (searchQ.length() > 0) {
                    searchQ.append(' ');
                }
                searchQ.append(fieldedOlTerm("author", authorQ));
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
            // Nested editions: when language: is set, OL returns matching editions (localized title/cover/IA).
            if (StringUtils.hasText(lang)) {
                url.append(",editions");
            }
            JsonNode root = getJson(url.toString());
            int total = root.path("numFound").asInt(root.path("num_found").asInt(0));
            List<BookItemDto> books = new ArrayList<>();
            JsonNode docs = root.path("docs");
            if (docs.isArray()) {
                for (JsonNode doc : docs) {
                    books.add(mapOpenLibraryDoc(doc, lang));
                }
            }
            String label = query.length() >= 2 ? query
                    : (authorQ.length() >= 2 ? authorQ : genreKey);
            BookSearchPageDto page = new BookSearchPageDto("openlibrary",
                    label, total, safeLimit, safeOffset, books);
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
        return searchGutenberg(q, languages, page, null, null);
    }

    public BookSearchPageDto searchGutenberg(String q, String languages, int page, String genre) {
        return searchGutenberg(q, languages, page, genre, null);
    }

    public BookSearchPageDto searchGutenberg(String q, String languages, int page, String genre, String author) {
        String query = q != null ? q.trim() : "";
        String authorQ = author != null ? author.trim() : "";
        int safePage = Math.max(1, page);
        String langs = languages != null ? languages.trim().toLowerCase(Locale.ROOT) : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        // Gutendex `search` matches title + author fields; combine both when present.
        String combinedSearch = joinSearchTerms(query, authorQ);
        String cacheKey = "gb|" + query.toLowerCase(Locale.ROOT) + "|" + authorQ.toLowerCase(Locale.ROOT)
                + "|" + langs + "|" + safePage + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            StringBuilder url = new StringBuilder(trimSlash(gutendexBaseUrl)).append("/books/?");
            boolean first = true;
            if (combinedSearch.length() >= 2) {
                url.append("search=").append(enc(combinedSearch));
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
            String label = query.length() >= 2 ? query
                    : (authorQ.length() >= 2 ? authorQ : genreKey);
            BookSearchPageDto pageDto = new BookSearchPageDto("gutenberg",
                    label, total, 32, offset, books);
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
        return searchLibriVox(title, author, limit, offset, null, null);
    }

    public BookSearchPageDto searchLibriVox(String title, String author, int limit, int offset, String genre) {
        return searchLibriVox(title, author, limit, offset, genre, null);
    }

    public BookSearchPageDto searchLibriVox(String title, String author, int limit, int offset, String genre,
                                           String language) {
        String t = title != null ? title.trim() : "";
        String a = author != null ? author.trim() : "";
        int safeLimit = clamp(limit, 1, 50, 25);
        int safeOffset = Math.max(0, offset);
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        String lvGenre = terms != null ? terms.librivoxGenre() : "";
        // LibriVox API has no language param — filter on returned language field (e.g. "French").
        String lvLanguage = mapLanguageForLibriVox(language);
        // Allow browse (no query) or search with ≥2 chars or genre / language filter
        boolean browsing = t.length() < 2 && a.length() < 2 && !StringUtils.hasText(lvGenre)
                && !StringUtils.hasText(lvLanguage);
        String queryLabel = browsing ? "" : (t.isEmpty()
                ? (a.isEmpty() ? (StringUtils.hasText(genreKey) ? genreKey : lvLanguage) : a)
                : t);
        String cacheKey = "lv|" + t.toLowerCase(Locale.ROOT) + "|" + a.toLowerCase(Locale.ROOT)
                + "|" + safeLimit + "|" + safeOffset + "|" + genreKey + "|" + lvLanguage.toLowerCase(Locale.ROOT);
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            // LibriVox returns HTTP 500 whenever title AND author are both sent — never combine them.
            // Genre can be combined with title OR author. Language is post-filtered (API unsupported).
            boolean hasTitle = t.length() >= 2;
            boolean hasAuthor = a.length() >= 2;
            boolean filterLang = StringUtils.hasText(lvLanguage);
            List<BookItemDto> books;
            if (hasTitle && hasAuthor) {
                if (filterLang) {
                    books = fetchLibriVoxBooksFiltered(t, null, lvGenre, lvLanguage, safeLimit, safeOffset);
                    books = filterLibriVoxByAuthor(books, a);
                    if (books.isEmpty()) {
                        books = fetchLibriVoxBooksFiltered(null, a, lvGenre, lvLanguage,
                                Math.min(50, Math.max(safeLimit * 3, safeLimit)), 0);
                        books = filterLibriVoxByTitle(books, t);
                        books = slicePage(books, safeOffset, safeLimit);
                    }
                } else {
                    books = fetchLibriVoxBooks(t, null, lvGenre, safeLimit, safeOffset);
                    books = filterLibriVoxByAuthor(books, a);
                    if (books.isEmpty()) {
                        books = fetchLibriVoxBooks(null, a, lvGenre, Math.min(50, Math.max(safeLimit * 3, safeLimit)), 0);
                        books = filterLibriVoxByTitle(books, t);
                        books = slicePage(books, safeOffset, safeLimit);
                    }
                }
            } else if (hasTitle) {
                books = filterLang
                        ? fetchLibriVoxBooksFiltered(t, null, lvGenre, lvLanguage, safeLimit, safeOffset)
                        : fetchLibriVoxBooks(t, null, lvGenre, safeLimit, safeOffset);
            } else if (hasAuthor) {
                books = filterLang
                        ? fetchLibriVoxBooksFiltered(null, a, lvGenre, lvLanguage, safeLimit, safeOffset)
                        : fetchLibriVoxBooks(null, a, lvGenre, safeLimit, safeOffset);
            } else {
                books = filterLang
                        ? fetchLibriVoxBooksFiltered(null, null, lvGenre, lvLanguage, safeLimit, safeOffset)
                        : fetchLibriVoxBooks(null, null, lvGenre, safeLimit, safeOffset);
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

    /**
     * LibriVox API does not support {@code language=} — scan batches and keep books whose
     * {@code language} field matches (e.g. French). Skips {@code offset} matches then takes {@code limit}.
     */
    private List<BookItemDto> fetchLibriVoxBooksFiltered(String title, String author, String genre,
                                                         String languageName, int limit, int offset)
            throws Exception {
        List<BookItemDto> collected = new ArrayList<>();
        int skip = Math.max(0, offset);
        int rawOffset = 0;
        final int batchSize = 50;
        final int maxScan = 1000;
        while (collected.size() < limit && rawOffset < maxScan) {
            List<BookItemDto> batch = fetchLibriVoxBooks(title, author, genre, batchSize, rawOffset);
            if (batch.isEmpty()) {
                break;
            }
            for (BookItemDto book : batch) {
                if (!matchesLibriVoxLanguage(book.getLanguage(), languageName)) {
                    continue;
                }
                if (skip > 0) {
                    skip--;
                    continue;
                }
                collected.add(book);
                if (collected.size() >= limit) {
                    break;
                }
            }
            rawOffset += batch.size();
            if (batch.size() < batchSize) {
                break;
            }
        }
        return collected;
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

    // --- Internet Archive ---

    public BookSearchPageDto searchInternetArchive(String q, int limit, int offset, String language,
                                                     String genre, String author) {
        String query = q != null ? q.trim() : "";
        String authorQ = author != null ? author.trim() : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        if (query.length() < 2 && authorQ.length() < 2 && terms == null) {
            return emptyPage("archive", query, limit, offset);
        }
        int safeLimit = clamp(limit, 1, 40, 20);
        int safeOffset = Math.max(0, offset);
        String lang = language != null ? language.trim().toLowerCase(Locale.ROOT) : "";
        String cacheKey = "ia|" + query.toLowerCase(Locale.ROOT) + "|" + authorQ.toLowerCase(Locale.ROOT)
                + "|" + safeLimit + "|" + safeOffset + "|" + lang + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        try {
            StringBuilder lucene = new StringBuilder(IA_BOOK_SCOPE);
            if (query.length() >= 2) {
                lucene.append(" AND title:(").append(escapeIaQuery(query)).append(')');
            }
            if (authorQ.length() >= 2) {
                lucene.append(" AND creator:(").append(escapeIaQuery(authorQ)).append(')');
            }
            if (terms != null) {
                lucene.append(" AND subject:(").append(escapeIaQuery(terms.openLibrarySubject())).append(')');
            }
            if (StringUtils.hasText(lang)) {
                lucene.append(" AND language:(").append(escapeIaQuery(mapLanguageForArchive(lang))).append(')');
            }
            int page = (safeOffset / safeLimit) + 1;
            String url = trimSlash(archiveBaseUrl) + "/advancedsearch.php?q=" + enc(lucene.toString())
                    + "&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=language"
                    + "&fl[]=description&fl[]=subject"
                    + "&rows=" + safeLimit + "&page=" + page + "&output=json";
            JsonNode root = getJson(url);
            JsonNode response = root.path("response");
            int total = response.path("numFound").asInt(0);
            List<BookItemDto> books = new ArrayList<>();
            JsonNode docs = response.path("docs");
            if (docs.isArray()) {
                for (JsonNode doc : docs) {
                    books.add(mapArchiveDoc(doc));
                }
            }
            String label = query.length() >= 2 ? query
                    : (authorQ.length() >= 2 ? authorQ : genreKey);
            BookSearchPageDto pageDto = new BookSearchPageDto("archive", label, total, safeLimit, safeOffset, books);
            searchCache.put(cacheKey, new CacheEntry<>(pageDto));
            return pageDto;
        } catch (Exception e) {
            log.warn("Internet Archive search failed for '{}': {}", query, e.toString());
            return emptyPage("archive", query, safeLimit, safeOffset);
        }
    }

    public Optional<BookItemDto> getInternetArchiveItem(String identifier) {
        if (!StringUtils.hasText(identifier)) {
            return Optional.empty();
        }
        String id = identifier.trim();
        String cacheKey = "ia-detail|" + id;
        BookItemDto cached = getCachedDetail(cacheKey);
        if (cached != null) {
            return Optional.of(cached);
        }
        try {
            JsonNode root = getJson(trimSlash(archiveBaseUrl) + "/metadata/" + enc(id));
            JsonNode meta = root.path("metadata");
            if (meta.isMissingNode() || meta.isNull()) {
                return Optional.empty();
            }
            BookItemDto item = mapArchiveMetadata(meta, id);
            applyArchiveReadableText(item, root.path("files"), meta, id);
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("Internet Archive metadata failed for {}: {}", id, e.toString());
            return Optional.empty();
        }
    }

    // --- Google Books (free ebooks) ---

    public BookSearchPageDto searchGoogleBooks(String q, int limit, int offset, String language,
                                                 String genre, String author) {
        String query = q != null ? q.trim() : "";
        String authorQ = author != null ? author.trim() : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        if (query.length() < 2 && authorQ.length() < 2 && terms == null) {
            return emptyPage("googlebooks", query, limit, offset);
        }
        int safeLimit = clamp(limit, 1, 40, 20);
        int safeOffset = Math.max(0, offset);
        String lang = language != null ? language.trim().toLowerCase(Locale.ROOT) : "";
        String cacheKey = "gbooks|" + query.toLowerCase(Locale.ROOT) + "|" + authorQ.toLowerCase(Locale.ROOT)
                + "|" + safeLimit + "|" + safeOffset + "|" + lang + "|" + genreKey;
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }
        if (isGoogleBooksInBackoff()) {
            return rateLimitedPage("googlebooks", query, safeLimit, safeOffset);
        }

        try {
            StringBuilder qParts = new StringBuilder();
            if (query.length() >= 2) {
                if (authorQ.length() >= 2) {
                    qParts.append("intitle:").append(quoteGoogleTerm(query));
                } else {
                    qParts.append(query);
                }
            }
            if (authorQ.length() >= 2) {
                if (qParts.length() > 0) {
                    qParts.append(' ');
                }
                qParts.append("inauthor:").append(quoteGoogleTerm(authorQ));
            }
            if (terms != null) {
                if (qParts.length() > 0) {
                    qParts.append(' ');
                }
                qParts.append("subject:").append(quoteGoogleTerm(terms.openLibrarySubject()));
            }
            if (qParts.length() == 0) {
                qParts.append("subject:").append(terms != null ? terms.openLibrarySubject() : "fiction");
            }
            StringBuilder url = new StringBuilder(trimSlash(googleBooksBaseUrl))
                    .append("/volumes?q=").append(enc(qParts.toString()))
                    .append("&filter=free-ebooks&printType=books&maxResults=")
                    .append(safeLimit)
                    .append("&startIndex=").append(safeOffset);
            String langRestrict = mapLanguageForGoogle(lang);
            if (StringUtils.hasText(langRestrict)) {
                url.append("&langRestrict=").append(enc(langRestrict));
            }
            appendGoogleBooksApiKey(url);
            JsonNode root = getJson(url.toString());
            int total = root.path("totalItems").asInt(0);
            List<BookItemDto> books = new ArrayList<>();
            JsonNode items = root.path("items");
            if (items.isArray()) {
                for (JsonNode node : items) {
                    books.add(mapGoogleVolume(node));
                }
            }
            String label = query.length() >= 2 ? query
                    : (authorQ.length() >= 2 ? authorQ : genreKey);
            BookSearchPageDto page = new BookSearchPageDto("googlebooks", label, total, safeLimit, safeOffset, books);
            searchCache.put(cacheKey, new CacheEntry<>(page));
            return page;
        } catch (Exception e) {
            if (isGoogleBooksRateLimited(e)) {
                markGoogleBooksRateLimited();
                log.warn("Google Books rate limited (429) for '{}'; backing off ~{} s. "
                                + "Set app.book.google-api-key for higher quota (anonymous quota is often exhausted).",
                        query, GOOGLE_BOOKS_BACKOFF_ON_429_MS / 1000);
                return rateLimitedPage("googlebooks", query, safeLimit, safeOffset);
            }
            log.warn("Google Books search failed for '{}': {}", query, e.toString());
            return emptyPage("googlebooks", query, safeLimit, safeOffset);
        }
    }

    public Optional<BookItemDto> getGoogleBook(String volumeId) {
        if (!StringUtils.hasText(volumeId)) {
            return Optional.empty();
        }
        String id = volumeId.trim();
        String cacheKey = "gbooks-detail|" + id;
        BookItemDto cached = getCachedDetail(cacheKey);
        if (cached != null) {
            return Optional.of(cached);
        }
        if (isGoogleBooksInBackoff()) {
            return Optional.empty();
        }
        try {
            StringBuilder url = new StringBuilder(trimSlash(googleBooksBaseUrl))
                    .append("/volumes/").append(enc(id));
            appendGoogleBooksApiKey(url);
            JsonNode node = getJson(url.toString());
            BookItemDto item = mapGoogleVolume(node);
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            if (isGoogleBooksRateLimited(e)) {
                markGoogleBooksRateLimited();
                log.warn("Google Books rate limited (429) for volume {}; backing off ~{} s. "
                                + "Set app.book.google-api-key for higher quota.",
                        id, GOOGLE_BOOKS_BACKOFF_ON_429_MS / 1000);
            } else {
                log.warn("Google Books volume fetch failed for {}: {}", id, e.toString());
            }
            return Optional.empty();
        }
    }

    private void appendGoogleBooksApiKey(StringBuilder url) {
        if (StringUtils.hasText(googleBooksApiKey)) {
            url.append(url.indexOf("?") >= 0 ? "&" : "?").append("key=")
                    .append(enc(googleBooksApiKey.trim()));
        }
    }

    private boolean isGoogleBooksInBackoff() {
        return System.currentTimeMillis() < googleBooksBackoffUntilMs;
    }

    private void markGoogleBooksRateLimited() {
        googleBooksBackoffUntilMs = System.currentTimeMillis() + GOOGLE_BOOKS_BACKOFF_ON_429_MS;
    }

    private static boolean isGoogleBooksRateLimited(Exception e) {
        if (e == null) {
            return false;
        }
        String msg = e.toString();
        return msg.contains("HTTP 429") || msg.contains("HTTP 403");
    }

    // --- Standard Ebooks (public HTML search + Atom new-releases; full OPDS is patrons-only) ---

    public BookSearchPageDto searchStandardEbooks(String q, int limit, int offset, String genre, String author) {
        return searchStandardEbooks(q, limit, offset, genre, author, null);
    }

    public BookSearchPageDto searchStandardEbooks(String q, int limit, int offset, String genre, String author,
                                                  String language) {
        String query = q != null ? q.trim() : "";
        String authorQ = author != null ? author.trim() : "";
        String genreKey = normalizeGenreKey(genre);
        GenreTerms terms = resolveGenre(genreKey);
        int safeLimit = clamp(limit, 1, 40, 20);
        int safeOffset = Math.max(0, offset);
        // Standard Ebooks publishes English editions only — non-English filters yield an empty page.
        String seLang = mapLanguageForLibriVox(language);
        String cacheKey = "se|" + query.toLowerCase(Locale.ROOT) + "|" + authorQ.toLowerCase(Locale.ROOT)
                + "|" + safeLimit + "|" + safeOffset + "|" + genreKey + "|" + seLang.toLowerCase(Locale.ROOT);
        BookSearchPageDto cached = getCachedSearch(cacheKey);
        if (cached != null) {
            return cached;
        }

        String label = query.length() >= 2 ? query
                : (authorQ.length() >= 2 ? authorQ
                : (StringUtils.hasText(genreKey) ? genreKey : seLang));
        if (StringUtils.hasText(seLang) && !"English".equalsIgnoreCase(seLang)) {
            BookSearchPageDto empty = emptyPage("standardebooks", label, safeLimit, safeOffset);
            searchCache.put(cacheKey, new CacheEntry<>(empty));
            return empty;
        }

        try {
            List<BookItemDto> books;
            int total;
            boolean browsing = query.length() < 2 && authorQ.length() < 2 && terms == null;
            if (browsing) {
                books = fetchStandardEbooksNewReleases();
                total = books.size();
                label = "";
                books = slicePage(books, safeOffset, safeLimit);
            } else {
                String searchQ = joinSearchTerms(query, authorQ);
                if (searchQ.length() < 2 && terms != null) {
                    searchQ = terms.openLibrarySubject();
                }
                int page = (safeOffset / safeLimit) + 1;
                List<BookItemDto> fetched = fetchStandardEbooksHtmlSearch(searchQ, page);
                if (terms != null && StringUtils.hasText(terms.openLibrarySubject())) {
                    fetched = filterBySubjectContains(fetched, terms.openLibrarySubject());
                }
                books = fetched.size() > safeLimit ? fetched.subList(0, safeLimit) : fetched;
                // SE HTML has no reliable total; approximate like LibriVox paging.
                total = books.size() < safeLimit ? safeOffset + books.size() : safeOffset + books.size() + 1;
                label = query.length() >= 2 ? query
                        : (authorQ.length() >= 2 ? authorQ : genreKey);
            }
            for (BookItemDto book : books) {
                if (!StringUtils.hasText(book.getLanguage())) {
                    book.setLanguage("English");
                }
            }
            BookSearchPageDto pageDto = new BookSearchPageDto("standardebooks", label, total, safeLimit, safeOffset, books);
            searchCache.put(cacheKey, new CacheEntry<>(pageDto));
            return pageDto;
        } catch (Exception e) {
            log.warn("Standard Ebooks search failed for '{}': {}", query, e.toString());
            return emptyPage("standardebooks", query, safeLimit, safeOffset);
        }
    }

    public Optional<BookItemDto> getStandardEbook(String pathOrId) {
        String path = normalizeSePath(pathOrId);
        if (!StringUtils.hasText(path)) {
            return Optional.empty();
        }
        String cacheKey = "se-detail|" + path;
        BookItemDto cached = getCachedDetail(cacheKey);
        if (cached != null) {
            return Optional.of(cached);
        }
        try {
            String url = trimSlash(standardEbooksBaseUrl) + path;
            String html = getText(url, "text/html,application/xhtml+xml,*/*;q=0.1");
            if (!StringUtils.hasText(html)) {
                return Optional.empty();
            }
            org.jsoup.nodes.Document doc = org.jsoup.Jsoup.parse(html, url);
            BookItemDto item = mapStandardEbookPage(doc, path);
            detailCache.put(cacheKey, new CacheEntry<>(item));
            return Optional.of(item);
        } catch (Exception e) {
            log.warn("Standard Ebooks detail failed for {}: {}", path, e.toString());
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
        String url = normalizeGutenbergContentUrl(upstreamUrl.trim());
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
                log.warn("Book content HTTP {} for {}", response.statusCode(), url);
                // Fallback: Gutendex often points at /ebooks/N.txt.utf-8 which some stacks mishandle;
                // try the stable /cache/epub/ path once more if we have not already rewritten.
                String alt = gutenbergCacheFallback(url);
                if (alt != null && !alt.equals(url)) {
                    return fetchContent(alt);
                }
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
            String alt = gutenbergCacheFallback(url);
            if (alt != null && !alt.equals(url)) {
                try {
                    return fetchContent(alt);
                } catch (Exception ignored) {
                    // fall through
                }
            }
            return Optional.empty();
        }
    }

    /**
     * Rewrite Project Gutenberg "pretty" download URLs to stable cache paths.
     * {@code /ebooks/1513.txt.utf-8} redirects to {@code /cache/epub/1513/pg1513.txt};
     * following that redirect fails in some Java HTTP client environments (502 via our proxy).
     */
    static String normalizeGutenbergContentUrl(String url) {
        if (!StringUtils.hasText(url)) {
            return url;
        }
        String alt = gutenbergCacheFallback(url);
        return alt != null ? alt : url;
    }

    /** @return cache/epub URL or {@code null} if not a Gutenberg ebooks download link */
    private static String gutenbergCacheFallback(String url) {
        if (url == null || !url.toLowerCase(Locale.ROOT).contains("gutenberg.org/ebooks/")) {
            return null;
        }
        // .../ebooks/1513.txt.utf-8 or .../ebooks/1513.txt
        java.util.regex.Matcher txt = java.util.regex.Pattern
                .compile("(?i)gutenberg\\.org/ebooks/(\\d+)\\.txt(?:\\.utf-8)?(?:\\?.*)?$")
                .matcher(url);
        if (txt.find()) {
            String id = txt.group(1);
            return "https://www.gutenberg.org/cache/epub/" + id + "/pg" + id + ".txt";
        }
        // .../ebooks/1513.html.images or .../ebooks/1513.html.noimages
        java.util.regex.Matcher html = java.util.regex.Pattern
                .compile("(?i)gutenberg\\.org/ebooks/(\\d+)\\.html(?:\\.(?:images|noimages))?(?:\\?.*)?$")
                .matcher(url);
        if (html.find()) {
            String id = html.group(1);
            boolean images = url.toLowerCase(Locale.ROOT).contains(".images");
            return "https://www.gutenberg.org/cache/epub/" + id + "/pg" + id
                    + (images ? "-images.html" : "-noimages.html");
        }
        return null;
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
        int coverId = doc.path("cover_i").asInt(0);

        // Open Library search hits are works: the work title is often English even when
        // language:fre matches because a French edition exists. Prefer that edition's metadata.
        JsonNode edition = firstMatchingEdition(doc.path("editions"), preferredLang);
        if (edition != null) {
            String edTitle = text(edition, "title");
            if (StringUtils.hasText(edTitle)) {
                item.setTitle(edTitle);
            }
            String edLang = preferLanguage(edition.path("language"), preferredLang);
            if (StringUtils.hasText(edLang)) {
                item.setLanguage(edLang);
            }
            String edIa = firstArray(edition.path("ia"));
            if (StringUtils.hasText(edIa)) {
                ia = edIa;
            }
            int edCover = edition.path("cover_i").asInt(0);
            if (edCover > 0) {
                coverId = edCover;
            }
            if (edition.path("has_fulltext").asBoolean(false)
                    || edition.path("public_scan_b").asBoolean(false)
                    || StringUtils.hasText(edIa)) {
                item.setHasFulltext(true);
            }
            String edKey = text(edition, "key");
            if (StringUtils.hasText(edKey)) {
                item.setHomepage(trimSlash(openLibraryBaseUrl) + edKey);
            }
        }

        if (StringUtils.hasText(ia)) {
            item.setIaId(ia);
            item.setHasFulltext(true);
            // Prefer Archive.org embed reader (stream/..._djvu.txt often returns HTML/CSS, not plain text).
            item.setHtmlUrl("https://archive.org/embed/" + ia);
            item.setHomepage("https://archive.org/details/" + ia);
            // Direct download when available — never the /stream/ HTML wrapper.
            item.setTextUrl("https://archive.org/download/" + ia + "/" + ia + "_djvu.txt");
        } else if (!StringUtils.hasText(item.getHomepage()) && StringUtils.hasText(key)) {
            item.setHomepage(trimSlash(openLibraryBaseUrl) + key);
        }
        if (coverId > 0) {
            item.setCoverUrl("https://covers.openlibrary.org/b/id/" + coverId + "-M.jpg");
        }
        return item;
    }

    /**
     * First nested edition matching {@code preferredLang}, or the first edition if no lang filter.
     */
    private static JsonNode firstMatchingEdition(JsonNode editionsWrapper, String preferredLang) {
        if (editionsWrapper == null || !editionsWrapper.isObject()) {
            return null;
        }
        JsonNode docs = editionsWrapper.path("docs");
        if (!docs.isArray() || docs.size() == 0) {
            return null;
        }
        String want = preferredLang != null ? preferredLang.trim().toLowerCase(Locale.ROOT) : "";
        if (StringUtils.hasText(want)) {
            for (JsonNode ed : docs) {
                JsonNode langs = ed.path("language");
                if (langs.isArray()) {
                    for (JsonNode lang : langs) {
                        if (lang.isTextual() && want.equals(lang.asText().trim().toLowerCase(Locale.ROOT))) {
                            return ed;
                        }
                    }
                }
            }
        }
        return docs.get(0);
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
            item.setTextUrl(normalizeGutenbergContentUrl(pickFormat(formats,
                    "text/plain; charset=utf-8",
                    "text/plain; charset=us-ascii",
                    "text/plain")));
            item.setHtmlUrl(normalizeGutenbergContentUrl(pickFormat(formats,
                    "text/html; charset=utf-8",
                    "text/html")));
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

    private BookItemDto mapArchiveDoc(JsonNode doc) {
        BookItemDto item = new BookItemDto();
        item.setSource("archive");
        String id = text(doc, "identifier");
        item.setId(id);
        item.setTitle(text(doc, "title"));
        item.setAuthors(joinArrayOrText(doc.path("creator")));
        item.setYear(parseYearField(doc.path("year")));
        item.setLanguage(joinArrayOrText(doc.path("language")));
        item.setSubjects(joinArrayLimited(normalizeToArray(doc.path("subject")), 8));
        item.setDescription(firstDescription(doc.path("description")));
        if (StringUtils.hasText(id)) {
            item.setIaId(id);
            item.setHasFulltext(true);
            item.setHtmlUrl(trimSlash(archiveBaseUrl) + "/embed/" + id);
            item.setHomepage(trimSlash(archiveBaseUrl) + "/details/" + id);
            item.setCoverUrl(trimSlash(archiveBaseUrl) + "/services/img/" + id);
            item.setTextUrl(trimSlash(archiveBaseUrl) + "/download/" + id + "/" + id + "_djvu.txt");
        }
        return item;
    }

    private BookItemDto mapArchiveMetadata(JsonNode meta, String id) {
        BookItemDto item = new BookItemDto();
        item.setSource("archive");
        item.setId(id);
        item.setTitle(text(meta, "title"));
        item.setAuthors(joinArrayOrText(meta.path("creator")));
        item.setYear(parseYearField(meta.path("year")));
        if (item.getYear() == null) {
            item.setYear(parseYearField(meta.path("date")));
        }
        item.setLanguage(joinArrayOrText(meta.path("language")));
        item.setSubjects(joinArrayLimited(normalizeToArray(meta.path("subject")), 12));
        item.setDescription(firstDescription(meta.path("description")));
        item.setIaId(id);
        item.setHasFulltext(true);
        item.setHtmlUrl(trimSlash(archiveBaseUrl) + "/embed/" + id);
        item.setHomepage(trimSlash(archiveBaseUrl) + "/details/" + id);
        item.setCoverUrl(trimSlash(archiveBaseUrl) + "/services/img/" + id);
        // Best-effort default; applyArchiveReadableText() may replace or clear this.
        item.setTextUrl(trimSlash(archiveBaseUrl) + "/download/" + id + "/" + id + "_djvu.txt");
        return item;
    }

    /**
     * Prefer a real public plain-text file from Archive.org metadata.
     * Controlled Digital Lending items often have no downloadable OCR — clear textUrl so
     * the UI opens Archive.org instead of loading a 403/HTML error as "text".
     */
    private void applyArchiveReadableText(BookItemDto item, JsonNode files, JsonNode meta, String id) {
        if (item == null || !StringUtils.hasText(id)) {
            return;
        }
        String fileName = pickArchivePlainTextFile(files);
        if (StringUtils.hasText(fileName)) {
            item.setTextUrl(trimSlash(archiveBaseUrl) + "/download/" + id + "/"
                    + fileName.replace(" ", "%20"));
            item.setHasFulltext(true);
            return;
        }
        if (isArchiveAccessRestricted(meta)) {
            item.setTextUrl(null);
        }
    }

    private static boolean isArchiveAccessRestricted(JsonNode meta) {
        if (meta == null || meta.isMissingNode() || meta.isNull()) {
            return false;
        }
        if (isTruthyFlag(meta.path("access-restricted-item"))
                || isTruthyFlag(meta.path("access-restricted"))) {
            return true;
        }
        JsonNode collections = normalizeToArray(meta.path("collection"));
        if (collections.isArray()) {
            for (JsonNode c : collections) {
                if (c != null && c.isTextual()) {
                    String col = c.asText().trim().toLowerCase(Locale.ROOT);
                    if ("inlibrary".equals(col) || "borrowable".equals(col)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static boolean isTruthyFlag(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return false;
        }
        if (node.isBoolean()) {
            return node.asBoolean();
        }
        if (node.isNumber()) {
            return node.asInt() != 0;
        }
        if (node.isTextual()) {
            String v = node.asText().trim().toLowerCase(Locale.ROOT);
            return "true".equals(v) || "1".equals(v) || "yes".equals(v);
        }
        return false;
    }

    /**
     * Pick the best publicly downloadable plain-text derivative from an IA files list.
     */
    private static String pickArchivePlainTextFile(JsonNode files) {
        if (files == null || !files.isArray()) {
            return null;
        }
        String bestDjvu = null;
        String bestTxt = null;
        for (JsonNode f : files) {
            if (f == null || !f.isObject()) {
                continue;
            }
            String name = text(f, "name");
            if (!StringUtils.hasText(name)) {
                continue;
            }
            String lower = name.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".xml") || lower.endsWith(".json") || lower.endsWith(".gz")
                    || lower.contains("_meta.") || lower.contains("_files.xml")
                    || lower.endsWith(".sqlite") || lower.endsWith(".log")) {
                continue;
            }
            String format = text(f, "format");
            String formatLower = format != null ? format.toLowerCase(Locale.ROOT) : "";
            if ("djvutxt".equals(formatLower) || lower.endsWith("_djvu.txt")) {
                bestDjvu = name;
                break;
            }
            if (bestTxt == null && (lower.endsWith(".txt")
                    || "text".equals(formatLower)
                    || "full text".equals(formatLower)
                    || formatLower.contains("ocr") && formatLower.contains("text"))) {
                bestTxt = name;
            }
        }
        return bestDjvu != null ? bestDjvu : bestTxt;
    }

    private BookItemDto mapGoogleVolume(JsonNode node) {
        BookItemDto item = new BookItemDto();
        item.setSource("googlebooks");
        item.setId(text(node, "id"));
        JsonNode info = node.path("volumeInfo");
        item.setTitle(text(info, "title"));
        item.setAuthors(joinArray(info.path("authors")));
        item.setDescription(stripHtml(text(info, "description")));
        item.setLanguage(text(info, "language"));
        item.setSubjects(joinArrayLimited(info.path("categories"), 8));
        item.setYear(parseYearFromDate(text(info, "publishedDate")));
        JsonNode images = info.path("imageLinks");
        String cover = firstNonBlank(text(images, "thumbnail"), text(images, "smallThumbnail"));
        if (StringUtils.hasText(cover)) {
            // Prefer https thumbnails
            item.setCoverUrl(cover.replace("http://", "https://"));
        }
        item.setHomepage(firstNonBlank(text(info, "infoLink"), text(info, "canonicalVolumeLink"), text(info, "previewLink")));

        JsonNode access = node.path("accessInfo");
        boolean free = access.path("publicDomain").asBoolean(false)
                || "ALL_PAGES".equalsIgnoreCase(text(access, "viewability"))
                || access.path("epub").path("isAvailable").asBoolean(false);
        item.setHasFulltext(free);
        String reader = text(access, "webReaderLink");
        if (StringUtils.hasText(reader)) {
            item.setHtmlUrl(reader);
            item.setHasFulltext(true);
        }
        JsonNode epub = access.path("epub");
        if (epub.path("isAvailable").asBoolean(false)) {
            String epubLink = text(epub, "downloadLink");
            if (StringUtils.hasText(epubLink)) {
                item.setEpubUrl(epubLink);
                item.setHasFulltext(true);
            }
        }
        JsonNode pdf = access.path("pdf");
        if (!StringUtils.hasText(item.getTextUrl()) && pdf.path("isAvailable").asBoolean(false)) {
            String pdfLink = text(pdf, "downloadLink");
            if (StringUtils.hasText(pdfLink)) {
                item.setTextUrl(pdfLink);
            }
        }
        return item;
    }

    private List<BookItemDto> fetchStandardEbooksNewReleases() throws Exception {
        String url = trimSlash(standardEbooksBaseUrl) + "/feeds/atom/new-releases";
        String xml = getText(url, "application/atom+xml,application/xml,text/xml,*/*;q=0.1");
        org.jsoup.nodes.Document doc = org.jsoup.Jsoup.parse(xml, url, org.jsoup.parser.Parser.xmlParser());
        List<BookItemDto> books = new ArrayList<>();
        for (org.jsoup.nodes.Element entry : doc.select("entry")) {
            BookItemDto item = mapStandardEbookAtomEntry(entry);
            if (item != null && StringUtils.hasText(item.getId())) {
                books.add(item);
            }
        }
        return books;
    }

    private List<BookItemDto> fetchStandardEbooksHtmlSearch(String searchQ, int page) throws Exception {
        StringBuilder url = new StringBuilder(trimSlash(standardEbooksBaseUrl))
                .append("/ebooks?query=").append(enc(searchQ));
        if (page > 1) {
            url.append("&page=").append(page);
        }
        String html = getText(url.toString(), "text/html,application/xhtml+xml,*/*;q=0.1");
        org.jsoup.nodes.Document doc = org.jsoup.Jsoup.parse(html, url.toString());
        List<BookItemDto> books = new ArrayList<>();
        for (org.jsoup.nodes.Element li : doc.select("ol.ebooks-list > li[typeof=schema:Book], ol.ebooks-list > li[about]")) {
            BookItemDto item = mapStandardEbookListItem(li);
            if (item != null && StringUtils.hasText(item.getId())) {
                books.add(item);
            }
        }
        return books;
    }

    private BookItemDto mapStandardEbookAtomEntry(org.jsoup.nodes.Element entry) {
        BookItemDto item = new BookItemDto();
        item.setSource("standardebooks");
        String idUrl = entry.selectFirst("id") != null ? entry.selectFirst("id").text() : "";
        String path = normalizeSePath(idUrl);
        item.setId(path);
        item.setTitle(entry.selectFirst("title") != null ? entry.selectFirst("title").text() : "");
        List<String> authors = new ArrayList<>();
        for (org.jsoup.nodes.Element a : entry.select("author > name")) {
            if (StringUtils.hasText(a.text())) {
                authors.add(a.text().trim());
            }
        }
        item.setAuthors(String.join(", ", authors));
        item.setLanguage("English");
        item.setDescription(entry.selectFirst("summary") != null ? entry.selectFirst("summary").text() : "");
        List<String> subjects = new ArrayList<>();
        for (org.jsoup.nodes.Element cat : entry.select("category[term]")) {
            String term = cat.attr("term");
            if (StringUtils.hasText(term) && subjects.size() < 8) {
                subjects.add(term);
            }
        }
        item.setSubjects(String.join(", ", subjects));
        org.jsoup.nodes.Element thumb = entry.selectFirst("*[url$=cover-thumbnail.jpg], thumbnail");
        if (thumb == null) {
            // Atom media:thumbnail — tag local name is usually "thumbnail"
            for (org.jsoup.nodes.Element el : entry.getAllElements()) {
                if ("thumbnail".equalsIgnoreCase(el.tagName()) && StringUtils.hasText(el.attr("url"))) {
                    thumb = el;
                    break;
                }
            }
        }
        if (thumb != null && StringUtils.hasText(thumb.attr("url"))) {
            item.setCoverUrl(thumb.attr("url"));
        }
        String homepage = path;
        org.jsoup.nodes.Element alt = entry.selectFirst("link[rel=alternate]");
        if (alt != null && StringUtils.hasText(alt.attr("href"))) {
            homepage = alt.attr("href");
        }
        applyStandardEbookUrls(item, homepage, true);
        item.setHasFulltext(true);
        org.jsoup.nodes.Element epub = entry.selectFirst("link[type=application/epub+zip][title*=Recommended], link[type=application/epub+zip]");
        if (epub != null && StringUtils.hasText(epub.attr("href"))) {
            item.setEpubUrl(absolutizeSeUrl(epub.attr("href")));
        }
        org.jsoup.nodes.Element xhtml = entry.selectFirst("link[type=application/xhtml+xml][title=XHTML], link[href*=/text/single-page]");
        if (xhtml != null && StringUtils.hasText(xhtml.attr("href"))) {
            item.setHtmlUrl(absolutizeSeUrl(xhtml.attr("href")));
        }
        return item;
    }

    private BookItemDto mapStandardEbookListItem(org.jsoup.nodes.Element li) {
        BookItemDto item = new BookItemDto();
        item.setSource("standardebooks");
        String about = li.attr("about");
        if (!StringUtils.hasText(about)) {
            org.jsoup.nodes.Element link = li.selectFirst("a[property=schema:url], a[href^=/ebooks/]");
            if (link != null) {
                about = link.attr("href");
            }
        }
        String path = normalizeSePath(about);
        item.setId(path);
        org.jsoup.nodes.Element titleEl = li.selectFirst("[property=schema:name]");
        item.setTitle(titleEl != null ? titleEl.text() : "");
        org.jsoup.nodes.Element authorEl = li.selectFirst(".author [property=schema:name], p.author [property=schema:name]");
        item.setAuthors(authorEl != null ? authorEl.text() : "");
        item.setLanguage("English");
        // "not-pd" / placeholder entries exist in the catalog but have no downloadable text yet.
        boolean readable = !li.hasClass("not-pd")
                && !li.hasClass("ebook-placeholder")
                && li.selectFirst(".ribbon.not-pd, .ebook-placeholder") == null;
        applyStandardEbookUrls(item, path, readable);
        item.setHasFulltext(readable);
        if (!readable) {
            item.setDescription("Not yet in the U.S. public domain (Standard Ebooks placeholder).");
        }
        return item;
    }

    private BookItemDto mapStandardEbookPage(org.jsoup.nodes.Document doc, String path) {
        BookItemDto item = new BookItemDto();
        item.setSource("standardebooks");
        item.setId(path);
        org.jsoup.nodes.Element titleEl = doc.selectFirst("h1, [property=schema:name]");
        item.setTitle(titleEl != null ? titleEl.text() : path);
        List<String> authors = new ArrayList<>();
        for (org.jsoup.nodes.Element a : doc.select("[property=schema:author] [property=schema:name], .author a")) {
            String name = a.text();
            if (StringUtils.hasText(name) && !authors.contains(name.trim())) {
                authors.add(name.trim());
            }
        }
        item.setAuthors(String.join(", ", authors));
        item.setLanguage("English");
        org.jsoup.nodes.Element desc = doc.selectFirst("meta[property=og:description], meta[name=description]");
        if (desc != null) {
            item.setDescription(desc.attr("content"));
        }
        org.jsoup.nodes.Element coverMeta = doc.selectFirst("meta[property=schema:thumbnailUrl], meta[property=og:image]");
        if (coverMeta != null && StringUtils.hasText(coverMeta.attr("content"))) {
            item.setCoverUrl(coverMeta.attr("content"));
        }
        boolean placeholder = doc.selectFirst("article.ebook-placeholder, #placeholder-details, .placeholder-details") != null;
        org.jsoup.nodes.Element epub = doc.selectFirst("a[property=schema:contentUrl][href$=.epub]");
        if (epub == null) {
            epub = doc.selectFirst("a[href$=.epub]");
        }
        if (epub != null && !placeholder) {
            item.setEpubUrl(absolutizeSeUrl(epub.attr("href")));
        }
        org.jsoup.nodes.Element singlePage = doc.selectFirst("a[href$=/text/single-page], a.page[href*=/text/single-page]");
        boolean readable = !placeholder && (epub != null || singlePage != null);
        if (placeholder) {
            org.jsoup.nodes.Element placeholderMsg = doc.selectFirst("#placeholder-details p, .placeholder-details p");
            if (placeholderMsg != null && StringUtils.hasText(placeholderMsg.text())) {
                item.setDescription(placeholderMsg.text());
            }
        }
        applyStandardEbookUrls(item, path, readable);
        if (singlePage != null && readable && !StringUtils.hasText(item.getHtmlUrl())) {
            item.setHtmlUrl(absolutizeSeUrl(singlePage.attr("href")));
        }
        item.setHasFulltext(readable);
        return item;
    }

    private void applyStandardEbookUrls(BookItemDto item, String pathOrUrl, boolean withReadableContent) {
        String path = normalizeSePath(pathOrUrl);
        if (!StringUtils.hasText(path)) {
            return;
        }
        String base = trimSlash(standardEbooksBaseUrl) + path;
        item.setHomepage(base);
        if (withReadableContent) {
            if (!StringUtils.hasText(item.getCoverUrl())) {
                item.setCoverUrl(base + "/downloads/cover-thumbnail.jpg");
            }
            if (!StringUtils.hasText(item.getHtmlUrl())) {
                item.setHtmlUrl(base + "/text/single-page");
            }
            if (!StringUtils.hasText(item.getEpubUrl())) {
                String slug = path.startsWith("/ebooks/")
                        ? path.substring("/ebooks/".length()).replace('/', '_')
                        : path.replace('/', '_');
                item.setEpubUrl(base + "/downloads/" + slug + ".epub");
            }
        } else if (!StringUtils.hasText(item.getCoverUrl())) {
            // Placeholder pages often have no cover file yet — leave blank rather than 404.
            item.setCoverUrl(null);
        }
    }

    private static List<BookItemDto> filterBySubjectContains(List<BookItemDto> books, String subject) {
        String needle = subject.trim().toLowerCase(Locale.ROOT);
        List<BookItemDto> out = new ArrayList<>();
        for (BookItemDto b : books) {
            String subjects = b.getSubjects() != null ? b.getSubjects().toLowerCase(Locale.ROOT) : "";
            String title = b.getTitle() != null ? b.getTitle().toLowerCase(Locale.ROOT) : "";
            if (subjects.contains(needle) || title.contains(needle)) {
                out.add(b);
            }
        }
        return out.isEmpty() ? books : out;
    }

    // --- HTTP / utils ---

    private String getText(String url, String accept) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(45))
                .header("User-Agent", USER_AGENT)
                .header("Accept", accept != null ? accept : "*/*")
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        int code = response.statusCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("HTTP " + code + " for " + url);
        }
        return response.body();
    }

    private static String escapeIaQuery(String raw) {
        if (raw == null) {
            return "";
        }
        // Keep Lucene query simple: strip parentheses/colons that break fielded queries.
        return raw.replace("(", " ").replace(")", " ").replace(":", " ").replace("\"", " ").trim();
    }

    private static String mapLanguageForArchive(String lang) {
        String l = lang != null ? lang.trim().toLowerCase(Locale.ROOT) : "";
        return switch (l) {
            case "en", "eng" -> "eng";
            case "fr", "fre", "fra" -> "fre";
            case "de", "ger", "deu" -> "ger";
            case "es", "spa" -> "spa";
            case "it", "ita" -> "ita";
            default -> l;
        };
    }

    /** Map ISO / OL codes to LibriVox language display names (English, French, …). */
    private static String mapLanguageForLibriVox(String lang) {
        String l = lang != null ? lang.trim().toLowerCase(Locale.ROOT) : "";
        if (l.isEmpty()) {
            return "";
        }
        return switch (l) {
            case "en", "eng", "english" -> "English";
            case "fr", "fre", "fra", "french" -> "French";
            case "de", "ger", "deu", "german" -> "German";
            case "es", "spa", "spanish" -> "Spanish";
            case "it", "ita", "italian" -> "Italian";
            default -> Character.toUpperCase(l.charAt(0)) + l.substring(1);
        };
    }

    private static boolean matchesLibriVoxLanguage(String bookLanguage, String wanted) {
        if (!StringUtils.hasText(wanted)) {
            return true;
        }
        if (!StringUtils.hasText(bookLanguage)) {
            return false;
        }
        return bookLanguage.trim().equalsIgnoreCase(wanted.trim());
    }

    private static String mapLanguageForGoogle(String lang) {
        String l = lang != null ? lang.trim().toLowerCase(Locale.ROOT) : "";
        return switch (l) {
            case "eng", "en" -> "en";
            case "fre", "fra", "fr" -> "fr";
            case "ger", "deu", "de" -> "de";
            case "spa", "es" -> "es";
            case "ita", "it" -> "it";
            default -> l.length() == 2 || l.length() == 3 ? l : "";
        };
    }

    /** Quote a Google Books field term when it contains spaces. */
    private static String quoteGoogleTerm(String raw) {
        String cleaned = raw != null ? raw.trim().replace("\"", "") : "";
        if (cleaned.contains(" ")) {
            return '"' + cleaned + '"';
        }
        return cleaned;
    }

    private static String normalizeSePath(String pathOrUrl) {
        if (!StringUtils.hasText(pathOrUrl)) {
            return null;
        }
        String p = pathOrUrl.trim();
        if (p.startsWith("http://") || p.startsWith("https://")) {
            try {
                URI uri = URI.create(p);
                p = uri.getPath();
            } catch (Exception e) {
                return null;
            }
        }
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        if (!p.startsWith("/ebooks/")) {
            return null;
        }
        // Drop trailing download/text segments if a full link was passed as id
        int downloads = p.indexOf("/downloads/");
        if (downloads > 0) {
            p = p.substring(0, downloads);
        }
        int textIdx = p.indexOf("/text/");
        if (textIdx > 0) {
            p = p.substring(0, textIdx);
        }
        while (p.endsWith("/") && p.length() > 1) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    private String absolutizeSeUrl(String href) {
        if (!StringUtils.hasText(href)) {
            return null;
        }
        if (href.startsWith("http://") || href.startsWith("https://")) {
            return href;
        }
        if (href.startsWith("/")) {
            return trimSlash(standardEbooksBaseUrl) + href;
        }
        return trimSlash(standardEbooksBaseUrl) + "/" + href;
    }

    private static String joinArrayOrText(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return "";
        }
        if (node.isArray()) {
            return joinArray(node);
        }
        if (node.isTextual() || node.isNumber()) {
            return node.asText();
        }
        return "";
    }

    private static JsonNode normalizeToArray(JsonNode node) {
        if (node != null && node.isArray()) {
            return node;
        }
        if (node != null && node.isTextual() && StringUtils.hasText(node.asText())) {
            return com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode().add(node.asText());
        }
        return com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode();
    }

    private static String firstDescription(JsonNode desc) {
        if (desc == null || desc.isMissingNode() || desc.isNull()) {
            return "";
        }
        if (desc.isArray()) {
            return firstArray(desc);
        }
        if (desc.isTextual()) {
            return desc.asText();
        }
        return "";
    }

    private static Integer parseYearField(JsonNode yearNode) {
        if (yearNode == null || yearNode.isMissingNode() || yearNode.isNull()) {
            return null;
        }
        if (yearNode.isArray() && yearNode.size() > 0) {
            return parseYearFromDate(yearNode.get(0).asText());
        }
        if (yearNode.isNumber()) {
            int y = yearNode.asInt();
            return y > 0 ? y : null;
        }
        if (yearNode.isTextual()) {
            return parseYearFromDate(yearNode.asText());
        }
        return null;
    }

    private static Integer parseYearFromDate(String date) {
        if (!StringUtils.hasText(date)) {
            return null;
        }
        String digits = date.trim();
        if (digits.length() >= 4) {
            try {
                int y = Integer.parseInt(digits.substring(0, 4).replaceAll("[^0-9]", ""));
                return y > 100 ? y : null;
            } catch (NumberFormatException e) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("(1[0-9]{3}|20[0-9]{2})").matcher(digits);
                if (m.find()) {
                    return Integer.parseInt(m.group(1));
                }
            }
        }
        return null;
    }

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

    private static BookSearchPageDto rateLimitedPage(String source, String query, int limit, int offset) {
        BookSearchPageDto page = emptyPage(source, query, limit, offset);
        page.setRateLimited(true);
        return page;
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

    /** Open Library fielded query term, e.g. {@code author:"Victor Hugo"} or {@code title:pride}. */
    private static String fieldedOlTerm(String field, String value) {
        String cleaned = value.replace("\"", "").trim();
        if (cleaned.contains(" ") || cleaned.contains(":")) {
            return field + ":\"" + cleaned + '"';
        }
        return field + ":" + cleaned;
    }

    /** Join non-empty search fragments for Gutendex (title + author full-text). */
    private static String joinSearchTerms(String title, String author) {
        StringBuilder sb = new StringBuilder();
        if (title != null && title.trim().length() >= 2) {
            sb.append(title.trim());
        }
        if (author != null && author.trim().length() >= 2) {
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(author.trim());
        }
        return sb.toString();
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
                || host.endsWith(".gutendex.com")
                || host.equals("standardebooks.org")
                || host.endsWith(".standardebooks.org")
                || host.equals("books.google.com")
                || host.endsWith(".books.google.com")
                || host.equals("www.googleapis.com");
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
