package com.pat.service;

import com.pat.controller.dto.TvChannelDto;
import com.pat.controller.dto.TvEpgNowDto;
import com.pat.controller.dto.TvEpgProgrammeDto;
import com.pat.controller.dto.TvEpgScheduleDto;
import com.pat.controller.dto.TvEpgSearchHitDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamReader;
import java.io.BufferedInputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiFunction;
import java.util.zip.GZIPInputStream;

/**
 * XMLTV EPG (now / next / schedule / search) from iptv-epg.org country files, matched by {@code tvg-id}.
 */
@Service
public class TvEpgService {

    private static final Logger log = LoggerFactory.getLogger(TvEpgService.class);

    private static final String USER_AGENT = "PATTOOL/1.0 (+https://www.patrickdeschamps.com)";
    private static final DateTimeFormatter XMLTV =
            DateTimeFormatter.ofPattern("yyyyMMddHHmmss");
    private static final int MAX_IDS_PER_REQUEST = 80;
    private static final int MAX_SEARCH_RESULTS = 80;
    private static final int MIN_SEARCH_QUERY_LEN = 2;

    /** Default countries scanned for worldwide programme search. */
    public static final List<String> WORLDWIDE_SEARCH_COUNTRIES = List.of(
            "fr", "us", "gb", "de", "es", "it", "be", "ch", "ca", "nl", "pt", "pl"
    );

