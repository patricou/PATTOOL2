package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.config.RestTemplateConfig;
import com.pat.controller.dto.NasaDtos.Apod;
import com.pat.controller.dto.NasaDtos.Epic;
import com.pat.controller.dto.NasaDtos.EpicImage;
import com.pat.controller.dto.NasaDtos.Mars;
import com.pat.controller.dto.NasaDtos.MarsPhoto;
import com.pat.controller.dto.NasaDtos.Neo;
import com.pat.controller.dto.NasaDtos.NeoFeed;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.HtmlUtils;
import org.springframework.web.util.UriComponentsBuilder;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import jakarta.annotation.PostConstruct;
import java.io.StringReader;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Proxy de l'API ouverte NASA ({@code api.nasa.gov}) : APOD, EPIC, rovers martiens, NeoWs.
 * La clé reste côté serveur. Les réponses JSON et les images EPIC sont mises en cache
 * pour ne pas épuiser le quota (très bas avec {@code DEMO_KEY}).
 */
@Service
public class NasaProxyService {

    private static final Logger log = LoggerFactory.getLogger(NasaProxyService.class);
    private static final String UA = "PATTOOL-NasaProxy/1.0";
    private static final int MAX_CACHE = 200;
    private static final int MAX_IMAGE_CACHE = 24;
    private static final int MAX_IMAGE_BYTES = 6_000_000;
    private static final int MAX_MARS_PHOTOS = 25;
    private static final int MAX_NEO = 80;
    private static final Duration FAILURE_TTL = Duration.ofSeconds(45);
    private static final String APOD_FEED = "https://science.nasa.gov/feed/apod-basic/";
    /** Catalogue et fichiers EPIC publics, sans clé. api.nasa.gov ne fait que les relayer. */
    private static final String EPIC_ARCHIVE = "https://epic.gsfc.nasa.gov";
    /** Photos Curiosity publiées par le site Mars, sans clé. api.nasa.gov expire souvent. */
    private static final String MARS_CATALOG = "https://mars.nasa.gov";
    private static final java.util.regex.Pattern APOD_SLUG_DATE =
            java.util.regex.Pattern.compile("apod-(\\d{4})-([a-z]+)-(\\d{1,2})");

    public static final Set<String> ROVERS = Set.of("curiosity", "perseverance", "opportunity", "spirit");

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final ConcurrentMap<String, CacheEntry<Object>> cache = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CacheEntry<String>> failures = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CacheEntry<byte[]>> imageCache = new ConcurrentHashMap<>();

    @Value("${app.nasa.api-base:https://api.nasa.gov}")
    private String apiBase;

    @Value("${app.nasa.api-key:DEMO_KEY}")
    private String apiKey;

