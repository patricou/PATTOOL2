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
    private static final Set<String> SORTS = Set.of(
            "popular", "rating", "rating_asc", "newest", "oldest", "title", "title_desc", "votes", "revenue");
    private static final int CREDIT_PAGE_SIZE = 20;
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

    public TmdbPageDto discover(
            String media,
            Integer genre,
            Integer year,
            String sort,
            String actor,
            String producer,
            String director,
            String lang,
            Integer page) {
        if (!isConfigured()) {
            return TmdbPageDto.missingKey();
        }
        String kind = DISCOVER_MEDIA.contains(media) ? media : "movie";
        String language = normalizeLang(lang);
        int pageNo = normalizePage(page);
        String sortKey = SORTS.contains(sort) ? sort : "popular";
        Integer genreId = genre != null && genre > 0 && genre < 100000 ? genre : null;
        Integer releaseYear = year != null && year >= 1870 && year <= 2100 ? year : null;
        String actorQuery = cleanPerson(actor);
        String producerQuery = cleanPerson(producer);
        String directorQuery = cleanPerson(director);
        if (rejectedPerson(actor) || rejectedPerson(producer) || rejectedPerson(director)) {
            return TmdbPageDto.failure("invalid_query");
        }
        String cacheKey = "discover|" + kind + "|" + language + "|" + pageNo + "|" + sortKey
                + "|" + genreId + "|" + releaseYear
                + "|" + cacheToken(actorQuery) + "|" + cacheToken(producerQuery) + "|" + cacheToken(directorQuery);
        TmdbPageDto cached = fromCache(cacheKey);
        if (cached != null) {
            return cached;
        }
        PersonHit actorHit = resolvePerson(actorQuery, "actor", language);
        PersonHit producerHit = resolvePerson(producerQuery, "producer", language);
        PersonHit directorHit = resolvePerson(directorQuery, "director", language);
        if (failed(actorHit) || failed(producerHit) || failed(directorHit)) {
            return TmdbPageDto.failure("upstream_error");
        }
        if (missingPerson(actorQuery, actorHit) || missingPerson(producerQuery, producerHit) || missingPerson(directorQuery, directorHit)) {
            TmdbPageDto empty = TmdbPageDto.empty();
            putCache(cacheKey, empty);
            return empty;
        }
        if (producerHit != null || directorHit != null) {
            TmdbPageDto credited = creditsPage(
                    kind, genreId, releaseYear, sortKey, pageNo, language, actorHit, producerHit, directorHit);
            if (credited.error() == null) {
                putCache(cacheKey, credited);
            }
            return credited;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/discover/" + kind)
                .queryParam("language", language)
                .queryParam("page", pageNo)
                .queryParam("include_adult", "false")
                .queryParam("sort_by", sortParam(sortKey, kind));
        if (("rating".equals(sortKey) || "rating_asc".equals(sortKey)) && actorHit == null) {
            builder.queryParam("vote_count.gte", 200);
        }
        if (genreId != null) {
            builder.queryParam("with_genres", genreId);
        }
        if (releaseYear != null) {
            String yearParam = "tv".equals(kind) ? "first_air_date_year" : "primary_release_year";
            builder.queryParam(yearParam, releaseYear);
        }
        if (actorHit != null) {
            builder.queryParam("with_cast", actorHit.id());
        }
        JsonNode raw = fetchJson(withKey(builder), "discover");
        TmdbPageDto result = mapPage(raw, kind, pageNo);
        if (actorHit != null && result.error() == null) {
            result = result.withPeople(actorHit.name(), null, null);
        }
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
        return new TmdbPageDto(true, null, page, totalPages, total, items, null, null, null);
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
                    blankToNull(textOrEmpty(node.path("original_language"))),
                    popularity(node.path("popularity"))
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
        boolean tv = "tv".equals(media);
        return switch (sort) {
            case "rating" -> "vote_average.desc";
            case "rating_asc" -> "vote_average.asc";
            case "newest" -> tv ? "first_air_date.desc" : "primary_release_date.desc";
            case "oldest" -> tv ? "first_air_date.asc" : "primary_release_date.asc";
            case "title" -> tv ? "name.asc" : "title.asc";
            case "title_desc" -> tv ? "name.desc" : "title.desc";
            case "votes" -> "vote_count.desc";
            case "revenue" -> tv ? "popularity.desc" : "revenue.desc";
            default -> "popularity.desc";
        };
    }

    /**
     * Producer and director are job-specific, which discover {@code with_crew} cannot express.
     * Filmography comes from combined credits, then the chosen sort is applied locally.
     */
    private TmdbPageDto creditsPage(
            String media,
            Integer genreId,
            Integer year,
            String sort,
            int pageNo,
            String language,
            PersonHit actor,
            PersonHit producer,
            PersonHit director) {
        List<TmdbItemDto> pool = null;
        PersonHit[] people = { actor, producer, director };
        String[] roles = { "actor", "producer", "director" };
        for (int i = 0; i < people.length; i++) {
            if (people[i] == null) {
                continue;
            }
            List<TmdbItemDto> credits = filmography(people[i].id(), roles[i], media, genreId, year, language);
            if (credits == null) {
                return TmdbPageDto.failure("upstream_error");
            }
            pool = intersect(pool, credits);
        }
        if (pool == null) {
            return TmdbPageDto.failure("upstream_error");
        }
        List<TmdbItemDto> sorted = new ArrayList<>(pool);
        sorted.sort(itemOrder(sort));
        int total = sorted.size();
        int totalPages = total == 0 ? 0 : (total + CREDIT_PAGE_SIZE - 1) / CREDIT_PAGE_SIZE;
        int safePage = totalPages == 0 ? 1 : Math.min(pageNo, totalPages);
        int from = total == 0 ? 0 : (safePage - 1) * CREDIT_PAGE_SIZE;
        int to = Math.min(total, from + CREDIT_PAGE_SIZE);
        List<TmdbItemDto> slice = total == 0 ? List.of() : new ArrayList<>(sorted.subList(from, to));
        return new TmdbPageDto(
                true,
                null,
                safePage,
                totalPages,
                total,
                slice,
                actor == null ? null : actor.name(),
                producer == null ? null : producer.name(),
                director == null ? null : director.name());
    }

    private List<TmdbItemDto> filmography(
            long personId, String role, String media, Integer genreId, Integer year, String language) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/person/" + personId + "/combined_credits")
                .queryParam("language", language);
        JsonNode raw = fetchJson(withKey(builder), "credits");
        if (raw == null || apiError(raw) != null) {
            return null;
        }
        JsonNode bucket = "actor".equals(role) ? raw.path("cast") : raw.path("crew");
        var filtered = objectMapper.createArrayNode();
        Set<String> seen = new LinkedHashSet<>();
        if (bucket.isArray()) {
            for (JsonNode node : bucket) {
                if (!creditMatches(node, role, media, genreId, year)) {
                    continue;
                }
                String kind = textOrEmpty(node.path("media_type"));
                long id = node.path("id").asLong(0);
                if (id <= 0 || !seen.add(kind + "-" + id)) {
                    continue;
                }
                filtered.add(node);
            }
        }
        return mapItems(filtered, media);
    }

    private static boolean creditMatches(JsonNode node, String role, String media, Integer genreId, Integer year) {
        if (node.path("adult").asBoolean(false)) {
            return false;
        }
        String kind = textOrEmpty(node.path("media_type"));
        if (!media.equals(kind)) {
            return false;
        }
        if (!roleMatches(node, role)) {
            return false;
        }
        if (genreId != null && !hasGenre(node, genreId)) {
            return false;
        }
        if (year != null) {
            String date = firstText(
                    node,
                    "movie".equals(kind) ? "release_date" : "first_air_date",
                    "release_date");
            if (!date.startsWith(String.valueOf(year))) {
                return false;
            }
        }
        return true;
    }

    private static boolean roleMatches(JsonNode node, String role) {
        if ("actor".equals(role)) {
            return true;
        }
        String job = textOrEmpty(node.path("job"));
        if ("director".equals(role)) {
            return "Director".equalsIgnoreCase(job);
        }
        if ("producer".equals(role)) {
            String department = textOrEmpty(node.path("department"));
            return "Production".equalsIgnoreCase(department)
                    && job.toLowerCase(Locale.ROOT).contains("producer");
        }
        return false;
    }

    private static boolean hasGenre(JsonNode node, int genreId) {
        JsonNode ids = node.path("genre_ids");
        if (!ids.isArray()) {
            return false;
        }
        for (JsonNode id : ids) {
            if (id.asInt(0) == genreId) {
                return true;
            }
        }
        return false;
    }

    private List<TmdbItemDto> intersect(List<TmdbItemDto> left, List<TmdbItemDto> right) {
        if (right == null) {
            return null;
        }
        if (left == null) {
            return right;
        }
        Set<String> ids = new LinkedHashSet<>();
        for (TmdbItemDto item : right) {
            ids.add(item.mediaType() + "-" + item.id());
        }
        List<TmdbItemDto> out = new ArrayList<>();
        for (TmdbItemDto item : left) {
            if (ids.contains(item.mediaType() + "-" + item.id())) {
                out.add(item);
            }
        }
        return out;
    }

    private PersonHit resolvePerson(String query, String role, String language) {
        if (!StringUtils.hasText(query)) {
            return null;
        }
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(apiBase + "/search/person")
                .queryParam("query", query)
                .queryParam("language", language)
                .queryParam("include_adult", "false")
                .queryParam("page", 1);
        JsonNode raw = fetchJson(withKey(builder), "person");
        if (raw == null) {
            return PersonHit.lookupFailed();
        }
        if (apiError(raw) != null) {
            return PersonHit.lookupFailed();
        }
        String department = switch (role) {
            case "producer" -> "Production";
            case "director" -> "Directing";
            default -> "Acting";
        };
        JsonNode first = null;
        JsonNode departmentBest = null;
        double departmentPop = -1;
        int seen = 0;
        for (JsonNode person : raw.path("results")) {
            if (seen >= 5) {
                break;
            }
            long id = person.path("id").asLong(0);
            if (id <= 0 || !StringUtils.hasText(textOrEmpty(person.path("name")))) {
                continue;
            }
            seen++;
            if (first == null) {
                first = person;
            }
            double pop = person.path("popularity").asDouble(0);
            if (department.equalsIgnoreCase(textOrEmpty(person.path("known_for_department"))) && pop > departmentPop) {
                departmentPop = pop;
                departmentBest = person;
            }
        }
        JsonNode best = departmentBest != null ? departmentBest : first;
        if (best == null) {
            return null;
        }
        return PersonHit.found(best.path("id").asLong(0), textOrEmpty(best.path("name")));
    }

    private static Comparator<TmdbItemDto> itemOrder(String sort) {
        return (a, b) -> {
            int primary = switch (sort) {
                case "rating" -> compareDouble(a.voteAverage(), b.voteAverage(), true);
                case "rating_asc" -> compareDouble(a.voteAverage(), b.voteAverage(), false);
                case "newest" -> compareText(a.date(), b.date(), true);
                case "oldest" -> compareText(a.date(), b.date(), false);
                case "title" -> compareText(a.title(), b.title(), false);
                case "title_desc" -> compareText(a.title(), b.title(), true);
                case "votes" -> compareInt(a.voteCount(), b.voteCount(), true);
                default -> compareDouble(a.popularity(), b.popularity(), true);
            };
            if (primary != 0 || "title".equals(sort) || "title_desc".equals(sort)) {
                return primary;
            }
            return compareText(a.title(), b.title(), false);
        };
    }

    private static int compareText(String left, String right, boolean descending) {
        boolean leftEmpty = !StringUtils.hasText(left);
        boolean rightEmpty = !StringUtils.hasText(right);
        if (leftEmpty || rightEmpty) {
            if (leftEmpty && rightEmpty) {
                return 0;
            }
            return leftEmpty ? 1 : -1;
        }
        int cmp = left.compareToIgnoreCase(right);
        return descending ? -cmp : cmp;
    }

    private static int compareDouble(Double left, Double right, boolean descending) {
        if (left == null || right == null) {
            if (left == null && right == null) {
                return 0;
            }
            return left == null ? 1 : -1;
        }
        int cmp = Double.compare(left, right);
        return descending ? -cmp : cmp;
    }

    private static int compareInt(Integer left, Integer right, boolean descending) {
        if (left == null || right == null) {
            if (left == null && right == null) {
                return 0;
            }
            return left == null ? 1 : -1;
        }
        int cmp = Integer.compare(left, right);
        return descending ? -cmp : cmp;
    }

    private static String cleanPerson(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String query = raw.trim().replaceAll("\\s+", " ");
        if (query.length() < 2 || !safeQuery(query)) {
            return null;
        }
        return query;
    }

    private static boolean rejectedPerson(String raw) {
        if (!StringUtils.hasText(raw)) {
            return false;
        }
        return !safeQuery(raw.trim());
    }

    private static String cacheToken(String query) {
        return query == null ? "" : query.toLowerCase(Locale.ROOT);
    }

    private static boolean failed(PersonHit hit) {
        return hit != null && hit.failed();
    }

    private static boolean missingPerson(String query, PersonHit hit) {
        return StringUtils.hasText(query) && hit == null;
    }

    private static Double popularity(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return null;
        }
        double value = node.asDouble(Double.NaN);
        if (Double.isNaN(value) || value < 0) {
            return null;
        }
        return Math.round(value * 10.0) / 10.0;
    }

    private record PersonHit(long id, String name, boolean failed) {
        private static PersonHit found(long id, String name) {
            return new PersonHit(id, name, false);
        }

        private static PersonHit lookupFailed() {
            return new PersonHit(0, null, true);
        }
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
