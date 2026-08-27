package com.pat.service.news;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.InetAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RSS/Atom news provider: curated catalogue + fetch proxy (CORS/SSRF) +
 * keyword/URL discovery (Feedly search and HTML {@code rel=alternate}).
 */
@Service("rssNewsService")
public class RssNewsService implements NewsProvider {

    private static final Logger log = LoggerFactory.getLogger(RssNewsService.class);
    private static final String USER_AGENT = "PATTOOL/1.0 (+https://www.patrickdeschamps.com; RSS reader)";
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(8);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(12);
    private static final Duration CACHE_TTL = Duration.ofMinutes(10);
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024;
    private static final int MAX_FEEDS_PER_REQUEST = 8;
    private static final int MAX_URL_LEN = 2048;
    private static final Pattern ALT_LINK = Pattern.compile(
            "<link[^>]+rel=[\"']alternate[\"'][^>]*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern HREF = Pattern.compile(
            "href=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE);
    private static final Pattern TYPE = Pattern.compile(
            "type=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE);
    private static final Pattern FEEDLY_ID = Pattern.compile("^feed/(.+)$");

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
    private final ObjectMapper objectMapper;
    private final ExecutorService pool = Executors.newFixedThreadPool(6, r -> {
        Thread t = new Thread(r, "rss-fetch");
        t.setDaemon(true);
        return t;
    });
    private final ConcurrentHashMap<String, CachedArticles> cache = new ConcurrentHashMap<>();

    public RssNewsService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public Map<String, Object> getTopHeadlines(String country, String category, String query,
                                               Integer pageSize, Integer page) {
        return getTopHeadlines(country, category, query, pageSize, page, List.of());
    }

    @Override
    public Map<String, Object> getTopHeadlines(String country, String category, String query,
                                               Integer pageSize, Integer page, List<String> feedUrls) {
        List<RssFeed> feeds = resolveFeeds(feedUrls, country, category, null);
        List<Map<String, Object>> articles = fetchMany(feeds);
        articles = filterQuery(articles, query);
        return pageResult(articles, pageSize, page);
    }

    @Override
    public Map<String, Object> getEverything(String query, String language, String from, String to,
                                             String sortBy, Integer pageSize, Integer page) {
        return getEverything(query, language, from, to, sortBy, pageSize, page, List.of());
    }

    @Override
    public Map<String, Object> getEverything(String query, String language, String from, String to,
                                             String sortBy, Integer pageSize, Integer page,
                                             List<String> feedUrls) {
        List<RssFeed> feeds = resolveFeeds(feedUrls, null, null, language);
        List<Map<String, Object>> articles = fetchMany(feeds);
        articles = filterQuery(articles, query);
        articles = filterDates(articles, from, to);
        if ("relevancy".equalsIgnoreCase(sortBy) && StringUtils.hasText(query)) {
            String q = query.toLowerCase(Locale.ROOT);
            articles.sort(Comparator.comparingInt((Map<String, Object> a) -> relevancy(a, q)).reversed());
        }
        return pageResult(articles, pageSize, page);
    }

    @Override
    public Map<String, Object> getSources(String country, String category, String language) {
        List<Map<String, Object>> sources = new ArrayList<>();
        for (RssFeed feed : RssFeedCatalog.defaults()) {
            if (StringUtils.hasText(country) && !country.equalsIgnoreCase(feed.country())) continue;
            if (StringUtils.hasText(category) && !category.equalsIgnoreCase(feed.category())) continue;
            if (StringUtils.hasText(language) && !language.equalsIgnoreCase(feed.language())) continue;
            sources.add(feed.toSourceMap());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        out.put("sources", sources);
        out.put("total", sources.size());
        return out;
    }

    @Override
    public Map<String, Object> getStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("service", "RSS");
        status.put("providerId", "rss");
        status.put("configured", true);
        status.put("status", "available");
        status.put("cacheTtlMinutes", CACHE_TTL.toMinutes());
        status.put("cacheEntries", cache.size());
        status.put("catalogSize", RssFeedCatalog.defaults().size());
        status.put("tickerEnabledDefault", false);
        status.put("defaultCountry", "fr");
        status.put("defaultLanguage", "fr");
        status.put("message", "No API key — public RSS/Atom feeds via PatTool proxy.");
        return status;
    }

    @Override
    public Map<String, Object> clearCache() {
        int n = cache.size();
        cache.clear();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cleared", n);
        return out;
    }

    /**
     * Keyword or URL discovery. A URL (site or feed) is resolved to one or
     * more feeds; a free-text query searches the local catalogue then Feedly.
     */
    public Map<String, Object> searchFeeds(String query) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!StringUtils.hasText(query) || query.trim().length() < 2) {
            out.put("status", "ok");
            out.put("results", List.of());
            return out;
        }
        String q = query.trim();
        List<Map<String, Object>> results = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();

        Optional<URI> maybeUrl = interpretAsUrl(q);
        if (maybeUrl.isPresent()) {
            results.addAll(resolveFromUrl(maybeUrl.get(), seen));
        } else {
            String needle = normalize(q);
            for (RssFeed feed : RssFeedCatalog.defaults()) {
                if (matches(feed, needle) && seen.add(normUrl(feed.url()))) {
                    Map<String, Object> row = feed.toSourceMap();
                    row.put("origin", "catalog");
                    results.add(row);
                }
            }
            results.addAll(searchFeedly(q, seen));
        }

        out.put("status", "ok");
        out.put("results", results);
        out.put("total", results.size());
        return out;
    }

