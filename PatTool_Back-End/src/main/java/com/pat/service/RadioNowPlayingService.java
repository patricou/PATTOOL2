package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.RadioNowPlayingDto;
import com.pat.controller.dto.RadioTrackImageDto;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import com.pat.util.SsrfGuard;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Current musical track for a live radio stream.
 * <p>
 * Radio France stations use the public livemeta grid (songs only, not talk shows).
 * Other Icecast / Shoutcast streams are probed for ICY {@code StreamTitle}.
 * Related photos come from the station cover, YouTube stills, iTunes artwork,
 * Deezer and Wikipedia.
 */
@Service
public class RadioNowPlayingService {

    private static final Logger log = LoggerFactory.getLogger(RadioNowPlayingService.class);

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final String WIKI_AGENT = "PatTool/1.0 (radio now-playing)";

    private static final Duration JSON_TIMEOUT = Duration.ofSeconds(4);
    private static final int ICY_CONNECT_MS = 4_000;
    private static final int ICY_READ_MS = 6_000;
    private static final int ICY_META_INT_CAP = 64 * 1024;
    private static final int MAX_REDIRECTS = 4;
    private static final int MAX_IMAGES = 24;
    /** Album sleeves shown on the radio face, ahead of stills and portraits. */
    private static final int MAX_ALBUM_COVERS = 18;
    /** Re-read the live title often enough to follow a song change. */
    private static final long META_HIT_MS = 6_000;
    private static final long META_MISS_MS = 12_000;
    private static final long IMAGE_HIT_MS = Duration.ofHours(6).toMillis();
    private static final long IMAGE_MISS_MS = Duration.ofMinutes(10).toMillis();

