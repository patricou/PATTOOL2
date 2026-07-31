package com.pat.service;

import com.pat.controller.dto.RadioFrancePodcastEpisodeDto;
import com.pat.controller.dto.RadioFrancePodcastShowDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Radio France podcasts via public website catalogs + official RSS enclosures
 * ({@code radiofrance-podcast.net}), without the Open API (aggregation is forbidden there).
 * <p>
 * Flow: scrape {@code /{station}/podcasts} → open show page for {@code rssFeed} → parse RSS items.
 */
@Service
public class RadioFrancePodcastService {

    private static final Logger log = LoggerFactory.getLogger(RadioFrancePodcastService.class);

    private static final String SITE = "https://www.radiofrance.fr";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final Duration SHOW_CACHE_TTL = Duration.ofHours(6);
    private static final Duration EPISODE_CACHE_TTL = Duration.ofMinutes(30);
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(25);
    private static final int MAX_EPISODES = 80;

    private static final Map<String, StationDef> STATIONS = new LinkedHashMap<>();

    static {
        STATIONS.put("franceinter", new StationDef("franceinter", "France Inter"));
        STATIONS.put("franceculture", new StationDef("franceculture", "France Culture"));
        STATIONS.put("franceinfo", new StationDef("franceinfo", "franceinfo"));
        STATIONS.put("francemusique", new StationDef("francemusique", "France Musique"));
        STATIONS.put("fip", new StationDef("fip", "FIP"));
        STATIONS.put("mouv", new StationDef("mouv", "Mouv'"));
    }