    public int cacheEntryCount() {
        pruneCache();
        return cache.size();
    }

    // ---------------------------------------------------------------------
    // Fetch
    // ---------------------------------------------------------------------

    private List<RssFeed> resolveFeeds(List<String> feedUrls, String country, String category, String language) {
        List<RssFeed> out = new ArrayList<>();
        if (feedUrls != null) {
            for (String raw : feedUrls) {
                if (!StringUtils.hasText(raw)) continue;
                for (String part : raw.split("\\s+")) {
                    if (!StringUtils.hasText(part)) continue;
                    Optional<RssFeed> known = findByUrl(part.trim());
                    out.add(known.orElseGet(() -> adHoc(part.trim())));
                    if (out.size() >= MAX_FEEDS_PER_REQUEST) return out;
                }
            }
        }
        if (!out.isEmpty()) return out;

        for (RssFeed feed : RssFeedCatalog.defaults()) {
            if (StringUtils.hasText(country) && !country.equalsIgnoreCase(feed.country())) continue;
            if (StringUtils.hasText(category) && !category.equalsIgnoreCase(feed.category())) continue;
            if (StringUtils.hasText(language) && !language.equalsIgnoreCase(feed.language())) continue;
            out.add(feed);
            if (out.size() >= MAX_FEEDS_PER_REQUEST) break;
        }
        if (out.isEmpty()) {
            // Country/language too strict — fall back to FR general then any.
            for (RssFeed feed : RssFeedCatalog.defaults()) {
                if ("fr".equalsIgnoreCase(feed.language()) && "general".equals(feed.category())) {
                    out.add(feed);
                    if (out.size() >= MAX_FEEDS_PER_REQUEST) break;
                }
            }
        }
        return out;
    }

    private List<Map<String, Object>> fetchMany(List<RssFeed> feeds) {
        List<CompletableFuture<List<Map<String, Object>>>> futures = new ArrayList<>();
        for (RssFeed feed : feeds) {
            futures.add(CompletableFuture.supplyAsync(() -> fetchOne(feed), pool)
                    .orTimeout(REQUEST_TIMEOUT.plusSeconds(2).toSeconds(), java.util.concurrent.TimeUnit.SECONDS)
                    .exceptionally(ex -> {
                        log.debug("RSS fetch failed for {}: {}", feed.url(), ex.toString());
                        return List.of();
                    }));
        }
        List<Map<String, Object>> all = new ArrayList<>();
        Set<String> seenUrls = new LinkedHashSet<>();
        for (CompletableFuture<List<Map<String, Object>>> f : futures) {
            try {
                for (Map<String, Object> article : f.join()) {
                    Object u = article.get("url");
                    String key = u == null ? String.valueOf(article.get("title")) : String.valueOf(u);
                    if (seenUrls.add(key)) all.add(article);
                }
            } catch (Exception e) {
                log.debug("RSS join failed: {}", e.toString());
            }
        }
        all.sort(Comparator.comparing((Map<String, Object> a) -> {
            Object p = a.get("publishedAt");
            return p == null ? "" : p.toString();
        }).reversed());
        return all;
    }