    /** Virtual live URLs → XMLTV channel ids used by iptv-epg.org. */
    private static final Map<String, String> VIRTUAL_EPG_IDS = Map.ofEntries(
            Map.entry("francetv:france-2", "France2.fr"),
            Map.entry("francetv:france-3", "France3.fr"),
            Map.entry("francetv:france-4", "France4.fr"),
            Map.entry("francetv:france-5", "France5.fr"),
            Map.entry("francetv:franceinfo", "franceinfo:.fr"),
            Map.entry("tf1:tf1", "TF1.fr"),
            Map.entry("tf1:tmc", "TMC.fr"),
            Map.entry("tf1:tfx", "TFX.fr"),
            Map.entry("tf1:lci", "LCI.fr"),
            Map.entry("canalgroup:cnews", "CNews.fr"),
            Map.entry("canalgroup:cstar", "CStar.fr"),
            Map.entry("radiofrance:franceinter", "FranceInter.fr"),
            Map.entry("m6group:m6", "M6.fr"),
            Map.entry("m6group:w9", "W9.fr"),
            Map.entry("m6group:6ter", "6ter.fr"),
            Map.entry("m6group:gulli", "Gulli.fr")
    );

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(20))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final String epgBaseUrl;
    private final Duration cacheTtl;
    private final ConcurrentHashMap<String, CachedGuide> guideCache = new ConcurrentHashMap<>();

    public TvEpgService(
            @Value("${app.tv.epg.base-url:https://iptv-epg.org/files}") String epgBaseUrl,
            @Value("${app.tv.epg.cache-minutes:180}") int cacheMinutes) {
        this.epgBaseUrl = epgBaseUrl;
        this.cacheTtl = Duration.ofMinutes(Math.max(30, cacheMinutes));
    }

    /**
     * Resolve the XMLTV channel id for a catalog channel (tvg-id / virtual live / name heuristics).
     */
    public static String resolveEpgChannelId(TvChannelDto channel) {
        if (channel == null) {
            return null;
        }
        String stream = channel.getStreamUrl() != null ? channel.getStreamUrl().trim().toLowerCase(Locale.ROOT) : "";
        if (VIRTUAL_EPG_IDS.containsKey(stream)) {
            return VIRTUAL_EPG_IDS.get(stream);
        }
        String id = channel.getId() != null ? channel.getId().trim() : "";
        if (id.toLowerCase(Locale.ROOT).startsWith("francetv-")) {
            String slug = id.substring("francetv-".length()).toLowerCase(Locale.ROOT);
            return VIRTUAL_EPG_IDS.getOrDefault("francetv:" + slug, null);
        }
        if (id.toLowerCase(Locale.ROOT).startsWith("tf1-")) {
            return VIRTUAL_EPG_IDS.getOrDefault("tf1:" + id.substring(4).toLowerCase(Locale.ROOT), null);
        }
        if (id.toLowerCase(Locale.ROOT).startsWith("canalgroup-")) {
            return VIRTUAL_EPG_IDS.getOrDefault("canalgroup:" + id.substring(11).toLowerCase(Locale.ROOT), null);
        }
        if (id.toLowerCase(Locale.ROOT).startsWith("radiofrance-")) {
            return VIRTUAL_EPG_IDS.getOrDefault("radiofrance:" + id.substring(12).toLowerCase(Locale.ROOT), null);
        }
        if (id.toLowerCase(Locale.ROOT).startsWith("m6group-")) {
            return VIRTUAL_EPG_IDS.getOrDefault("m6group:" + id.substring(8).toLowerCase(Locale.ROOT), null);
        }
        // Playlist ids look like "TF1.fr#0" or "TF1.fr@HD#1"
        int hash = id.indexOf('#');
        String base = hash >= 0 ? id.substring(0, hash) : id;
        int at = base.indexOf('@');
        if (at > 0) {
            base = base.substring(0, at);
        }
        if (base.contains(".") && base.length() >= 3) {
            return base;
        }
        return null;
    }

    public Map<String, TvEpgNowDto> nowForIds(String countryCode, List<String> rawIds) {
        String cc = normalizeCountry(countryCode);
        if (cc == null || rawIds == null || rawIds.isEmpty()) {
            return Map.of();
        }
        List<String> ids = new ArrayList<>();
        for (String raw : rawIds) {
            String cleaned = cleanChannelId(raw);
            if (cleaned != null) {
                ids.add(cleaned);
            }
            if (ids.size() >= MAX_IDS_PER_REQUEST) {
                break;
            }
        }
        if (ids.isEmpty()) {
            return Map.of();
        }

        CountryGuide guide = loadGuide(cc);
        if (guide == null) {
            return Map.of();
        }

        Instant now = Instant.now();
        Map<String, TvEpgNowDto> out = new LinkedHashMap<>();
        for (String id : ids) {
            String key = id.toLowerCase(Locale.ROOT);
            List<Programme> list = guide.byChannel.get(key);
            if (list == null || list.isEmpty()) {
                continue;
            }
            TvEpgNowDto dto = pickNowNext(list, now);
            if (dto.getNow() != null || dto.getNext() != null) {
                out.put(guide.canonicalId.getOrDefault(key, id), dto);
            }
        }
        return out;
    }

    /**
     * Full cached schedule for one XMLTV channel id (≈ −6h … +36h window).
     */
    public TvEpgScheduleDto scheduleForId(String countryCode, String rawId) {
        String cc = normalizeCountry(countryCode);
        String id = cleanChannelId(rawId);
        if (cc == null || id == null) {
            return new TvEpgScheduleDto(rawId != null ? rawId.trim() : "", List.of());
        }
        CountryGuide guide = loadGuide(cc);
        if (guide == null) {
            return new TvEpgScheduleDto(id, List.of());
        }
        String key = id.toLowerCase(Locale.ROOT);
        List<Programme> list = guide.byChannel.get(key);
        String canonical = guide.canonicalId.getOrDefault(key, id);
        if (list == null || list.isEmpty()) {
            return new TvEpgScheduleDto(canonical, List.of());
        }
        List<TvEpgProgrammeDto> programmes = new ArrayList<>(list.size());
        for (Programme p : list) {
            TvEpgProgrammeDto dto = toDto(p);
            if (dto != null) {
                programmes.add(dto);
            }
        }
        return new TvEpgScheduleDto(canonical, programmes);
    }

    /**
     * Search programme titles/descriptions in the cached XMLTV window.
     * {@code countryCode=all} scans {@link #WORLDWIDE_SEARCH_COUNTRIES}.
     *
     * @param channelResolver optional catalog lookup {@code (country, epgId) → channel}
     */
    public List<TvEpgSearchHitDto> searchProgrammes(
            String countryCode,
            String query,
            int limit,
            BiFunction<String, String, TvChannelDto> channelResolver) {
        String q = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
        if (q.length() < MIN_SEARCH_QUERY_LEN) {
            return List.of();
        }
        int max = Math.min(MAX_SEARCH_RESULTS, Math.max(1, limit));
        List<String> countries = resolveSearchCountries(countryCode);
        if (countries.isEmpty()) {
            return List.of();
        }

        Instant now = Instant.now();
        List<TvEpgSearchHitDto> hits = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();

        for (String cc : countries) {
            CountryGuide guide = loadGuide(cc);
            if (guide == null) {
                continue;
            }

            List<ScoredHit> scored = new ArrayList<>();
            for (Map.Entry<String, List<Programme>> entry : guide.byChannel.entrySet()) {
                String canonical = guide.canonicalId.getOrDefault(entry.getKey(), entry.getKey());
                for (Programme p : entry.getValue()) {
                    if (p.stop != null && !p.stop.isAfter(now.minus(Duration.ofHours(1)))) {
                        continue;
                    }
                    int score = matchScore(p, q);
                    if (score <= 0) {
                        continue;
                    }
                    scored.add(new ScoredHit(cc, canonical, p, score));
                }
            }
            scored.sort(Comparator
                    .comparingInt((ScoredHit h) -> h.score).reversed()
                    .thenComparing(h -> h.programme.start, Comparator.nullsLast(Comparator.naturalOrder())));

            for (ScoredHit h : scored) {
                String dedupe = h.country + "|" + h.channelId.toLowerCase(Locale.ROOT)
                        + "|" + (h.programme.start != null ? h.programme.start.toString() : "")
                        + "|" + h.programme.title;
                if (!seen.add(dedupe)) {
                    continue;
                }
                TvChannelDto channel = channelResolver != null
                        ? channelResolver.apply(h.country, h.channelId)
                        : null;
                hits.add(new TvEpgSearchHitDto(h.country, h.channelId, toDto(h.programme), channel));
                if (hits.size() >= max) {
                    return hits;
                }
            }
        }
        return hits;
    }

    private static int matchScore(Programme p, String q) {
        String title = p.title != null ? p.title.toLowerCase(Locale.ROOT) : "";
        String desc = p.description != null ? p.description.toLowerCase(Locale.ROOT) : "";
        if (title.equals(q)) {
            return 100;
        }
        if (title.startsWith(q)) {
            return 80;
        }
        if (title.contains(q)) {
            return 60;
        }
        if (desc.contains(q)) {
            return 20;
        }
        return 0;
    }

    private static List<String> resolveSearchCountries(String countryCode) {
        if (!StringUtils.hasText(countryCode)) {
            return List.of();
        }
        String cc = countryCode.trim().toLowerCase(Locale.ROOT);
        if ("all".equals(cc)) {
            return WORLDWIDE_SEARCH_COUNTRIES;
        }
        String normalized = normalizeCountry(cc);
        return normalized != null ? List.of(normalized) : List.of();
    }

    private static String cleanChannelId(String rawId) {
        if (!StringUtils.hasText(rawId)) {
            return null;
        }
        String cleaned = rawId.trim();
        int hash = cleaned.indexOf('#');
        if (hash >= 0) {
            cleaned = cleaned.substring(0, hash);
        }
        int at = cleaned.indexOf('@');
        if (at > 0) {
            cleaned = cleaned.substring(0, at);
        }
        return StringUtils.hasText(cleaned) ? cleaned : null;
    }

    private TvEpgNowDto pickNowNext(List<Programme> list, Instant now) {
        Programme current = null;
        Programme upcoming = null;
        for (Programme p : list) {
            if (p.stop != null && !p.stop.isAfter(now)) {
                continue;
            }
            if (p.start != null && p.stop != null && !p.start.isAfter(now) && p.stop.isAfter(now)) {
                current = p;
                continue;
            }
            if (p.start != null && p.start.isAfter(now)) {
                upcoming = p;
                break;
            }
        }
        return new TvEpgNowDto(toDto(current), toDto(upcoming));
    }

    private static TvEpgProgrammeDto toDto(Programme p) {
        if (p == null || !StringUtils.hasText(p.title)) {
            return null;
        }
        return new TvEpgProgrammeDto(
                p.title,
                p.description,
                p.start != null ? p.start.toString() : null,
                p.stop != null ? p.stop.toString() : null
        );
    }

    private final ConcurrentHashMap<String, Object> countryLocks = new ConcurrentHashMap<>();

    private CountryGuide loadGuide(String countryCode) {
        Instant now = Instant.now();
        CachedGuide cached = guideCache.get(countryCode);
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.guide;
        }
        Object lock = countryLocks.computeIfAbsent(countryCode, k -> new Object());
        synchronized (lock) {
            cached = guideCache.get(countryCode);
            if (cached != null && cached.expiresAt.isAfter(Instant.now())) {
                return cached.guide;
            }
            try {
                CountryGuide guide = downloadAndParse(countryCode);
                if (guide == null) {
                    return cached != null ? cached.guide : null;
                }
                guideCache.put(countryCode, new CachedGuide(guide, Instant.now().plus(cacheTtl)));
                log.info("TV EPG loaded for {} ({} channels, {} programmes)",
                        countryCode, guide.byChannel.size(),
                        guide.byChannel.values().stream().mapToInt(List::size).sum());
                return guide;
            } catch (Exception e) {
                log.warn("TV EPG load failed for {}: {}", countryCode, e.toString());
                return cached != null ? cached.guide : null;
            }
        }
    }

    private CountryGuide downloadAndParse(String countryCode) throws Exception {
        String base = epgBaseUrl.replaceAll("/+$", "");
        String gzUrl = base + "/epg-" + countryCode + ".xml.gz";
        String xmlUrl = base + "/epg-" + countryCode + ".xml";

        HttpResponse<InputStream> response = fetch(gzUrl);
        boolean gzip = true;
        if (response == null || response.statusCode() < 200 || response.statusCode() >= 300) {
            response = fetch(xmlUrl);
            gzip = false;
            if (response == null || response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("TV EPG HTTP {} for {}", response != null ? response.statusCode() : -1, xmlUrl);
                return null;
            }
        }

        try (InputStream raw = response.body();
             InputStream in = gzip
                     ? new GZIPInputStream(new BufferedInputStream(raw, 64 * 1024))
                     : new BufferedInputStream(raw, 64 * 1024)) {
            return parseXmltv(in);
        }
    }

    private HttpResponse<InputStream> fetch(String url) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(90))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/gzip, application/xml, text/xml, */*")
                    .GET()
                    .build();
            return httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (Exception e) {
            log.debug("TV EPG fetch failed {}: {}", url, e.toString());
            return null;
        }
    }

    private CountryGuide parseXmltv(InputStream in) throws Exception {
        XMLInputFactory factory = XMLInputFactory.newFactory();
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        XMLStreamReader reader = factory.createXMLStreamReader(in);

        Instant windowStart = Instant.now().minus(Duration.ofHours(6));
        Instant windowEnd = Instant.now().plus(Duration.ofHours(36));

        Map<String, List<Programme>> byChannel = new HashMap<>();
        Map<String, String> canonicalId = new HashMap<>();

        String progChannel = null;
        Instant progStart = null;
        Instant progStop = null;
        String progTitle = null;
        String progDesc = null;
        boolean inProgramme = false;
        String currentElement = null;
        StringBuilder text = new StringBuilder();

        while (reader.hasNext()) {
            int event = reader.next();
            if (event == XMLStreamConstants.START_ELEMENT) {
                String local = reader.getLocalName();
                currentElement = local;
                text.setLength(0);
                if ("programme".equals(local)) {
                    inProgramme = true;
                    progChannel = attr(reader, "channel");
                    progStart = parseXmltvTime(attr(reader, "start"));
                    progStop = parseXmltvTime(attr(reader, "stop"));
                    progTitle = null;
                    progDesc = null;
                }
            } else if (event == XMLStreamConstants.CHARACTERS || event == XMLStreamConstants.CDATA) {
                if (inProgramme && currentElement != null) {
                    text.append(reader.getText());
                }
            } else if (event == XMLStreamConstants.END_ELEMENT) {
                String local = reader.getLocalName();
                if (inProgramme) {
                    if ("title".equals(local) && progTitle == null) {
                        progTitle = text.toString().trim();
                    } else if ("desc".equals(local) && progDesc == null) {
                        String d = text.toString().trim();
                        if (d.length() > 400) {
                            d = d.substring(0, 400) + "…";
                        }
                        progDesc = d;
                    } else if ("programme".equals(local)) {
                        if (StringUtils.hasText(progChannel)
                                && StringUtils.hasText(progTitle)
                                && progStart != null
                                && progStop != null
                                && progStop.isAfter(windowStart)
                                && progStart.isBefore(windowEnd)) {
                            String key = progChannel.toLowerCase(Locale.ROOT);
                            canonicalId.putIfAbsent(key, progChannel);
                            byChannel.computeIfAbsent(key, k -> new ArrayList<>())
                                    .add(new Programme(progTitle, progDesc, progStart, progStop));
                        }
                        inProgramme = false;
                        progChannel = null;
                        progStart = null;
                        progStop = null;
                        progTitle = null;
                        progDesc = null;
                    }
                }
                currentElement = null;
                text.setLength(0);
            }
        }
        reader.close();

        for (List<Programme> list : byChannel.values()) {
            list.sort(Comparator.comparing(p -> p.start, Comparator.nullsLast(Comparator.naturalOrder())));
        }
        return new CountryGuide(Collections.unmodifiableMap(byChannel), Collections.unmodifiableMap(canonicalId));
    }

    private static String attr(XMLStreamReader reader, String name) {
        String v = reader.getAttributeValue(null, name);
        return v != null ? v.trim() : null;
    }

    /**
     * Parse XMLTV time {@code yyyyMMddHHmmss[ ±HHmm]}.
     */
    static Instant parseXmltvTime(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String s = raw.trim();
        try {
            if (s.length() >= 14) {
                String digits = s.substring(0, 14);
                LocalDateTime ldt = LocalDateTime.parse(digits, XMLTV);
                ZoneOffset offset = ZoneOffset.UTC;
                String rest = s.substring(14).trim();
                if (rest.length() >= 5 && (rest.startsWith("+") || rest.startsWith("-"))) {
                    offset = ZoneOffset.of(rest.substring(0, 5));
                }
                return OffsetDateTime.of(ldt, offset).toInstant();
            }
        } catch (Exception ignored) {
            // fall through
        }
        return null;
    }

    private static String normalizeCountry(String countryCode) {
        if (!StringUtils.hasText(countryCode)) {
            return null;
        }
        String cc = countryCode.trim().toLowerCase(Locale.ROOT);
        if ("all".equals(cc) || cc.length() != 2) {
            return null;
        }
        return cc;
    }

    private record Programme(String title, String description, Instant start, Instant stop) {
    }

    private record ScoredHit(String country, String channelId, Programme programme, int score) {
    }

    private record CountryGuide(Map<String, List<Programme>> byChannel, Map<String, String> canonicalId) {
    }

    private record CachedGuide(CountryGuide guide, Instant expiresAt) {
    }
}