    public NasaProxyService(
            @Qualifier(RestTemplateConfig.NASA_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    void logApiKeyMode() {
        String key = apiKey == null ? "" : apiKey.trim();
        log.info("NASA API key: {}", key.isEmpty() || "DEMO_KEY".equals(key) ? "DEMO_KEY" : "personal");
    }

    public Apod apod(LocalDate date) {
        boolean today = date == null || date.equals(LocalDate.now(ZoneOffset.UTC));
        String key = "apod|" + (date == null ? "today" : date);
        Duration ttl = today ? Duration.ofHours(2) : Duration.ofDays(7);
        return load(key, ttl, () -> {
            Apod fromFeed = apodFromFeed(date);
            if (fromFeed != null) {
                return fromFeed;
            }
            log.info("APOD feed has no item for {}, trying api.nasa.gov", date);
            return parseApod(getJson(apodUri(date)));
        });
    }

    public Epic epic(LocalDate date) {
        String key = "epic|" + (date == null ? "latest" : date);
        Duration ttl = date == null ? Duration.ofHours(1) : Duration.ofHours(12);
        return load(key, ttl, () -> parseEpic(date, epicCatalog(date)));
    }

    private JsonNode epicCatalog(LocalDate date) {
        try {
            return getJson(epicCatalogUri(date));
        } catch (NasaProxyException ex) {
            if (!"unavailable".equals(ex.code())) {
                throw ex;
            }
            log.info("EPIC catalog unavailable for {}, trying api.nasa.gov", date);
            return getJson(epicUri(date));
        }
    }

    static URI epicCatalogUri(LocalDate date) {
        String path = date == null ? "/api/natural" : "/api/natural/date/" + date;
        return UriComponentsBuilder.fromHttpUrl(EPIC_ARCHIVE + path).encode().build().toUri();
    }

    public byte[] epicImage(LocalDate date, String name) {
        String key = "epic-img|" + date + "|" + name;
        CacheEntry<byte[]> hit = imageCache.get(key);
        if (hit != null && !hit.expired()) {
            return hit.value;
        }
        throwIfFailed(key);
        try {
            byte[] bytes = fetchEpicImage(date, name);
            imageCache.put(key, new CacheEntry<>(bytes, Instant.now().plus(Duration.ofHours(12))));
            trim(imageCache, MAX_IMAGE_CACHE);
            failures.remove(key);
            return bytes;
        } catch (NasaProxyException ex) {
            rememberFailure(key, ex.code());
            throw ex;
        }
    }

    private byte[] fetchEpicImage(LocalDate date, String name) {
        try {
            return fetchImage(epicArchiveUri(date, name));
        } catch (NasaProxyException ex) {
            if (!"unavailable".equals(ex.code())) {
                throw ex;
            }
            log.info("EPIC archive unavailable for {}, trying api.nasa.gov", name);
            return fetchImage(epicImageUri(date, name));
        }
    }

    static URI epicArchiveUri(LocalDate date, String name) {
        String day = date.format(DateTimeFormatter.ofPattern("yyyy/MM/dd"));
        return UriComponentsBuilder
                .fromHttpUrl(EPIC_ARCHIVE + "/archive/natural/" + day + "/png/" + name + ".png")
                .encode()
                .build()
                .toUri();
    }

    public Mars mars(String rover, Integer sol, LocalDate earthDate, String camera, int page) {
        String key = "mars|" + rover + "|" + sol + "|" + earthDate + "|" + (camera == null ? "" : camera) + "|" + page;
        boolean paged = earthDate != null || sol != null;
        Duration ttl = paged ? Duration.ofHours(24) : Duration.ofHours(3);
        return load(key, ttl, () -> loadMars(rover, sol, earthDate, camera, page, paged));
    }

    private Mars loadMars(String rover, Integer sol, LocalDate earthDate, String camera, int page, boolean paged) {
        if ("curiosity".equals(rover)) {
            try {
                Mars catalog = parseMarsCatalog(rover, sol, page, getJson(marsCatalogUri(sol, earthDate, page)));
                if (camera == null || camera.isBlank()) {
                    return catalog;
                }
                String code = camera.toUpperCase(Locale.ROOT);
                List<MarsPhoto> filtered = catalog.photos().stream()
                        .filter(photo -> photo.camera() != null && photo.camera().toUpperCase(Locale.ROOT).contains(code))
                        .toList();
                return new Mars(catalog.rover(), catalog.sol(), catalog.page(), catalog.hasMore(), filtered);
            } catch (NasaProxyException ex) {
                if (!"unavailable".equals(ex.code())) {
                    throw ex;
                }
                log.info("Mars catalog unavailable for {}, trying api.nasa.gov", rover);
            }
        }
        Mars parsed = parseMars(rover, sol, page, paged, getJson(marsUri(rover, sol, earthDate, camera, page)));
        if (paged || camera == null || camera.isBlank()) {
            return parsed;
        }
        List<MarsPhoto> filtered = parsed.photos().stream()
                .filter(photo -> camera.equals(photo.camera()))
                .toList();
        return new Mars(parsed.rover(), parsed.sol(), parsed.page(), false, filtered);
    }

    static URI marsCatalogUri(Integer sol, LocalDate earthDate, int page) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(MARS_CATALOG + "/api/v1/raw_image_items/")
                .queryParam("order", earthDate == null && sol == null ? "sol desc" : "date_taken desc")
                .queryParam("per_page", MAX_MARS_PHOTOS)
                .queryParam("page", Math.max(0, page - 1))
                .queryParam("condition_1", "msl:mission");
        if (earthDate != null) {
            builder.queryParam("condition_2", earthDate + ":date_taken:gte");
            builder.queryParam("condition_3", earthDate.plusDays(1) + ":date_taken:lt");
        } else if (sol != null) {
            builder.queryParam("condition_2", sol + ":sol:gte");
            builder.queryParam("condition_3", sol + ":sol:lte");
        }
        return builder.build().toUri();
    }

    static Mars parseMarsCatalog(String rover, Integer sol, int page, JsonNode node) {
        if (node == null || !node.isObject() || !node.path("items").isArray()) {
            throw new NasaProxyException("unavailable");
        }
        List<MarsPhoto> out = new ArrayList<>();
        for (JsonNode item : node.get("items")) {
            if (out.size() >= MAX_MARS_PHOTOS) {
                break;
            }
            String imageUrl = safeHttpsUrl(firstNonBlank(text(item, "https_url"), text(item, "url")));
            if (imageUrl == null) {
                continue;
            }
            String taken = text(item, "date_taken");
            String earthDate = taken != null && taken.length() >= 10 ? taken.substring(0, 10) : null;
            String instrument = text(item, "instrument");
            out.add(new MarsPhoto(
                    item.path("id").asLong(0),
                    item.path("sol").asInt(sol == null ? 0 : sol),
                    earthDate,
                    instrument,
                    text(item, "title"),
                    rover,
                    imageUrl
            ));
        }
        return new Mars(rover, sol, page, node.path("more").asBoolean(false), out);
    }

    public NeoFeed neo(LocalDate start, LocalDate end) {
        String key = "neo|" + start + "|" + end;
        return load(key, Duration.ofHours(3), () -> parseNeo(start, end, getJson(neoUri(start, end))));
    }

    static Apod parseApod(JsonNode node) {
        if (node == null || !node.isObject() || !node.hasNonNull("title")) {
            throw new NasaProxyException("not_found");
        }
        return new Apod(
                text(node, "date"),
                text(node, "title"),
                text(node, "explanation"),
                text(node, "media_type"),
                safeHttpsUrl(text(node, "url")),
                safeHttpsUrl(text(node, "hdurl")),
                safeHttpsUrl(text(node, "thumbnail_url")),
                text(node, "copyright")
        );
    }

    private Apod apodFromFeed(LocalDate date) {
        try {
            Map<String, Apod> feed = load("apod-feed", Duration.ofHours(2), this::downloadApodFeed);
            if (date == null) {
                return feed.values().stream().findFirst().orElse(null);
            }
            return feed.get(date.toString());
        } catch (RuntimeException ex) {
            log.warn("APOD feed unavailable: {}", ex.toString());
            return null;
        }
    }

    private Map<String, Apod> downloadApodFeed() {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, UA);
        headers.setAccept(List.of(MediaType.APPLICATION_XML, MediaType.TEXT_XML, MediaType.ALL));
        ResponseEntity<String> response = restTemplate.exchange(
                URI.create(APOD_FEED), HttpMethod.GET, new HttpEntity<>(headers), String.class);
        if (response.getBody() == null || response.getBody().isBlank()) {
            throw new NasaProxyException("unavailable");
        }
        Map<String, Apod> parsed = parseApodFeed(response.getBody());
        if (parsed.isEmpty()) {
            throw new NasaProxyException("not_found");
        }
        return parsed;
    }