    private List<Map<String, Object>> fetchOne(RssFeed feed) {
        pruneCache();
        CachedArticles cached = cache.get(normUrl(feed.url()));
        if (cached != null && cached.expiresAt.isAfter(Instant.now())) {
            return cached.articles;
        }
        try {
            FetchResult fetched = download(URI.create(feed.url()), false);
            if (fetched == null || fetched.body.length == 0) {
                return cached != null ? cached.articles : List.of();
            }
            if (looksLikeHtml(fetched.contentType, fetched.body)) {
                List<URI> alts = extractAlternateFeeds(fetched.finalUri, fetched.body);
                if (!alts.isEmpty()) {
                    fetched = download(alts.get(0), true);
                    if (fetched == null) return List.of();
                }
            }
            List<Map<String, Object>> articles = RssFeedParser.parse(fetched.body, feed);
            cache.put(normUrl(feed.url()), new CachedArticles(articles, Instant.now().plus(CACHE_TTL)));
            return articles;
        } catch (Exception e) {
            log.debug("RSS parse/fetch failed for {}: {}", feed.url(), e.toString());
            return cached != null ? cached.articles : List.of();
        }
    }

    private FetchResult download(URI uri, boolean requireXml) throws Exception {
        URI safe = assertPublicHttp(uri);
        HttpRequest request = HttpRequest.newBuilder(safe)
                .timeout(REQUEST_TIMEOUT)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5")
                .GET()
                .build();
        HttpResponse<byte[]> resp = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (resp.statusCode() < 200 || resp.statusCode() >= 400) {
            log.debug("RSS HTTP {} for {}", resp.statusCode(), safe);
            return null;
        }
        byte[] body = resp.body() == null ? new byte[0] : resp.body();
        if (body.length > MAX_BODY_BYTES) {
            throw new IllegalArgumentException("Feed too large");
        }
        String ctype = resp.headers().firstValue("Content-Type").orElse("");
        URI finalUri = resp.uri() != null ? resp.uri() : safe;
        if (requireXml && looksLikeHtml(ctype, body)) {
            return null;
        }
        return new FetchResult(body, ctype, finalUri);
    }

    // ---------------------------------------------------------------------
    // Discovery
    // ---------------------------------------------------------------------

    private List<Map<String, Object>> resolveFromUrl(URI uri, Set<String> seen) {
        List<Map<String, Object>> out = new ArrayList<>();
        try {
            FetchResult fetched = download(uri, false);
            if (fetched == null) return out;
            if (!looksLikeHtml(fetched.contentType, fetched.body)) {
                RssFeed feed = adHoc(fetched.finalUri.toString());
                String title = RssFeedParser.extractTitle(fetched.body);
                if (StringUtils.hasText(title)) {
                    feed = new RssFeed(feed.id(), title, feed.url(), websiteOf(fetched.finalUri),
                            "general", "", "", title);
                }
                if (seen.add(normUrl(feed.url()))) {
                    Map<String, Object> row = feed.toSourceMap();
                    row.put("origin", "url");
                    out.add(row);
                }
                cache.put(normUrl(feed.url()),
                        new CachedArticles(RssFeedParser.parse(fetched.body, feed), Instant.now().plus(CACHE_TTL)));
                return out;
            }
            List<URI> alts = extractAlternateFeeds(fetched.finalUri, fetched.body);
            if (alts.isEmpty()) {
                alts = probeCommonPaths(fetched.finalUri);
            }
            for (URI alt : alts) {
                if (!seen.add(normUrl(alt.toString()))) continue;
                RssFeed feed = findByUrl(alt.toString()).orElseGet(() -> adHoc(alt.toString()));
                Map<String, Object> row = feed.toSourceMap();
                row.put("origin", "discover");
                out.add(row);
                if (out.size() >= 8) break;
            }
        } catch (Exception e) {
            log.debug("RSS URL resolve failed for {}: {}", uri, e.toString());
        }
        return out;
    }

