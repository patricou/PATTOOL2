package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.TmdbCreditDto;
import com.pat.controller.dto.TmdbDetailDto;
import com.pat.controller.dto.TmdbGenreDto;
import com.pat.controller.dto.TmdbGenresDto;
import com.pat.controller.dto.TmdbItemDto;
import com.pat.controller.dto.TmdbPageDto;
import com.pat.controller.dto.TmdbVideoDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * TMDB API v3 proxy. The browser never calls api.themoviedb.org and never
 * sees {@code app.tmdb.api-key}. Posters are public image URLs (no key).
 */
@Service
public class TmdbProxyService {

    private static final Logger log = LoggerFactory.getLogger(TmdbProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (tmdb helper; https://www.patrickdeschamps.com)";
    private static final String IMAGE_BASE = "https://image.tmdb.org/t/p/";
    private static final Duration CACHE_TTL = Duration.ofMinutes(15);
    private static final int CACHE_MAX = 250;
    private static final int CAST_LIMIT = 12;
    private static final Pattern YT_KEY = Pattern.compile("^[A-Za-z0-9_-]{6,20}$");
    private static final Pattern IMAGE_PATH = Pattern.compile("^/[A-Za-z0-9_./-]{1,200}$");
    private static final Set<String> TRENDING_MEDIA = Set.of("all", "movie", "tv");
    private static final Set<String> SEARCH_MEDIA = Set.of("multi", "movie", "tv");
    private static final Set<String> DISCOVER_MEDIA = Set.of("movie", "tv");
    private static final Set<String> WINDOWS = Set.of("day", "week");
    private static final Set<String> SORTS = Set.of("popular", "rating", "newest");
    private static final Map<String, String> LANGS = Map.ofEntries(
            Map.entry("fr", "fr-FR"),
            Map.entry("en", "en-US"),
            Map.entry("de", "de-DE"),
            Map.entry("es", "es-ES"),
            Map.entry("it", "it-IT"),
            Map.entry("ru", "ru-RU"),
            Map.entry("ja", "ja-JP"),
            Map.entry("jp", "ja-JP"),
            Map.entry("zh", "zh-CN"),
            Map.entry("cn", "zh-CN"),
            Map.entry("ar", "ar-SA"),
            Map.entry("he", "he-IL"),
            Map.entry("el", "el-GR"),
            Map.entry("hi", "hi-IN"),
            Map.entry("in", "hi-IN"),
            Map.entry("pt", "pt-PT")
    );

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String apiBase;
    private final String apiKey;
    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public TmdbProxyService(
            RestTemplateBuilder builder,
            ObjectMapper objectMapper,
            @Value("${app.tmdb.api-base:https://api.themoviedb.org/3}") String apiBase,
            @Value("${app.tmdb.api-key:}") String apiKey) {
        this.restTemplate = builder
                .setConnectTimeout(Duration.ofSeconds(5))
                .setReadTimeout(Duration.ofSeconds(12))
                .build();
        this.objectMapper = objectMapper;
        this.apiBase = trimSlash(apiBase);
        this.apiKey = apiKey == null ? "" : apiKey.trim();
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    public TmdbPageDto trending(String media, String window, String lang, Integer page) {
        if (!isConfigured()) {
            return TmdbPageDto.missingKey();
        }
        String kind = TRENDING_MEDIA.contains(media) ? media : "all";
        String span = WINDOWS.contains(window) ? window : "week";
        String language = normalizeLang(lang);
        int pageNo = normalizePage(page);
        String cacheKey = "trending|" + kind + "|" + span + "|" + language + "|" + pageNo;
        TmdbPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/trending/" + kind + "/" + span)
                .queryParam("language", language)
                .queryParam("page", pageNo);
        JsonNode raw = fetchJson(withKey(builder), "trending");
        TmdbPageDto result = mapPage(raw, kind, pageNo);
        if (result.error() == null) {
            putCache(cacheKey, result);
        }
        return result;
    }

    public TmdbPageDto search(String query, String media, String lang, Integer page) {
        if (!isConfigured()) {
            return TmdbPageDto.missingKey();
        }
        String q = query == null ? "" : query.trim();
        if (!StringUtils.hasText(q)) {
            return TmdbPageDto.empty();
        }
        if (!safeQuery(q)) {
            return TmdbPageDto.failure("invalid_query");
        }
        String kind = SEARCH_MEDIA.contains(media) ? media : "multi";
        String language = normalizeLang(lang);
        int pageNo = normalizePage(page);
        String cacheKey = "search|" + kind + "|" + language + "|" + pageNo + "|" + q;
        TmdbPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/search/" + kind)
                .queryParam("query", q)
                .queryParam("language", language)
                .queryParam("page", pageNo)
                .queryParam("include_adult", "false");
        JsonNode raw = fetchJson(withKey(builder), "search");
        TmdbPageDto result = mapPage(raw, "multi".equals(kind) ? "" : kind, pageNo);
        if (result.error() == null) {
            putCache(cacheKey, result);
        }
        return result;
    }

    public TmdbPageDto discover(String media, Integer genre, Integer year, String sort, String lang, Integer page) {
        if (!isConfigured()) {
            return TmdbPageDto.missingKey();
        }
        String kind = DISCOVER_MEDIA.contains(media) ? media : "movie";
        String language = normalizeLang(lang);
        int pageNo = normalizePage(page);
        String sortKey = SORTS.contains(sort) ? sort : "popular";
        Integer genreId = genre != null && genre > 0 && genre < 100000 ? genre : null;
        Integer releaseYear = year != null && year >= 1870 && year <= 2100 ? year : null;
        String cacheKey = "discover|" + kind + "|" + language + "|" + pageNo + "|" + sortKey
                + "|" + genreId + "|" + releaseYear;
        TmdbPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/discover/" + kind)
                .queryParam("language", language)
                .queryParam("page", pageNo)
                .queryParam("include_adult", "false")
                .queryParam("sort_by", sortParam(sortKey, kind));
        if ("rating".equals(sortKey)) {
            builder.queryParam("vote_count.gte", 200);
        }
        if (genreId != null) {
            builder.queryParam("with_genres", genreId);
        }
        if (releaseYear != null) {
            String yearParam = "tv".equals(kind) ? "first_air_date_year" : "primary_release_year";
            builder.queryParam(yearParam, releaseYear);
        }
        JsonNode raw = fetchJson(withKey(builder), "discover");
        TmdbPageDto result = mapPage(raw, kind, pageNo);
        if (result.error() == null) {
            putCache(cacheKey, result);
        }
        return result;
    }

    public TmdbGenresDto genres(String media, String lang) {
        if (!isConfigured()) {
            return TmdbGenresDto.missingKey();
        }
        String kind = DISCOVER_MEDIA.contains(media) ? media : "movie";
        String language = normalizeLang(lang);
        String cacheKey = "genres|" + kind + "|" + language;
        CacheEntry hit = cache.get(cacheKey);
        if (hit != null && hit.expiresAt.isAfter(Instant.now()) && hit.genres != null) {
            return hit.genres;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/genre/" + kind + "/list")
                .queryParam("language", language);
        JsonNode raw = fetchJson(withKey(builder), "genres");
        if (raw == null) {
            return TmdbGenresDto.failure("upstream_error");
        }
        String err = apiError(raw);
        if (err != null) {
            return TmdbGenresDto.failure(err);
        }
        List<TmdbGenreDto> items = new ArrayList<>();
        for (JsonNode node : raw.path("genres")) {
            int id = node.path("id").asInt(0);
            String name = textOrEmpty(node.path("name"));
            if (id > 0 && StringUtils.hasText(name)) {
                items.add(new TmdbGenreDto(id, name));
            }
        }
        TmdbGenresDto result = new TmdbGenresDto(true, null, items);
        putCache(cacheKey, result);
        return result;
    }

    public TmdbDetailDto detail(String media, long id, String lang) {
        if (!isConfigured()) {
            return TmdbDetailDto.missingKey();
        }
        if (!DISCOVER_MEDIA.contains(media) || id <= 0) {
            return TmdbDetailDto.failure("invalid_query");
        }
        String language = normalizeLang(lang);
        String cacheKey = "detail|" + media + "|" + id + "|" + language;
        CacheEntry hit = cache.get(cacheKey);
        if (hit != null && hit.expiresAt.isAfter(Instant.now()) && hit.detail != null) {
            return hit.detail;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/" + media + "/" + id)
                .queryParam("language", language)
                .queryParam("append_to_response", "credits,videos");
        JsonNode raw = fetchJson(withKey(builder), "detail");
        if (raw == null) {
            return TmdbDetailDto.failure("upstream_error");
        }
        String err = apiError(raw);
        if ("not_found".equals(err)) {
            return TmdbDetailDto.failure("not_found");
        }
        if (err != null) {
            return TmdbDetailDto.failure(err);
        }
        TmdbDetailDto result = mapDetail(raw, media, id);
        putCache(cacheKey, result);
        return result;
    }

    private TmdbPageDto mapPage(JsonNode raw, String fallbackMedia, int requestedPage) {
        if (raw == null) {
            return TmdbPageDto.failure("upstream_error");
        }
        String err = apiError(raw);
        if (err != null) {
            return TmdbPageDto.failure(err);
        }
        List<TmdbItemDto> items = mapItems(raw.path("results"), fallbackMedia);
        int page = raw.path("page").asInt(requestedPage);
        int totalPages = Math.max(0, raw.path("total_pages").asInt(0));
        int total = Math.max(0, raw.path("total_results").asInt(items.size()));
        return new TmdbPageDto(true, null, page, totalPages, total, items);
    }

    private List<TmdbItemDto> mapItems(JsonNode results, String fallbackMedia) {
        List<TmdbItemDto> items = new ArrayList<>();
        if (results == null || !results.isArray()) {
            return items;
        }
        for (JsonNode node : results) {
            String media = textOrEmpty(node.path("media_type"));
            if (!StringUtils.hasText(media)) {
                media = fallbackMedia;
            }
            if (!"movie".equals(media) && !"tv".equals(media)) {
                continue;
            }
            long id = node.path("id").asLong(0);
            if (id <= 0) {
                continue;
            }
            String title = firstText(node, "movie".equals(media) ? "title" : "name", "movie".equals(media) ? "name" : "title");
            if (!StringUtils.hasText(title)) {
                continue;
            }
            String original = firstText(
                    node,
                    "movie".equals(media) ? "original_title" : "original_name",
                    "movie".equals(media) ? "original_name" : "original_title");
            String date = firstText(
                    node,
                    "movie".equals(media) ? "release_date" : "first_air_date",
                    "movie".equals(media) ? "first_air_date" : "release_date");
            items.add(new TmdbItemDto(
                    id,
                    media,
                    title,
                    blankToNull(original),
                    blankToNull(textOrEmpty(node.path("overview"))),
                    imageUrl(textOrNull(node.path("poster_path")), "w342"),
                    imageUrl(textOrNull(node.path("backdrop_path")), "w780"),
                    blankToNull(date),
                    vote(node.path("vote_average")),
                    positiveInt(node.path("vote_count")),
                    blankToNull(textOrEmpty(node.path("original_language")))
            ));
        }
        return items;
    }

    private TmdbDetailDto mapDetail(JsonNode node, String media, long id) {
        String title = firstText(node, "movie".equals(media) ? "title" : "name", "title");
        String original = firstText(
                node,
                "movie".equals(media) ? "original_title" : "original_name",
                "original_title");
        String date = firstText(
                node,
                "movie".equals(media) ? "release_date" : "first_air_date",
                "release_date");
        List<TmdbVideoDto> videos = youtubeVideos(node.path("videos"));
        return new TmdbDetailDto(
                true,
                null,
                id,
                media,
                title,
                blankToNull(original),
                blankToNull(textOrEmpty(node.path("tagline"))),
                blankToNull(textOrEmpty(node.path("overview"))),
                imageUrl(textOrNull(node.path("poster_path")), "w342"),
                imageUrl(textOrNull(node.path("backdrop_path")), "w780"),
                blankToNull(date),
                vote(node.path("vote_average")),
                positiveInt(node.path("vote_count")),
                runtimeOf(node, media),
                genreNames(node.path("genres")),
                blankToNull(textOrEmpty(node.path("status"))),
                "tv".equals(media) ? positiveInt(node.path("number_of_seasons")) : null,
                "tv".equals(media) ? positiveInt(node.path("number_of_episodes")) : null,
                videos.isEmpty() ? null : videos.get(0).key(),
                videos,
                tmdbUrl(media, id),
                castOf(node.path("credits"))
        );
    }

    private List<String> genreNames(JsonNode genres) {
        List<String> names = new ArrayList<>();
        if (genres != null && genres.isArray()) {
            for (JsonNode genre : genres) {
                String name = textOrEmpty(genre.path("name"));
                if (StringUtils.hasText(name)) {
                    names.add(name);
                }
            }
        }
        return names;
    }

    private List<TmdbCreditDto> castOf(JsonNode credits) {
        List<TmdbCreditDto> cast = new ArrayList<>();
        JsonNode people = credits == null ? null : credits.path("cast");
        if (people == null || !people.isArray()) {
            return cast;
        }
        for (JsonNode person : people) {
            if (cast.size() >= CAST_LIMIT) {
                break;
            }
            String name = textOrEmpty(person.path("name"));
            if (!StringUtils.hasText(name)) {
                continue;
            }
            cast.add(new TmdbCreditDto(
                    person.path("id").asLong(0),
                    name,
                    blankToNull(textOrEmpty(person.path("character"))),
                    imageUrl(textOrNull(person.path("profile_path")), "w185")
            ));
        }
        return cast;
    }

    private List<TmdbVideoDto> youtubeVideos(JsonNode videos) {
        JsonNode results = videos == null ? null : videos.path("results");
        List<TmdbVideoDto> items = new ArrayList<>();
        if (results == null || !results.isArray()) {
            return items;
        }
        List<JsonNode> nodes = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode video : results) {
            if (!"YouTube".equalsIgnoreCase(textOrEmpty(video.path("site")))) {
                continue;
            }
            String key = textOrEmpty(video.path("key"));
            if (!YT_KEY.matcher(key).matches() || !seen.add(key)) {
                continue;
            }
            nodes.add(video);
        }
        nodes.sort(Comparator.comparingInt(this::videoRank));
        int limit = Math.min(nodes.size(), 15);
        for (int i = 0; i < limit; i++) {
            JsonNode video = nodes.get(i);
            String name = blankToNull(textOrEmpty(video.path("name")));
            String type = blankToNull(textOrEmpty(video.path("type")));
            items.add(new TmdbVideoDto(textOrEmpty(video.path("key")), name, type));
        }
        return items;
    }

    private int videoRank(JsonNode video) {
        String type = textOrEmpty(video.path("type"));
        boolean official = video.path("official").asBoolean(false);
        if ("Trailer".equalsIgnoreCase(type) && official) {
            return 0;
        }
        if ("Trailer".equalsIgnoreCase(type)) {
            return 1;
        }
        if ("Teaser".equalsIgnoreCase(type)) {
            return 2;
        }
        if ("Clip".equalsIgnoreCase(type)) {
            return 3;
        }
        return 4;
    }

    private Integer runtimeOf(JsonNode node, String media) {
        if ("tv".equals(media)) {
            JsonNode runtimes = node.path("episode_run_time");
            if (runtimes.isArray() && !runtimes.isEmpty()) {
                return positiveInt(runtimes.get(0));
            }
            return null;
        }
        return positiveInt(node.path("runtime"));
    }

    private String sortParam(String sort, String media) {
        return switch (sort) {
            case "rating" -> "vote_average.desc";
            case "newest" -> "tv".equals(media) ? "first_air_date.desc" : "primary_release_date.desc";
            default -> "popularity.desc";
        };
    }

    private java.net.URI withKey(UriComponentsBuilder builder) {
        return builder.queryParam("api_key", apiKey).build().encode().toUri();
    }

    private JsonNode fetchJson(java.net.URI uri, String label) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = restTemplate.exchange(
                    uri,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            log.warn("TMDB HTTP {} for {}", e.getStatusCode().value(), label);
            String body = e.getResponseBodyAsString();
            if (StringUtils.hasText(body)) {
                try {
                    return objectMapper.readTree(body);
                } catch (Exception ignored) {
                    return null;
                }
            }
            return null;
        } catch (RestClientException e) {
            log.warn("TMDB unavailable for {}: {}", label, e.getClass().getSimpleName());
            return null;
        } catch (Exception e) {
            log.warn("TMDB parse failed for {}: {}", label, e.getClass().getSimpleName());
            return null;
        }
    }

    private String apiError(JsonNode raw) {
        if (raw == null || !raw.has("status_code")) {
            return null;
        }
        if (raw.path("success").asBoolean(true)) {
            return null;
        }
        int code = raw.path("status_code").asInt(0);
        if (code == 7) {
            return "invalid_api_key";
        }
        if (code == 34) {
            return "not_found";
        }
        return "upstream_error";
    }

    private String normalizeLang(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "fr-FR";
        }
        String code = raw.trim().toLowerCase(Locale.ROOT);
        int dash = code.indexOf('-');
        if (dash > 0) {
            code = code.substring(0, dash);
        }
        if (code.length() > 2) {
            code = code.substring(0, 2);
        }
        return LANGS.getOrDefault(code, "en-US");
    }

    private static int normalizePage(Integer page) {
        if (page == null || page < 1) {
            return 1;
        }
        return Math.min(page, 500);
    }

    private static boolean safeQuery(String q) {
        if (q.length() > 120) {
            return false;
        }
        for (int i = 0; i < q.length(); i++) {
            if (Character.isISOControl(q.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    private static String imageUrl(String path, String size) {
        if (!StringUtils.hasText(path) || !IMAGE_PATH.matcher(path).matches()) {
            return null;
        }
        return IMAGE_BASE + size + path;
    }

    private static String tmdbUrl(String media, long id) {
        return "https://www.themoviedb.org/" + ("tv".equals(media) ? "tv" : "movie") + "/" + id;
    }

    private static Double vote(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        double value = node.asDouble(Double.NaN);
        if (Double.isNaN(value) || value <= 0) {
            return null;
        }
        return Math.round(value * 10.0) / 10.0;
    }

    private static Integer positiveInt(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        int value = node.asInt(0);
        return value > 0 ? value : null;
    }

    private static String firstText(JsonNode node, String primary, String fallback) {
        String value = textOrEmpty(node.path(primary));
        if (StringUtils.hasText(value)) {
            return value;
        }
        return textOrEmpty(node.path(fallback));
    }

    private static String textOrEmpty(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return "";
        }
        return node.asText("").trim();
    }

    private static String textOrNull(JsonNode node) {
        String value = textOrEmpty(node);
        return StringUtils.hasText(value) ? value : null;
    }

    private static String blankToNull(String value) {
        return StringUtils.hasText(value) ? value : null;
    }

    private static String trimSlash(String value) {
        if (!StringUtils.hasText(value)) {
            return "https://api.themoviedb.org/3";
        }
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private TmdbPageDto fromCache(String key) {
        CacheEntry hit = cache.get(key);
        if (hit == null || hit.page == null || !hit.expiresAt.isAfter(Instant.now())) {
            return null;
        }
        return hit.page;
    }

    private void putCache(String key, TmdbPageDto page) {
        if (cache.size() > CACHE_MAX) {
            cache.clear();
        }
        cache.put(key, CacheEntry.page(page, Instant.now().plus(CACHE_TTL)));
    }

    private void putCache(String key, TmdbGenresDto genres) {
        if (cache.size() > CACHE_MAX) {
            cache.clear();
        }
        cache.put(key, CacheEntry.genres(genres, Instant.now().plus(CACHE_TTL)));
    }

    private void putCache(String key, TmdbDetailDto detail) {
        if (cache.size() > CACHE_MAX) {
            cache.clear();
        }
        cache.put(key, CacheEntry.detail(detail, Instant.now().plus(CACHE_TTL)));
    }

    private static final class CacheEntry {
        private final Instant expiresAt;
        private final TmdbPageDto page;
        private final TmdbGenresDto genres;
        private final TmdbDetailDto detail;

        private CacheEntry(Instant expiresAt, TmdbPageDto page, TmdbGenresDto genres, TmdbDetailDto detail) {
            this.expiresAt = expiresAt;
            this.page = page;
            this.genres = genres;
            this.detail = detail;
        }

        private static CacheEntry page(TmdbPageDto page, Instant expiresAt) {
            return new CacheEntry(expiresAt, page, null, null);
        }

        private static CacheEntry genres(TmdbGenresDto genres, Instant expiresAt) {
            return new CacheEntry(expiresAt, null, genres, null);
        }

        private static CacheEntry detail(TmdbDetailDto detail, Instant expiresAt) {
            return new CacheEntry(expiresAt, null, null, detail);
        }
    }
}
