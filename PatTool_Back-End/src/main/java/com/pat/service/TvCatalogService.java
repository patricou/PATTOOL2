package com.pat.service;

import com.pat.controller.dto.TvChannelDto;
import com.pat.controller.dto.TvCountryDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Loads free public IPTV playlists from iptv-org (by country) and caches them in memory.
 */
@Service
public class TvCatalogService {

    private static final Logger log = LoggerFactory.getLogger(TvCatalogService.class);

    private static final Pattern EXTINF = Pattern.compile(
            "#EXTINF:-?\\d+\\s*(.*),(.*)$",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern ATTR = Pattern.compile("([\\w-]+)=\"([^\"]*)\"");
    private static final Pattern QUALITY_IN_NAME = Pattern.compile("\\((\\d+p)\\)", Pattern.CASE_INSENSITIVE);
    private static final Pattern COUNTRY_CODE = Pattern.compile("^[a-z]{2}$");

    /** ISO 3166-1 alpha-2 codes (iptv-org playlists). France & Switzerland pinned first at display time. */
    private static final List<String> COUNTRY_CODES = List.of(
            "fr",
            "ch",
            "ae",
            "af",
            "ag",
            "al",
            "am",
            "ao",
            "ar",
            "at",
            "au",
            "az",
            "ba",
            "bb",
            "bd",
            "be",
            "bf",
            "bg",
            "bh",
            "bi",
            "bj",
            "bn",
            "bo",
            "br",
            "bs",
            "bt",
            "bw",
            "by",
            "bz",
            "ca",
            "cd",
            "cf",
            "cg",
            "ci",
            "cl",
            "cm",
            "cn",
            "co",
            "cr",
            "cu",
            "cv",
            "cy",
            "cz",
            "de",
            "dj",
            "dk",
            "dm",
            "do",
            "dz",
            "ec",
            "ee",
            "eg",
            "er",
            "es",
            "et",
            "fi",
            "fj",
            "ga",
            "gb",
            "gd",
            "ge",
            "gh",
            "gm",
            "gn",
            "gq",
            "gr",
            "gt",
            "gw",
            "gy",
            "hk",
            "hn",
            "hr",
            "ht",
            "hu",
            "id",
            "ie",
            "il",
            "in",
            "iq",
            "ir",
            "is",
            "it",
            "jm",
            "jo",
            "jp",
            "ke",
            "kg",
            "kh",
            "km",
            "kn",
            "kp",
            "kr",
            "kw",
            "kz",
            "la",
            "lb",
            "lc",
            "lk",
            "lr",
            "ls",
            "lt",
            "lu",
            "lv",
            "ly",
            "ma",
            "md",
            "me",
            "mg",
            "mk",
            "ml",
            "mm",
            "mn",
            "mr",
            "mt",
            "mu",
            "mv",
            "mw",
            "mx",
            "my",
            "mz",
            "na",
            "ne",
            "ng",
            "ni",
            "nl",
            "no",
            "np",
            "nz",
            "om",
            "pa",
            "pe",
            "pg",
            "ph",
            "pk",
            "pl",
            "pr",
            "ps",
            "pt",
            "py",
            "qa",
            "ro",
            "rs",
            "ru",
            "rw",
            "sa",
            "sb",
            "sc",
            "sd",
            "se",
            "sg",
            "si",
            "sk",
            "sl",
            "sn",
            "so",
            "sr",
            "ss",
            "sv",
            "sy",
            "sz",
            "td",
            "tg",
            "th",
            "tj",
            "tl",
            "tm",
            "tn",
            "to",
            "tr",
            "tt",
            "tw",
            "tz",
            "ua",
            "ug",
            "us",
            "uy",
            "uz",
            "vc",
            "ve",
            "vn",
            "vu",
            "ws",
            "xk",
            "ye",
            "za",
            "zm",
            "zw"
    );

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ConcurrentHashMap<String, CachedPlaylist> cache = new ConcurrentHashMap<>();
    private volatile Integer worldwideCountCache;
    private volatile Instant worldwideCountExpires;
    private volatile List<String> worldwideGroupsCache;
    private volatile Instant worldwideGroupsExpires;
    /** Flattened worldwide channel list (all countries), for fast paging / search. */
    private volatile List<TvChannelDto> worldwideChannelsCache;
    private volatile Instant worldwideChannelsRefreshedAt;
    private volatile Instant worldwideChannelsExpires;
    private final AtomicBoolean worldwideCountRefreshing = new AtomicBoolean(false);
    private final AtomicBoolean worldwideGroupsRefreshing = new AtomicBoolean(false);
    private final AtomicBoolean worldwideChannelsRefreshing = new AtomicBoolean(false);
    private final AtomicBoolean reloadAllBusy = new AtomicBoolean(false);
    private final ExecutorService catalogRefreshExecutor = Executors.newFixedThreadPool(3, r -> {
        Thread t = new Thread(r, "tv-catalog-refresh");
        t.setDaemon(true);
        return t;
    });

    @Value("${app.tv.playlist-base-url:https://iptv-org.github.io/iptv/countries}")
    private String playlistBaseUrl;

    @Value("${app.tv.catalog-cache-minutes:60}")
    private long cacheMinutes;

    public List<TvCountryDto> listCountries() {
        List<TvCountryDto> countries = new ArrayList<>(COUNTRY_CODES.size());
        for (String code : COUNTRY_CODES) {
            countries.add(toCountryDto(code));
        }
        countries.sort((a, b) -> {
            int pa = countryPinRank(a.getCode());
            int pb = countryPinRank(b.getCode());
            if (pa != pb) {
                return Integer.compare(pa, pb);
            }
            String na = a.getName() != null ? a.getName() : "";
            String nb = b.getName() != null ? b.getName() : "";
            return na.compareToIgnoreCase(nb);
        });
        return countries;
    }

    /** All catalogued ISO country codes (iptv-org playlists). */
    public List<String> allCountryCodes() {
        return COUNTRY_CODES;
    }

    /** France / Suisse first, then frequent catalogs, then alphabetical. */
    private static int countryPinRank(String code) {
        if (code == null) {
            return 100;
        }
        return switch (code.trim().toLowerCase(Locale.ROOT)) {
            case "fr" -> 0;
            case "ch" -> 1;
            case "be" -> 2;
            case "us" -> 3;
            case "gb" -> 4;
            case "ca" -> 5;
            case "de" -> 6;
            case "es" -> 7;
            case "it" -> 8;
            default -> 100;
        };
    }

    private static TvCountryDto toCountryDto(String code) {
        String normalized = code.trim().toLowerCase(Locale.ROOT);
        String name = Locale.of("", normalized.toUpperCase(Locale.ROOT)).getDisplayCountry(Locale.FRENCH);
        if (name == null || name.isBlank() || name.equalsIgnoreCase(normalized)) {
            name = normalized.toUpperCase(Locale.ROOT);
        }
        // Prefer common French labels when Locale is incomplete / ambiguous
        name = switch (normalized) {
            case "xk" -> "Kosovo";
            case "us" -> "États-Unis";
            case "gb" -> "Royaume-Uni";
            default -> name;
        };
        return new TvCountryDto(normalized, name, flagEmoji(normalized));
    }

    private static String flagEmoji(String code) {
        if (code == null || code.length() != 2) {
            return "";
        }
        int first = Character.toUpperCase(code.charAt(0)) - 'A' + 0x1F1E6;
        int second = Character.toUpperCase(code.charAt(1)) - 'A' + 0x1F1E6;
        if (first < 0x1F1E6 || first > 0x1F1FF || second < 0x1F1E6 || second > 0x1F1FF) {
            return "";
        }
        return new String(Character.toChars(first)) + new String(Character.toChars(second));
    }

    public boolean isSupportedCountry(String country) {
        if (country == null) {
            return false;
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        if (!COUNTRY_CODE.matcher(code).matches()) {
            return false;
        }
        return COUNTRY_CODES.contains(code);
    }

    /** {@code all} / {@code *} = search across every catalogued country. */
    public boolean isAllCountries(String country) {
        if (country == null) {
            return false;
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        return "all".equals(code) || "*".equals(code);
    }

    public List<TvChannelDto> listChannels(String country) {
        if (!isSupportedCountry(country)) {
            return Collections.emptyList();
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        CachedPlaylist cached = cache.get(code);
        Instant now = Instant.now();
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.channels;
        }
        List<TvChannelDto> channels = fetchAndParse(code);
        if (channels != null) {
            channels = overlayOfficialLiveSources(channels, code);
            cache.put(code, new CachedPlaylist(channels, now.plus(Duration.ofMinutes(Math.max(5, cacheMinutes)))));
            return channels;
        }
        return cached != null ? cached.channels : Collections.emptyList();
    }

    /** Drop all playlist / worldwide aggregates (next access reloads from iptv-org). */
    public void invalidateAll() {
        cache.clear();
        worldwideCountCache = null;
        worldwideCountExpires = null;
        worldwideGroupsCache = null;
        worldwideGroupsExpires = null;
        worldwideChannelsCache = null;
        worldwideChannelsRefreshedAt = null;
        worldwideChannelsExpires = null;
    }

    public int cacheEntryCount() {
        int n = cache.size();
        if (worldwideCountCache != null) {
            n++;
        }
        if (worldwideGroupsCache != null) {
            n++;
        }
        if (worldwideChannelsCache != null) {
            n++;
        }
        return n;
    }

    /** Total TV channels held in playlist / worldwide list cache. */
    public long cachedChannelCount() {
        List<TvChannelDto> worldwide = worldwideChannelsCache;
        if (worldwide != null) {
            return worldwide.size();
        }
        long total = 0;
        for (CachedPlaylist playlist : cache.values()) {
            if (playlist != null && playlist.channels != null) {
                total += playlist.channels.size();
            }
        }
        return total;
    }

    /** Stats for the System cache registry page. */
    public Map<String, Object> cacheStats() {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("countries", cache.size());
        d.put("channels", cachedChannelCount());
        List<TvChannelDto> worldwide = worldwideChannelsCache;
        d.put("worldwideChannels", worldwide != null ? worldwide.size() : 0);
        d.put("worldwideChannelsCached", worldwide != null);
        d.put("worldwideChannelsRefreshedAt",
                worldwideChannelsRefreshedAt != null ? worldwideChannelsRefreshedAt.toString() : null);
        d.put("worldwideChannelsExpiresAt",
                worldwideChannelsExpires != null ? worldwideChannelsExpires.toString() : null);
        d.put("worldwideCount", worldwideCountCache);
        d.put("worldwideCountExpiresAt",
                worldwideCountExpires != null ? worldwideCountExpires.toString() : null);
        d.put("worldwideGroups", worldwideGroupsCache != null ? worldwideGroupsCache.size() : 0);
        d.put("worldwideGroupsExpiresAt",
                worldwideGroupsExpires != null ? worldwideGroupsExpires.toString() : null);
        d.put("reloadBusy", reloadAllBusy.get());
        d.put("recordUnit", "channels");
        return d;
    }

    /** Warm frequently used countries without scanning the full worldwide catalog. */
    public void warmFrequentCountries() {
        for (String code : List.of("fr", "ch", "be")) {
            try {
                listChannels(code);
            } catch (Exception e) {
                log.warn("TV warm {} failed: {}", code, e.toString());
            }
        }
    }

    /**
     * Reload every country playlist into cache (including empty 404 entries),
     * then refresh worldwide count, groups, and the flattened worldwide channel list.
     */
    public void reloadAllPlaylists() {
        for (String code : COUNTRY_CODES) {
            try {
                // Bypass TTL: remove entry then fetch.
                cache.remove(code);
                listChannels(code);
            } catch (Exception e) {
                log.warn("TV reload {} failed: {}", code, e.toString());
            }
        }
        recomputeWorldwideChannels();
        recomputeWorldwideGroups();
    }

    /**
     * Background full reload of every country playlist + worldwide aggregates.
     * Returns {@code false} if a reload is already running.
     */
    public boolean scheduleReloadAllPlaylists() {
        if (!reloadAllBusy.compareAndSet(false, true)) {
            return false;
        }
        catalogRefreshExecutor.execute(() -> {
            try {
                log.info("TV catalog full reload starting ({} countries)", COUNTRY_CODES.size());
                reloadAllPlaylists();
                log.info("TV catalog full reload done (worldwideChannels={})",
                        worldwideChannelsCache != null ? worldwideChannelsCache.size() : 0);
            } catch (Exception e) {
                log.warn("TV catalog full reload failed: {}", e.toString());
            } finally {
                reloadAllBusy.set(false);
            }
        });
        return true;
    }

    /**
     * Search / list channels across all configured countries.
     * Uses the cached worldwide channel list when available.
     * Empty query and group returns a page of the worldwide catalog.
     * Returns at most {@code limit} channels starting at {@code offset}.
     */
    public static final int WORLDWIDE_SEARCH_MAX = 500;

    public TvChannelSearchResult searchAllCountries(String query, String group, int offset, int limit) {
        String q = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
        String groupFilter = group != null ? group.trim().toLowerCase(Locale.ROOT) : "";
        int max = Math.max(1, Math.min(limit <= 0 ? 50 : limit, WORLDWIDE_SEARCH_MAX));
        int skip = Math.max(0, offset);
        boolean filterByName = q.length() >= 2;
        boolean unfiltered = !filterByName && groupFilter.isEmpty();

        List<TvChannelDto> source = ensureWorldwideChannels();
        if (unfiltered) {
            int total = source.size();
            int from = Math.min(skip, total);
            int to = Math.min(from + max, total);
            List<TvChannelDto> page = from < to ? source.subList(from, to) : List.of();
            return new TvChannelSearchResult(List.copyOf(page), total, max, from);
        }

        List<TvChannelDto> out = new ArrayList<>(Math.min(max, 64));
        int matched = 0;
        int total = 0;
        for (TvChannelDto ch : source) {
            if (filterByName && !matchesQuery(ch, q)) {
                continue;
            }
            if (!groupFilter.isEmpty()
                    && (ch.getGroup() == null
                    || !ch.getGroup().toLowerCase(Locale.ROOT).contains(groupFilter))) {
                continue;
            }
            total++;
            if (matched >= skip && out.size() < max) {
                out.add(ch);
            }
            matched++;
        }
        return new TvChannelSearchResult(out, total, max, skip);
    }

    /** @deprecated use {@link #searchAllCountries(String, String, int, int)} */
    public TvChannelSearchResult searchAllCountries(String query, String group, int limit) {
        return searchAllCountries(query, group, 0, limit);
    }

    /** Worldwide channel search page: truncated list + exact match count. */
    public record TvChannelSearchResult(List<TvChannelDto> channels, int total, int limit, int offset) {
        public TvChannelSearchResult(List<TvChannelDto> channels, int total, int limit) {
            this(channels, total, limit, 0);
        }
    }

    /**
     * Cached flattened worldwide list (stale-while-revalidate). Builds synchronously if empty.
     */
    public List<TvChannelDto> ensureWorldwideChannels() {
        Instant now = Instant.now();
        List<TvChannelDto> cached = worldwideChannelsCache;
        Instant expires = worldwideChannelsExpires;
        if (cached != null && expires != null && expires.isAfter(now)) {
            return cached;
        }
        if (cached != null && !cached.isEmpty()) {
            scheduleWorldwideChannelsRefresh();
            return cached;
        }
        return recomputeWorldwideChannels();
    }

    private void scheduleWorldwideChannelsRefresh() {
        if (!worldwideChannelsRefreshing.compareAndSet(false, true)) {
            return;
        }
        catalogRefreshExecutor.execute(() -> {
            try {
                recomputeWorldwideChannels();
            } catch (Exception e) {
                log.warn("TV worldwide channels refresh failed: {}", e.toString());
            } finally {
                worldwideChannelsRefreshing.set(false);
            }
        });
    }

    private List<TvChannelDto> recomputeWorldwideChannels() {
        List<TvChannelDto> out = new ArrayList<>(12_000);
        for (String countryCode : COUNTRY_CODES) {
            List<TvChannelDto> channels = listChannels(countryCode);
            if (channels == null || channels.isEmpty()) {
                continue;
            }
            out.addAll(channels);
        }
        List<TvChannelDto> frozen = List.copyOf(out);
        Instant now = Instant.now();
        worldwideChannelsCache = frozen;
        worldwideChannelsRefreshedAt = now;
        worldwideChannelsExpires = now.plus(Duration.ofMinutes(Math.max(5, cacheMinutes)));
        worldwideCountCache = frozen.size();
        worldwideCountExpires = worldwideChannelsExpires;
        return frozen;
    }

    /**
     * Distinct primary {@code group-title} values for one country, or the worldwide union when {@code all}.
     * Serves a stale worldwide cache immediately while refreshing in the background.
     */
    public List<String> listGroups(String country) {
        if (isAllCountries(country)) {
            Instant now = Instant.now();
            List<String> cached = worldwideGroupsCache;
            Instant expires = worldwideGroupsExpires;
            if (cached != null && expires != null && expires.isAfter(now)) {
                return cached;
            }
            if (cached != null && !cached.isEmpty()) {
                scheduleWorldwideGroupsRefresh();
                return cached;
            }
            return recomputeWorldwideGroups();
        }
        if (!isSupportedCountry(country)) {
            return Collections.emptyList();
        }
        TreeSet<String> groups = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        collectPrimaryGroups(listChannels(country), groups);
        return List.copyOf(groups);
    }

    private void scheduleWorldwideGroupsRefresh() {
        if (!worldwideGroupsRefreshing.compareAndSet(false, true)) {
            return;
        }
        catalogRefreshExecutor.execute(() -> {
            try {
                recomputeWorldwideGroups();
            } catch (Exception e) {
                log.warn("TV worldwide groups refresh failed: {}", e.toString());
            } finally {
                worldwideGroupsRefreshing.set(false);
            }
        });
    }

    private List<String> recomputeWorldwideGroups() {
        TreeSet<String> groups = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        for (String code : COUNTRY_CODES) {
            collectPrimaryGroups(listChannels(code), groups);
        }
        List<String> result = List.copyOf(groups);
        worldwideGroupsCache = result;
        worldwideGroupsExpires = Instant.now().plus(Duration.ofMinutes(Math.max(5, cacheMinutes)));
        return result;
    }

    private static void collectPrimaryGroups(List<TvChannelDto> channels, TreeSet<String> groups) {
        if (channels == null) {
            return;
        }
        for (TvChannelDto ch : channels) {
            String g = ch.getGroup();
            if (g == null || g.isBlank()) {
                continue;
            }
            String primary = g.split(";")[0].trim();
            if (!primary.isEmpty()) {
                groups.add(primary);
            }
        }
    }

    /**
     * Channel count for one country, or the sum across every catalogued country when {@code all}.
     * Relies on the same playlist cache as {@link #listChannels(String)}.
     * Serves a stale worldwide total immediately while refreshing in the background.
     */
    public int countChannels(String country) {
        if (isAllCountries(country)) {
            List<TvChannelDto> worldwide = worldwideChannelsCache;
            if (worldwide != null) {
                return worldwide.size();
            }
            Instant now = Instant.now();
            Integer cached = worldwideCountCache;
            Instant expires = worldwideCountExpires;
            if (cached != null && expires != null && expires.isAfter(now)) {
                return cached;
            }
            if (cached != null && cached > 0) {
                scheduleWorldwideCountRefresh();
                return cached;
            }
            return recomputeWorldwideCount();
        }
        if (!isSupportedCountry(country)) {
            return 0;
        }
        List<TvChannelDto> channels = listChannels(country);
        return channels != null ? channels.size() : 0;
    }

    private void scheduleWorldwideCountRefresh() {
        if (!worldwideCountRefreshing.compareAndSet(false, true)) {
            return;
        }
        catalogRefreshExecutor.execute(() -> {
            try {
                recomputeWorldwideCount();
            } catch (Exception e) {
                log.warn("TV worldwide count refresh failed: {}", e.toString());
            } finally {
                worldwideCountRefreshing.set(false);
            }
        });
    }

    private int recomputeWorldwideCount() {
        int total = COUNTRY_CODES.parallelStream()
                .mapToInt(code -> {
                    List<TvChannelDto> channels = listChannels(code);
                    return channels != null ? channels.size() : 0;
                })
                .sum();
        worldwideCountCache = total;
        worldwideCountExpires = Instant.now().plus(Duration.ofMinutes(Math.max(5, cacheMinutes)));
        return total;
    }

    private static boolean matchesQuery(TvChannelDto ch, String queryLower) {
        if (queryLower == null || queryLower.isEmpty()) {
            return true;
        }
        if (ch.getName() != null && ch.getName().toLowerCase(Locale.ROOT).contains(queryLower)) {
            return true;
        }
        if (ch.getGroup() != null && ch.getGroup().toLowerCase(Locale.ROOT).contains(queryLower)) {
            return true;
        }
        if (ch.getId() != null && ch.getId().toLowerCase(Locale.ROOT).contains(queryLower)) {
            return true;
        }
        return false;
    }

    /**
     * Replace broken third-party mirrors of major French FTA channels with virtual
     * {@code francetv:…} / {@code tf1:…} / {@code canalgroup:…} / {@code radiofrance:…} / {@code m6group:…}
     * / {@code rts:…} / {@code arte:LIVE} URLs resolved on play.
     */
    private List<TvChannelDto> overlayOfficialLiveSources(List<TvChannelDto> channels, String countryCode) {
        if (channels == null || channels.isEmpty()) {
            return channels;
        }
        if ("ch".equals(countryCode)) {
            return overlayRtsLiveSources(channels);
        }
        if (!"fr".equals(countryCode)) {
            return channels;
        }
        Map<String, String> franceByTvg = Map.of(
                "france2.fr", "france-2",
                "france3.fr", "france-3",
                "france4.fr", "france-4",
                "france5.fr", "france-5",
                "franceinfo.fr", "franceinfo"
        );
        Map<String, String> radioFranceByTvg = Map.of(
                "franceinter.fr", "franceinter"
        );
        Map<String, String> tf1ByTvg = Map.of(
                "tf1.fr", "tf1",
                "tmc.fr", "tmc",
                "tfx.fr", "tfx",
                "lci.fr", "lci"
        );
        Map<String, String> canalByTvg = Map.ofEntries(
                Map.entry("cnews.fr", "cnews"),
                Map.entry("cstar.fr", "cstar"),
                Map.entry("lequipe.fr", "lequipe"),
                Map.entry("publicsenat.fr", "publicsenat"),
                Map.entry("sudradio.fr", "sudradio"),
                Map.entry("funradio.fr", "funradio"),
                Map.entry("rtl2.fr", "rtl2")
        );
        Map<String, String> m6ByTvg = Map.of(
                "m6.fr", "m6",
                "w9.fr", "w9",
                "6ter.fr", "6ter",
                "gulli.fr", "gulli"
        );
        List<TvChannelDto> out = new ArrayList<>(channels.size());
        for (TvChannelDto ch : channels) {
            String franceSlug = matchFranceTvSlug(ch, franceByTvg);
            String tf1Slug = matchTf1Slug(ch, tf1ByTvg);
            String canalSlug = matchCanalGroupSlug(ch, canalByTvg);
            String radioSlug = matchRadioFranceSlug(ch, radioFranceByTvg);
            String m6Slug = matchM6GroupSlug(ch, m6ByTvg);
            if (franceSlug != null) {
                out.add(patchVirtual(ch, FranceTvLiveService.virtualUrl(franceSlug)));
            } else if (tf1Slug != null) {
                out.add(patchVirtual(ch, Tf1LiveService.virtualUrl(tf1Slug)));
            } else if (canalSlug != null) {
                out.add(patchVirtual(ch, CanalGroupLiveService.virtualUrl(canalSlug)));
            } else if (radioSlug != null) {
                out.add(patchVirtual(ch, RadioFranceLiveService.virtualUrl(radioSlug)));
            } else if (m6Slug != null) {
                out.add(patchVirtual(ch, M6GroupLiveService.virtualUrl(m6Slug)));
            } else if (isArteLiveChannel(ch)) {
                out.add(patchVirtual(ch, ArteReplayService.virtualUrl("LIVE")));
            } else {
                out.add(ch);
            }
        }
        ensureFranceTvChannel(out, "france-2", "France 2", "General",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/France_2_2018.svg/960px-France_2_2018.svg.png");
        ensureFranceTvChannel(out, "france-3", "France 3", "General",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/France_3_2018.svg/960px-France_3_2018.svg.png");
        ensureFranceTvChannel(out, "france-4", "France 4", "Kids",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/France_4_2018.svg/960px-France_4_2018.svg.png");
        ensureFranceTvChannel(out, "france-5", "France 5", "General",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/5/50/France_5_2018.svg/960px-France_5_2018.svg.png");
        ensureFranceTvChannel(out, "franceinfo", "franceinfo", "News",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/03/Franceinfo.svg/960px-Franceinfo.svg.png");
        ensureRadioFranceChannel(out, "franceinter", "France Inter", "Radio",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/France_Inter_logo_2017.svg/512px-France_Inter_logo_2017.svg.png");
        ensureTf1Channel(out, "tf1", "TF1", "Entertainment", "https://i.imgur.com/QxHt9NC.png");
        ensureTf1Channel(out, "tmc", "TMC", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/TMC_logo_2016.svg/512px-TMC_logo_2016.svg.png");
        ensureTf1Channel(out, "tfx", "TFX", "Entertainment", "https://i.imgur.com/d91GcVf.png");
        ensureTf1Channel(out, "lci", "LCI", "News",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/LCI_-_Logo_%28France%29.svg/512px-LCI_-_Logo_%28France%29.svg.png");
        ensureCanalGroupChannel(out, "cnews", "CNews", "News",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/CNews_logo_2017.svg/512px-CNews_logo_2017.svg.png");
        ensureCanalGroupChannel(out, "cstar", "CStar", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/CStar_logo_2016.svg/512px-CStar_logo_2016.svg.png");
        ensureCanalGroupChannel(out, "lequipe", "L'Équipe", "Sports",
                "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/lequipe-fr.png");
        ensureCanalGroupChannel(out, "publicsenat", "Public Sénat", "News",
                "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/public-senat-fr.png");
        ensureCanalGroupChannel(out, "sudradio", "Sud Radio", "Radio",
                "https://s2.dmcdn.net/u/1ERZ11gSEqESArNIw/720x720");
        ensureCanalGroupChannel(out, "funradio", "Fun Radio", "Radio",
                "https://s2.dmcdn.net/u/2MYk91gSFHm8UswjE/720x720");
        ensureCanalGroupChannel(out, "rtl2", "RTL2", "Radio",
                "https://s2.dmcdn.net/u/2MjtK1gSFHmYn42_n/720x720");
        ensureM6GroupChannel(out, "m6", "M6", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Logo_M6_2015.svg/512px-Logo_M6_2015.svg.png");
        ensureM6GroupChannel(out, "w9", "W9", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/40/W9_2018.svg/512px-W9_2018.svg.png");
        ensureM6GroupChannel(out, "6ter", "6ter", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/6ter_2012.svg/512px-6ter_2012.svg.png");
        ensureM6GroupChannel(out, "gulli", "Gulli", "Kids",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Gulli_2017.svg/512px-Gulli_2017.svg.png");
        ensureArteLiveChannel(out, "ARTE", "General",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Arte_Logo_2017.svg/512px-Arte_Logo_2017.svg.png");
        return prioritizeOfficialLive(out);
    }

    private List<TvChannelDto> overlayRtsLiveSources(List<TvChannelDto> channels) {
        Map<String, String> rtsByTvg = Map.of(
                "rts1.ch", "rts1",
                "rts2.ch", "rts2",
                "rtsinfo.ch", "rtsinfo"
        );
        List<TvChannelDto> out = new ArrayList<>(channels.size());
        for (TvChannelDto ch : channels) {
            String rtsSlug = matchRtsSlug(ch, rtsByTvg);
            if (rtsSlug != null) {
                out.add(patchVirtual(ch, RtsLiveService.virtualUrl(rtsSlug)));
            } else {
                out.add(ch);
            }
        }
        ensureRtsChannel(out, "rts1", "RTS 1", "General", "https://i.imgur.com/OP5lHv9.png");
        ensureRtsChannel(out, "rts2", "RTS 2", "General",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/RTS_Deux_2016.svg/512px-RTS_Deux_2016.svg.png");
        ensureRtsChannel(out, "rtsinfo", "RTS Info", "News",
                "https://raw.githubusercontent.com/tv-logo/tv-logos/refs/heads/main/countries/switzerland/rts-info-ch.png");
        return prioritizeOfficialLive(out);
    }

    private static TvChannelDto patchVirtual(TvChannelDto ch, String virtualUrl) {
        return new TvChannelDto(
                ch.getId(),
                ch.getName(),
                ch.getLogo(),
                ch.getGroup(),
                ch.getCountry(),
                virtualUrl,
                ch.getQuality()
        );
    }

    private static String matchFranceTvSlug(TvChannelDto ch, Map<String, String> byTvgPrefix) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT) : "";
        for (Map.Entry<String, String> e : byTvgPrefix.entrySet()) {
            if (id.startsWith(e.getKey())) {
                return e.getValue();
            }
        }
        if (name.matches("france\\s*2\\b.*")) return "france-2";
        if (name.matches("france\\s*3\\b.*") && !name.contains("24")) return "france-3";
        if (name.matches("france\\s*4\\b.*")) return "france-4";
        if (name.matches("france\\s*5\\b.*")) return "france-5";
        if (name.contains("franceinfo") || name.matches("france\\s*info\\b.*")
                || name.equals("france info")) {
            return "franceinfo";
        }
        return null;
    }

    private static String matchRadioFranceSlug(TvChannelDto ch, Map<String, String> byTvgPrefix) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT) : "";
        for (Map.Entry<String, String> e : byTvgPrefix.entrySet()) {
            if (id.startsWith(e.getKey()) || id.contains(e.getKey())) {
                return e.getValue();
            }
        }
        if (name.matches("france\\s*inter\\b.*") || name.contains("franceinter")) {
            return "franceinter";
        }
        return null;
    }

    private static String matchTf1Slug(TvChannelDto ch, Map<String, String> byTvgPrefix) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT) : "";
        for (Map.Entry<String, String> e : byTvgPrefix.entrySet()) {
            if (id.startsWith(e.getKey())) {
                return e.getValue();
            }
        }
        if (name.matches("tf1\\b.*") && !name.contains("series") && !name.contains("info")) return "tf1";
        if (name.matches("tmc\\b.*")) return "tmc";
        if (name.matches("tfx\\b.*")) return "tfx";
        if (name.matches("lci\\b.*") || name.contains("tf1 info")) return "lci";
        return null;
    }

    private static String matchCanalGroupSlug(TvChannelDto ch, Map<String, String> byTvgPrefix) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT) : "";
        for (Map.Entry<String, String> e : byTvgPrefix.entrySet()) {
            if (id.startsWith(e.getKey())) {
                return e.getValue();
            }
        }
        if (name.matches("c\\s*news\\b.*") || name.equals("cnews")) return "cnews";
        if (name.matches("c\\s*star\\b.*") || name.equals("cstar")) return "cstar";
        if (name.contains("equipe") || name.contains("équipe") || name.equals("lequipe")) return "lequipe";
        if ((name.contains("public") && (name.contains("senat") || name.contains("sénat")))
                || name.contains("publicsenat")) {
            return "publicsenat";
        }
        if (name.contains("sud radio") || name.equals("sudradio")) return "sudradio";
        if (name.contains("fun radio") || name.equals("funradio")) return "funradio";
        if (name.equals("rtl2") || name.matches("rtl\\s*2\\b.*")) return "rtl2";
        return null;
    }

    private static String matchM6GroupSlug(TvChannelDto ch, Map<String, String> byTvgPrefix) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT) : "";
        if (id.startsWith("m6music.fr") || name.contains("m6 music")) {
            return null;
        }
        for (Map.Entry<String, String> e : byTvgPrefix.entrySet()) {
            if (id.startsWith(e.getKey())) {
                return e.getValue();
            }
        }
        if (name.matches("^m6\\b.*") && !name.contains("music")) return "m6";
        if (name.matches("^w9\\b.*")) return "w9";
        if (name.matches("^6\\s*ter\\b.*") || name.equals("6ter")) return "6ter";
        if (name.matches("^gulli\\b.*")) return "gulli";
        return null;
    }

    private static String matchRtsSlug(TvChannelDto ch, Map<String, String> byTvgPrefix) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT) : "";
        for (Map.Entry<String, String> e : byTvgPrefix.entrySet()) {
            if (id.startsWith(e.getKey())) {
                return e.getValue();
            }
        }
        // Legacy brand TSR 1 / TSR Un still appears in some playlists.
        if (name.matches("^rts\\s*1\\b.*") || name.matches("^rts\\s*un\\b.*")
                || name.matches("^tsr\\s*1\\b.*") || name.equals("rts1") || name.equals("tsr1")) {
            return "rts1";
        }
        if (name.matches("^rts\\s*2\\b.*") || name.matches("^rts\\s*deux\\b.*")
                || name.matches("^tsr\\s*2\\b.*") || name.equals("rts2")) {
            return "rts2";
        }
        if (name.contains("rts info") || name.equals("rtsinfo") || name.matches("^rts\\s*info\\b.*")) {
            return "rtsinfo";
        }
        return null;
    }

    private static void ensureFranceTvChannel(List<TvChannelDto> list, String slug, String name,
                                              String group, String logo) {
        String virtual = FranceTvLiveService.virtualUrl(slug);
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("francetv-" + slug, name, logo, group, "fr", virtual, "1080p"));
        }
    }

    private static void ensureTf1Channel(List<TvChannelDto> list, String slug, String name,
                                         String group, String logo) {
        String virtual = Tf1LiveService.virtualUrl(slug);
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("tf1-" + slug, name, logo, group, "fr", virtual, "720p"));
        }
    }

    private static void ensureCanalGroupChannel(List<TvChannelDto> list, String slug, String name,
                                                String group, String logo) {
        String virtual = CanalGroupLiveService.virtualUrl(slug);
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("canalgroup-" + slug, name, logo, group, "fr", virtual, "720p"));
        }
    }

    private static void ensureRadioFranceChannel(List<TvChannelDto> list, String slug, String name,
                                                 String group, String logo) {
        String virtual = RadioFranceLiveService.virtualUrl(slug);
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("radiofrance-" + slug, name, logo, group, "fr", virtual, "audio"));
        }
    }

    private static void ensureM6GroupChannel(List<TvChannelDto> list, String slug, String name,
                                             String group, String logo) {
        String virtual = M6GroupLiveService.virtualUrl(slug);
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("m6group-" + slug, name, logo, group, "fr", virtual, "720p"));
        }
    }

    private static void ensureRtsChannel(List<TvChannelDto> list, String slug, String name,
                                         String group, String logo) {
        String virtual = RtsLiveService.virtualUrl(slug);
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("rts-" + slug, name, logo, group, "ch", virtual, "720p"));
        }
    }

    private static void ensureArteLiveChannel(List<TvChannelDto> list, String name,
                                              String group, String logo) {
        String virtual = ArteReplayService.virtualUrl("LIVE");
        boolean present = list.stream().anyMatch(c -> virtual.equalsIgnoreCase(c.getStreamUrl()));
        if (!present) {
            list.add(0, new TvChannelDto("arte-LIVE", name, logo, group, "fr", virtual, "720p"));
        }
    }

    /** ARTE main live (not regional / themed IPTV clones). */
    private static boolean isArteLiveChannel(TvChannelDto ch) {
        String id = ch.getId() != null ? ch.getId().toLowerCase(Locale.ROOT) : "";
        String name = ch.getName() != null ? ch.getName().toLowerCase(Locale.ROOT).trim() : "";
        if (id.startsWith("arte.fr")) {
            return true;
        }
        // ARTE, ARTE HD, ARTE FHD, ARTE (1080p), …
        return name.matches("^arte(\\b|[\\s\\-_.(]|hd|fhd|sd|uhd|4k).*");
    }

    private static List<TvChannelDto> prioritizeOfficialLive(List<TvChannelDto> channels) {
        List<TvChannelDto> priority = new ArrayList<>();
        List<TvChannelDto> rest = new ArrayList<>();
        for (TvChannelDto ch : channels) {
            if (FranceTvLiveService.isVirtualUrl(ch.getStreamUrl())
                    || Tf1LiveService.isVirtualUrl(ch.getStreamUrl())
                    || CanalGroupLiveService.isVirtualUrl(ch.getStreamUrl())
                    || RadioFranceLiveService.isVirtualUrl(ch.getStreamUrl())
                    || M6GroupLiveService.isVirtualUrl(ch.getStreamUrl())
                    || RtsLiveService.isVirtualUrl(ch.getStreamUrl())
                    || ArteReplayService.isVirtualUrl(ch.getStreamUrl())) {
                priority.add(ch);
            } else {
                rest.add(ch);
            }
        }
        Map<String, TvChannelDto> uniq = new LinkedHashMap<>();
        for (TvChannelDto ch : priority) {
            String key = ch.getStreamUrl() != null ? ch.getStreamUrl().toLowerCase(Locale.ROOT) : ch.getId();
            uniq.putIfAbsent(key, ch);
        }
        List<TvChannelDto> ordered = new ArrayList<>(uniq.values());
        ordered.addAll(rest);
        return ordered;
    }

    private List<TvChannelDto> fetchAndParse(String countryCode) {
        String url = playlistBaseUrl.replaceAll("/+$", "") + "/" + countryCode + ".m3u";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(45))
                    .header("User-Agent", "PATTOOL/1.0 (+https://www.patrickdeschamps.com)")
                    .header("Accept", "application/vnd.apple.mpegurl, audio/mpegurl, text/plain, */*")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            int status = response.statusCode();
            if (status == 404) {
                // iptv-org has no playlist for this country — cache as empty (do not retry every count).
                log.debug("TV playlist not found (404) for {}", countryCode);
                return Collections.emptyList();
            }
            if (status < 200 || status >= 300) {
                log.warn("TV playlist HTTP {} for {}", status, url);
                return null;
            }
            return parseM3u(response.body(), countryCode);
        } catch (Exception e) {
            log.warn("Failed to fetch TV playlist {}: {}", url, e.toString());
            return null;
        }
    }

    private List<TvChannelDto> parseM3u(String body, String countryCode) {
        if (body == null || body.isBlank()) {
            return Collections.emptyList();
        }
        String[] lines = body.split("\\R");
        List<TvChannelDto> channels = new ArrayList<>();
        Map<String, String> pendingAttrs = null;
        String pendingName = null;
        int seq = 0;

        for (String raw : lines) {
            String line = raw == null ? "" : raw.trim();
            if (line.isEmpty() || line.startsWith("#EXTM3U")) {
                continue;
            }
            if (line.startsWith("#EXTINF")) {
                Matcher m = EXTINF.matcher(line);
                if (m.find()) {
                    pendingAttrs = parseAttrs(m.group(1));
                    pendingName = m.group(2) != null ? m.group(2).trim() : "";
                } else {
                    pendingAttrs = new LinkedHashMap<>();
                    pendingName = "";
                }
                continue;
            }
            if (line.startsWith("#")) {
                continue;
            }
            if (pendingName == null) {
                continue;
            }
            String streamUrl = line;
            if (!(streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) {
                pendingAttrs = null;
                pendingName = null;
                continue;
            }
            String tvgId = pendingAttrs.getOrDefault("tvg-id", "");
            String logo = pendingAttrs.getOrDefault("tvg-logo", "");
            String group = pendingAttrs.getOrDefault("group-title", "");
            String quality = extractQuality(pendingName);
            String id = !tvgId.isBlank() ? tvgId + "#" + seq : countryCode + "-" + seq;
            channels.add(new TvChannelDto(id, pendingName, logo, group, countryCode, streamUrl, quality));
            seq++;
            pendingAttrs = null;
            pendingName = null;
        }
        return channels;
    }

    private static Map<String, String> parseAttrs(String attrPart) {
        Map<String, String> map = new LinkedHashMap<>();
        if (attrPart == null || attrPart.isBlank()) {
            return map;
        }
        Matcher m = ATTR.matcher(attrPart);
        while (m.find()) {
            map.put(m.group(1).toLowerCase(Locale.ROOT), m.group(2));
        }
        return map;
    }

    private static String extractQuality(String name) {
        if (name == null) {
            return "";
        }
        Matcher m = QUALITY_IN_NAME.matcher(name);
        return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : "";
    }

    private static final class CachedPlaylist {
        private final List<TvChannelDto> channels;
        private final Instant expiresAt;

        private CachedPlaylist(List<TvChannelDto> channels, Instant expiresAt) {
            this.channels = Collections.unmodifiableList(channels);
            this.expiresAt = expiresAt;
        }
    }
}