    private List<Map<String, Object>> searchFeedly(String query, Set<String> seen) {
        List<Map<String, Object>> out = new ArrayList<>();
        try {
            String url = "https://cloud.feedly.com/v3/search/feeds?query="
                    + URLEncoder.encode(query, StandardCharsets.UTF_8)
                    + "&count=12";
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(REQUEST_TIMEOUT)
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", MediaType.APPLICATION_JSON_VALUE)
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() < 200 || resp.statusCode() >= 400 || resp.body() == null) {
                return out;
            }
            JsonNode root = objectMapper.readTree(resp.body());
            JsonNode results = root.path("results");
            if (!results.isArray()) return out;
            for (JsonNode n : results) {
                String feedId = n.path("feedId").asText("");
                Matcher m = FEEDLY_ID.matcher(feedId);
                String feedUrl = m.matches() ? m.group(1) : n.path("website").asText("");
                if (!StringUtils.hasText(feedUrl) || !seen.add(normUrl(feedUrl))) continue;
                try {
                    assertPublicHttp(URI.create(feedUrl));
                } catch (Exception e) {
                    continue;
                }
                String title = n.path("title").asText("RSS");
                String website = n.path("website").asText("");
                String description = n.path("description").asText("");
                String language = n.path("language").asText("");
                RssFeed feed = new RssFeed(adHocId(feedUrl), title, feedUrl, website,
                        "general", language, "", description);
                Map<String, Object> row = feed.toSourceMap();
                row.put("origin", "feedly");
                row.put("subscribers", n.path("subscribers").asInt(0));
                out.add(row);
            }
        } catch (Exception e) {
            log.debug("Feedly search failed: {}", e.toString());
        }
        return out;
    }

    private List<URI> extractAlternateFeeds(URI base, byte[] htmlBytes) {
        String html = new String(htmlBytes, StandardCharsets.UTF_8);
        List<URI> out = new ArrayList<>();
        Matcher link = ALT_LINK.matcher(html);
        while (link.find()) {
            String tag = link.group();
            Matcher typeM = TYPE.matcher(tag);
            String type = typeM.find() ? typeM.group(1).toLowerCase(Locale.ROOT) : "";
            if (!type.contains("rss") && !type.contains("atom") && !type.contains("xml")) continue;
            Matcher hrefM = HREF.matcher(tag);
            if (!hrefM.find()) continue;
            URI resolved = resolveHref(base, hrefM.group(1));
            if (resolved != null) out.add(resolved);
        }
        return out;
    }

    private List<URI> probeCommonPaths(URI site) {
        String[] paths = {"/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/feeds/all.atom.xml"};
        List<URI> found = new ArrayList<>();
        String origin = site.getScheme() + "://" + site.getHost()
                + (site.getPort() > 0 ? ":" + site.getPort() : "");
        for (String path : paths) {
            try {
                URI u = URI.create(origin + path);
                FetchResult r = download(u, true);
                if (r != null && r.body.length > 40 && !looksLikeHtml(r.contentType, r.body)) {
                    found.add(r.finalUri);
                    break;
                }
            } catch (Exception ignored) {
                // try next common path
            }
        }
        return found;
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private static List<Map<String, Object>> filterQuery(List<Map<String, Object>> articles, String query) {
        if (!StringUtils.hasText(query) || query.trim().length() < 2) return articles;
        String q = normalize(query);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> a : articles) {
            String blob = normalize(String.valueOf(a.get("title")) + " " + a.get("description")
                    + " " + sourceName(a));
            if (blob.contains(q)) out.add(a);
        }
        return out;
    }

    private static List<Map<String, Object>> filterDates(List<Map<String, Object>> articles, String from, String to) {
        Instant fromI = parseInstant(from);
        Instant toI = parseInstant(to);
        if (fromI == null && toI == null) return articles;
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> a : articles) {
            Instant p = parseInstant(String.valueOf(a.get("publishedAt")));
            if (p == null) continue;
            if (fromI != null && p.isBefore(fromI)) continue;
            if (toI != null && p.isAfter(toI)) continue;
            out.add(a);
        }
        return out;
    }

    private static Instant parseInstant(String raw) {
        if (!StringUtils.hasText(raw)) return null;
        try {
            return Instant.parse(raw);
        } catch (Exception e) {
            try {
                return Instant.parse(raw + "Z");
            } catch (Exception e2) {
                return null;
            }
        }
    }

    private static int relevancy(Map<String, Object> article, String q) {
        int score = 0;
        String title = String.valueOf(article.get("title")).toLowerCase(Locale.ROOT);
        String desc = String.valueOf(article.get("description")).toLowerCase(Locale.ROOT);
        if (title.contains(q)) score += 5;
        if (desc.contains(q)) score += 1;
        return score;
    }

    private Map<String, Object> pageResult(List<Map<String, Object>> articles, Integer pageSize, Integer page) {
        int size = pageSize == null ? 12 : Math.min(Math.max(pageSize, 1), 50);
        int p = page == null ? 1 : Math.max(page, 1);
        int from = (p - 1) * size;
        List<Map<String, Object>> slice = from >= articles.size()
                ? List.of()
                : articles.subList(from, Math.min(articles.size(), from + size));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", "ok");
        out.put("totalResults", articles.size());
        out.put("articles", slice);
        return out;
    }

    private void pruneCache() {
        Instant now = Instant.now();
        cache.entrySet().removeIf(e -> e.getValue().expiresAt.isBefore(now));
    }

    private static Optional<RssFeed> findByUrl(String url) {
        String n = normUrl(url);
        for (RssFeed feed : RssFeedCatalog.defaults()) {
            if (normUrl(feed.url()).equals(n)) return Optional.of(feed);
        }
        return Optional.empty();
    }

    private static RssFeed adHoc(String url) {
        return new RssFeed(adHocId(url), hostLabel(url), url, websiteOfUrl(url),
                "general", "", "", "");
    }

    private static String adHocId(String url) {
        return "custom-" + Integer.toHexString(normUrl(url).hashCode());
    }

    private static String hostLabel(String url) {
        try {
            String host = URI.create(url).getHost();
            return host == null ? "RSS" : host.replaceFirst("^www\\.", "");
        } catch (Exception e) {
            return "RSS";
        }
    }

    private static String websiteOfUrl(String url) {
        try {
            return websiteOf(URI.create(url));
        } catch (Exception e) {
            return url;
        }
    }

    private static String websiteOf(URI uri) {
        if (uri.getHost() == null) return uri.toString();
        String port = uri.getPort() > 0 ? ":" + uri.getPort() : "";
        return uri.getScheme() + "://" + uri.getHost() + port + "/";
    }

    private static String sourceName(Map<String, Object> article) {
        Object src = article.get("source");
        if (src instanceof Map<?, ?> m && m.get("name") != null) return String.valueOf(m.get("name"));
        return "";
    }

    private static boolean matches(RssFeed feed, String needle) {
        String blob = normalize(feed.name() + " " + feed.description() + " " + feed.url()
                + " " + feed.website() + " " + feed.country() + " " + feed.language());
        return blob.contains(needle);
    }

    private static String normalize(String s) {
        if (s == null) return "";
        String n = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD)
                .replaceAll("\\p{M}", "");
        return n.toLowerCase(Locale.ROOT);
    }

    private static String normUrl(String url) {
        if (url == null) return "";
        String u = url.trim();
        try {
            u = URLDecoder.decode(u, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            // keep raw
        }
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u.toLowerCase(Locale.ROOT);
    }

    private static Optional<URI> interpretAsUrl(String q) {
        String s = q.trim();
        if (s.startsWith("http://") || s.startsWith("https://")) {
            try {
                return Optional.of(assertPublicHttp(URI.create(s)));
            } catch (Exception e) {
                return Optional.empty();
            }
        }
        if (s.matches("(?i)^[a-z0-9.-]+\\.[a-z]{2,}(/\\S*)?$")) {
            try {
                return Optional.of(assertPublicHttp(URI.create("https://" + s)));
            } catch (Exception e) {
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    private static URI resolveHref(URI base, String href) {
        try {
            URI resolved = base.resolve(href.trim());
            return assertPublicHttp(resolved);
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean looksLikeHtml(String contentType, byte[] body) {
        String ct = contentType == null ? "" : contentType.toLowerCase(Locale.ROOT);
        if (ct.contains("html")) return true;
        if (ct.contains("xml") || ct.contains("rss") || ct.contains("atom")) return false;
        String start = new String(body, 0, Math.min(body.length, 200), StandardCharsets.UTF_8)
                .toLowerCase(Locale.ROOT).trim();
        return start.startsWith("<!doctype html") || start.startsWith("<html");
    }

    static URI assertPublicHttp(URI uri) {
        if (uri == null) throw new IllegalArgumentException("Missing URL");
        String raw = uri.toString();
        if (raw.length() > MAX_URL_LEN) throw new IllegalArgumentException("URL too long");
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            throw new IllegalArgumentException("Only http(s) URLs are allowed");
        }
        if (uri.getUserInfo() != null) throw new IllegalArgumentException("Credentials in URL are not allowed");
        String host = uri.getHost();
        if (host == null || host.isBlank()) throw new IllegalArgumentException("Host required");
        try {
            InetAddress addr = InetAddress.getByName(host);
            if (addr.isAnyLocalAddress() || addr.isLoopbackAddress() || addr.isLinkLocalAddress()
                    || addr.isSiteLocalAddress() || addr.isMulticastAddress()) {
                throw new IllegalArgumentException("Private/local hosts are not allowed");
            }
        } catch (UnknownHostException e) {
            throw new IllegalArgumentException("Unknown host");
        }
        return uri;
    }

    private record CachedArticles(List<Map<String, Object>> articles, Instant expiresAt) {
        private CachedArticles {
            articles = articles == null ? List.of() : Collections.unmodifiableList(new ArrayList<>(articles));
        }
    }

    private record FetchResult(byte[] body, String contentType, URI finalUri) {}
}
