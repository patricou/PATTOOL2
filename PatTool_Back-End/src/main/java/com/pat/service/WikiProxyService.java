package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import com.pat.util.SsrfGuard;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Proxy for Wikipedia REST search and summaries (read-only). The browser never
 * calls wikipedia.org directly (CSP {@code connect-src} is limited to this API).
 * A missing page is a normal empty result, not a 502.
 */
@Service
public class WikiProxyService {

    private static final Logger log = LoggerFactory.getLogger(WikiProxyService.class);
    private static final Pattern SAFE_TITLE = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{S}\\p{Z}_]{1,160}$");
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");
    private static final Pattern WIKIDATA_ID = Pattern.compile("Q\\d{1,12}");
    private static final Pattern COMMONS_IMAGE = Pattern.compile("(?i)\\.(jpe?g|png|gif|webp|svg|tiff?)$");
    private static final Set<String> SAFE_LANGS = Set.of(
            "fr", "en", "de", "es", "it", "ru", "ja", "zh", "ar", "he", "el", "hi"
    );
    private static final String USER_AGENT = "PatTool/1.0 (wikipedia helper; https://www.patrickdeschamps.com)";
    private static final Set<String> NAME_STOPWORDS = Set.of(
            "de", "la", "le", "les", "du", "des", "un", "une", "et", "au", "aux", "sur", "en", "of",
            "the", "and", "pour", "par", "dans", "avec", "sous", "chez", "von", "van", "di", "d"
    );
    /** Road words at the start of an OpenStreetMap name. The place itself follows them. */
    private static final Set<String> WAY_WORDS = Set.of(
            "route", "chemin", "sentier", "rue", "avenue", "boulevard", "place", "impasse",
            "allee", "voie", "road", "street", "path", "track", "trail", "highway", "forestiere", "rte"
    );
    private static final int DEFAULT_SEARCH_LIMIT = 10;
    private static final int MAX_SEARCH_LIMIT = 20;
    /** Place photos use this radius unless the viewer asks for another. */
    private static final double PHOTO_RADIUS_M = 300;
    /** Widest radius the photo slider can ask for. */
    private static final double PHOTO_RADIUS_MAX_M = 1_000;
    /** Frames kept for one source. The viewer shows them as one gallery. */
    private static final int PHOTO_GALLERY_MAX = 48;
    /** Half the circumference of the Earth in Web Mercator metres (EPSG:3857). */
    private static final double WEB_MERCATOR_M = 20_037_508.342789244;
    /** Dashcam frames closer than this are the same view. */
    private static final double KARTAVIEW_SPACING_M = 15;

    private static double photoRadius(Double requested) {
        if (requested == null || !Double.isFinite(requested) || requested < 10) {
            return PHOTO_RADIUS_M;
        }
        return Math.min(PHOTO_RADIUS_MAX_M, requested);
    }

    /** Today's count up to {@link #PHOTO_RADIUS_M}. A wider search may keep more hits. */
    private static int widePhotoCap(double radiusM, int base, int max) {
        if (radiusM <= PHOTO_RADIUS_M || max <= base) {
            return base;
        }
        double span = PHOTO_RADIUS_MAX_M - PHOTO_RADIUS_M;
        double extra = Math.min(1.0, Math.max(0.0, (radiusM - PHOTO_RADIUS_M) / span));
        return (int) Math.round(base + (max - base) * extra);
    }

    private final RestTemplate restTemplate;
    /** Nominatim and Commons can take longer than the short default client. */
    private final RestTemplate photoRestTemplate;
    private final ObjectMapper objectMapper;
    /** Client token from https://www.mapillary.com/dashboard/developers . Empty skips Mapillary. */
    private final String mapillaryToken;
    /** Key from https://www.flickr.com/services/apps/create/apply . Empty skips Flickr. */
    private final String flickrApiKey;
    /** Access Key from https://unsplash.com/developers . Empty skips Unsplash. */
    private final String unsplashAccessKey;
    /** One lookup per click, shared by the sources that need the place name. */
    private final ConcurrentHashMap<String, NearbyPlace> nearbyPlaceCache = new ConcurrentHashMap<>();

    public WikiProxyService(
            RestTemplate restTemplate,
            ObjectMapper objectMapper,
            @Value("${app.mapillary.access-token:}") String mapillaryToken,
            @Value("${app.flickr.api-key:}") String flickrApiKey,
            @Value("${app.unsplash.access-key:}") String unsplashAccessKey) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.mapillaryToken = mapillaryToken == null ? "" : mapillaryToken.trim();
        this.flickrApiKey = flickrApiKey == null ? "" : flickrApiKey.trim();
        this.unsplashAccessKey = unsplashAccessKey == null ? "" : unsplashAccessKey.trim();
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(3));
        factory.setReadTimeout(Duration.ofSeconds(8));
        this.photoRestTemplate = new RestTemplate(factory);
    }

    public JsonNode search(String query, String lang, Integer limit) {
        String trimmed = query == null ? "" : query.trim();
        String code = normalizeLang(lang);
        int n = clampLimit(limit);
        if (!StringUtils.hasText(trimmed)) {
            return emptySearch(trimmed, code);
        }
        if (!SAFE_TITLE.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_query");
        }
        String encoded = URLEncoder.encode(trimmed, StandardCharsets.UTF_8).replace("+", "%20");
        String url = "https://" + code + ".wikipedia.org/w/rest.php/v1/search/page?q=" + encoded + "&limit=" + n;
        JsonNode raw = fetchJson(url, "search " + trimmed, code);
        return mapSearch(trimmed, code, raw);
    }

    /**
     * Summary in {@code lang} when Wikipedia has that edition, otherwise the
     * article in the language the source actually provides (English, then French).
     */
    public JsonNode fetchSummary(String title, String lang) {
        String trimmed = title == null ? "" : title.trim();
        if (!SAFE_TITLE.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_title");
        }
        String want = normalizeLang(lang);

        // Prefer the user's language via EN interlanguage links: English titles
        // like "Mars" collide on other wikis (disambiguation / unrelated pages).
        // French uses catalogue titles already disambiguated (Mars_(planète)).
        if (!"en".equals(want) && !"fr".equals(want)) {
            JsonNode localized = fetchViaLanglink(trimmed, "en", want);
            if (isUsable(localized)) {
                return localized;
            }
        }

        JsonNode direct = fetchOne(trimmed, want);
        if (isUsable(direct)) {
            return direct;
        }

        if (!"fr".equals(want)) {
            JsonNode fromFrench = fetchViaLanglink(trimmed, "fr", want);
            if (isUsable(fromFrench)) {
                return fromFrench;
            }
        }

        if (!"en".equals(want)) {
            JsonNode english = fetchOne(trimmed, "en");
            if (isUsable(english)) {
                return english;
            }
            JsonNode englishFromFr = fetchViaLanglink(trimmed, "fr", "en");
            if (isUsable(englishFromFr)) {
                return englishFromFr;
            }
        }

        if (!"fr".equals(want)) {
            JsonNode french = fetchOne(trimmed, "fr");
            if (isUsable(french)) {
                return french;
            }
            JsonNode frenchFromEn = fetchViaLanglink(trimmed, "en", "fr");
            if (isUsable(frenchFromEn)) {
                return frenchFromEn;
            }
        }

        return objectMapper.createObjectNode();
    }

    /**
     * Image for a map attraction or a place dot. Wikidata and the OpenStreetMap
     * tags already known for that object come first, then a search around the
     * click, then a geotagged Commons file whose title shares the place name.
     */
    public JsonNode fetchPoiPhoto(
            String id, String name, String nameEn, Double lat, Double lng,
            String wikipedia, String commons, String image, String source, String lang, Double radiusM) {
        String qid = normalizeWikidataId(id);
        String label = clipTitle(name);
        String english = clipTitle(nameEn);
        boolean located = isCoord(lat, lng);
        if (!StringUtils.hasText(qid) && !StringUtils.hasText(label) && !StringUtils.hasText(english)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "missing_poi");
        }
        String code = normalizeLang(lang);
        String only = photoSource(source);
        double radius = photoRadius(radiusM);
        if (located && unnamedPoint(label, english) && placeNameHelps(only)) {
            NearbyPlace place = nearestNamedPlace(lat, lng, radius);
            if (place != null) {
                label = place.name();
                if (!StringUtils.hasText(qid)) {
                    qid = place.wikidata();
                }
            } else {
                if (isCoordinateLabel(label)) {
                    label = "";
                }
                if (isCoordinateLabel(english)) {
                    english = "";
                }
            }
        }
        ObjectNode out = objectMapper.createObjectNode();
        out.put("title", StringUtils.hasText(label) ? label : english);
        out.put("imageUrl", "");
        out.put("pageUrl", "");
        out.put("source", "");
        out.putArray("photos");
        if (StringUtils.hasText(qid) && (allows(only, "wikidata") || allows(only, "wikipedia"))) {
            fillFromWikidata(out, qid, code, label, only);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText())) {
            fillFromOsmTags(out, label, english, wikipedia, commons, image, only);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && nominatimCanHelp(only)) {
            fillFromNominatim(out, label, english, lat, lng, code, only, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && allows(only, "wikipedia")) {
            fillFromMatchingArticle(out, label, code);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && allows(only, "wikipedia") && !english.equalsIgnoreCase(label)) {
            fillFromMatchingArticle(out, english, "en");
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "wikipedia")) {
            fillFromWikipediaNearby(out, lat, lng, code, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "commons")) {
            fillFromCommonsNearby(out, label, english, lat, lng, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "camptocamp")) {
            fillFromCamptocamp(out, label, english, lat, lng, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "inaturalist")) {
            fillFromINaturalist(out, label, lat, lng, code, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "flickr")) {
            fillFromFlickr(out, label, english, lat, lng, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && allows(only, "openverse")
                && (specificPlaceName(label) || specificPlaceName(english) || "openverse".equals(only))) {
            fillFromOpenverse(out, label, english);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && allows(only, "unsplash")
                && (specificPlaceName(label) || specificPlaceName(english) || "unsplash".equals(only))) {
            fillFromUnsplash(out, label, english);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "mapillary")) {
            fillFromMapillary(out, lat, lng, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "panoramax")) {
            fillFromPanoramax(out, lat, lng, radius);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText()) && located && allows(only, "kartaview")) {
            fillFromKartaView(out, lat, lng, radius);
        }
        out.put("unsplash", StringUtils.hasText(unsplashAccessKey));
        return out;
    }

    private static String photoSource(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        String value = raw.trim().toLowerCase(Locale.ROOT);
        return switch (value) {
            case "wikidata", "wikipedia", "commons", "flickr", "openverse", "unsplash", "mapillary", "panoramax", "kartaview", "camptocamp", "inaturalist", "osm" -> value;
            default -> "";
        };
    }

    /** Keeps every photo already found. The first one stays in {@code imageUrl}. */
    private void rememberPhoto(ObjectNode out, String imageUrl, String pageUrl, String source) {
        rememberPhoto(out, imageUrl, pageUrl, source, false, "", false);
    }

    /** {@code pano} is a Mapillary 360° image the viewer can turn. */
    private void rememberPhoto(ObjectNode out, String imageUrl, String pageUrl, String source, boolean pano) {
        rememberPhoto(out, imageUrl, pageUrl, source, pano, "", false);
    }

    /**
     * {@code title} replaces the place name for this frame (a nearby article or file).
     * {@code nearby} is a photo of the surroundings, not one named after the place.
     */
    private void rememberPhoto(
            ObjectNode out, String imageUrl, String pageUrl, String source,
            boolean pano, String title, boolean nearby) {
        if (!StringUtils.hasText(imageUrl) || !imageUrl.startsWith("https://")) {
            return;
        }
        var photos = out.withArray("photos");
        for (JsonNode existing : photos) {
            if (imageUrl.equals(existing.path("imageUrl").asText())) {
                return;
            }
        }
        if (photos.size() >= PHOTO_GALLERY_MAX) {
            return;
        }
        String page = StringUtils.hasText(pageUrl) && pageUrl.startsWith("https://") ? pageUrl : "";
        String caption = StringUtils.hasText(title) ? clipTitle(title) : "";
        ObjectNode photo = photos.addObject();
        photo.put("imageUrl", imageUrl);
        photo.put("pageUrl", page);
        photo.put("source", source);
        if (StringUtils.hasText(caption)) {
            photo.put("title", caption);
        }
        if (pano) {
            photo.put("pano", true);
        }
        if (nearby) {
            photo.put("nearby", true);
        }
        if (!StringUtils.hasText(out.path("imageUrl").asText())) {
            out.put("imageUrl", imageUrl);
            out.put("pageUrl", page);
            out.put("source", source);
            out.put("pano", pano);
            if (StringUtils.hasText(caption)) {
                out.put("title", caption);
            }
        }
    }

    /** Empty {@code only} accepts every source. A named source skips the others. */
    private static boolean allows(String only, String source) {
        return !StringUtils.hasText(only) || only.equals(source);
    }

    /** A map click sends "46.27094, 5.93987" and no place name. */
    static boolean isCoordinateLabel(String value) {
        return StringUtils.hasText(value)
                && value.trim().matches("-?\\d+(?:\\.\\d+)?\\s*,\\s*-?\\d+(?:\\.\\d+)?");
    }

    /** Wikidata, Wikipedia, Openverse and Unsplash need a place, not a coordinate pair. */
    private static boolean placeNameHelps(String only) {
        return !StringUtils.hasText(only)
                || "wikidata".equals(only)
                || "wikipedia".equals(only)
                || "openverse".equals(only)
                || "unsplash".equals(only)
                || "flickr".equals(only);
    }

    /** No usable place name: blank, or only the clicked coordinates. */
    private static boolean unnamedPoint(String label, String english) {
        boolean labelBare = !StringUtils.hasText(label) || isCoordinateLabel(label);
        boolean englishBare = !StringUtils.hasText(english) || isCoordinateLabel(english);
        return labelBare && englishBare;
    }

    /** Name and Wikidata id of the OpenStreetMap feature closest to the click. */
    record NearbyPlace(String name, String wikidata) {}

    /**
     * Closest named OpenStreetMap feature inside the radius that carries a
     * Wikidata id. A coordinate label cannot be matched to "Crêt de la Neige".
     */
    private NearbyPlace nearestNamedPlace(double lat, double lng, double radiusM) {
        int meters = Math.max(10, (int) Math.round(radiusM));
        String key = String.format(Locale.US, "%.5f,%.5f,%d", lat, lng, meters);
        NearbyPlace cached = nearbyPlaceCache.get(key);
        if (cached != null) {
            return StringUtils.hasText(cached.name()) ? cached : null;
        }
        if (nearbyPlaceCache.size() > 200) {
            nearbyPlaceCache.clear();
        }
        String query = String.format(Locale.US, """
                [out:json][timeout:8];
                (
                  node(around:%1$d,%2$.6f,%3$.6f)["name"]["wikidata"];
                  way(around:%1$d,%2$.6f,%3$.6f)["name"]["wikidata"];
                );
                out tags center 20;
                """, meters, lat, lng);
        String[] urls = {
                "https://overpass.openstreetmap.fr/api/interpreter",
                "https://overpass-api.de/api/interpreter"
        };
        for (String url : urls) {
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("data", query);
            JsonNode raw = postPhotoForm(url, form, "nearby place");
            if (raw == null || !raw.isObject() || !raw.has("elements")) {
                continue;
            }
            NearbyPlace found = closestNamedPlace(raw, lat, lng, radiusM);
            nearbyPlaceCache.put(key, found == null ? new NearbyPlace("", "") : found);
            return found;
        }
        return null;
    }

    static NearbyPlace closestNamedPlace(JsonNode raw, double lat, double lng, double radiusM) {
        JsonNode elements = raw == null ? null : raw.get("elements");
        if (elements == null || !elements.isArray()) {
            return null;
        }
        NearbyPlace best = null;
        double bestDistance = radiusM;
        for (JsonNode element : elements) {
            JsonNode tags = element.get("tags");
            if (tags == null || !tags.isObject()) {
                continue;
            }
            if ("administrative".equals(textOrEmpty(tags.get("boundary")))) {
                continue;
            }
            String name = textOrEmpty(tags.get("name"));
            String wikidata = normalizeWikidataId(textOrEmpty(tags.get("wikidata")));
            if (!StringUtils.hasText(name) || isCoordinateLabel(name) || !StringUtils.hasText(wikidata)) {
                continue;
            }
            double placeLat = element.path("lat").asDouble(Double.NaN);
            double placeLng = element.path("lon").asDouble(Double.NaN);
            if (!Double.isFinite(placeLat) || !Double.isFinite(placeLng)) {
                placeLat = element.path("center").path("lat").asDouble(Double.NaN);
                placeLng = element.path("center").path("lon").asDouble(Double.NaN);
            }
            if (!Double.isFinite(placeLat) || !Double.isFinite(placeLng)) {
                continue;
            }
            double distance = haversineMeters(lat, lng, placeLat, placeLng);
            if (distance <= bestDistance) {
                bestDistance = distance;
                best = new NearbyPlace(name, wikidata);
            }
        }
        return best;
    }

    /** Nominatim only recovers tags used by these sources. Openverse and Unsplash search by name. */
    private static boolean nominatimCanHelp(String only) {
        return allows(only, "wikidata") || allows(only, "wikipedia") || allows(only, "commons")
                || allows(only, "flickr") || allows(only, "mapillary") || allows(only, "osm");
    }

    /** Tags already stored on the OpenStreetMap object (place dot or recovered hit). */
    private void fillFromOsmTags(
            ObjectNode out, String label, String english,
            String wikipedia, String commons, String image, String only) {
        if (allows(only, "wikipedia")) {
            String[] wiki = parseWikipediaTag(wikipedia);
            if (wiki != null) {
                applyArticleImage(out, fetchOne(wiki[1], wiki[0]), label);
                if (StringUtils.hasText(out.path("imageUrl").asText())) {
                    return;
                }
            }
        }
        if (allows(only, "commons") && applyCommonsTag(out, commons, label, english)) {
            return;
        }
        String direct = osmImageUrl(image);
        if (allows(only, "osm") && StringUtils.hasText(direct)) {
            out.put("imageUrl", direct);
            out.put("pageUrl", direct);
            out.put("source", "osm");
        }
    }

    /**
     * The vector tile often drops Wikidata. The OpenStreetMap object at the
     * click still has it, plus wikipedia / image / commons tags.
     */
    private void fillFromNominatim(ObjectNode out, String label, String english, double lat, double lng, String lang, String only, double radiusM) {
        String query = StringUtils.hasText(label) ? label : english;
        if (!StringUtils.hasText(query)) {
            return;
        }
        double dLat = radiusM / 111_320.0;
        double dLng = dLat / Math.max(0.25, Math.cos(Math.toRadians(lat)));
        String viewbox = (lng - dLng) + "," + (lat + dLat) + "," + (lng + dLng) + "," + (lat - dLat);
        String url = "https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&limit=6&bounded=1"
                + "&q=" + urlEncode(query)
                + "&viewbox=" + viewbox;
        JsonNode raw = fetchPhotoJson(url, "nominatim " + query);
        if (raw == null || !raw.isArray() || raw.isEmpty()) {
            return;
        }
        List<JsonNode> hits = new ArrayList<>();
        raw.forEach(hits::add);
        hits.sort(Comparator.comparingDouble(hit -> distanceMeters(lat, lng, hit)));
        int tried = 0;
        for (JsonNode hit : hits) {
            if (tried >= 4 || StringUtils.hasText(out.path("imageUrl").asText())) {
                return;
            }
            double meters = distanceMeters(lat, lng, hit);
            String hitName = firstText(textOrEmpty(hit.get("name")), textOrEmpty(hit.path("namedetails").path("name")));
            if (!StringUtils.hasText(hitName)) {
                hitName = query;
            }
            boolean exact = fold(hitName).equals(fold(query)) || fold(hitName).equals(fold(english));
            if (meters > radiusM || !samePlace(query, hitName, meters) && !samePlace(english, hitName, meters)) {
                continue;
            }
            if (skipOsmClass(textOrEmpty(hit.get("category")), meters, exact)) {
                continue;
            }
            tried++;
            JsonNode tags = hit.get("extratags");
            if (tags == null || !tags.isObject()) {
                continue;
            }
            String foundId = normalizeWikidataId(textOrEmpty(tags.get("wikidata")));
            if (StringUtils.hasText(foundId) && (allows(only, "wikidata") || allows(only, "wikipedia"))) {
                fillFromWikidata(out, foundId, lang, label, only);
                if (StringUtils.hasText(out.path("imageUrl").asText())) {
                    return;
                }
            }
            if (allows(only, "wikipedia")) {
                String[] wiki = parseWikipediaTag(textOrEmpty(tags.get("wikipedia")));
                if (wiki != null) {
                    applyArticleImage(out, fetchOne(wiki[1], wiki[0]), label);
                    if (StringUtils.hasText(out.path("imageUrl").asText())) {
                        return;
                    }
                }
            }
            if (allows(only, "commons") && applyCommonsTag(out, textOrEmpty(tags.get("wikimedia_commons")), label, english)) {
                return;
            }
            if (allows(only, "flickr") && applyFlickrTag(out, textOrEmpty(tags.get("flickr")))) {
                return;
            }
            if (allows(only, "mapillary") && applyMapillaryId(out, textOrEmpty(tags.get("mapillary")))) {
                return;
            }
            String image = osmImageUrl(textOrEmpty(tags.get("image")));
            if (allows(only, "osm") && StringUtils.hasText(image)) {
                out.put("imageUrl", image);
                out.put("pageUrl", image);
                out.put("source", "osm");
                return;
            }
        }
    }

    /**
     * Geotagged Commons files within the search radius. Files named like the
     * place come first. The other photographs around the point stay in the gallery.
     */
    private void fillFromCommonsNearby(ObjectNode out, String label, String english, double lat, double lng, double radiusM) {
        int fetch = 50;
        String url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=geosearch"
                + "&gscoord=" + lat + "|" + lng
                + "&gsradius=" + (int) radiusM + "&gsnamespace=6&gslimit=" + fetch;
        JsonNode raw = fetchPhotoJson(url, "commons geo " + label);
        JsonNode rows = raw == null ? null : raw.path("query").path("geosearch");
        if (rows == null || !rows.isArray()) {
            return;
        }
        List<JsonNode> named = new ArrayList<>();
        List<JsonNode> scenic = new ArrayList<>();
        for (JsonNode row : rows) {
            String title = textOrEmpty(row.get("title"));
            double dist = row.path("dist").asDouble(Double.MAX_VALUE);
            if (!scenicCommonsFile(title) || dist > radiusM) {
                continue;
            }
            if (samePlace(label, title, dist) || samePlace(english, title, dist)) {
                named.add(row);
            } else {
                scenic.add(row);
            }
        }
        Comparator<JsonNode> byDistance = Comparator.comparingDouble(row -> row.path("dist").asDouble(Double.MAX_VALUE));
        named.sort(byDistance);
        scenic.sort(byDistance);
        List<JsonNode> chosen = new ArrayList<>(named.size() + scenic.size());
        chosen.addAll(named);
        chosen.addAll(scenic);
        int limit = widePhotoCap(radiusM, 36, PHOTO_GALLERY_MAX);
        int added = 0;
        for (JsonNode row : chosen) {
            if (added >= limit) {
                break;
            }
            boolean nearby = !named.contains(row);
            int before = out.withArray("photos").size();
            applyCommonsFile(out, textOrEmpty(row.get("title")), nearby);
            if (out.withArray("photos").size() > before) {
                added++;
            }
        }
    }

    /**
     * Illustrated Wikipedia article within the search radius, when the
     * place itself has no page.
     */
    private void fillFromWikipediaNearby(ObjectNode out, double lat, double lng, String lang, double radiusM) {
        if (collectNearbyArticles(out, lat, lng, lang, radiusM)) {
            return;
        }
        if (!"fr".equals(lang)) {
            collectNearbyArticles(out, lat, lng, "fr", radiusM);
        }
    }

    private boolean collectNearbyArticles(ObjectNode out, double lat, double lng, String lang, double radiusM) {
        int fetch = widePhotoCap(radiusM, 6, 12);
        int tryCap = widePhotoCap(radiusM, 4, 8);
        int addCap = widePhotoCap(radiusM, 3, 6);
        String url = "https://" + lang + ".wikipedia.org/w/api.php?action=query&format=json&list=geosearch"
                + "&gscoord=" + lat + "|" + lng
                + "&gsradius=" + (int) radiusM + "&gslimit=" + fetch;
        JsonNode raw = fetchPhotoJson(url, "wiki geo " + lang);
        JsonNode rows = raw == null ? null : raw.path("query").path("geosearch");
        if (rows == null || !rows.isArray()) {
            return false;
        }
        int tried = 0;
        int added = 0;
        for (JsonNode row : rows) {
            if (tried >= tryCap || added >= addCap) {
                break;
            }
            String title = textOrEmpty(row.get("title"));
            double dist = row.path("dist").asDouble(Double.MAX_VALUE);
            if (!StringUtils.hasText(title) || dist > radiusM || skipNearbyArticle(title)) {
                continue;
            }
            tried++;
            int before = out.withArray("photos").size();
            rememberArticle(out, fetchOne(title, lang), true);
            if (out.withArray("photos").size() > before) {
                added++;
            }
        }
        return added > 0;
    }

    private static boolean skipNearbyArticle(String title) {
        String folded = fold(title);
        return folded.startsWith("canton ")
                || folded.startsWith("arrondissement ")
                || folded.startsWith("departement ")
                || folded.startsWith("department ")
                || folded.startsWith("liste ")
                || folded.startsWith("list of ");
    }

    private void rememberArticle(ObjectNode out, JsonNode summary, boolean nearby) {
        if (!isUsable(summary)) {
            return;
        }
        String image = safeImageUrl(widerThumb(textOrEmpty(summary.path("thumbnail").path("source"))));
        if (!StringUtils.hasText(image)) {
            image = safeImageUrl(textOrEmpty(summary.path("originalimage").path("source")));
        }
        if (!StringUtils.hasText(image)) {
            return;
        }
        String page = safePageUrl(textOrEmpty(summary.path("content_urls").path("desktop").path("page")));
        String title = textOrEmpty(summary.get("title"));
        rememberPhoto(out, image, page, "wikipedia", false, title, nearby);
    }

    /** Wikimedia thumb URLs are 330 px. The popup is readable at 960. */
    private static String widerThumb(String url) {
        if (!StringUtils.hasText(url)) {
            return "";
        }
        return url.replaceAll("/\\d+px-", "/960px-");
    }

    /**
     * Street-level photo from Panoramax, the open coverage used on French roads.
     * No account is required. A picture farther than the search radius is left out.
     */
    private void fillFromPanoramax(ObjectNode out, double lat, double lng, double radiusM) {
        double dLat = radiusM / 111_320.0;
        double dLng = dLat / Math.max(0.2, Math.cos(Math.toRadians(lat)));
        int cap = widePhotoCap(radiusM, 8, PHOTO_GALLERY_MAX);
        int fetch = radiusM <= PHOTO_RADIUS_M ? Math.max(8, cap * 2) : Math.min(40, Math.max(16, cap * 3));
        String url = String.format(Locale.US,
                "https://api.panoramax.xyz/api/search?limit=%d&bbox=%.5f,%.5f,%.5f,%.5f",
                fetch,
                lng - dLng, lat - dLat, lng + dLng, lat + dLat);
        JsonNode raw = fetchPhotoJson(url, "panoramax");
        JsonNode features = raw == null ? null : raw.get("features");
        if (features == null || !features.isArray() || features.isEmpty()) {
            return;
        }
        List<JsonNode> rows = new ArrayList<>();
        features.forEach(rows::add);
        rows.sort(Comparator.comparingDouble(feature -> panoramaxDistance(lat, lng, feature)));
        int added = 0;
        for (JsonNode feature : rows) {
            if (added >= cap || panoramaxDistance(lat, lng, feature) > radiusM) {
                break;
            }
            String id = textOrEmpty(feature.get("id"));
            if (!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) {
                continue;
            }
            String image = panoramaxImage(feature);
            if (!StringUtils.hasText(image)) {
                continue;
            }
            int before = out.withArray("photos").size();
            rememberPhoto(
                    out, image, "https://api.panoramax.xyz/#focus=pic&pic=" + id,
                    "panoramax", panoramaxPano(feature), "", true);
            if (out.withArray("photos").size() > before) {
                added++;
            }
        }
    }

    private static double panoramaxDistance(double lat, double lng, JsonNode feature) {
        JsonNode coords = feature.path("geometry").path("coordinates");
        if (!coords.isArray() || coords.size() < 2) {
            return Double.MAX_VALUE;
        }
        return haversineMeters(lat, lng, coords.get(1).asDouble(), coords.get(0).asDouble());
    }

    private static String panoramaxImage(JsonNode feature) {
        String sd = textOrEmpty(feature.path("assets").path("sd").path("href"));
        String thumb = textOrEmpty(feature.path("assets").path("thumb").path("href"));
        String chosen = sd.startsWith("https://") ? sd : thumb;
        return panoramaxImageHost(chosen) ? chosen : "";
    }

    /**
     * A Panoramax sphere is an equirectangular frame: field of view around 360°,
     * or a picture twice as wide as it is tall. The same viewer as Mapillary can turn it.
     */
    static boolean panoramaxPano(JsonNode feature) {
        if (feature == null || !feature.isObject()) {
            return false;
        }
        JsonNode properties = feature.path("properties");
        JsonNode orientation = properties.path("pers:interior_orientation");
        double fov = jsonDouble(orientation.path("field_of_view"));
        if (!Double.isFinite(fov)) {
            fov = jsonDouble(properties.path("field_of_view"));
        }
        if (fov >= 300) {
            return true;
        }
        JsonNode dims = orientation.path("sensor_array_dimensions");
        if (dims.isArray() && dims.size() >= 2 && equirectFrame(jsonDouble(dims.get(0)), jsonDouble(dims.get(1)))) {
            return true;
        }
        JsonNode exif = properties.path("exif");
        double width = jsonDouble(exif.path("Exif.Photo.PixelXDimension"));
        double height = jsonDouble(exif.path("Exif.Photo.PixelYDimension"));
        if (!equirectFrame(width, height)) {
            width = jsonDouble(exif.path("Exif.Image.ImageWidth"));
            height = jsonDouble(exif.path("Exif.Image.ImageLength"));
        }
        return equirectFrame(width, height);
    }

    static boolean equirectFrame(double width, double height) {
        if (!(width > 0) || !(height > 0)) {
            return false;
        }
        double ratio = width / height;
        return ratio >= 1.9 && ratio <= 2.1;
    }

    private static double jsonDouble(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return Double.NaN;
        }
        if (node.isNumber()) {
            return node.asDouble();
        }
        if (!node.isTextual()) {
            return Double.NaN;
        }
        try {
            return Double.parseDouble(node.asText().trim());
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static boolean panoramaxImageHost(String url) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://")) {
            return false;
        }
        try {
            String host = URI.create(url.trim()).getHost();
            if (!StringUtils.hasText(host)) {
                return false;
            }
            host = host.toLowerCase(Locale.ROOT);
            return "panoramax.xyz".equals(host) || host.endsWith(".panoramax.xyz")
                    || "panoramax.fr".equals(host) || host.endsWith(".panoramax.fr")
                    || "panoramax.openstreetmap.fr".equals(host)
                    || "panoramax.ign.fr".equals(host) || host.endsWith(".panoramax.ign.fr");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /**
     * Geotagged mountain photo from Camptocamp. The bounding box is Web Mercator
     * metres. A file whose camera position is outside the search radius is left out.
     * No account is required.
     */
    private void fillFromCamptocamp(
            ObjectNode out, String label, String english, double lat, double lng, double radiusM) {
        int cap = widePhotoCap(radiusM, 8, PHOTO_GALLERY_MAX);
        String url = "https://api.camptocamp.org/images?limit=" + Math.min(40, cap * 2)
                + "&pl=fr&bbox=" + urlEncode(webMercatorBbox(lat, lng, radiusM));
        JsonNode raw = fetchPhotoJson(url, "camptocamp");
        JsonNode documents = raw == null ? null : raw.get("documents");
        if (documents == null || !documents.isArray() || documents.isEmpty()) {
            return;
        }
        List<JsonNode> rows = new ArrayList<>();
        documents.forEach(rows::add);
        rows.sort(Comparator.comparingDouble(row -> camptocampDistance(lat, lng, row)));
        int added = 0;
        for (JsonNode row : rows) {
            if (added >= cap) {
                break;
            }
            double distance = camptocampDistance(lat, lng, row);
            if (distance > radiusM) {
                break;
            }
            String image = camptocampImageUrl(textOrEmpty(row.get("filename")));
            long id = row.path("document_id").asLong(0);
            if (!StringUtils.hasText(image) || id <= 0) {
                continue;
            }
            String title = camptocampTitle(row);
            boolean named = samePlace(label, title, distance) || samePlace(english, title, distance);
            int before = out.withArray("photos").size();
            rememberPhoto(
                    out, image, "https://www.camptocamp.org/images/" + id + "/fr",
                    "camptocamp", false, title, !named);
            if (out.withArray("photos").size() > before) {
                added++;
            }
        }
    }

    private double camptocampDistance(double lat, double lng, JsonNode row) {
        String geom = textOrEmpty(row.path("geometry").path("geom"));
        if (!geom.startsWith("{")) {
            return Double.MAX_VALUE;
        }
        try {
            JsonNode coords = objectMapper.readTree(geom).path("coordinates");
            if (!coords.isArray() || coords.size() < 2) {
                return Double.MAX_VALUE;
            }
            double[] latLng = mercatorToLatLng(coords.get(0).asDouble(), coords.get(1).asDouble());
            return haversineMeters(lat, lng, latLng[0], latLng[1]);
        } catch (Exception e) {
            return Double.MAX_VALUE;
        }
    }

    private static String camptocampTitle(JsonNode row) {
        String title = "";
        JsonNode locales = row.path("locales");
        if (!locales.isArray()) {
            return "";
        }
        for (JsonNode locale : locales) {
            String value = textOrEmpty(locale.get("title"));
            if (!StringUtils.hasText(value)) {
                continue;
            }
            title = value;
            if ("fr".equals(textOrEmpty(locale.get("lang")))) {
                break;
            }
        }
        return title;
    }

    /** Big Camptocamp rendition ({@code BI}), still small enough for the popup. */
    static String camptocampImageUrl(String filename) {
        if (!StringUtils.hasText(filename)) {
            return "";
        }
        Matcher matcher = Pattern.compile("^(\\d+_\\d+)\\.(jpe?g|png|webp)$", Pattern.CASE_INSENSITIVE)
                .matcher(filename.trim());
        if (!matcher.matches()) {
            return "";
        }
        return "https://media.camptocamp.org/c2corg-active/"
                + matcher.group(1) + "BI." + matcher.group(2).toLowerCase(Locale.ROOT);
    }

    /**
     * Nature photo from iNaturalist within the search radius. The radius is in
     * kilometres. No account is required. One frame per observation.
     */
    private void fillFromINaturalist(
            ObjectNode out, String label, double lat, double lng, String lang, double radiusM) {
        int cap = widePhotoCap(radiusM, 8, PHOTO_GALLERY_MAX);
        String locale = SAFE_LANGS.contains(lang) ? lang : "en";
        String url = String.format(Locale.US,
                "https://api.inaturalist.org/v1/observations?photos=true&order_by=votes&order=desc"
                        + "&per_page=%d&locale=%s&lat=%.6f&lng=%.6f&radius=%.3f",
                Math.min(30, cap + 4), locale, lat, lng, Math.max(0.05, radiusM / 1000.0));
        JsonNode raw = fetchPhotoJson(url, "inaturalist " + label);
        JsonNode results = raw == null ? null : raw.get("results");
        if (results == null || !results.isArray()) {
            return;
        }
        int added = 0;
        for (JsonNode row : results) {
            if (added >= cap) {
                break;
            }
            double distance = inaturalistDistance(lat, lng, row);
            if (!Double.isFinite(distance) || distance > radiusM) {
                continue;
            }
            String id = row.path("id").asText("");
            if (!id.matches("\\d{1,12}")) {
                continue;
            }
            JsonNode photos = row.get("photos");
            if (photos == null || !photos.isArray() || photos.isEmpty()) {
                continue;
            }
            String image = inaturalistImageUrl(textOrEmpty(photos.get(0).get("url")));
            if (!StringUtils.hasText(image)) {
                continue;
            }
            String title = firstText(
                    textOrEmpty(row.path("taxon").path("preferred_common_name")),
                    textOrEmpty(row.get("species_guess")),
                    textOrEmpty(row.path("taxon").path("name")));
            int before = out.withArray("photos").size();
            rememberPhoto(
                    out, image, "https://www.inaturalist.org/observations/" + id,
                    "inaturalist", false, title, true);
            if (out.withArray("photos").size() > before) {
                added++;
            }
        }
    }

    private static double inaturalistDistance(double lat, double lng, JsonNode row) {
        JsonNode coords = row.path("geojson").path("coordinates");
        if (!coords.isArray() || coords.size() < 2) {
            return Double.NaN;
        }
        return haversineMeters(lat, lng, coords.get(1).asDouble(), coords.get(0).asDouble());
    }

    /** iNaturalist serves a square thumb. The popup uses the large rendition. */
    static String inaturalistImageUrl(String url) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://")) {
            return "";
        }
        try {
            URI uri = URI.create(url.trim());
            String host = uri.getHost();
            if (!StringUtils.hasText(host)) {
                return "";
            }
            host = host.toLowerCase(Locale.ROOT);
            if (!"inaturalist-open-data.s3.amazonaws.com".equals(host) && !"static.inaturalist.org".equals(host)) {
                return "";
            }
            String path = uri.getRawPath();
            if (!StringUtils.hasText(path) || path.contains("..")) {
                return "";
            }
            String sized = path.replaceFirst("/(square|thumb|small|medium)\\.(jpe?g|png|webp)$", "/large.$2");
            if (!sized.matches(".*/large\\.(jpe?g|png|webp)$")) {
                return "";
            }
            return "https://" + host + sized;
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    /**
     * Street-level photo from KartaView (OpenStreetCam). No account is required.
     * Frames a few metres apart are the same drive, so only one of them is kept.
     */
    private void fillFromKartaView(ObjectNode out, double lat, double lng, double radiusM) {
        int cap = widePhotoCap(radiusM, 6, PHOTO_GALLERY_MAX);
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("lat", String.format(Locale.US, "%.6f", lat));
        form.add("lng", String.format(Locale.US, "%.6f", lng));
        form.add("radius", Integer.toString((int) Math.round(radiusM)));
        form.add("page", "1");
        form.add("ipp", Integer.toString(Math.min(40, cap * 4)));
        JsonNode raw = postPhotoForm("https://api.kartaview.org/1.0/list/nearby-photos/", form, "kartaview");
        if (raw == null || raw.path("status").path("apiCode").asInt(0) != 600) {
            return;
        }
        JsonNode rows = raw.get("currentPageItems");
        if (rows == null || !rows.isArray() || rows.isEmpty()) {
            return;
        }
        List<JsonNode> photos = new ArrayList<>();
        rows.forEach(photos::add);
        photos.sort(Comparator.comparingDouble(row -> kartaviewDistance(lat, lng, row)));
        List<double[]> kept = new ArrayList<>();
        int added = 0;
        for (JsonNode row : photos) {
            if (added >= cap) {
                break;
            }
            double photoLat = jsonDouble(row.get("lat"));
            double photoLng = jsonDouble(row.get("lng"));
            double distance = kartaviewDistance(lat, lng, row);
            if (!Double.isFinite(photoLat) || !Double.isFinite(photoLng) || distance > radiusM) {
                break;
            }
            if (kept.stream().anyMatch(point -> haversineMeters(photoLat, photoLng, point[0], point[1]) < KARTAVIEW_SPACING_M)) {
                continue;
            }
            String image = kartaviewImageUrl(firstText(
                    textOrEmpty(row.get("lth_name")),
                    textOrEmpty(row.get("name")),
                    textOrEmpty(row.get("th_name"))));
            String sequence = textOrEmpty(row.get("sequence_id"));
            String index = textOrEmpty(row.get("sequence_index"));
            if (!StringUtils.hasText(image) || !sequence.matches("\\d{1,12}") || !index.matches("\\d{1,8}")) {
                continue;
            }
            boolean pano = jsonDouble(row.get("field_of_view")) >= 300;
            int before = out.withArray("photos").size();
            rememberPhoto(
                    out, image, "https://kartaview.org/details/" + sequence + "/" + index,
                    "kartaview", pano, "", true);
            if (out.withArray("photos").size() > before) {
                kept.add(new double[] { photoLat, photoLng });
                added++;
            }
        }
    }

    private static double kartaviewDistance(double lat, double lng, JsonNode row) {
        double photoLat = jsonDouble(row.get("lat"));
        double photoLng = jsonDouble(row.get("lng"));
        if (!Double.isFinite(photoLat) || !Double.isFinite(photoLng)) {
            return Double.MAX_VALUE;
        }
        return haversineMeters(lat, lng, photoLat, photoLng);
    }

    /**
     * KartaView returns a storage path. The picture itself is on the CDN, which
     * wraps the storage URL. The storage host does not answer directly.
     */
    static String kartaviewImageUrl(String storagePath) {
        if (!StringUtils.hasText(storagePath)) {
            return "";
        }
        String path = storagePath.trim();
        Matcher matcher = Pattern.compile(
                "^(storage\\d+)/files/photo/(\\d{4}/\\d{1,2}/\\d{1,2}/(?:lth|proc|th)/[A-Za-z0-9_]+\\.jpe?g)$"
        ).matcher(path);
        if (!matcher.matches()) {
            return "";
        }
        String direct = "https://" + matcher.group(1) + ".openstreetcam.org/files/photo/" + matcher.group(2);
        String token = Base64.getEncoder().encodeToString(direct.getBytes(StandardCharsets.UTF_8)).replace("=", "");
        return "https://cdn.kartaview.org/pr:sharp/" + token;
    }

    /** West, south, east, north in EPSG:3857 metres, the box Camptocamp expects. */
    static String webMercatorBbox(double lat, double lng, double radiusM) {
        double pad = radiusM / Math.max(0.2, Math.cos(Math.toRadians(lat)));
        double x = lng / 180.0 * WEB_MERCATOR_M;
        double y = Math.log(Math.tan(Math.PI / 4.0 + Math.toRadians(lat) / 2.0)) / Math.PI * WEB_MERCATOR_M;
        return String.format(Locale.US, "%.1f,%.1f,%.1f,%.1f", x - pad, y - pad, x + pad, y + pad);
    }

    static double[] mercatorToLatLng(double x, double y) {
        double lng = x / WEB_MERCATOR_M * 180.0;
        double lat = Math.toDegrees(Math.atan(Math.sinh(y * Math.PI / WEB_MERCATOR_M)));
        return new double[] { lat, lng };
    }

    /**
     * Creative Commons photo indexed by Openverse, matched on the place name.
     * One request covers the French and English names. Dead-link checks stay off:
     * Openverse probes each file before answering and that holds the button.
     * A title that does not contain the place name is ignored.
     */
    private void fillFromOpenverse(ObjectNode out, String label, String english) {
        List<String> names = new ArrayList<>();
        addSearchName(names, label);
        addSearchName(names, english);
        if (names.isEmpty()) {
            return;
        }
        String query = String.join(" OR ", names);
        String url = "https://api.openverse.org/v1/images/?page_size=12&q=" + urlEncode(query);
        JsonNode raw = fetchPhotoJson(url, "openverse " + label);
        JsonNode results = raw == null ? null : raw.get("results");
        if (results == null || !results.isArray()) {
            return;
        }
        List<String> wanted = new ArrayList<>();
        for (String name : names) {
            wanted.add(fold(name));
        }
        int added = 0;
        for (JsonNode row : results) {
            String title = fold(textOrEmpty(row.get("title")));
            boolean matches = false;
            for (String name : wanted) {
                if (title.contains(name)) {
                    matches = true;
                    break;
                }
            }
            if (!matches) {
                continue;
            }
            String image = openverseImage(textOrEmpty(row.get("url")));
            if (!StringUtils.hasText(image)) {
                continue;
            }
            String page = textOrEmpty(row.get("foreign_landing_url"));
            int before = out.withArray("photos").size();
            rememberPhoto(out, image, page, "openverse");
            if (out.withArray("photos").size() > before) {
                added++;
            }
            if (added >= 6) {
                break;
            }
        }
    }

    /** The place after a leading road word, and the shortest “du / de la” tail that still names it. */
    static String corePlaceName(String name) {
        if (!StringUtils.hasText(name)) {
            return "";
        }
        String[] words = name.trim().split("\\s+");
        List<String> kept = new ArrayList<>();
        for (String word : words) {
            String token = fold(word);
            if (kept.isEmpty() && (token.isEmpty() || NAME_STOPWORDS.contains(token) || WAY_WORDS.contains(token))) {
                continue;
            }
            kept.add(word);
        }
        if (kept.isEmpty()) {
            return name.trim();
        }
        int bestFrom = 0;
        String bestFolded = fold(String.join(" ", kept));
        for (int i = 0; i < kept.size(); i++) {
            String token = fold(kept.get(i));
            if (!token.equals("de") && !token.equals("du") && !token.equals("des") && !token.equals("of") && !token.equals("d")) {
                continue;
            }
            int from = i + 1;
            if (token.equals("de") && from < kept.size()) {
                String next = fold(kept.get(from));
                if (next.equals("la") || next.equals("le") || next.equals("les") || next.equals("l")) {
                    from++;
                }
            }
            if (from >= kept.size()) {
                continue;
            }
            String tail = fold(String.join(" ", kept.subList(from, kept.size())));
            if (tail.length() >= 6 && tail.length() < bestFolded.length()) {
                bestFrom = from;
                bestFolded = tail;
            }
        }
        return String.join(" ", kept.subList(bestFrom, kept.size())).trim();
    }

    /** Query Openverse with the place, not the road designation in front of it. */
    private static void addSearchName(List<String> names, String raw) {
        String core = corePlaceName(raw);
        if (fold(core).length() < 4) {
            return;
        }
        for (String existing : names) {
            if (fold(existing).equals(fold(core))) {
                return;
            }
        }
        names.add(core);
    }

    /** Short generic names stay out of the automatic search. The button can still ask. */
    private static boolean specificPlaceName(String name) {
        return fold(name).length() >= 8 || fold(corePlaceName(name)).length() >= 8;
    }

    /**
     * Best Unsplash photo for the place name. The image stays on images.unsplash.com,
     * which is how Unsplash requires photos to be shown.
     */
    private void fillFromUnsplash(ObjectNode out, String label, String english) {
        if (!StringUtils.hasText(unsplashAccessKey)) {
            return;
        }
        if (searchUnsplash(out, label)) {
            return;
        }
        if (StringUtils.hasText(english) && !fold(english).equals(fold(label))) {
            searchUnsplash(out, english);
        }
    }

    private boolean searchUnsplash(ObjectNode out, String name) {
        if (fold(name).length() < 4) {
            return false;
        }
        String url = "https://api.unsplash.com/search/photos?per_page=6&content_filter=high&query=" + urlEncode(name);
        JsonNode raw = fetchUnsplash(url, name);
        JsonNode results = raw == null ? null : raw.get("results");
        if (results == null || !results.isArray() || results.isEmpty()) {
            return false;
        }
        int added = 0;
        for (JsonNode row : results) {
            if (applyUnsplashPhoto(out, row)) {
                added++;
            }
            if (added >= 6) {
                break;
            }
        }
        return added > 0;
    }

    private boolean applyUnsplashPhoto(ObjectNode out, JsonNode photo) {
        if (photo == null || !photo.isObject()) {
            return false;
        }
        String image = unsplashImage(textOrEmpty(photo.path("urls").path("regular")));
        if (!StringUtils.hasText(image)) {
            image = unsplashImage(textOrEmpty(photo.path("urls").path("small")));
        }
        if (!StringUtils.hasText(image)) {
            return false;
        }
        String page = textOrEmpty(photo.path("links").path("html"));
        if (page.startsWith("https://unsplash.com/") && !page.contains("utm_source=")) {
            page = page + (page.contains("?") ? "&" : "?") + "utm_source=pattool&utm_medium=referral";
        }
        int before = out.withArray("photos").size();
        rememberPhoto(out, image, page, "unsplash");
        if (out.withArray("photos").size() == before) {
            return false;
        }
        String download = textOrEmpty(photo.path("links").path("download_location"));
        if (download.startsWith("https://api.unsplash.com/photos/")) {
            fetchUnsplash(download, "download");
        }
        return true;
    }

    private static String unsplashImage(String url) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://")) {
            return "";
        }
        try {
            String host = URI.create(url).getHost();
            if (host != null && "images.unsplash.com".equals(host.toLowerCase(Locale.ROOT))) {
                return url;
            }
        } catch (IllegalArgumentException e) {
            return "";
        }
        return "";
    }

    private JsonNode fetchUnsplash(String url, String label) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            headers.set(HttpHeaders.AUTHORIZATION, "Client-ID " + unsplashAccessKey);
            ResponseEntity<String> response = photoRestTemplate.exchange(
                    URI.create(url),
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (RestClientException e) {
            log.warn("Unsplash unavailable for {}", label);
            return objectMapper.nullNode();
        } catch (Exception e) {
            log.warn("Unsplash parse failed for {}", label);
            return objectMapper.nullNode();
        }
    }

    private static String openverseImage(String url) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://") || url.contains("@")) {
            return "";
        }
        try {
            String host = URI.create(url).getHost();
            if (!StringUtils.hasText(host)) {
                return "";
            }
            host = host.toLowerCase(Locale.ROOT);
            if ("localhost".equals(host) || host.endsWith(".local") || host.chars().allMatch(ch -> Character.isDigit(ch) || ch == '.')) {
                return "";
            }
            return url;
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    /**
     * Public Flickr photo whose title matches the place name, within the search radius.
     * A geotagged photo with an unrelated title is ignored.
     */
    private void fillFromFlickr(ObjectNode out, String label, String english, double lat, double lng, double radiusM) {
        if (!StringUtils.hasText(flickrApiKey)) {
            return;
        }
        if (searchFlickr(out, label, lat, lng, radiusM)) {
            return;
        }
        if (StringUtils.hasText(english) && !fold(english).equals(fold(label))) {
            searchFlickr(out, english, lat, lng, radiusM);
        }
    }

    private boolean searchFlickr(ObjectNode out, String name, double lat, double lng, double radiusM) {
        if (!StringUtils.hasText(name)) {
            return false;
        }
        String url = "https://www.flickr.com/services/rest/?method=flickr.photos.search"
                + "&api_key=" + urlEncode(flickrApiKey)
                + "&format=json&nojsoncallback=1"
                + "&content_type=1&media=photos&safe_search=1&privacy_filter=1"
                + "&sort=relevance&per_page=8"
                + "&lat=" + String.format(Locale.US, "%.6f", lat)
                + "&lon=" + String.format(Locale.US, "%.6f", lng)
                + "&radius=" + String.format(Locale.US, "%.3f", radiusM / 1000.0) + "&radius_units=km"
                + "&text=" + urlEncode(name)
                + "&extras=url_l,url_c,url_z";
        JsonNode raw = fetchFlickr(url, name);
        JsonNode photos = raw == null ? null : raw.path("photos").path("photo");
        if (photos == null || !photos.isArray()) {
            return false;
        }
        String wanted = fold(name);
        for (JsonNode photo : photos) {
            String title = textOrEmpty(photo.get("title"));
            String folded = fold(title);
            boolean named = samePlace(name, title, 0) || (wanted.length() >= 4 && folded.contains(wanted));
            if (!named) {
                continue;
            }
            if (applyFlickrPhoto(out, photo)) {
                return true;
            }
        }
        return false;
    }

    /** OSM tag {@code flickr} is a photo page. The image itself comes from the API. */
    private boolean applyFlickrTag(ObjectNode out, String tag) {
        if (!StringUtils.hasText(flickrApiKey) || !StringUtils.hasText(tag)) {
            return false;
        }
        Matcher matcher = Pattern.compile("flickr\\.com/photos/[^/\\s]+/(\\d{5,20})").matcher(tag);
        if (!matcher.find()) {
            return false;
        }
        String photoId = matcher.group(1);
        String url = "https://www.flickr.com/services/rest/?method=flickr.photos.getSizes"
                + "&api_key=" + urlEncode(flickrApiKey)
                + "&format=json&nojsoncallback=1"
                + "&photo_id=" + photoId;
        JsonNode raw = fetchFlickr(url, photoId);
        JsonNode sizes = raw == null ? null : raw.path("sizes").path("size");
        if (sizes == null || !sizes.isArray()) {
            return false;
        }
        String image = "";
        String page = "";
        for (String wanted : List.of("Large 1024", "Large", "Medium 800", "Medium")) {
            for (JsonNode size : sizes) {
                if (!wanted.equals(textOrEmpty(size.get("label"))) || !flickrImageHost(textOrEmpty(size.get("source")))) {
                    continue;
                }
                image = textOrEmpty(size.get("source"));
                String candidate = textOrEmpty(size.get("url"));
                if (candidate.startsWith("https://www.flickr.com/photos/")) {
                    page = candidate;
                }
                break;
            }
            if (StringUtils.hasText(image)) {
                break;
            }
        }
        if (!StringUtils.hasText(image)) {
            return false;
        }
        out.put("imageUrl", image);
        out.put("pageUrl", StringUtils.hasText(page) ? page : "https://www.flickr.com/photos/" + photoId);
        out.put("source", "flickr");
        return true;
    }

    private boolean applyFlickrPhoto(ObjectNode out, JsonNode photo) {
        if (photo == null || !photo.isObject()) {
            return false;
        }
        String id = textOrEmpty(photo.get("id"));
        String owner = textOrEmpty(photo.get("owner"));
        if (!id.matches("\\d{5,20}") || !owner.matches("[A-Za-z0-9@]+")) {
            return false;
        }
        String image = firstText(
                flickrImage(textOrEmpty(photo.get("url_l"))),
                flickrImage(textOrEmpty(photo.get("url_c"))),
                flickrImage(textOrEmpty(photo.get("url_z"))));
        if (!StringUtils.hasText(image)) {
            String server = textOrEmpty(photo.get("server"));
            String secret = textOrEmpty(photo.get("secret"));
            if (server.matches("\\d{1,12}") && secret.matches("[A-Za-z0-9]+")) {
                image = flickrImage("https://live.staticflickr.com/" + server + "/" + id + "_" + secret + "_b.jpg");
            }
        }
        if (!StringUtils.hasText(image)) {
            return false;
        }
        out.put("imageUrl", image);
        out.put("pageUrl", "https://www.flickr.com/photos/" + owner + "/" + id);
        out.put("source", "flickr");
        return true;
    }

    private static String flickrImage(String url) {
        return flickrImageHost(url) ? url : "";
    }

    private static boolean flickrImageHost(String url) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://")) {
            return false;
        }
        try {
            String host = URI.create(url).getHost();
            if (!StringUtils.hasText(host)) {
                return false;
            }
            host = host.toLowerCase(Locale.ROOT);
            return "staticflickr.com".equals(host) || host.endsWith(".staticflickr.com");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private JsonNode fetchFlickr(String url, String label) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = photoRestTemplate.exchange(
                    URI.create(url),
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return objectMapper.nullNode();
            }
            JsonNode tree = objectMapper.readTree(body);
            if (!"ok".equals(textOrEmpty(tree.get("stat")))) {
                return objectMapper.nullNode();
            }
            return tree;
        } catch (RestClientException e) {
            log.warn("Flickr unavailable for {}", label);
            return objectMapper.nullNode();
        } catch (Exception e) {
            log.warn("Flickr parse failed for {}", label);
            return objectMapper.nullNode();
        }
    }

    /**
     * Street-level photo within the search radius. Mapillary rejects a
     * radius above 50 m, so the search is a bounding box. One kilometre stays
     * under the 0.01 square-degree box limit. The place name only chooses the point.
     */
    private void fillFromMapillary(ObjectNode out, double lat, double lng, double radiusM) {
        if (!StringUtils.hasText(mapillaryToken)) {
            return;
        }
        double dLat = radiusM / 111_320.0;
        double dLng = dLat / Math.max(0.2, Math.cos(Math.toRadians(lat)));
        int cap = widePhotoCap(radiusM, 6, 18);
        int fetch = radiusM <= PHOTO_RADIUS_M ? cap : Math.min(100, Math.max(cap * 3, (int) Math.round(radiusM / 12.0)));
        String url = String.format(Locale.US,
                "https://graph.mapillary.com/images?fields=id,thumb_1024_url,thumb_2048_url,is_pano,computed_geometry"
                        + "&bbox=%.6f,%.6f,%.6f,%.6f&limit=%d",
                lng - dLng, lat - dLat, lng + dLng, lat + dLat, fetch);
        JsonNode raw = fetchMapillary(url, "bbox");
        JsonNode data = raw == null ? null : raw.get("data");
        if (data == null || !data.isArray() || data.isEmpty()) {
            return;
        }
        List<JsonNode> rows = new ArrayList<>();
        data.forEach(rows::add);
        rows.sort(Comparator.comparingDouble(row -> {
            JsonNode coords = row.path("computed_geometry").path("coordinates");
            if (!coords.isArray() || coords.size() < 2) {
                return radiusM;
            }
            return mapillaryDistance(lat, lng, row);
        }));
        int added = 0;
        for (JsonNode row : rows) {
            double distance = mapillaryDistance(lat, lng, row);
            if (distance > radiusM) {
                break;
            }
            int before = out.withArray("photos").size();
            applyMapillaryImage(out, row);
            if (out.withArray("photos").size() > before && ++added >= cap) {
                break;
            }
        }
    }

    /** OSM tag {@code mapillary} stores the image id linked to that place. */
    private boolean applyMapillaryId(ObjectNode out, String imageId) {
        if (!StringUtils.hasText(mapillaryToken) || imageId == null || !imageId.trim().matches("\\d{5,30}")) {
            return false;
        }
        String url = "https://graph.mapillary.com/" + imageId.trim() + "?fields=id,thumb_1024_url,thumb_2048_url,is_pano";
        JsonNode image = fetchMapillary(url, imageId.trim());
        if (image == null || !image.isObject() || image.has("error")) {
            return false;
        }
        applyMapillaryImage(out, image);
        return StringUtils.hasText(out.path("imageUrl").asText());
    }

    /** A missing position stays, because the bounding box already limits the query. */
    private static double mapillaryDistance(double lat, double lng, JsonNode image) {
        JsonNode coords = image.path("computed_geometry").path("coordinates");
        if (!coords.isArray() || coords.size() < 2) {
            return 0;
        }
        return haversineMeters(lat, lng, coords.get(1).asDouble(), coords.get(0).asDouble());
    }

    private void applyMapillaryImage(ObjectNode out, JsonNode image) {
        if (image == null || !image.isObject()) {
            return;
        }
        String id = textOrEmpty(image.get("id"));
        boolean pano = image.path("is_pano").asBoolean(false);
        String thumb = textOrEmpty(image.get("thumb_1024_url"));
        if (pano) {
            String large = textOrEmpty(image.get("thumb_2048_url"));
            if (large.startsWith("https://")) {
                thumb = large;
            }
        }
        if (!id.matches("\\d{5,30}") || !thumb.startsWith("https://")) {
            return;
        }
        rememberPhoto(out, thumb, "https://www.mapillary.com/app/?focus=photo&pKey=" + id, "mapillary", pano);
    }

    /**
     * Same-origin bytes for a Mapillary or Panoramax picture. The browser cannot
     * read the CDN image into a canvas, so the 360° viewer asks the API for it.
     */
    public ResponseEntity<byte[]> fetchPublicImage(String url) {
        if (!proxiedPanoHost(url)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "image_host");
        }
        String current = url.trim();
        try {
            for (int hop = 0; hop < 3; hop++) {
                HttpURLConnection conn = (HttpURLConnection) URI.create(current).toURL().openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(12000);
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setRequestProperty("Accept", "image/*,*/*");
                int status = conn.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (!StringUtils.hasText(location)) {
                        break;
                    }
                    current = URI.create(current).resolve(location).toString();
                    // Panoramax answers on its API host, then redirects the JPEG to object storage.
                    if (!current.startsWith("https://") || !SsrfGuard.isPublicHttpUrl(current)) {
                        break;
                    }
                    continue;
                }
                if (status != 200) {
                    conn.disconnect();
                    break;
                }
                String contentType = conn.getContentType() == null ? "" : conn.getContentType();
                int semicolon = contentType.indexOf(';');
                if (semicolon >= 0) {
                    contentType = contentType.substring(0, semicolon).trim();
                }
                byte[] bytes;
                try (InputStream input = conn.getInputStream()) {
                    bytes = input.readNBytes(8_000_001);
                } finally {
                    conn.disconnect();
                }
                if (bytes.length < 32 || bytes.length > 8_000_000 || !contentType.startsWith("image/")) {
                    break;
                }
                MediaType type = MediaType.IMAGE_JPEG;
                try {
                    type = MediaType.parseMediaType(contentType);
                } catch (Exception ignored) {
                    type = MediaType.IMAGE_JPEG;
                }
                return ResponseEntity.ok()
                        .contentType(type)
                        .cacheControl(CacheControl.maxAge(Duration.ofHours(1)))
                        .body(bytes);
            }
        } catch (IOException | IllegalArgumentException e) {
            log.warn("360 photo download failed");
        }
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "image_download");
    }

    private static boolean proxiedPanoHost(String url) {
        return mapillaryThumbHost(url) || panoramaxImageHost(url);
    }

    private static boolean mapillaryThumbHost(String url) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://")) {
            return false;
        }
        try {
            String host = URI.create(url.trim()).getHost();
            if (!StringUtils.hasText(host)) {
                return false;
            }
            host = host.toLowerCase(Locale.ROOT);
            return "mapillary.com".equals(host) || host.endsWith(".mapillary.com") || host.endsWith(".fbcdn.net");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private JsonNode fetchMapillary(String url, String label) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.AUTHORIZATION, "OAuth " + mapillaryToken);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = photoRestTemplate.exchange(
                    URI.create(url),
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (RestClientException e) {
            log.warn("Mapillary unavailable for {}: {}", label, e.getMessage());
            return objectMapper.nullNode();
        } catch (Exception e) {
            log.warn("Mapillary parse failed for {}: {}", label, e.getMessage());
            return objectMapper.nullNode();
        }
    }

    private boolean applyCommonsTag(ObjectNode out, String tag, String label, String english) {
        if (!StringUtils.hasText(tag)) {
            return false;
        }
        String value = tag.trim();
        if (value.regionMatches(true, 0, "category:", 0, 9)) {
            return applyCommonsCategory(out, value, label, english);
        }
        String filename = value;
        int file = value.toLowerCase(Locale.ROOT).indexOf("file:");
        if (file >= 0) {
            filename = value.substring(file + 5).trim();
        }
        applyCommonsFile(out, "File:" + filename);
        return StringUtils.hasText(out.path("imageUrl").asText());
    }

    private boolean applyCommonsCategory(ObjectNode out, String category, String label, String english) {
        String title = category.regionMatches(true, 0, "category:", 0, 9) ? category : "Category:" + category;
        String url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=categorymembers"
                + "&cmtype=file&cmlimit=12&cmtitle=" + urlEncode(title.replace(' ', '_'));
        JsonNode raw = fetchPhotoJson(url, "commons cat " + title);
        JsonNode members = raw == null ? null : raw.path("query").path("categorymembers");
        if (members == null || !members.isArray()) {
            return false;
        }
        List<String> named = new ArrayList<>();
        List<String> other = new ArrayList<>();
        for (JsonNode member : members) {
            String file = textOrEmpty(member.get("title"));
            if (!file.toLowerCase(Locale.ROOT).startsWith("file:") || !COMMONS_IMAGE.matcher(file).find()) {
                continue;
            }
            if (samePlace(label, file, 0) || samePlace(english, file, 0)) {
                named.add(file);
            } else {
                other.add(file);
            }
        }
        List<String> chosen = new ArrayList<>(named);
        chosen.addAll(other);
        if (chosen.isEmpty()) {
            return false;
        }
        int added = 0;
        for (String file : chosen) {
            int before = out.withArray("photos").size();
            applyCommonsFile(out, file);
            if (out.withArray("photos").size() > before) {
                added++;
            }
            if (added >= 6) {
                break;
            }
        }
        return added > 0;
    }

    private void applyCommonsFile(ObjectNode out, String fileTitle) {
        applyCommonsFile(out, fileTitle, false);
    }

    private void applyCommonsFile(ObjectNode out, String fileTitle, boolean nearby) {
        String filename = fileTitle;
        if (filename.regionMatches(true, 0, "file:", 0, 5)) {
            filename = filename.substring(5).trim();
        }
        String image = commonsThumbnailUrl(filename, 960);
        String page = commonsFilePageUrl(filename);
        rememberPhoto(out, image, page, "commons", false, nearby ? commonsCaption(fileTitle) : "", nearby);
    }

    static String commonsCaption(String fileTitle) {
        String name = fileTitle == null ? "" : fileTitle.trim();
        if (name.regionMatches(true, 0, "file:", 0, 5)) {
            name = name.substring(5).trim();
        }
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            name = name.substring(0, dot);
        }
        return name.replace('_', ' ').replaceAll("\\s+", " ").trim();
    }

    private void fillFromWikidata(ObjectNode out, String qid, String lang, String label, String only) {
        String url = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json"
                + "&props=claims|labels|sitelinks&ids=" + qid
                + "&languages=" + lang + "|en|fr"
                + "&sitefilter=" + lang + "wiki|enwiki|frwiki";
        JsonNode raw = fetchJson(url, qid, lang);
        JsonNode entity = raw == null ? null : raw.path("entities").path(qid);
        if (entity == null || !entity.isObject() || entity.has("missing")) {
            return;
        }
        String titled = firstText(
                textOrEmpty(entity.path("labels").path(lang).path("value")),
                textOrEmpty(entity.path("labels").path("en").path("value")),
                textOrEmpty(entity.path("labels").path("fr").path("value")),
                label
        );
        if (StringUtils.hasText(titled)) {
            out.put("title", titled);
        }
        if (allows(only, "wikidata")) {
            for (String filename : claimFilenames(entity.path("claims").path("P18"), 6)) {
                rememberPhoto(out, commonsThumbnailUrl(filename, 960), commonsFilePageUrl(filename), "wikidata");
            }
            if (StringUtils.hasText(out.path("imageUrl").asText())) {
                return;
            }
        }
        if (!allows(only, "wikipedia")) {
            return;
        }
        String article = firstText(
                textOrEmpty(entity.path("sitelinks").path(lang + "wiki").path("title")),
                textOrEmpty(entity.path("sitelinks").path("enwiki").path("title")),
                textOrEmpty(entity.path("sitelinks").path("frwiki").path("title"))
        );
        if (!StringUtils.hasText(article)) {
            return;
        }
        String articleLang = entity.path("sitelinks").path(lang + "wiki").path("title").isTextual()
                ? lang
                : entity.path("sitelinks").path("enwiki").path("title").isTextual() ? "en" : "fr";
        applyArticleImage(out, fetchOne(article.replace(' ', '_'), articleLang), titled);
    }

    private void fillFromMatchingArticle(ObjectNode out, String label, String lang) {
        if (!StringUtils.hasText(label) || !SAFE_TITLE.matcher(label).matches()) {
            return;
        }
        JsonNode summary = fetchOne(label, lang);
        if (!titleMatches(label, textOrEmpty(summary == null ? null : summary.get("title")))) {
            return;
        }
        applyArticleImage(out, summary, label);
    }

    private void applyArticleImage(ObjectNode out, JsonNode summary, String fallbackTitle) {
        if (!isUsable(summary)) {
            return;
        }
        String image = safeImageUrl(firstText(
                textOrEmpty(summary.path("originalimage").path("source")),
                textOrEmpty(summary.path("thumbnail").path("source"))
        ));
        if (!StringUtils.hasText(image)) {
            return;
        }
        String page = safePageUrl(textOrEmpty(summary.path("content_urls").path("desktop").path("page")));
        String title = firstText(textOrEmpty(summary.get("title")), fallbackTitle);
        if (StringUtils.hasText(title)) {
            out.put("title", title);
        }
        out.put("imageUrl", image);
        out.put("source", "wikipedia");
        if (StringUtils.hasText(page)) {
            out.put("pageUrl", page);
        }
    }

    private static List<String> claimFilenames(JsonNode claims, int limit) {
        List<String> preferred = new ArrayList<>();
        List<String> normal = new ArrayList<>();
        if (claims != null && claims.isArray()) {
            for (JsonNode claim : claims) {
                if (claim == null || !claim.isObject()) {
                    continue;
                }
                if ("deprecated".equals(textOrEmpty(claim.get("rank")))) {
                    continue;
                }
                JsonNode value = claim.path("mainsnak").path("datavalue").path("value");
                if (!value.isTextual() || !StringUtils.hasText(value.asText())) {
                    continue;
                }
                String filename = value.asText().trim();
                if ("preferred".equals(textOrEmpty(claim.get("rank")))) {
                    preferred.add(filename);
                } else {
                    normal.add(filename);
                }
            }
        }
        List<String> all = new ArrayList<>(preferred);
        all.addAll(normal);
        return all.size() > limit ? all.subList(0, limit) : all;
    }

    static String normalizeWikidataId(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        Matcher matcher = WIKIDATA_ID.matcher(raw.toUpperCase(Locale.ROOT));
        return matcher.find() ? matcher.group() : "";
    }

    static String commonsThumbnailUrl(String filename, int width) {
        String encoded = encodeCommonsFile(filename);
        if (!StringUtils.hasText(encoded)) {
            return "";
        }
        int px = Math.max(120, Math.min(1280, width));
        return "https://commons.wikimedia.org/wiki/Special:FilePath/" + encoded + "?width=" + px;
    }

    static String commonsFilePageUrl(String filename) {
        String encoded = encodeCommonsFile(filename);
        if (!StringUtils.hasText(encoded)) {
            return "";
        }
        return "https://commons.wikimedia.org/wiki/File:" + encoded;
    }

    private static boolean isCoord(Double lat, Double lng) {
        return lat != null && lng != null
                && lat >= -90 && lat <= 90
                && lng >= -180 && lng <= 180
                && !(lat == 0 && lng == 0);
    }

    private static double distanceMeters(double lat, double lng, JsonNode hit) {
        double hitLat = hit.path("lat").asDouble(Double.NaN);
        double hitLng = hit.path("lon").asDouble(Double.NaN);
        if (!Double.isFinite(hitLat)) {
            try {
                hitLat = Double.parseDouble(textOrEmpty(hit.get("lat")));
                hitLng = Double.parseDouble(textOrEmpty(hit.get("lon")));
            } catch (NumberFormatException e) {
                return Double.MAX_VALUE;
            }
        }
        if (!Double.isFinite(hitLat) || !Double.isFinite(hitLng)) {
            return Double.MAX_VALUE;
        }
        return haversineMeters(lat, lng, hitLat, hitLng);
    }

    private static boolean skipOsmClass(String category, double meters, boolean exactName) {
        String kind = category == null ? "" : category.toLowerCase(Locale.ROOT);
        if (kind.equals("highway") || kind.equals("railway") || kind.equals("waterway") || kind.equals("boundary")) {
            return !(exactName && meters < 40);
        }
        return kind.equals("place") && !(exactName && meters < 40);
    }

    private static String osmImageUrl(String raw) {
        if (!StringUtils.hasText(raw) || !raw.startsWith("https://") || !COMMONS_IMAGE.matcher(raw).find()) {
            return "";
        }
        String known = safeImageUrl(raw);
        if (StringUtils.hasText(known)) {
            return known;
        }
        try {
            String host = URI.create(raw).getHost();
            return StringUtils.hasText(host) ? raw : "";
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static List<String> distinctiveTokens(String place) {
        List<String> tokens = new ArrayList<>();
        for (String token : fold(place).split(" ")) {
            if (token.length() >= 3 && !NAME_STOPWORDS.contains(token)) {
                tokens.add(token);
            }
        }
        return tokens;
    }

    /** A photograph, not a locator map, a coat of arms or a diagram. */
    static boolean scenicCommonsFile(String title) {
        String folded = fold(title);
        if (!folded.endsWith(" jpg") && !folded.endsWith(" jpeg") && !folded.endsWith(" png")
                && !folded.endsWith(" webp") && !folded.endsWith(" gif")) {
            return false;
        }
        return !folded.contains("locator")
                && !folded.contains("location map")
                && !folded.contains("carte de")
                && !folded.contains("plan de")
                && !folded.contains("blason")
                && !folded.contains("coat of arms")
                && !folded.contains("drapeau")
                && !folded.contains("flag of")
                && !folded.contains("logo")
                && !folded.contains("diagram");
    }

    static boolean samePlace(String place, String candidate, double meters) {
        if (!StringUtils.hasText(place) || !StringUtils.hasText(candidate)) {
            return false;
        }
        if (fold(place).equals(fold(candidate))) {
            return true;
        }
        List<String> tokens = distinctiveTokens(place);
        if (tokens.isEmpty()) {
            return false;
        }
        List<String> candidateTokens = distinctiveTokens(candidate);
        int hits = 0;
        String longHit = "";
        for (String token : tokens) {
            if (!candidateTokens.contains(token)) {
                continue;
            }
            hits++;
            if (token.length() >= 5) {
                longHit = token;
            }
        }
        if (hits == 0) {
            return false;
        }
        if (hits == tokens.size() || (tokens.size() >= 2 && hits >= 2)) {
            return true;
        }
        if (!StringUtils.hasText(longHit) || meters > 80) {
            return false;
        }
        for (String extra : candidateTokens) {
            if (!tokens.contains(extra)) {
                return false;
            }
        }
        return true;
    }

    static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double r = 6_371_000.0;
        double p1 = Math.toRadians(lat1);
        double p2 = Math.toRadians(lat2);
        double dp = Math.toRadians(lat2 - lat1);
        double dl = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2)
                + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** {@code fr:Title} or a Wikipedia URL. Returns language then title, or null. */
    static String[] parseWikipediaTag(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String value = raw.trim();
        Matcher url = Pattern.compile("https?://([a-z]{2,3})\\.wikipedia\\.org/wiki/([^\\s#]+)").matcher(value);
        if (url.find()) {
            String lang = url.group(1).toLowerCase(Locale.ROOT);
            String title = url.group(2).replace('_', ' ');
            return SAFE_LANGS.contains(lang) && StringUtils.hasText(title) ? new String[] { lang, title } : null;
        }
        int colon = value.indexOf(':');
        if (colon < 2 || colon > 3) {
            return null;
        }
        String lang = value.substring(0, colon).toLowerCase(Locale.ROOT);
        String title = value.substring(colon + 1).trim();
        if (!SAFE_LANGS.contains(lang) || !StringUtils.hasText(title)) {
            return null;
        }
        return new String[] { lang, title };
    }

    static boolean titleMatches(String query, String title) {
        String left = fold(query);
        String right = fold(title);
        if (left.isEmpty() || right.isEmpty()) {
            return false;
        }
        if (left.equals(right)) {
            return true;
        }
        int shorter = Math.min(left.length(), right.length());
        if (shorter < 8) {
            return false;
        }
        return left.contains(right) || right.contains(left);
    }

    private static String encodeCommonsFile(String filename) {
        if (!StringUtils.hasText(filename)) {
            return "";
        }
        String clean = filename.trim();
        if (clean.regionMatches(true, 0, "file:", 0, 5)) {
            clean = clean.substring(5).trim();
        }
        if (clean.length() > 240 || clean.contains("/") || clean.contains("\\") || clean.contains("..")
                || clean.startsWith("http:") || clean.startsWith("https:")
                || !COMMONS_IMAGE.matcher(clean).find()) {
            return "";
        }
        return URLEncoder.encode(clean.replace(' ', '_'), StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String clipTitle(String value) {
        if (!StringUtils.hasText(value)) {
            return "";
        }
        String trimmed = value.trim().replace('\n', ' ');
        return trimmed.length() > 160 ? trimmed.substring(0, 160) : trimmed;
    }

    private static String firstText(String... values) {
        if (values == null) {
            return "";
        }
        for (String value : values) {
            if (StringUtils.hasText(value)) {
                return value.trim();
            }
        }
        return "";
    }

    private static String fold(String value) {
        if (!StringUtils.hasText(value)) {
            return "";
        }
        String decomposed = Normalizer.normalize(value, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        return decomposed.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim();
    }

    private static String safeImageUrl(String url) {
        return hostAllowed(url, true) ? url : "";
    }

    private static String safePageUrl(String url) {
        return hostAllowed(url, false) ? url : "";
    }

    private static boolean hostAllowed(String url, boolean image) {
        if (!StringUtils.hasText(url) || !url.startsWith("https://")) {
            return false;
        }
        try {
            String host = URI.create(url).getHost();
            if (!StringUtils.hasText(host)) {
                return false;
            }
            host = host.toLowerCase(Locale.ROOT);
            if ("upload.wikimedia.org".equals(host) || "commons.wikimedia.org".equals(host)
                    || "thumb.wikimedia.org".equals(host)) {
                return true;
            }
            if (image && (host.endsWith(".wikimedia.org")
                    || host.endsWith(".wikipedia.org") || "wikipedia.org".equals(host))) {
                return true;
            }
            return !image && (host.endsWith(".wikipedia.org") || "wikipedia.org".equals(host)
                    || host.endsWith(".wikimedia.org"));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private JsonNode fetchOne(String title, String code) {
        String encoded = encodeTitle(title);
        String url = "https://" + code + ".wikipedia.org/api/rest_v1/page/summary/" + encoded;
        return fetchJson(url, title, code);
    }

    /**
     * RestTemplate.exchange(String) re-encodes the URL. Titles with parentheses or
     * accents then become {@code %2528} / {@code %25C3} and Wikipedia REST answers
     * {@code 403 {"type":"Internal error"}}. Pass a prebuilt {@link URI} instead.
     */
    private JsonNode fetchPhotoJson(String url, String label) {
        return fetchJson(url, label, "photo", photoRestTemplate);
    }

    /** Form POST used by KartaView. A missing picture is an empty body, not an error page. */
    private JsonNode postPhotoForm(String url, MultiValueMap<String, String> form, String label) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
            ResponseEntity<String> response = photoRestTemplate.exchange(
                    URI.create(url),
                    HttpMethod.POST,
                    new HttpEntity<>(form, headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (RestClientException e) {
            log.warn("Photo search unavailable for {}", label);
            return objectMapper.nullNode();
        } catch (Exception e) {
            log.warn("Photo search parse failed for {}", label);
            return objectMapper.nullNode();
        }
    }

    private JsonNode fetchJson(String url, String label, String code) {
        return fetchJson(url, label, code, restTemplate);
    }

    private JsonNode fetchJson(String url, String label, String code, RestTemplate client) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set("Api-User-Agent", USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = client.exchange(
                    URI.create(url.replace("|", "%7C")),
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            if (isExpectedMiss(e)) {
                log.debug("Wikipedia page missing for {} ({}): {}", label, code, e.getStatusCode());
                return objectMapper.nullNode();
            }
            log.warn("Wikipedia HTTP {} for {} ({})", e.getStatusCode().value(), label, code);
            return objectMapper.nullNode();
        } catch (RestClientException e) {
            log.warn("Wikipedia unavailable for {} ({})", label, code);
            return objectMapper.nullNode();
        } catch (Exception e) {
            log.warn("Wikipedia parse failed for {} ({})", label, code);
            return objectMapper.nullNode();
        }
    }

    private JsonNode fetchViaLanglink(String title, String fromLang, String toLang) {
        String resolved = resolveLangTitle(title, fromLang, toLang);
        if (!StringUtils.hasText(resolved)) {
            return objectMapper.nullNode();
        }
        return fetchOne(resolved, toLang);
    }

    private String resolveLangTitle(String title, String fromLang, String toLang) {
        if (!StringUtils.hasText(title) || !StringUtils.hasText(fromLang) || !StringUtils.hasText(toLang)
                || fromLang.equals(toLang)) {
            return "";
        }
        String url = "https://" + fromLang + ".wikipedia.org/w/api.php?action=query&format=json&formatversion=2"
                + "&redirects=1&prop=langlinks&lllang=" + toLang + "&titles=" + encodeTitle(title);
        JsonNode raw = fetchJson(url, "langlinks " + title, fromLang);
        if (raw == null || !raw.isObject()) {
            return "";
        }
        JsonNode pages = raw.path("query").path("pages");
        if (!pages.isArray() || pages.isEmpty()) {
            return "";
        }
        JsonNode page = pages.get(0);
        if (page == null || page.path("missing").asBoolean(false)) {
            return "";
        }
        JsonNode links = page.get("langlinks");
        if (links == null || !links.isArray()) {
            return "";
        }
        for (JsonNode link : links) {
            if (link != null && toLang.equals(textOrEmpty(link.get("lang")))) {
                String resolved = textOrEmpty(link.get("title")).replace(' ', '_');
                if (StringUtils.hasText(resolved)) {
                    return resolved;
                }
            }
        }
        return "";
    }

    private JsonNode mapSearch(String query, String lang, JsonNode raw) {
        var root = objectMapper.createObjectNode();
        root.put("query", query);
        root.put("lang", lang);
        var pages = objectMapper.createArrayNode();
        root.set("pages", pages);
        if (raw == null || !raw.isObject()) {
            return root;
        }
        JsonNode list = raw.get("pages");
        if (list == null || !list.isArray()) {
            return root;
        }
        for (JsonNode page : list) {
            if (page == null || !page.isObject()) {
                continue;
            }
            var item = objectMapper.createObjectNode();
            if (page.has("id") && page.get("id").canConvertToInt()) {
                item.put("id", page.get("id").asInt());
            }
            putText(item, "key", page.get("key"));
            putText(item, "title", page.get("title"));
            item.put("excerpt", stripHtml(textOrEmpty(page.get("excerpt"))));
            putText(item, "description", page.get("description"));
            String thumb = thumbnailUrl(page.get("thumbnail"));
            if (StringUtils.hasText(thumb)) {
                item.put("thumbnailUrl", thumb);
            }
            if (item.has("title") || item.has("key")) {
                pages.add(item);
            }
        }
        return root;
    }

    private JsonNode emptySearch(String query, String lang) {
        var root = objectMapper.createObjectNode();
        root.put("query", query);
        root.put("lang", lang);
        root.set("pages", objectMapper.createArrayNode());
        return root;
    }

    private static void putText(ObjectNode target, String field, JsonNode node) {
        String value = textOrEmpty(node);
        if (StringUtils.hasText(value)) {
            target.put(field, value);
        }
    }

    private static String textOrEmpty(JsonNode node) {
        return node != null && node.isTextual() ? node.asText() : "";
    }

    private static String stripHtml(String html) {
        if (!StringUtils.hasText(html)) {
            return "";
        }
        return HTML_TAG.matcher(html)
                .replaceAll("")
                .replace("&quot;", "\"")
                .replace("&#039;", "'")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&nbsp;", " ")
                .trim();
    }

    private static String thumbnailUrl(JsonNode thumbnail) {
        if (thumbnail == null || !thumbnail.isObject()) {
            return "";
        }
        String url = textOrEmpty(thumbnail.get("url"));
        if (!StringUtils.hasText(url)) {
            url = textOrEmpty(thumbnail.get("source"));
        }
        if (url.startsWith("//")) {
            return "https:" + url;
        }
        return url;
    }

    private static int clampLimit(Integer limit) {
        if (limit == null) {
            return DEFAULT_SEARCH_LIMIT;
        }
        return Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit));
    }

    private static String encodeTitle(String title) {
        return URLEncoder.encode(title.replace(' ', '_'), StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static boolean isExpectedMiss(HttpStatusCodeException e) {
        if (e.getStatusCode().isSameCodeAs(HttpStatus.NOT_FOUND)) {
            return true;
        }
        if (!e.getStatusCode().isSameCodeAs(HttpStatus.FORBIDDEN)) {
            return false;
        }
        String body = e.getResponseBodyAsString();
        return StringUtils.hasText(body) && body.contains("\"type\":\"Internal error\"");
    }

    private static boolean isUsable(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode() || !node.isObject() || node.isEmpty()) {
            return false;
        }
        if ("disambiguation".equalsIgnoreCase(textOrEmpty(node.get("type")))) {
            return false;
        }
        JsonNode extract = node.get("extract");
        JsonNode description = node.get("description");
        JsonNode title = node.get("title");
        return (extract != null && extract.isTextual() && StringUtils.hasText(extract.asText()))
                || (description != null && description.isTextual() && StringUtils.hasText(description.asText()))
                || (title != null && title.isTextual() && StringUtils.hasText(title.asText()));
    }

    private static String normalizeLang(String lang) {
        if (!StringUtils.hasText(lang)) {
            return "fr";
        }
        String code = lang.trim().toLowerCase(Locale.ROOT);
        if (code.startsWith("jp")) {
            code = "ja";
        } else if (code.startsWith("cn")) {
            code = "zh";
        } else if (code.startsWith("in")) {
            code = "hi";
        }
        if (code.length() > 2) {
            code = code.substring(0, 2);
        }
        return SAFE_LANGS.contains(code) ? code : "en";
    }
}
