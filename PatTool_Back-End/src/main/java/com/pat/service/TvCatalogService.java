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

    /** France first, Switzerland second, then alphabetical. */
    private static int countryPinRank(String code) {
        if (code == null) {
            return 100;
        }
        return switch (code.trim().toLowerCase(Locale.ROOT)) {
            case "fr" -> 0;
            case "ch" -> 1;
            default -> 100;
        };
    }

    private static TvCountryDto toCountryDto(String code) {
        String normalized = code.trim().toLowerCase(Locale.ROOT);
        String name = Locale.of("", normalized.toUpperCase(Locale.ROOT)).getDisplayCountry(Locale.FRENCH);
        if (name == null || name.isBlank() || name.equalsIgnoreCase(normalized)) {
            name = normalized.toUpperCase(Locale.ROOT);
        }
        // Prefer common French labels when Locale is incomplete
        if ("xk".equals(normalized)) {
            name = "Kosovo";
        }
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

    /**
     * Search channel name/group across all configured countries.
     * Requires a name query of at least 2 characters <strong>or</strong> a non-empty category filter.
     */
    public List<TvChannelDto> searchAllCountries(String query, String group, int limit) {
        String q = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
        String groupFilter = group != null ? group.trim().toLowerCase(Locale.ROOT) : "";
        if (q.length() < 2 && groupFilter.isEmpty()) {
            return Collections.emptyList();
        }
        int max = Math.max(1, Math.min(limit <= 0 ? 200 : limit, 500));
        List<TvChannelDto> out = new ArrayList<>(Math.min(max, 64));
        for (String countryCode : COUNTRY_CODES) {
            List<TvChannelDto> channels = listChannels(countryCode);
            if (channels == null || channels.isEmpty()) {
                continue;
            }
            for (TvChannelDto ch : channels) {
                if (q.length() >= 2 && !matchesQuery(ch, q)) {
                    continue;
                }
                if (!groupFilter.isEmpty()
                        && (ch.getGroup() == null
                        || !ch.getGroup().toLowerCase(Locale.ROOT).contains(groupFilter))) {
                    continue;
                }
                out.add(ch);
                if (out.size() >= max) {
                    return out;
                }
            }
        }
        return out;
    }

    /**
     * Distinct primary {@code group-title} values for one country, or the worldwide union when {@code all}.
     */
    public List<String> listGroups(String country) {
        if (isAllCountries(country)) {
            Instant now = Instant.now();
            List<String> cached = worldwideGroupsCache;
            Instant expires = worldwideGroupsExpires;
            if (cached != null && expires != null && expires.isAfter(now)) {
                return cached;
            }
            TreeSet<String> groups = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
            for (String code : COUNTRY_CODES) {
                collectPrimaryGroups(listChannels(code), groups);
            }
            List<String> result = List.copyOf(groups);
            worldwideGroupsCache = result;
            worldwideGroupsExpires = now.plus(Duration.ofMinutes(Math.max(5, cacheMinutes)));
            return result;
        }
        if (!isSupportedCountry(country)) {
            return Collections.emptyList();
        }
        TreeSet<String> groups = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        collectPrimaryGroups(listChannels(country), groups);
        return List.copyOf(groups);
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
     */
    public int countChannels(String country) {
        if (isAllCountries(country)) {
            Instant now = Instant.now();
            Integer cached = worldwideCountCache;
            Instant expires = worldwideCountExpires;
            if (cached != null && expires != null && expires.isAfter(now)) {
                return cached;
            }
            int total = COUNTRY_CODES.parallelStream()
                    .mapToInt(code -> {
                        List<TvChannelDto> channels = listChannels(code);
                        return channels != null ? channels.size() : 0;
                    })
                    .sum();
            worldwideCountCache = total;
            worldwideCountExpires = now.plus(Duration.ofMinutes(Math.max(5, cacheMinutes)));
            return total;
        }
        if (!isSupportedCountry(country)) {
            return 0;
        }
        List<TvChannelDto> channels = listChannels(country);
        return channels != null ? channels.size() : 0;
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
     * URLs resolved on play.
     */
    private List<TvChannelDto> overlayOfficialLiveSources(List<TvChannelDto> channels, String countryCode) {
        if (!"fr".equals(countryCode) || channels == null || channels.isEmpty()) {
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
        Map<String, String> canalByTvg = Map.of(
                "cnews.fr", "cnews",
                "cstar.fr", "cstar"
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
        ensureM6GroupChannel(out, "m6", "M6", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Logo_M6_2015.svg/512px-Logo_M6_2015.svg.png");
        ensureM6GroupChannel(out, "w9", "W9", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/4/40/W9_2018.svg/512px-W9_2018.svg.png");
        ensureM6GroupChannel(out, "6ter", "6ter", "Entertainment",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/6ter_2012.svg/512px-6ter_2012.svg.png");
        ensureM6GroupChannel(out, "gulli", "Gulli", "Kids",
                "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Gulli_2017.svg/512px-Gulli_2017.svg.png");
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

    private static List<TvChannelDto> prioritizeOfficialLive(List<TvChannelDto> channels) {
        List<TvChannelDto> priority = new ArrayList<>();
        List<TvChannelDto> rest = new ArrayList<>();
        for (TvChannelDto ch : channels) {
            if (FranceTvLiveService.isVirtualUrl(ch.getStreamUrl())
                    || Tf1LiveService.isVirtualUrl(ch.getStreamUrl())
                    || CanalGroupLiveService.isVirtualUrl(ch.getStreamUrl())
                    || RadioFranceLiveService.isVirtualUrl(ch.getStreamUrl())
                    || M6GroupLiveService.isVirtualUrl(ch.getStreamUrl())) {
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
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("TV playlist HTTP {} for {}", response.statusCode(), url);
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