    private static final Pattern SHOW_HREF = Pattern.compile(
            "href=\"(/([a-z0-9]+)/podcasts/([a-z0-9][a-z0-9\\-]*))\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern SHOW_ARIA = Pattern.compile(
            "href=\"(/([a-z0-9]+)/podcasts/([a-z0-9][a-z0-9\\-]*))\"[^>]*aria-label=\"([^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern SHOW_TITLE_ID = Pattern.compile(
            "id=\"title-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern RSS_FEED = Pattern.compile(
            "rssFeed:\"(https://radiofrance-podcast\\.net[^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern OG_TITLE = Pattern.compile(
            "property=\"og:title\" content=\"([^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern OG_IMAGE = Pattern.compile(
            "property=\"og:image\" content=\"([^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern OG_DESC = Pattern.compile(
            "property=\"og:description\" content=\"([^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern ITEM_BLOCK = Pattern.compile(
            "<item\\b[^>]*>(.*?)</item>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_TITLE = Pattern.compile(
            "<title>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</title>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_DESC = Pattern.compile(
            "<description>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</description>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_LINK = Pattern.compile(
            "<link>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</link>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_GUID = Pattern.compile(
            "<guid[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</guid>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_PUB = Pattern.compile(
            "<pubDate>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</pubDate>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_ENCLOSURE = Pattern.compile(
            "<enclosure[^>]*\\burl=\"([^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern TAG_DURATION = Pattern.compile(
            "<itunes:duration>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</itunes:duration>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern TAG_IMAGE = Pattern.compile(
            "<itunes:image[^>]*href=\"([^\"]+)\"",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern CHANNEL_TITLE = Pattern.compile(
            "<channel\\b[^>]*>\\s*<title>(?:<!\\[CDATA\\[)?(.*?)(?:]]>)?</title>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern CHANNEL_IMAGE = Pattern.compile(
            "<itunes:image[^>]*href=\"([^\"]+)\"|<image>\\s*<url>([^<]+)</url>",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(12))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ConcurrentHashMap<String, CachedShows> showCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedEpisodes> episodeCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedShowMeta> showMetaCache = new ConcurrentHashMap<>();

    public List<Map<String, String>> stations() {
        List<Map<String, String>> out = new ArrayList<>();
        for (StationDef st : STATIONS.values()) {
            Map<String, String> row = new LinkedHashMap<>();
            row.put("id", st.id());
            row.put("name", st.name());
            out.add(row);
        }
        return out;
    }

    public String normalizeStation(String station) {
        if (!StringUtils.hasText(station)) {
            return "franceinter";
        }
        String id = station.trim().toLowerCase(Locale.ROOT);
        return STATIONS.containsKey(id) ? id : "franceinter";
    }

    public boolean isKnownStation(String station) {
        return StringUtils.hasText(station) && STATIONS.containsKey(station.trim().toLowerCase(Locale.ROOT));
    }

    public List<RadioFrancePodcastShowDto> listShows(String station, String query) {
        String st = normalizeStation(station);
        List<RadioFrancePodcastShowDto> shows = loadShows(st);
        String q = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
        if (q.isEmpty()) {
            return shows;
        }
        List<RadioFrancePodcastShowDto> filtered = new ArrayList<>();
        for (RadioFrancePodcastShowDto show : shows) {
            if (matchesQuery(show, q)) {
                filtered.add(show);
            }
        }
        return filtered;
    }

    public Optional<RadioFrancePodcastShowDto> findShow(String station, String slug) {
        if (!StringUtils.hasText(slug)) {
            return Optional.empty();
        }
        String st = normalizeStation(station);
        String needle = slug.trim().toLowerCase(Locale.ROOT);
        for (RadioFrancePodcastShowDto show : loadShows(st)) {
            if (needle.equalsIgnoreCase(show.getSlug())) {
                return Optional.of(show);
            }
        }
        // Show may exist even if absent from the listing page (deep link).
        StationDef def = STATIONS.get(st);
        String path = "/" + st + "/podcasts/" + needle;
        return Optional.of(new RadioFrancePodcastShowDto(
                "rf-show-" + st + "-" + needle,
                st,
                def != null ? def.name() : st,
                needle,
                humanizeSlug(needle),
                "",
                "",
                path,
                SITE + path));
    }

    public List<RadioFrancePodcastEpisodeDto> listEpisodes(String station, String slug, int limit) {
        String st = normalizeStation(station);
        String showSlug = slug != null ? slug.trim().toLowerCase(Locale.ROOT) : "";
        if (showSlug.isEmpty()) {
            return List.of();
        }
        int safeLimit = Math.max(1, Math.min(limit <= 0 ? MAX_EPISODES : limit, MAX_EPISODES));
        String cacheKey = st + "/" + showSlug;
        CachedEpisodes cached = episodeCache.get(cacheKey);
        if (cached != null && !cached.expired()) {
            return cached.episodes().stream().limit(safeLimit).toList();
        }

        Optional<ShowRss> rss = resolveRss(st, showSlug);
        if (rss.isEmpty()) {
            return List.of();
        }
        List<RadioFrancePodcastEpisodeDto> episodes = parseRss(st, showSlug, rss.get(), safeLimit);
        episodeCache.put(cacheKey, new CachedEpisodes(episodes, Instant.now().plus(EPISODE_CACHE_TTL)));
        return episodes;
    }

    public int invalidateAll() {
        int n = showCache.size() + episodeCache.size() + showMetaCache.size();
        showCache.clear();
        episodeCache.clear();
        showMetaCache.clear();
        return n;
    }

    private List<RadioFrancePodcastShowDto> loadShows(String station) {
        CachedShows cached = showCache.get(station);
        if (cached != null && !cached.expired()) {
            return cached.shows();
        }
        StationDef def = STATIONS.get(station);
        if (def == null) {
            return List.of();
        }
        Optional<String> html = fetchText(SITE + "/" + station + "/podcasts");
        if (html.isEmpty()) {
            if (cached != null) {
                return cached.shows();
            }
            return List.of();
        }
        List<RadioFrancePodcastShowDto> shows = parseShowListing(def, html.get());
        showCache.put(station, new CachedShows(shows, Instant.now().plus(SHOW_CACHE_TTL)));
        return shows;
    }

    private List<RadioFrancePodcastShowDto> parseShowListing(StationDef station, String html) {
        Map<String, String> titlesByPath = new LinkedHashMap<>();
        Matcher aria = SHOW_ARIA.matcher(html);
        while (aria.find()) {
            String path = aria.group(1);
            String st = aria.group(2).toLowerCase(Locale.ROOT);
            String slug = aria.group(3).toLowerCase(Locale.ROOT);
            if (!station.id().equals(st) || "podcasts".equals(slug)) {
                continue;
            }
            titlesByPath.put("/" + st + "/podcasts/" + slug, unescapeHtml(aria.group(4)).trim());
        }

        // Fallback: collect hrefs even without aria-label.
        Matcher href = SHOW_HREF.matcher(html);
        Set<String> paths = new LinkedHashSet<>();
        while (href.find()) {
            String st = href.group(2).toLowerCase(Locale.ROOT);
            String slug = href.group(3).toLowerCase(Locale.ROOT);
            if (!station.id().equals(st) || "podcasts".equals(slug)) {
                continue;
            }
            paths.add("/" + st + "/podcasts/" + slug);
        }

        // Optional UUID near title anchors (used as stable id when present).
        Map<String, String> uuidNearPath = new LinkedHashMap<>();
        Matcher titleId = SHOW_TITLE_ID.matcher(html);
        while (titleId.find()) {
            int from = Math.max(0, titleId.start() - 40);
            int to = Math.min(html.length(), titleId.end() + 500);
            String window = html.substring(from, to);
            Matcher pathInWindow = SHOW_HREF.matcher(window);
            if (pathInWindow.find()) {
                uuidNearPath.put(pathInWindow.group(1), titleId.group(1).toLowerCase(Locale.ROOT));
            }
        }

        List<RadioFrancePodcastShowDto> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String path : paths) {
            if (!seen.add(path)) {
                continue;
            }
            String slug = path.substring(path.lastIndexOf('/') + 1);
            String title = titlesByPath.getOrDefault(path, humanizeSlug(slug));
            String uuid = uuidNearPath.get(path);
            String id = uuid != null ? "rf-show-" + uuid : "rf-show-" + station.id() + "-" + slug;
            out.add(new RadioFrancePodcastShowDto(
                    id,
                    station.id(),
                    station.name(),
                    slug,
                    title,
                    "",
                    "",
                    path,
                    SITE + path));
        }
        out.sort((a, b) -> a.getTitle().compareToIgnoreCase(b.getTitle()));
        return out;
    }