    static Map<String, Apod> parseApodFeed(String xml) {
        Map<String, Apod> byDate = new LinkedHashMap<>();
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setExpandEntityReferences(false);
            var document = factory.newDocumentBuilder().parse(new InputSource(new StringReader(xml)));
            var items = document.getElementsByTagName("item");
            for (int i = 0; i < items.getLength(); i++) {
                if (!(items.item(i) instanceof Element item)) {
                    continue;
                }
                Apod apod = apodFromFeedItem(item);
                if (apod != null && apod.date() != null) {
                    byDate.putIfAbsent(apod.date(), apod);
                }
            }
        } catch (NasaProxyException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new NasaProxyException("unavailable");
        }
        return byDate;
    }

    private static Apod apodFromFeedItem(Element item) {
        String title = directChild(item, "title");
        String link = directChild(item, "link");
        String image = firstNonBlank(directChild(item, "hdurl"), directChild(item, "url"));
        String explanation = plainText(firstNonBlank(directChild(item, "explanation"), directChild(item, "description")));
        String credit = plainText(firstNonBlank(directChild(item, "copyright"), directChild(item, "credit")));
        String day = apodDate(link, directChild(item, "pubDate"));
        if (title == null || day == null) {
            return null;
        }
        String mediaUrl = safeHttpsUrl(image);
        boolean video = mediaUrl != null && (mediaUrl.contains("youtube.com") || mediaUrl.contains("youtu.be") || mediaUrl.contains("vimeo.com"));
        return new Apod(day, title, explanation, video ? "video" : "image", video ? mediaUrl : mediaUrl, video ? null : mediaUrl, null, credit);
    }

    private static String apodDate(String link, String pubDate) {
        if (link != null) {
            var matcher = APOD_SLUG_DATE.matcher(link.toLowerCase(Locale.ROOT));
            if (matcher.find()) {
                java.time.Month month = month(matcher.group(2));
                if (month != null) {
                    return LocalDate.of(Integer.parseInt(matcher.group(1)), month, Integer.parseInt(matcher.group(3))).toString();
                }
            }
        }
        if (pubDate == null || pubDate.isBlank()) {
            return null;
        }
        try {
            return java.time.ZonedDateTime.parse(pubDate.trim(), DateTimeFormatter.RFC_1123_DATE_TIME)
                    .withZoneSameInstant(ZoneOffset.UTC)
                    .toLocalDate()
                    .toString();
        } catch (RuntimeException ex) {
            return null;
        }
    }

    private static java.time.Month month(String name) {
        return switch (name) {
            case "january" -> java.time.Month.JANUARY;
            case "february" -> java.time.Month.FEBRUARY;
            case "march" -> java.time.Month.MARCH;
            case "april" -> java.time.Month.APRIL;
            case "may" -> java.time.Month.MAY;
            case "june" -> java.time.Month.JUNE;
            case "july" -> java.time.Month.JULY;
            case "august" -> java.time.Month.AUGUST;
            case "september" -> java.time.Month.SEPTEMBER;
            case "october" -> java.time.Month.OCTOBER;
            case "november" -> java.time.Month.NOVEMBER;
            case "december" -> java.time.Month.DECEMBER;
            default -> null;
        };
    }

    private static String directChild(Element item, String localName) {
        var children = item.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node node = children.item(i);
            if (!(node instanceof Element element)) {
                continue;
            }
            String name = element.getLocalName() != null ? element.getLocalName() : element.getTagName();
            if (localName.equals(name)) {
                String value = element.getTextContent();
                return value == null || value.isBlank() ? null : value.trim();
            }
        }
        return null;
    }

    static String plainText(String html) {
        if (html == null || html.isBlank()) {
            return null;
        }
        String text = html.replaceAll("(?i)<br\\s*/?>", "\n").replaceAll("<[^>]+>", "");
        text = HtmlUtils.htmlUnescape(text).replace('\u00a0', ' ').replaceAll("[ \\t]+\\n", "\n").trim();
        text = text.replaceFirst("(?i)^Explanation:\\s*", "");
        return text.isBlank() ? null : text;
    }

    private static String firstNonBlank(String first, String second) {
        return first != null && !first.isBlank() ? first : second;
    }

    static Epic parseEpic(LocalDate requested, JsonNode node) {
        if (node == null || !node.isArray()) {
            throw new NasaProxyException("not_found");
        }
        List<EpicImage> images = new ArrayList<>();
        String day = requested == null ? null : requested.toString();
        for (JsonNode item : node) {
            if (images.size() >= 24) {
                break;
            }
            String image = text(item, "image");
            if (image == null || !image.startsWith("epic_")) {
                continue;
            }
            String rawDate = text(item, "date");
            String isoDay = rawDate != null && rawDate.length() >= 10 ? rawDate.substring(0, 10) : day;
            String time = rawDate != null && rawDate.length() > 11 ? rawDate.substring(11).trim() : null;
            JsonNode centroid = item.get("centroid_coordinates");
            images.add(new EpicImage(
                    image,
                    text(item, "caption"),
                    isoDay,
                    time,
                    centroid == null ? null : doubleOrNull(centroid, "lat"),
                    centroid == null ? null : doubleOrNull(centroid, "lon")
            ));
            if (day == null && isoDay != null) {
                day = isoDay;
            }
        }
        return new Epic(day, images);
    }

    static Mars parseMars(String rover, Integer sol, int page, boolean paged, JsonNode node) {
        if (node == null || !node.isObject()) {
            throw new NasaProxyException("not_found");
        }
        JsonNode photos = node.get("photos");
        if (photos == null || !photos.isArray()) {
            photos = node.get("latest_photos");
        }
        if (photos == null || !photos.isArray()) {
            throw new NasaProxyException("not_found");
        }
        List<MarsPhoto> out = new ArrayList<>();
        for (JsonNode photo : photos) {
            if (out.size() >= MAX_MARS_PHOTOS) {
                break;
            }
            String imageUrl = safeHttpsUrl(text(photo, "img_src"));
            if (imageUrl == null) {
                continue;
            }
            JsonNode camera = photo.get("camera");
            JsonNode roverNode = photo.get("rover");
            out.add(new MarsPhoto(
                    photo.path("id").asLong(0),
                    photo.path("sol").asInt(sol == null ? 0 : sol),
                    text(photo, "earth_date"),
                    camera == null ? null : text(camera, "name"),
                    camera == null ? null : text(camera, "full_name"),
                    roverNode == null ? rover : text(roverNode, "name"),
                    imageUrl
            ));
        }
        boolean hasMore = paged && photos.size() >= MAX_MARS_PHOTOS;
        return new Mars(rover, sol, page, hasMore, out);
    }

    static NeoFeed parseNeo(LocalDate start, LocalDate end, JsonNode node) {
        if (node == null || !node.isObject()) {
            throw new NasaProxyException("not_found");
        }
        JsonNode byDate = node.get("near_earth_objects");
        if (byDate == null || !byDate.isObject()) {
            throw new NasaProxyException("not_found");
        }
        List<Neo> objects = new ArrayList<>();
        Iterator<String> dates = byDate.fieldNames();
        while (dates.hasNext()) {
            String day = dates.next();
            for (JsonNode neo : byDate.get(day)) {
                objects.add(toNeo(day, neo));
            }
        }
        objects.sort(Comparator.comparing(Neo::missKm, Comparator.nullsLast(Double::compareTo)));
        if (objects.size() > MAX_NEO) {
            objects = new ArrayList<>(objects.subList(0, MAX_NEO));
        }
        return new NeoFeed(start.toString(), end.toString(), objects.size(), objects);
    }

    private static Neo toNeo(String day, JsonNode neo) {
        JsonNode meters = neo.path("estimated_diameter").path("meters");
        JsonNode approach = neo.path("close_approach_data").isArray() && neo.path("close_approach_data").size() > 0
                ? neo.path("close_approach_data").get(0)
                : null;
        String approachDate = approach == null ? day : text(approach, "close_approach_date");
        return new Neo(
                text(neo, "id"),
                text(neo, "name"),
                approachDate == null ? day : approachDate,
                neo.path("is_potentially_hazardous_asteroid").asBoolean(false),
                doubleOrNull(meters, "estimated_diameter_min"),
                doubleOrNull(meters, "estimated_diameter_max"),
                approach == null ? null : parseDouble(text(approach.path("miss_distance"), "kilometers")),
                approach == null ? null : parseDouble(text(approach.path("miss_distance"), "lunar")),
                approach == null ? null : parseDouble(text(approach.path("relative_velocity"), "kilometers_per_hour")),
                safeHttpsUrl(text(neo, "nasa_jpl_url"))
        );
    }

    static String safeHttpsUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String url = raw.trim();
        if (url.regionMatches(true, 0, "http://", 0, 7)) {
            url = "https://" + url.substring(7);
        }
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException ex) {
            return null;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            return null;
        }
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        boolean allowed = host.equals("nasa.gov")
                || host.endsWith(".nasa.gov")
                || host.equals("youtube.com")
                || host.endsWith(".youtube.com")
                || host.equals("youtu.be")
                || host.equals("youtube-nocookie.com")
                || host.endsWith(".youtube-nocookie.com")
                || host.equals("vimeo.com")
                || host.endsWith(".vimeo.com");
        return allowed ? url : null;
    }

    private URI apodUri(LocalDate date) {
        UriComponentsBuilder builder = base("/planetary/apod").queryParam("thumbs", "true");
        if (date != null) {
            builder.queryParam("date", date.toString());
        }
        return builder.encode().build().toUri();
    }

    private URI epicUri(LocalDate date) {
        String path = date == null ? "/EPIC/api/natural" : "/EPIC/api/natural/date/" + date;
        return base(path).encode().build().toUri();
    }

    private URI epicImageUri(LocalDate date, String name) {
        String path = "/EPIC/archive/natural/"
                + date.format(DateTimeFormatter.ofPattern("yyyy/MM/dd"))
                + "/png/" + name + ".png";
        return base(path).encode().build().toUri();
    }

    private URI marsUri(String rover, Integer sol, LocalDate earthDate, String camera, int page) {
        if (earthDate != null) {
            UriComponentsBuilder builder = base("/mars-photos/api/v1/rovers/" + rover + "/photos")
                    .queryParam("earth_date", earthDate.toString())
                    .queryParam("page", page);
            if (camera != null && !camera.isBlank()) {
                builder.queryParam("camera", camera);
            }
            return builder.encode().build().toUri();
        }
        if (sol == null) {
            UriComponentsBuilder builder = base("/mars-photos/api/v1/rovers/" + rover + "/latest_photos");
            return builder.encode().build().toUri();
        }
        UriComponentsBuilder builder = base("/mars-photos/api/v1/rovers/" + rover + "/photos")
                .queryParam("sol", sol)
                .queryParam("page", page);
        if (camera != null && !camera.isBlank()) {
            builder.queryParam("camera", camera);
        }
        return builder.encode().build().toUri();
    }

    private URI neoUri(LocalDate start, LocalDate end) {
        return base("/neo/rest/v1/feed")
                .queryParam("start_date", start.toString())
                .queryParam("end_date", end.toString())
                .encode()
                .build()
                .toUri();
    }

    private UriComponentsBuilder base(String path) {
        String root = apiBase == null ? "https://api.nasa.gov" : apiBase.trim();
        if (root.endsWith("/")) {
            root = root.substring(0, root.length() - 1);
        }
        String key = apiKey == null || apiKey.isBlank() ? "DEMO_KEY" : apiKey.trim();
        return UriComponentsBuilder.fromHttpUrl(root + path).queryParam("api_key", key);
    }

    private <T> T load(String key, Duration ttl, java.util.function.Supplier<T> loader) {
        CacheEntry<Object> hit = cache.get(key);
        if (hit != null && !hit.expired()) {
            @SuppressWarnings("unchecked")
            T value = (T) hit.value;
            return value;
        }
        throwIfFailed(key);
        try {
            T value = loader.get();
            cache.put(key, new CacheEntry<>(value, Instant.now().plus(ttl)));
            trim(cache, MAX_CACHE);
            failures.remove(key);
            return value;
        } catch (NasaProxyException ex) {
            rememberFailure(key, ex.code());
            throw ex;
        }
    }

    private void throwIfFailed(String key) {
        CacheEntry<String> failure = failures.get(key);
        if (failure != null && !failure.expired()) {
            throw new NasaProxyException(failure.value);
        }
    }

    private void rememberFailure(String key, String code) {
        failures.put(key, new CacheEntry<>(code, Instant.now().plus(FAILURE_TTL)));
    }

    private JsonNode getJson(URI uri) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, UA);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (response.getBody() == null || response.getBody().isBlank()) {
                throw new NasaProxyException("unavailable");
            }
            return objectMapper.readTree(response.getBody());
        } catch (NasaProxyException ex) {
            throw ex;
        } catch (RestClientResponseException ex) {
            throw mapStatus(ex);
        } catch (Exception ex) {
            log.warn("NASA JSON call failed: {}", redact(ex.toString()));
            throw new NasaProxyException("unavailable");
        }
    }

    private byte[] fetchImage(URI uri) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, UA);
        headers.setAccept(List.of(MediaType.IMAGE_PNG, MediaType.ALL));
        try {
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
            byte[] body = response.getBody();
            MediaType type = response.getHeaders().getContentType();
            if (body == null || body.length == 0 || body.length > MAX_IMAGE_BYTES
                    || type == null || !"image".equalsIgnoreCase(type.getType())) {
                throw new NasaProxyException("not_found");
            }
            return body;
        } catch (NasaProxyException ex) {
            throw ex;
        } catch (RestClientResponseException ex) {
            throw mapStatus(ex);
        } catch (Exception ex) {
            log.warn("NASA image call failed: {}", redact(ex.toString()));
            throw new NasaProxyException("unavailable");
        }
    }

    private static String redact(String message) {
        if (message == null) {
            return "";
        }
        return message.replaceAll("(?i)(api_key=)[^&\\s\"]+", "$1***");
    }

    private static NasaProxyException mapStatus(RestClientResponseException ex) {
        int status = ex.getStatusCode().value();
        String body = ex.getResponseBodyAsString();
        String lower = body == null ? "" : body.toLowerCase(Locale.ROOT);
        if (status == 429 || lower.contains("over_rate_limit") || lower.contains("rate limit")) {
            return new NasaProxyException("quota");
        }
        if (status == 404) {
            return new NasaProxyException("not_found");
        }
        log.warn("NASA upstream HTTP {}: {}", status, ex.getStatusText());
        return new NasaProxyException("unavailable");
    }

    private static String text(JsonNode node, String field) {
        if (node == null || node.get(field) == null || node.get(field).isNull()) {
            return null;
        }
        String value = node.get(field).asText("").trim();
        return value.isEmpty() ? null : value;
    }

    private static Double doubleOrNull(JsonNode node, String field) {
        if (node == null || node.get(field) == null || !node.get(field).isNumber()) {
            return null;
        }
        return node.get(field).asDouble();
    }

    private static Double parseDouble(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Double.valueOf(raw.trim());
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static <T> void trim(ConcurrentMap<String, CacheEntry<T>> map, int max) {
        if (map.size() <= max) {
            return;
        }
        map.entrySet().removeIf(entry -> entry.getValue().expired());
        if (map.size() <= max) {
            return;
        }
        int extra = map.size() - max;
        for (String key : List.copyOf(map.keySet())) {
            if (extra-- <= 0) {
                break;
            }
            map.remove(key);
        }
    }

    private record CacheEntry<T>(T value, Instant expiresAt) {
        boolean expired() {
            return Instant.now().isAfter(expiresAt);
        }
    }
}
