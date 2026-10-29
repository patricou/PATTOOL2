package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AudioDbAlbumDto;
import com.pat.controller.dto.AudioDbArtistDto;
import com.pat.controller.dto.AudioDbDossierDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Public TheAudioDB catalog (free key {@code 123}). Biographies and album
 * descriptions are not part of the Deezer API. Calls stay on the server.
 */
@Service
public class AudioDbCatalogService {

    private static final Logger log = LoggerFactory.getLogger(AudioDbCatalogService.class);

    /** Documented public test key. About 30 requests per minute. */
    private static final String API = "https://www.theaudiodb.com/api/v1/json/123/";
    private static final String USER_AGENT = "PatTool/1.0 (audiodb helper; https://www.patrickdeschamps.com)";
    private static final Duration TIMEOUT = Duration.ofSeconds(8);
    private static final long HIT_TTL_MS = Duration.ofHours(12).toMillis();
    private static final long MISS_TTL_MS = Duration.ofMinutes(10).toMillis();
    private static final long PACE_MS = 1_100;
    private static final int MAX_CACHE = 200;
    private static final int MAX_BODY = 1_500_000;
    private static final int MAX_PROSE = 6_000;
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(TIMEOUT)
            .build();
    private final ConcurrentHashMap<String, Cached> cache = new ConcurrentHashMap<>();
    private final Object paceLock = new Object();
    private long nextAllowedAt;

    public AudioDbCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** TheAudioDB rejected or missed the call. A missing artist is an empty dossier, not this. */
    public static class UpstreamException extends RuntimeException {
        public UpstreamException() {
            super("audiodb");
        }
    }

    public AudioDbDossierDto dossier(String artist, String album, String lang) {
        String artistName = cleanQuery(artist);
        String albumTitle = cleanQuery(album);
        String code = normalizeLang(lang);
        if (artistName.isEmpty()) {
            return new AudioDbDossierDto(null, null);
        }
        String key = code + "|" + artistName.toLowerCase(Locale.ROOT) + "|" + albumTitle.toLowerCase(Locale.ROOT);
        long now = System.currentTimeMillis();
        Cached cached = cache.get(key);
        if (cached != null && cached.expiresAt > now) {
            return cached.dossier;
        }
        UpstreamException failure = null;
        AudioDbArtistDto artistDto = null;
        AudioDbAlbumDto albumDto = null;
        try {
            JsonNode root = fetch("search.php?s=" + encode(artistName));
            artistDto = mapArtist(pick(root, "artists", "strArtist", artistName), code);
        } catch (UpstreamException e) {
            failure = e;
        }
        if (!albumTitle.isEmpty()) {
            try {
                JsonNode root = fetch("searchalbum.php?s=" + encode(artistName) + "&a=" + encode(albumTitle));
                albumDto = mapAlbum(pick(root, "album", "strAlbum", albumTitle), code);
            } catch (UpstreamException e) {
                failure = e;
            }
        }
        if (artistDto == null && albumDto == null && failure != null) {
            throw failure;
        }
        AudioDbDossierDto dossier = new AudioDbDossierDto(artistDto, albumDto);
        long ttl = artistDto == null && albumDto == null ? MISS_TTL_MS : HIT_TTL_MS;
        if (cache.size() > MAX_CACHE) {
            cache.clear();
        }
        cache.put(key, new Cached(dossier, System.currentTimeMillis() + ttl));
        return dossier;
    }