    /** Livemeta ids confirmed against api.radiofrance.fr and the FIP webradio cards. */
    private static final Map<String, Integer> RADIO_FRANCE_IDS = new LinkedHashMap<>();
    private static final Pattern RF_SLUG = Pattern.compile(
            "(?<![a-z0-9])(franceinter|franceinfo|franceculture|francemusique|mouv|fip(?:-[a-z]+)*)(?![a-z0-9])");
    private static final Pattern STREAM_TITLE = Pattern.compile(
            "StreamTitle='([^']*)'|StreamTitle=\"([^\"]*)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern WIKI_PX = Pattern.compile("(\\d+)px");

    static {
        RADIO_FRANCE_IDS.put("franceinter", 1);
        RADIO_FRANCE_IDS.put("franceinfo", 2);
        RADIO_FRANCE_IDS.put("francemusique", 4);
        RADIO_FRANCE_IDS.put("franceculture", 5);
        RADIO_FRANCE_IDS.put("mouv", 6);
        RADIO_FRANCE_IDS.put("fip", 7);
        RADIO_FRANCE_IDS.put("fip-rock", 64);
        RADIO_FRANCE_IDS.put("fip-jazz", 65);
        RADIO_FRANCE_IDS.put("fip-groove", 66);
        RADIO_FRANCE_IDS.put("fip-monde", 69);
        RADIO_FRANCE_IDS.put("fip-world", 69);
        RADIO_FRANCE_IDS.put("fip-nouveautes", 70);
        RADIO_FRANCE_IDS.put("fip-reggae", 71);
        RADIO_FRANCE_IDS.put("fip-electro", 74);
        RADIO_FRANCE_IDS.put("fip-metal", 77);
        RADIO_FRANCE_IDS.put("fip-pop", 78);
        RADIO_FRANCE_IDS.put("fip-hiphop", 95);
        RADIO_FRANCE_IDS.put("fip-sacre-francais", 96);
        RADIO_FRANCE_IDS.put("fip-cultes", 709);
    }

    private final ObjectMapper objectMapper;
    private final RadioFranceLiveService radioFranceLiveService;
    private final YoutubeProxyService youtubeProxyService;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(JSON_TIMEOUT)
            .build();

    private final ConcurrentHashMap<String, Cached<Track>> metaCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Cached<List<RadioTrackImageDto>>> imageCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();
    private final java.util.Set<String> imageFetches = ConcurrentHashMap.newKeySet();
    private final ExecutorService imagePool = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "radio-track-images");
        thread.setDaemon(true);
        return thread;
    });

    public RadioNowPlayingService(ObjectMapper objectMapper,
                                  RadioFranceLiveService radioFranceLiveService,
                                  YoutubeProxyService youtubeProxyService) {
        this.objectMapper = objectMapper;
        this.radioFranceLiveService = radioFranceLiveService;
        this.youtubeProxyService = youtubeProxyService;
    }

    @PreDestroy
    public void shutdownImagePool() {
        imagePool.shutdownNow();
    }

    public RadioNowPlayingDto lookup(String streamUrl, String stationName, String homepage) {
        String url = streamUrl != null ? streamUrl.trim() : "";
        if (url.isEmpty() || url.length() > 2000) {
            return RadioNowPlayingDto.empty();
        }
        String name = clip(stationName, 300);
        String home = clip(homepage, 500);
        String key = url;
        synchronized (locks.computeIfAbsent(key, k -> new Object())) {
            long now = System.currentTimeMillis();
            Cached<Track> cached = metaCache.get(key);
            Track track;
            if (cached != null && cached.until > now) {
                track = cached.value;
            } else {
                track = resolve(url, name, home);
                long ttl = track.hasTitle() ? META_HIT_MS : META_MISS_MS;
                if (metaCache.size() > 400) {
                    Object held = locks.get(key);
                    metaCache.clear();
                    locks.clear();
                    if (held != null) {
                        locks.put(key, held);
                    }
                }
                metaCache.put(key, new Cached<>(track, now + ttl));
            }
            return withImages(track, now);
        }
    }

    private RadioNowPlayingDto withImages(Track track, long now) {
        if (!track.hasTitle()) {
            return track.toDto(List.of());
        }
        String key = imageKey(track);
        Cached<List<RadioTrackImageDto>> cached = imageCache.get(key);
        if (cached != null && cached.until > now) {
            return track.toDto(cached.value);
        }
        // New song: send its title (and its own cover) at once. The rest of the
        // photos load in the background and replace the previous track on the next poll.
        if (imageFetches.add(key)) {
            imagePool.execute(() -> loadImages(key, track));
        }
        List<RadioTrackImageDto> cover = new ArrayList<>();
        addImage(cover, track.coverUrl, track.label());
        addImage(cover, track.extraImageUrl, track.label());
        return track.toDto(cover);
    }

    private void loadImages(String key, Track track) {
        try {
            List<RadioTrackImageDto> images;
            try {
                images = fetchImages(track);
            } catch (Exception e) {
                log.debug("radio track images failed: {}", e.toString());
                images = List.of();
            }
            long ttl = images.isEmpty() ? IMAGE_MISS_MS : IMAGE_HIT_MS;
            imageCache.put(key, new Cached<>(images, System.currentTimeMillis() + ttl));
            trim(imageCache);
        } finally {
            imageFetches.remove(key);
        }
    }

    private Track resolve(String url, String stationName, String homepage) {
        String probeUrl = url;
        if (RadioFranceLiveService.isVirtualUrl(url)) {
            probeUrl = RadioFranceLiveService.slugFromVirtualUrl(url)
                    .flatMap(radioFranceLiveService::resolveHlsUrl)
                    .orElse(url);
        }
        Integer stationId = radioFranceStationId(probeUrl + " " + url, stationName, homepage);
        if (stationId != null) {
            Track fromGrid = readRadioFrance(stationId);
            if (fromGrid.hasTitle()) {
                return fromGrid;
            }
        }
        if (RadioStreamProxyService.isProgressivePodcastFile(probeUrl)
                || RadioStreamProxyService.useBufferedProxy(probeUrl)) {
            return Track.none();
        }
        String icyUrl = probeUrl;
        if (RadioStreamProxyService.isSimplePlaylistUrl(probeUrl)) {
            icyUrl = resolvePlaylist(probeUrl);
            if (icyUrl == null) {
                return Track.none();
            }
        }
        return readIcy(icyUrl, stationName);
    }

    static Integer radioFranceStationId(String url, String stationName, String homepage) {
        Integer fromStream = longestSlug(url, homepage);
        if (fromStream != null) {
            return fromStream;
        }
        return longestSlug(stationName, null);
    }

    private static Integer longestSlug(String primary, String secondary) {
        String blob = ((primary == null ? "" : primary) + " " + (secondary == null ? "" : secondary))
                .toLowerCase(Locale.ROOT)
                .replace('_', '-');
        Matcher matcher = RF_SLUG.matcher(blob);
        String bestKey = null;
        while (matcher.find()) {
            String key = knownSlug(matcher.group(1));
            if (key != null && (bestKey == null || key.length() > bestKey.length())) {
                bestKey = key;
            }
        }
        return bestKey == null ? null : RADIO_FRANCE_IDS.get(bestKey);
    }

    /** {@code fip-rock-midfi} → {@code fip-rock}; {@code fip-hifi} → {@code fip}. */
    private static String knownSlug(String slug) {
        String current = slug;
        while (current != null && !current.isEmpty()) {
            if (RADIO_FRANCE_IDS.containsKey(current)) {
                return current;
            }
            int dash = current.lastIndexOf('-');
            if (dash <= 0) {
                return null;
            }
            current = current.substring(0, dash);
        }
        return null;
    }

    private Track readRadioFrance(int stationId) {
        JsonNode root = fetchJson("https://api.radiofrance.fr/livemeta/pull/" + stationId, USER_AGENT);
        if (root == null) {
            return Track.none();
        }
        JsonNode step = pickSong(root, System.currentTimeMillis() / 1000L);
        if (step == null) {
            return Track.none();
        }
        String title = clean(step.path("title").asText(""));
        String artist = radioFranceArtist(step);
        String album = clean(step.path("titreAlbum").asText(""));
        if (!isUsefulTitle(title, "")) {
            return Track.none();
        }
        String cover = httpsImage(step.path("visual").asText(""));
        String extra = httpsImage(step.path("visuelYoutube").asText(""));
        return new Track(title, artist, album, cover, extra);
    }

    static JsonNode pickSong(JsonNode root, long nowEpochSeconds) {
        JsonNode steps = root.path("steps");
        if (!steps.isObject()) {
            return null;
        }
        JsonNode best = null;
        int bestDepth = -1;
        long bestStart = -1;
        Iterator<JsonNode> it = steps.elements();
        while (it.hasNext()) {
            JsonNode step = it.next();
            if (!"song".equalsIgnoreCase(step.path("embedType").asText(""))) {
                continue;
            }
            long start = step.path("start").asLong(0);
            long end = step.path("end").asLong(0);
            if (start <= 0 || nowEpochSeconds + 20 < start || nowEpochSeconds - 20 >= end) {
                continue;
            }
            int depth = step.path("depth").asInt(0);
            if (depth > bestDepth || (depth == bestDepth && start >= bestStart)) {
                best = step;
                bestDepth = depth;
                bestStart = start;
            }
        }
        return best;
    }

    private static String radioFranceArtist(JsonNode step) {
        JsonNode highlighted = step.path("highlightedArtists");
        if (highlighted.isArray() && !highlighted.isEmpty()) {
            List<String> names = new ArrayList<>();
            for (JsonNode node : highlighted) {
                String name = clean(node.asText(""));
                if (!name.isEmpty() && names.size() < 3) {
                    names.add(name);
                }
            }
            if (!names.isEmpty()) {
                return String.join(", ", names);
            }
        }
        String authors = clean(step.path("authors").asText(""));
        if (authors.isEmpty()) {
            return "";
        }
        int cut = authors.indexOf(" & ");
        if (cut < 0) {
            cut = authors.indexOf(", ");
        }
        return cut > 0 ? authors.substring(0, cut).trim() : authors;
    }

    private Track readIcy(String url, String stationName) {
        if (!SsrfGuard.isPublicHttpUrl(url)) {
            return Track.none();
        }
        String current = url;
        HttpURLConnection conn = null;
        try {
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                if (!SsrfGuard.isPublicHttpUrl(current)) {
                    return Track.none();
                }
                conn = (HttpURLConnection) URI.create(current).toURL().openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(ICY_CONNECT_MS);
                conn.setReadTimeout(ICY_READ_MS);
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setRequestProperty("Icy-MetaData", "1");
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Accept-Encoding", "identity");
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (location == null || location.isBlank()) {
                        return Track.none();
                    }
                    current = URI.create(current).resolve(location).toString();
                    continue;
                }
                if (code >= 400) {
                    return Track.none();
                }
                String metaIntRaw = conn.getHeaderField("icy-metaint");
                if (metaIntRaw == null || metaIntRaw.isBlank()) {
                    return Track.none();
                }
                int metaInt = Integer.parseInt(metaIntRaw.trim());
                if (metaInt <= 0 || metaInt > ICY_META_INT_CAP) {
                    return Track.none();
                }
                try (InputStream in = conn.getInputStream()) {
                    if (!skipFully(in, metaInt)) {
                        return Track.none();
                    }
                    int lenByte = in.read();
                    if (lenByte <= 0) {
                        if (!skipFully(in, metaInt)) {
                            return Track.none();
                        }
                        lenByte = in.read();
                    }
                    if (lenByte <= 0) {
                        return Track.none();
                    }
                    int metaLen = lenByte * 16;
                    if (metaLen > 4080) {
                        return Track.none();
                    }
                    byte[] meta = in.readNBytes(metaLen);
                    return trackFromIcy(decodeMeta(meta), stationName);
                }
            }
            return Track.none();
        } catch (Exception e) {
            log.debug("icy metadata failed for {}: {}", url, e.toString());
            return Track.none();
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    static Track trackFromIcy(String metadata, String stationName) {
        String raw = extractStreamTitle(metadata);
        if (!isUsefulTitle(raw, stationName)) {
            return Track.none();
        }
        String[] parts = splitArtistTitle(raw);
        return new Track(parts[1], parts[0], "", "", "");
    }

    static String extractStreamTitle(String metadata) {
        if (metadata == null || metadata.isBlank()) {
            return "";
        }
        Matcher matcher = STREAM_TITLE.matcher(metadata.replace('\0', ' '));
        if (!matcher.find()) {
            return "";
        }
        String value = matcher.group(1) != null ? matcher.group(1) : matcher.group(2);
        return clean(value);
    }

    static String[] splitArtistTitle(String raw) {
        String text = raw == null ? "" : raw.trim();
        String[] seps = {" - ", " – ", " — "};
        for (String sep : seps) {
            int index = text.indexOf(sep);
            if (index <= 0 || index >= text.length() - sep.length()) {
                continue;
            }
            String artist = text.substring(0, index).trim();
            String rest = text.substring(index + sep.length()).trim();
            int next = indexOfSeparator(rest);
            String title = next > 0 ? rest.substring(0, next).trim() : rest;
            if (!artist.isEmpty() && !title.isEmpty()) {
                return new String[] {clip(artist, 120), clip(title, 160)};
            }
        }
        return new String[] {"", clip(text, 160)};
    }

    private static int indexOfSeparator(String text) {
        int best = -1;
        for (String sep : new String[] {" - ", " – ", " — "}) {
            int index = text.indexOf(sep);
            if (index > 0 && (best < 0 || index < best)) {
                best = index;
            }
        }
        return best;
    }

    static boolean isUsefulTitle(String title, String stationName) {
        String text = title == null ? "" : title.trim();
        if (text.length() < 2 || text.length() > 180) {
            return false;
        }
        String folded = fold(text);
        if (folded.isEmpty()) {
            return false;
        }
        if (stationName != null && !stationName.isBlank() && folded.equals(fold(stationName))) {
            return false;
        }
        return switch (folded) {
            case "unknown", "null", "test", "info", "live", "radio", "stream", "livestream",
                    "advert", "advertisement", "commercial", "jingle", "publicite", "pub",
                    "untitled", "no title", "spotify", "auto dj" -> false;
            default -> !folded.startsWith("http ") && !folded.startsWith("https ");
        };
    }

    private String resolvePlaylist(String playlistUrl) {
        if (!SsrfGuard.isPublicHttpUrl(playlistUrl)) {
            return null;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) URI.create(playlistUrl).toURL().openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(ICY_CONNECT_MS);
            conn.setReadTimeout(ICY_READ_MS);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            if (conn.getResponseCode() >= 400) {
                return null;
            }
            try (InputStream in = conn.getInputStream()) {
                byte[] body = in.readNBytes(32 * 1024);
                String text = new String(body, StandardCharsets.UTF_8);
                for (String line : text.split("\\R")) {
                    String t = line.trim();
                    if (t.isEmpty() || t.startsWith("#")) {
                        continue;
                    }
                    String upper = t.toUpperCase(Locale.ROOT);
                    if (upper.startsWith("FILE") && t.contains("=")) {
                        t = t.substring(t.indexOf('=') + 1).trim();
                    }
                    if ((t.startsWith("http://") || t.startsWith("https://")) && SsrfGuard.isPublicHttpUrl(t)) {
                        return t;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("radio playlist now-playing resolve failed: {}", e.toString());
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        return null;
    }

    private List<RadioTrackImageDto> fetchImages(Track track) {
        List<RadioTrackImageDto> images = new ArrayList<>();
        String alt = track.label();
        addImage(images, track.coverUrl, alt);
        addImage(images, track.extraImageUrl, alt);
        JsonNode hit = searchDeezer(track);
        String artistForWiki = track.artist;
        long artistId = 0;
        if (hit != null && deezerMatches(track, hit)) {
            String cover = httpsImage(hit.path("album").path("cover_xl").asText(""));
            if (cover.isEmpty()) {
                cover = httpsImage(hit.path("album").path("cover_big").asText(""));
            }
            addImage(images, cover, alt);
            String picture = httpsImage(hit.path("artist").path("picture_xl").asText(""));
            addImage(images, picture, track.artist.isEmpty() ? alt : track.artist);
            if (artistForWiki.isEmpty()) {
                artistForWiki = clean(hit.path("artist").path("name").asText(""));
            }
            artistId = hit.path("artist").path("id").asLong(0);
        }
        if (artistId <= 0 && !track.artist.isBlank()) {
            artistId = findDeezerArtistId(track.artist);
        }
        if (artistId > 0) {
            addAlbumCovers(images, artistId, track.artist.isEmpty() ? alt : track.artist);
        }
        addItunesArtwork(images, track);
        addItunesAlbums(images, track);
        addYoutubeStills(images, track);
        if (!artistForWiki.isBlank()) {
            addWikipediaPhotos(images, artistForWiki);
        }
        if (images.size() > MAX_IMAGES) {
            return List.copyOf(images.subList(0, MAX_IMAGES));
        }
        return List.copyOf(images);
    }

    private void addYoutubeStills(List<RadioTrackImageDto> images, Track track) {
        if (images.size() >= MAX_IMAGES || youtubeProxyService == null || !youtubeProxyService.isConfigured()) {
            return;
        }
        String query = clip((track.artist + " " + track.title).trim(), 100);
        if (query.length() < 2) {
            return;
        }
        YoutubeSearchPageDto page;
        try {
            page = youtubeProxyService.search(query, "video", "FR", "fr", null, null, 4, "relevance", null);
        } catch (Exception e) {
            log.debug("radio youtube stills failed: {}", e.toString());
            return;
        }
        if (page == null || page.items() == null) {
            return;
        }
        int added = 0;
        for (YoutubeItemDto item : page.items()) {
            if (added >= 4 || images.size() >= MAX_IMAGES) {
                return;
            }
            if (item == null || item.thumbnailUrl() == null || !item.thumbnailUrl().startsWith("external/youtube/image?")) {
                continue;
            }
            int before = images.size();
            addImage(images, item.thumbnailUrl(), item.title() == null || item.title().isBlank() ? track.label() : item.title());
            if (images.size() > before) {
                added++;
            }
        }
    }

    private void addItunesArtwork(List<RadioTrackImageDto> images, Track track) {
        if (images.size() >= MAX_IMAGES || track.title.isBlank()) {
            return;
        }
        String term = (track.artist.isBlank() ? track.title : track.artist + " " + track.title).trim();
        String url = "https://itunes.apple.com/search?entity=song&limit=10&country=FR&term="
                + URLEncoder.encode(term, StandardCharsets.UTF_8);
        JsonNode root = fetchJson(url, USER_AGENT);
        if (root == null || !root.path("results").isArray()) {
            return;
        }
        int added = 0;
        for (JsonNode hit : root.path("results")) {
            if (added >= 6 || images.size() >= MAX_IMAGES) {
                return;
            }
            if (!itunesMatches(track, hit)) {
                continue;
            }
            String art = itunesLarge(hit.path("artworkUrl100").asText(""));
            int before = images.size();
            String alt = clean(hit.path("artistName").asText(track.label()));
            addImage(images, art, alt.isEmpty() ? track.label() : alt);
            if (images.size() > before) {
                added++;
            }
        }
    }

    static boolean itunesMatches(Track track, JsonNode hit) {
        String hitTitle = fold(hit.path("trackName").asText(""));
        String hitArtist = fold(hit.path("artistName").asText(""));
        String title = fold(track.title);
        String artist = fold(track.artist);
        boolean titleOk = title.length() >= 3 && (hitTitle.contains(title) || title.contains(hitTitle));
        boolean artistOk = artist.length() >= 2 && (hitArtist.contains(artist) || artist.contains(hitArtist));
        if (!artist.isEmpty()) {
            return artistOk || titleOk;
        }
        return titleOk;
    }

    static String itunesLarge(String raw) {
        String safe = httpsImage(raw);
        if (safe.isEmpty()) {
            return "";
        }
        return safe.replaceAll("/\\d+x\\d+bb", "/600x600bb");
    }

    private JsonNode searchDeezer(Track track) {
        String query;
        if (!track.artist.isBlank() && !track.title.isBlank()) {
            query = "artist:\"" + track.artist.replace("\"", "") + "\" track:\"" + track.title.replace("\"", "") + "\"";
        } else if (!track.title.isBlank()) {
            query = track.title;
        } else {
            return null;
        }
        String url = "https://api.deezer.com/search?limit=5&q=" + URLEncoder.encode(query, StandardCharsets.UTF_8);
        JsonNode root = fetchJson(url, USER_AGENT);
        if (root == null) {
            return null;
        }
        JsonNode data = root.path("data");
        if (!data.isArray() || data.isEmpty()) {
            return null;
        }
        for (JsonNode hit : data) {
            if (deezerMatches(track, hit)) {
                return hit;
            }
        }
        return null;
    }

    static boolean deezerMatches(Track track, JsonNode hit) {
        String hitTitle = fold(hit.path("title").asText(""));
        String hitArtist = fold(hit.path("artist").path("name").asText(""));
        String title = fold(track.title);
        String artist = fold(track.artist);
        boolean titleOk = title.length() >= 3 && (hitTitle.contains(title) || title.contains(hitTitle));
        boolean artistOk = artist.length() >= 2 && (hitArtist.contains(artist) || artist.contains(hitArtist));
        if (!artist.isEmpty()) {
            return artistOk || titleOk;
        }
        return titleOk;
    }

    private long findDeezerArtistId(String artistName) {
        String name = clean(artistName);
        if (name.length() < 2) {
            return 0;
        }
        JsonNode root = fetchJson(
                "https://api.deezer.com/search/artist?limit=5&q=" + URLEncoder.encode(name, StandardCharsets.UTF_8),
                USER_AGENT);
        if (root == null || !root.path("data").isArray()) {
            return 0;
        }
        String wanted = fold(name);
        long fallback = 0;
        for (JsonNode hit : root.path("data")) {
            long id = hit.path("id").asLong(0);
            String hitName = fold(hit.path("name").asText(""));
            if (id <= 0 || hitName.isEmpty()) {
                continue;
            }
            if (hitName.equals(wanted)) {
                return id;
            }
            if (fallback == 0 && wanted.length() >= 4 && hitName.length() >= 4
                    && (hitName.contains(wanted) || wanted.contains(hitName))) {
                fallback = id;
            }
        }
        return fallback;
    }

    private void addItunesAlbums(List<RadioTrackImageDto> images, Track track) {
        if (images.size() >= MAX_IMAGES) {
            return;
        }
        String term = (track.artist.isBlank() ? track.title : track.artist).trim();
        if (term.length() < 2) {
            return;
        }
        String url = "https://itunes.apple.com/search?entity=album&limit=16&country=FR&term="
                + URLEncoder.encode(term, StandardCharsets.UTF_8);
        JsonNode root = fetchJson(url, USER_AGENT);
        if (root == null || !root.path("results").isArray()) {
            return;
        }
        String artist = fold(track.artist);
        int added = 0;
        for (JsonNode hit : root.path("results")) {
            if (added >= 10 || images.size() >= MAX_IMAGES) {
                return;
            }
            String hitArtist = fold(hit.path("artistName").asText(""));
            if (!artist.isEmpty()) {
                boolean artistOk = hitArtist.length() >= 2 && (hitArtist.contains(artist) || artist.contains(hitArtist));
                if (!artistOk) {
                    continue;
                }
            }
            String art = itunesLarge(hit.path("artworkUrl100").asText(""));
            int before = images.size();
            String alt = clean(hit.path("collectionName").asText(track.label()));
            addImage(images, art, alt.isEmpty() ? track.label() : alt);
            if (images.size() > before) {
                added++;
            }
        }
    }

    private void addAlbumCovers(List<RadioTrackImageDto> images, long artistId, String alt) {
        if (images.size() >= MAX_IMAGES) {
            return;
        }
        JsonNode root = fetchJson(
                "https://api.deezer.com/artist/" + artistId + "/albums?limit=40", USER_AGENT);
        if (root == null) {
            return;
        }
        JsonNode data = root.path("data");
        if (!data.isArray()) {
            return;
        }
        List<JsonNode> albums = new ArrayList<>();
        List<JsonNode> others = new ArrayList<>();
        for (JsonNode album : data) {
            String type = album.path("record_type").asText("");
            if ("album".equalsIgnoreCase(type) || "ep".equalsIgnoreCase(type)) {
                albums.add(album);
            } else {
                others.add(album);
            }
        }
        int added = 0;
        for (List<JsonNode> group : List.of(albums, others)) {
            for (JsonNode album : group) {
                if (added >= MAX_ALBUM_COVERS || images.size() >= MAX_IMAGES) {
                    return;
                }
                String cover = httpsImage(album.path("cover_xl").asText(""));
                if (cover.isEmpty()) {
                    cover = httpsImage(album.path("cover_big").asText(""));
                }
                int before = images.size();
                addImage(images, cover, alt);
                if (images.size() > before) {
                    added++;
                }
            }
        }
    }

    private void addWikipediaPhotos(List<RadioTrackImageDto> images, String artist) {
        if (images.size() >= MAX_IMAGES) {
            return;
        }
        String encoded = URLEncoder.encode(artist.trim().replace(' ', '_'), StandardCharsets.UTF_8)
                .replace("+", "%20");
        JsonNode root = fetchJson("https://fr.wikipedia.org/api/rest_v1/page/media-list/" + encoded, WIKI_AGENT);
        if (root == null || !root.path("items").isArray()) {
            root = fetchJson("https://en.wikipedia.org/api/rest_v1/page/media-list/" + encoded, WIKI_AGENT);
        }
        if (root == null) {
            return;
        }
        JsonNode items = root.path("items");
        int added = 0;
        for (JsonNode item : items) {
            if (added >= 4 || images.size() >= MAX_IMAGES) {
                return;
            }
            if (!"image".equalsIgnoreCase(item.path("type").asText(""))) {
                continue;
            }
            String fileTitle = item.path("title").asText("");
            if (!wikiPhotoAllowed(fileTitle)) {
                continue;
            }
            String url = bestWikiSrc(item);
            int before = images.size();
            addImage(images, url, artist);
            if (images.size() > before) {
                added++;
            }
        }
    }

    static boolean wikiPhotoAllowed(String fileTitle) {
        String folded = fold(fileTitle);
        if (folded.isEmpty()) {
            return false;
        }
        if (folded.endsWith(" svg") || folded.endsWith(" gif") || folded.endsWith(" tif") || folded.endsWith(" tiff")) {
            return false;
        }
        String[] blocked = {
                "logo", "icon", "flag", "carte", "map", "blason", "signature", "pictogram",
                "symbol", "commons", "ambox", "wikimedia", "padlock", "nuvola", "question book",
                "edit clear", "speaker", "coat of arms", "locator"
        };
        for (String word : blocked) {
            if (folded.contains(word)) {
                return false;
            }
        }
        return folded.endsWith(" jpg") || folded.endsWith(" jpeg") || folded.endsWith(" png")
                || folded.endsWith(" webp") || folded.contains(" jpg ") || !folded.contains(".");
    }

    private static String bestWikiSrc(JsonNode item) {
        JsonNode original = item.path("original");
        String originalSrc = httpsImage(original.path("source").asText(""));
        int width = original.path("width").asInt(0);
        if (!originalSrc.isEmpty() && width >= 320) {
            return originalSrc;
        }
        String best = "";
        int bestScale = -1;
        JsonNode srcset = item.path("srcset");
        if (srcset.isArray()) {
            for (JsonNode candidate : srcset) {
                String src = httpsImage(candidate.path("src").asText(""));
                if (src.isEmpty() || !wikiSizeOk(src)) {
                    continue;
                }
                int scale = parseScale(candidate.path("scale").asText(""));
                if (scale >= bestScale) {
                    best = src;
                    bestScale = scale;
                }
            }
        }
        if (!best.isEmpty()) {
            return best;
        }
        return wikiSizeOk(originalSrc) ? originalSrc : "";
    }

    private static boolean wikiSizeOk(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        Matcher matcher = WIKI_PX.matcher(url);
        int max = 0;
        boolean any = false;
        while (matcher.find()) {
            any = true;
            max = Math.max(max, Integer.parseInt(matcher.group(1)));
        }
        return !any || max >= 200;
    }

    private static int parseScale(String scale) {
        if (scale == null) {
            return 0;
        }
        String digits = scale.replaceAll("[^0-9]", "");
        if (digits.isEmpty()) {
            return 0;
        }
        try {
            return Integer.parseInt(digits);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static void addImage(List<RadioTrackImageDto> images, String url, String alt) {
        if (url == null || url.isBlank() || images.size() >= MAX_IMAGES) {
            return;
        }
        String safe = url.startsWith("external/youtube/image?") ? url.trim() : httpsImage(url);
        if (safe.isEmpty()) {
            return;
        }
        boolean proxied = safe.startsWith("external/youtube/image?");
        String bare = proxied || !safe.contains("?") ? safe : safe.substring(0, safe.indexOf('?'));
        for (RadioTrackImageDto existing : images) {
            String other = existing.getUrl();
            if (other == null) {
                continue;
            }
            boolean otherProxied = other.startsWith("external/youtube/image?");
            String otherBare = otherProxied || !other.contains("?") ? other : other.substring(0, other.indexOf('?'));
            if (otherBare.equals(bare)) {
                return;
            }
        }
        images.add(new RadioTrackImageDto(safe, alt == null ? "" : alt));
    }

    static String httpsImage(String raw) {
        if (raw == null) {
            return "";
        }
        String url = raw.trim();
        if (!url.startsWith("https://") || url.length() > 2000) {
            return "";
        }
        if (!SsrfGuard.isPublicHttpUrl(url)) {
            return "";
        }
        return url;
    }

    private JsonNode fetchJson(String url, String userAgent) {
        if (!SsrfGuard.isPublicHttpUrl(url)) {
            return null;
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(JSON_TIMEOUT)
                    .header("User-Agent", userAgent)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                return null;
            }
            String body = response.body();
            if (body == null || body.isBlank() || body.length() > 2_000_000) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (Exception e) {
            log.debug("radio json fetch failed for {}: {}", url, e.toString());
            return null;
        }
    }

    private static boolean skipFully(InputStream in, int count) throws java.io.IOException {
        long left = count;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped > 0) {
                left -= skipped;
                continue;
            }
            if (in.read() < 0) {
                return false;
            }
            left--;
        }
        return true;
    }

    private static String decodeMeta(byte[] bytes) {
        String utf8 = new String(bytes, StandardCharsets.UTF_8);
        if (utf8.indexOf('\uFFFD') >= 0) {
            return new String(bytes, StandardCharsets.ISO_8859_1);
        }
        return utf8;
    }

    private static String imageKey(Track track) {
        return "covers2|" + fold(track.artist) + "|" + fold(track.title);
    }

    private static String fold(String value) {
        String text = value == null ? "" : value;
        String normalized = Normalizer.normalize(text, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        return normalized.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim();
    }

    private static String clean(String value) {
        if (value == null) {
            return "";
        }
        return value.replace('\u00a0', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String clip(String value, int max) {
        String text = clean(value);
        if (text.length() <= max) {
            return text;
        }
        return text.substring(0, max).trim();
    }

    private static <T> void trim(ConcurrentHashMap<String, Cached<T>> cache) {
        if (cache.size() > 400) {
            cache.clear();
        }
    }

    static final class Track {
        final String title;
        final String artist;
        final String album;
        final String coverUrl;
        final String extraImageUrl;

        Track(String title, String artist, String album, String coverUrl, String extraImageUrl) {
            this.title = title == null ? "" : title;
            this.artist = artist == null ? "" : artist;
            this.album = album == null ? "" : album;
            this.coverUrl = coverUrl == null ? "" : coverUrl;
            this.extraImageUrl = extraImageUrl == null ? "" : extraImageUrl;
        }

        static Track none() {
            return new Track("", "", "", "", "");
        }

        boolean hasTitle() {
            return !title.isBlank();
        }

        String label() {
            if (!artist.isBlank() && !title.isBlank()) {
                return artist + " — " + title;
            }
            return title;
        }

        RadioNowPlayingDto toDto(List<RadioTrackImageDto> images) {
            RadioNowPlayingDto dto = new RadioNowPlayingDto();
            dto.setTitle(title);
            dto.setArtist(artist);
            dto.setAlbum(album);
            dto.setLabel(label());
            dto.setImages(images == null ? List.of() : images);
            return dto;
        }
    }

    private static final class Cached<T> {
        final T value;
        final long until;

        Cached(T value, long until) {
            this.value = value;
            this.until = until;
        }
    }
}
