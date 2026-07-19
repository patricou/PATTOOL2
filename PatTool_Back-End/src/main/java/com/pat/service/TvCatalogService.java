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

    private static final List<TvCountryDto> COUNTRIES = List.of(
            new TvCountryDto("fr", "France", "🇫🇷"),
            new TvCountryDto("be", "Belgique", "🇧🇪"),
            new TvCountryDto("ch", "Suisse", "🇨🇭"),
            new TvCountryDto("ca", "Canada", "🇨🇦"),
            new TvCountryDto("us", "United States", "🇺🇸"),
            new TvCountryDto("gb", "United Kingdom", "🇬🇧"),
            new TvCountryDto("de", "Germany", "🇩🇪"),
            new TvCountryDto("es", "Spain", "🇪🇸"),
            new TvCountryDto("it", "Italy", "🇮🇹"),
            new TvCountryDto("pt", "Portugal", "🇵🇹"),
            new TvCountryDto("nl", "Netherlands", "🇳🇱"),
            new TvCountryDto("pl", "Poland", "🇵🇱"),
            new TvCountryDto("ru", "Russia", "🇷🇺"),
            new TvCountryDto("ma", "Morocco", "🇲🇦"),
            new TvCountryDto("tn", "Tunisia", "🇹🇳"),
            new TvCountryDto("dz", "Algeria", "🇩🇿"),
            new TvCountryDto("sn", "Senegal", "🇸🇳"),
            new TvCountryDto("ci", "Côte d'Ivoire", "🇨🇮"),
            new TvCountryDto("br", "Brazil", "🇧🇷"),
            new TvCountryDto("mx", "Mexico", "🇲🇽"),
            new TvCountryDto("ar", "Argentina", "🇦🇷"),
            new TvCountryDto("jp", "Japan", "🇯🇵"),
            new TvCountryDto("cn", "China", "🇨🇳"),
            new TvCountryDto("in", "India", "🇮🇳"),
            new TvCountryDto("au", "Australia", "🇦🇺"),
            new TvCountryDto("tr", "Turkey", "🇹🇷"),
            new TvCountryDto("eg", "Egypt", "🇪🇬"),
            new TvCountryDto("sa", "Saudi Arabia", "🇸🇦"),
            new TvCountryDto("ae", "United Arab Emirates", "🇦🇪"),
            new TvCountryDto("kr", "South Korea", "🇰🇷")
    );

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final ConcurrentHashMap<String, CachedPlaylist> cache = new ConcurrentHashMap<>();

    @Value("${app.tv.playlist-base-url:https://iptv-org.github.io/iptv/countries}")
    private String playlistBaseUrl;

    @Value("${app.tv.catalog-cache-minutes:60}")
    private long cacheMinutes;

    public List<TvCountryDto> listCountries() {
        return COUNTRIES;
    }

    public boolean isSupportedCountry(String country) {
        if (country == null) {
            return false;
        }
        String code = country.trim().toLowerCase(Locale.ROOT);
        return COUNTRY_CODE.matcher(code).matches();
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
     * Replace broken third-party mirrors of major French FTA channels with virtual
     * {@code francetv:…} / {@code tf1:…} / {@code canalgroup:…} / {@code radiofrance:…}
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
        List<TvChannelDto> out = new ArrayList<>(channels.size());
        for (TvChannelDto ch : channels) {
            String franceSlug = matchFranceTvSlug(ch, franceByTvg);
            String tf1Slug = matchTf1Slug(ch, tf1ByTvg);
            String canalSlug = matchCanalGroupSlug(ch, canalByTvg);
            String radioSlug = matchRadioFranceSlug(ch, radioFranceByTvg);
            if (franceSlug != null) {
                out.add(patchVirtual(ch, FranceTvLiveService.virtualUrl(franceSlug)));
            } else if (tf1Slug != null) {
                out.add(patchVirtual(ch, Tf1LiveService.virtualUrl(tf1Slug)));
            } else if (canalSlug != null) {
                out.add(patchVirtual(ch, CanalGroupLiveService.virtualUrl(canalSlug)));
            } else if (radioSlug != null) {
                out.add(patchVirtual(ch, RadioFranceLiveService.virtualUrl(radioSlug)));
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

    private static List<TvChannelDto> prioritizeOfficialLive(List<TvChannelDto> channels) {
        List<TvChannelDto> priority = new ArrayList<>();
        List<TvChannelDto> rest = new ArrayList<>();
        for (TvChannelDto ch : channels) {
            if (FranceTvLiveService.isVirtualUrl(ch.getStreamUrl())
                    || Tf1LiveService.isVirtualUrl(ch.getStreamUrl())
                    || CanalGroupLiveService.isVirtualUrl(ch.getStreamUrl())
                    || RadioFranceLiveService.isVirtualUrl(ch.getStreamUrl())) {
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