    static AudioDbArtistDto mapArtist(JsonNode node, String lang) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        String name = plain(node.path("strArtist").asText(""));
        if (name.isEmpty()) {
            return null;
        }
        return new AudioDbArtistDto(
                name,
                prose(localized(node, "strBiography", lang)),
                plain(node.path("strGenre").asText("")),
                plain(node.path("strStyle").asText("")),
                plain(node.path("strMood").asText("")),
                plain(node.path("strCountry").asText("")),
                year(node.path("intFormedYear").asText("")),
                website(node.path("strWebsite").asText("")),
                members(node.path("intMembers").asText("")),
                mediaUrl(node.path("strArtistThumb").asText(""))
        );
    }

    static AudioDbAlbumDto mapAlbum(JsonNode node, String lang) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        String title = plain(node.path("strAlbum").asText(""));
        if (title.isEmpty()) {
            return null;
        }
        return new AudioDbAlbumDto(
                title,
                plain(node.path("strArtist").asText("")),
                prose(localized(node, "strDescription", lang)),
                plain(node.path("strGenre").asText("")),
                plain(node.path("strStyle").asText("")),
                plain(node.path("strMood").asText("")),
                plain(node.path("strLabel").asText("")),
                year(node.path("intYearReleased").asText("")),
                mediaUrl(firstText(node, "strAlbumThumbHQ", "strAlbumThumb"))
        );
    }

    static String localized(JsonNode node, String prefix, String lang) {
        String wanted = text(node, prefix + suffix(lang));
        if (!wanted.isEmpty()) {
            return wanted;
        }
        String english = text(node, prefix + "EN");
        if (!english.isEmpty()) {
            return english;
        }
        return text(node, prefix + "FR");
    }

    static String prose(String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.replace("\r\n", "\n").replace('\r', '\n');
        text = text.replaceAll("(?i)<br\\s*/?>", "\n");
        text = text.replaceAll("(?i)</p>", "\n");
        text = HTML_TAG.matcher(text).replaceAll("");
        text = text.replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">");
        text = text.replaceAll("[\\t\\x0B\\f ]+", " ");
        text = text.replaceAll(" *\\n *", "\n");
        text = text.replaceAll("\\n{3,}", "\n\n").trim();
        if (text.equalsIgnoreCase("null")) {
            return "";
        }
        if (text.length() > MAX_PROSE) {
            return text.substring(0, MAX_PROSE).trim() + "…";
        }
        return text;
    }

    static String mediaUrl(String raw) {
        String url = https(raw);
        if (url.isEmpty()) {
            return "";
        }
        String host = hostOf(url);
        if ("theaudiodb.com".equals(host) || host.endsWith(".theaudiodb.com")) {
            return url;
        }
        return "";
    }

    public static String cleanQuery(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.trim().replaceAll("\\s+", " ");
        if (value.length() > 120) {
            value = value.substring(0, 120).trim();
        }
        for (int i = 0; i < value.length(); i++) {
            if (value.charAt(i) < 32) {
                return "";
            }
        }
        if (value.equalsIgnoreCase("null")) {
            return "";
        }
        return value;
    }

    private JsonNode fetch(String pathAndQuery) {
        pace();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(API + pathAndQuery))
                    .timeout(TIMEOUT)
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            int status = response.statusCode();
            if (status == 404) {
                return objectMapper.createObjectNode();
            }
            String body = response.body();
            if (status < 200 || status >= 300 || body == null || body.isBlank() || body.length() > MAX_BODY) {
                throw new UpstreamException();
            }
            JsonNode node = objectMapper.readTree(body);
            if (node == null || node.isNull()) {
                return objectMapper.createObjectNode();
            }
            return node;
        } catch (UpstreamException e) {
            throw e;
        } catch (Exception e) {
            log.debug("audiodb fetch failed: {}", e.toString());
            throw new UpstreamException();
        }
    }

    private void pace() {
        synchronized (paceLock) {
            long now = System.currentTimeMillis();
            long wait = nextAllowedAt - now;
            if (wait > 0) {
                try {
                    Thread.sleep(wait);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new UpstreamException();
                }
            }
            nextAllowedAt = System.currentTimeMillis() + PACE_MS;
        }
    }

    private static JsonNode pick(JsonNode root, String arrayField, String nameField, String wanted) {
        JsonNode array = root == null ? null : root.get(arrayField);
        if (array == null || !array.isArray() || array.isEmpty()) {
            return null;
        }
        String needle = wanted == null ? "" : wanted.trim();
        JsonNode fallback = null;
        for (JsonNode item : array) {
            if (item == null || item.isNull()) {
                continue;
            }
            if (fallback == null) {
                fallback = item;
            }
            if (!needle.isEmpty() && needle.equalsIgnoreCase(item.path(nameField).asText("").trim())) {
                return item;
            }
        }
        return fallback;
    }

    private static String suffix(String lang) {
        return switch (lang == null ? "" : lang) {
            case "fr" -> "FR";
            case "de" -> "DE";
            case "es" -> "ES";
            case "it" -> "IT";
            case "ru" -> "RU";
            case "ja" -> "JP";
            case "zh" -> "CN";
            case "he" -> "IL";
            default -> "EN";
        };
    }

    private static String normalizeLang(String lang) {
        String raw = lang == null ? "" : lang.trim().toLowerCase(Locale.ROOT);
        String mapped = raw.startsWith("jp") ? "ja"
                : raw.startsWith("cn") ? "zh"
                : raw.startsWith("in") ? "hi"
                : raw.length() >= 2 ? raw.substring(0, 2) : "en";
        return switch (mapped) {
            case "fr", "en", "de", "es", "it", "ru", "ja", "zh", "ar", "he", "el", "hi" -> mapped;
            default -> "en";
        };
    }

    private static String text(JsonNode node, String field) {
        return plain(node.path(field).asText(""));
    }

    private static String plain(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.trim();
        return value.equalsIgnoreCase("null") ? "" : value;
    }

    private static String year(String raw) {
        String value = plain(raw);
        if (value.isEmpty() || "0".equals(value)) {
            return "";
        }
        return value.length() > 4 ? value.substring(0, 4) : value;
    }

    private static int members(String raw) {
        String value = plain(raw);
        if (value.isEmpty()) {
            return 0;
        }
        try {
            int count = Integer.parseInt(value);
            return Math.max(0, Math.min(count, 99));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String website(String raw) {
        String value = plain(raw);
        if (value.isEmpty()) {
            return "";
        }
        if (value.startsWith("http://")) {
            value = "https://" + value.substring("http://".length());
        } else if (!value.startsWith("https://")) {
            value = "https://" + value;
        }
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || host.isBlank() || value.contains(" ")) {
                return "";
            }
            return uri.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String firstText(JsonNode node, String... fields) {
        for (String field : fields) {
            String value = plain(node.path(field).asText(""));
            if (!value.isEmpty()) {
                return value;
            }
        }
        return "";
    }

    private static String https(String raw) {
        String value = plain(raw);
        if (value.startsWith("http://")) {
            value = "https://" + value.substring("http://".length());
        }
        if (!value.startsWith("https://") || value.contains(" ")) {
            return "";
        }
        return value;
    }

    private static String hostOf(String url) {
        try {
            String host = URI.create(url).getHost();
            return host == null ? "" : host.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "";
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private record Cached(AudioDbDossierDto dossier, long expiresAt) {
    }
}