    private Optional<ShowRss> resolveRss(String station, String slug) {
        String metaKey = station + "/" + slug;
        CachedShowMeta meta = showMetaCache.get(metaKey);
        if (meta != null && !meta.expired() && StringUtils.hasText(meta.rssUrl())) {
            return Optional.of(new ShowRss(meta.title(), meta.image(), meta.rssUrl()));
        }

        String path = "/" + station + "/podcasts/" + slug;
        Optional<String> html = fetchText(SITE + path);
        if (html.isEmpty()) {
            return Optional.empty();
        }
        Matcher rss = RSS_FEED.matcher(html.get());
        if (!rss.find()) {
            log.debug("No rssFeed on Radio France show page {}", path);
            return Optional.empty();
        }
        String rssUrl = rss.group(1).trim();
        String title = firstGroup(OG_TITLE, html.get()).orElse(humanizeSlug(slug));
        String image = firstGroup(OG_IMAGE, html.get()).orElse("");
        String desc = firstGroup(OG_DESC, html.get()).orElse("");
        showMetaCache.put(metaKey, new CachedShowMeta(
                title, image, desc, rssUrl, Instant.now().plus(SHOW_CACHE_TTL)));
        return Optional.of(new ShowRss(title, image, rssUrl));
    }

    private List<RadioFrancePodcastEpisodeDto> parseRss(
            String station, String slug, ShowRss showRss, int limit) {
        Optional<String> xml = fetchText(showRss.rssUrl());
        if (xml.isEmpty()) {
            return List.of();
        }
        String body = xml.get();
        String channelTitle = firstGroup(CHANNEL_TITLE, body).orElse(showRss.title());
        String channelImage = "";
        Matcher img = CHANNEL_IMAGE.matcher(body);
        if (img.find()) {
            channelImage = StringUtils.hasText(img.group(1)) ? img.group(1) : img.group(2);
        }
        if (!StringUtils.hasText(channelImage)) {
            channelImage = showRss.image();
        }

        Optional<RadioFrancePodcastShowDto> show = findShow(station, slug);
        String showId = show.map(RadioFrancePodcastShowDto::getId).orElse("rf-show-" + station + "-" + slug);

        List<RadioFrancePodcastEpisodeDto> out = new ArrayList<>();
        Matcher items = ITEM_BLOCK.matcher(body);
        while (items.find() && out.size() < limit) {
            String item = items.group(1);
            String enclosure = firstGroup(TAG_ENCLOSURE, item).orElse("");
            if (!StringUtils.hasText(enclosure)
                    || !(enclosure.startsWith("http://") || enclosure.startsWith("https://"))) {
                continue;
            }
            String title = stripTags(firstGroup(TAG_TITLE, item).orElse("Épisode")).trim();
            if (title.isEmpty()) {
                title = "Épisode";
            }
            String guid = firstGroup(TAG_GUID, item).orElse(enclosure);
            String link = firstGroup(TAG_LINK, item).orElse("");
            String pub = firstGroup(TAG_PUB, item).orElse("");
            String desc = stripTags(firstGroup(TAG_DESC, item).orElse("")).trim();
            String epImage = firstGroup(TAG_IMAGE, item).orElse(channelImage);
            Integer duration = parseDuration(firstGroup(TAG_DURATION, item).orElse(null));

            RadioFrancePodcastEpisodeDto ep = new RadioFrancePodcastEpisodeDto();
            ep.setId("rf-ep-" + stableId(guid));
            ep.setShowId(showId);
            ep.setShowTitle(channelTitle);
            ep.setStation(station);
            ep.setTitle(title);
            ep.setDescription(desc);
            ep.setImage(epImage);
            ep.setStreamUrl(enclosure.trim());
            ep.setHomepage(StringUtils.hasText(link) ? link.trim() : showRss.rssUrl());
            ep.setPublishedAt(pub.trim());
            ep.setDurationSec(duration);
            ep.setCodec(guessCodec(enclosure));
            out.add(ep);
        }
        return out;
    }

    private Optional<String> fetchText(String url) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(HTTP_TIMEOUT)
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                    .header("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8")
                    .header("Referer", SITE + "/")
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (resp.statusCode() >= 200 && resp.statusCode() < 300 && StringUtils.hasText(resp.body())) {
                return Optional.of(resp.body());
            }
            log.debug("Radio France fetch {} -> {}", url, resp.statusCode());
        } catch (Exception e) {
            log.debug("Radio France fetch failed for {}: {}", url, e.toString());
        }
        return Optional.empty();
    }

    private static boolean matchesQuery(RadioFrancePodcastShowDto show, String q) {
        return contains(show.getTitle(), q)
                || contains(show.getSlug(), q)
                || contains(show.getDescription(), q)
                || contains(show.getStationName(), q);
    }

    private static boolean contains(String value, String q) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(q);
    }

    private static Optional<String> firstGroup(Pattern pattern, String text) {
        Matcher m = pattern.matcher(text);
        if (!m.find()) {
            return Optional.empty();
        }
        String g = m.group(1);
        return StringUtils.hasText(g) ? Optional.of(g.trim()) : Optional.empty();
    }

    private static String humanizeSlug(String slug) {
        if (!StringUtils.hasText(slug)) {
            return "Podcast";
        }
        String[] parts = slug.replace('-', ' ').split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p.isEmpty()) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(Character.toUpperCase(p.charAt(0)));
            if (p.length() > 1) {
                sb.append(p.substring(1));
            }
        }
        return sb.toString();
    }

    private static String unescapeHtml(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&nbsp;", " ");
    }

    private static String stripTags(String s) {
        if (s == null) {
            return "";
        }
        return unescapeHtml(s.replaceAll("(?is)<[^>]+>", " ").replaceAll("\\s+", " ")).trim();
    }

    private static Integer parseDuration(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String t = raw.trim();
        if (t.matches("^\\d+$")) {
            try {
                return Integer.parseInt(t);
            } catch (NumberFormatException e) {
                return null;
            }
        }
        String[] parts = t.split(":");
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
        return null;
    }

    private static String guessCodec(String url) {
        String u = url.toLowerCase(Locale.ROOT);
        if (u.contains(".m4a") || u.contains("audio/mp4") || u.contains("audio/x-m4a")) {
            return "M4A";
        }
        if (u.contains(".aac")) {
            return "AAC";
        }
        if (u.contains(".mp3")) {
            return "MP3";
        }
        if (u.contains(".ogg") || u.contains(".opus")) {
            return "OGG";
        }
        return "AUDIO";
    }

    private static String stableId(String raw) {
        String s = raw != null ? raw.trim() : "";
        if (s.isEmpty()) {
            return Integer.toHexString(("x" + System.nanoTime()).hashCode());
        }
        // Prefer trailing UUID / short token; else hash.
        Matcher m = Pattern.compile("([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                Pattern.CASE_INSENSITIVE).matcher(s);
        if (m.find()) {
            return m.group(1).toLowerCase(Locale.ROOT);
        }
        return Integer.toHexString(s.hashCode());
    }

    private record StationDef(String id, String name) {
    }

    private record ShowRss(String title, String image, String rssUrl) {
    }

    private record CachedShows(List<RadioFrancePodcastShowDto> shows, Instant expiresAt) {
        boolean expired() {
            return Instant.now().isAfter(expiresAt);
        }
    }

    private record CachedEpisodes(List<RadioFrancePodcastEpisodeDto> episodes, Instant expiresAt) {
        boolean expired() {
            return Instant.now().isAfter(expiresAt);
        }
    }

    private record CachedShowMeta(
            String title, String image, String description, String rssUrl, Instant expiresAt) {
        boolean expired() {
            return Instant.now().isAfter(expiresAt);
        }
    }
}
