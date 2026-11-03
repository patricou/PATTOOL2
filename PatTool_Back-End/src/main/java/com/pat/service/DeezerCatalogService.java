package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerAlbumDto;
import com.pat.controller.dto.DeezerAlbumPageDto;
import com.pat.controller.dto.DeezerArtistDto;
import com.pat.controller.dto.DeezerArtistPageDto;
import com.pat.controller.dto.DeezerChartDto;
import com.pat.controller.dto.DeezerGenreDto;
import com.pat.controller.dto.DeezerPlaylistDto;
import com.pat.controller.dto.DeezerPlaylistPageDto;
import com.pat.controller.dto.DeezerSearchDto;
import com.pat.controller.dto.DeezerSliceDto;
import com.pat.controller.dto.DeezerTrackDto;
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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Public Deezer catalog (no API key). Audio is limited to the 30-second {@code preview} MP3.
 * Full-length tracks and videos are not part of this API.
 */
@Service
public class DeezerCatalogService {

    private static final Logger log = LoggerFactory.getLogger(DeezerCatalogService.class);

    private static final String API = "https://api.deezer.com";
    private static final String USER_AGENT = "PatTool/1.0 (deezer catalog)";
    private static final Duration TIMEOUT = Duration.ofSeconds(6);
    private static final Duration GENRE_TTL = Duration.ofHours(12);
    private static final Duration CHART_TTL = Duration.ofMinutes(15);
    private static final Duration SEARCH_TTL = Duration.ofMinutes(5);
    private static final Duration PAGE_TTL = Duration.ofMinutes(20);
    private static final Duration TRACK_TTL = Duration.ofSeconds(90);
    private static final long STALE_MS = Duration.ofHours(6).toMillis();
    private static final int MAX_BODY = 2_000_000;
    private static final int MAX_CACHE = 300;
    /** Deezer list endpoints accept at most 100 items per call. */
    private static final int TRACK_PAGE = 100;
    private static final int TRACK_PAGE_DEFAULT = 50;

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(TIMEOUT)
            .build();
    private final ConcurrentHashMap<String, Cached> cache = new ConcurrentHashMap<>();

    public DeezerCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** Deezer rejected the call (quota, outage). Distinct from a missing id. */
    public static class UpstreamException extends RuntimeException {
        public UpstreamException() {
            super("deezer");
        }
    }

    public List<DeezerGenreDto> genres() {
        JsonNode root = fetchOk("/genre", GENRE_TTL);
        if (root == null) {
            return List.of();
        }
        List<DeezerGenreDto> genres = new ArrayList<>();
        for (JsonNode hit : arrayOf(root)) {
            long id = hit.path("id").asLong(-1);
            String name = clean(hit.path("name").asText(""));
            if (id < 0 || name.isEmpty()) {
                continue;
            }
            genres.add(new DeezerGenreDto(id, name, mediaUrl(firstText(hit, "picture_medium", "picture_big", "picture"))));
        }
        return List.copyOf(genres);
    }

    public DeezerChartDto chart(long genreId, int trackIndex, int albumIndex, int artistIndex, int playlistIndex) {
        String base = "/chart/" + genreId;
        JsonNode tracks = fetchOk(base + pageQuery("/tracks", trackIndex), CHART_TTL);
        JsonNode albums = optional(base + pageQuery("/albums", albumIndex), CHART_TTL);
        JsonNode artists = optional(base + pageQuery("/artists", artistIndex), CHART_TTL);
        JsonNode playlists = optional(base + pageQuery("/playlists", playlistIndex), CHART_TTL);
        List<DeezerArtistDto> artistList = mapArtists(artists, TRACK_PAGE);
        List<DeezerTrackDto> trackList = attachFans(mapTracks(tracks, null, TRACK_PAGE), artistList);
        List<DeezerAlbumDto> albumList = mapAlbums(albums, false, TRACK_PAGE);
        List<DeezerPlaylistDto> playlistList = mapPlaylists(playlists, TRACK_PAGE);
        return new DeezerChartDto(
                genreId,
                trackList,
                albumList,
                artistList,
                playlistList,
                sliceOf(tracks, trackIndex, trackList.size()),
                sliceOf(albums, albumIndex, albumList.size()),
                sliceOf(artists, artistIndex, artistList.size()),
                sliceOf(playlists, playlistIndex, playlistList.size())
        );
    }

    public DeezerSearchDto search(String query, String type, int index) {
        String q = clean(query);
        String kind = normalizeType(type);
        int start = pageIndex(index);
        String path = ("track".equals(kind) ? "/search" : "/search/" + kind) + pageQuery("", start) + "&q=" + encode(q);
        JsonNode root = fetchOk(path, SEARCH_TTL);
        List<DeezerTrackDto> tracks = "track".equals(kind) ? attachFans(mapTracks(root, null, TRACK_PAGE), List.of()) : List.of();
        List<DeezerAlbumDto> albums = "album".equals(kind) ? mapAlbums(root, false, TRACK_PAGE) : List.of();
        List<DeezerArtistDto> artists = "artist".equals(kind) ? mapArtists(root, TRACK_PAGE) : List.of();
        List<DeezerPlaylistDto> playlists = "playlist".equals(kind) ? mapPlaylists(root, TRACK_PAGE) : List.of();
        int count = switch (kind) {
            case "album" -> albums.size();
            case "artist" -> artists.size();
            case "playlist" -> playlists.size();
            default -> tracks.size();
        };
        DeezerSliceDto slice = sliceOf(root, start, count);
        return new DeezerSearchDto(kind, q, tracks, albums, artists, playlists, slice.index(), slice.total(), slice.hasNext());
    }

    /** Deezer pages are 100 items. Anything else is refused by the controller. */
    public static int pageIndex(int index) {
        if (index < 0 || index > 10_000 || index % TRACK_PAGE != 0) {
            return -1;
        }
        return index;
    }

    static DeezerSliceDto sliceOf(JsonNode root, int index, int count) {
        int total = 0;
        boolean next = false;
        if (root != null && !root.isMissingNode() && !root.isNull()) {
            total = Math.max(0, root.path("total").asInt(0));
            next = !root.path("next").asText("").isBlank();
        }
        // Charts report total equal to this page and omit next, but index + 100 still returns rows.
        boolean full = count >= TRACK_PAGE - 5;
        boolean hasNext = count > 0 && (next || total > index + count || full);
        if (!full && total > 0 && index + count >= total) {
            hasNext = false;
        }
        return new DeezerSliceDto(index, total, hasNext);
    }

    private static String pageQuery(String path, int index) {
        return path + "?limit=" + TRACK_PAGE + "&index=" + index;
    }

    public DeezerTrackDto track(long id, boolean fresh) {
        if (fresh) {
            cache.remove("/track/" + id);
        }
        JsonNode root = fetchOk("/track/" + id, TRACK_TTL);
        if (root == null || root.path("id").asLong(0) <= 0) {
            return null;
        }
        DeezerTrackDto mapped = mapTrack(root, null);
        if (mapped == null) {
            return null;
        }
        List<DeezerTrackDto> filled = attachFans(List.of(mapped), List.of());
        return filled.isEmpty() ? mapped : filled.get(0);
    }

    public DeezerAlbumPageDto album(long id) {
        JsonNode root = fetchOk("/album/" + id, PAGE_TTL);
        if (root == null || root.path("id").asLong(0) <= 0) {
            return null;
        }
        DeezerAlbumDto album = mapAlbum(root);
        if (album == null) {
            return null;
        }
        return new DeezerAlbumPageDto(
                album,
                attachFans(mapTracks(root.path("tracks"), album), List.of()),
                albumDuration(root),
                albumFans(root),
                albumLabel(root),
                albumGenres(root));
    }

    static int albumDuration(JsonNode root) {
        return root == null ? 0 : Math.max(0, root.path("duration").asInt(0));
    }

    static long albumFans(JsonNode root) {
        return root == null ? 0L : Math.max(0L, root.path("fans").asLong(0));
    }

    static String albumLabel(JsonNode root) {
        return root == null ? "" : clean(root.path("label").asText(""));
    }

    /** Genre names from a Deezer album payload. Search hits often omit this block. */
    static List<String> albumGenres(JsonNode root) {
        if (root == null) {
            return List.of();
        }
        List<String> names = new ArrayList<>();
        for (JsonNode genre : arrayOf(root.path("genres"))) {
            String name = clean(genre.path("name").asText(""));
            if (name.isEmpty() || names.contains(name)) {
                continue;
            }
            names.add(name);
            if (names.size() >= 8) {
                break;
            }
        }
        return List.copyOf(names);
    }

    public List<DeezerAlbumDto> artistAlbums(long artistId) {
        return mapAlbums(fetchOk("/artist/" + artistId + "/albums?limit=30", PAGE_TTL), true);
    }

    public DeezerArtistPageDto artist(long artistId) {
        JsonNode root = fetchOk("/artist/" + artistId, PAGE_TTL);
        DeezerArtistDto artist = root == null ? null : mapArtist(root);
        if (artist == null) {
            return null;
        }
        return new DeezerArtistPageDto(
                artist,
                attachFans(mapTracks(optional("/artist/" + artistId + "/top?limit=25", PAGE_TTL), null), List.of(artist)),
                mapAlbums(optional("/artist/" + artistId + "/albums?limit=30", PAGE_TTL), true),
                mapArtists(optional("/artist/" + artistId + "/related?limit=12", PAGE_TTL))
        );
    }

    public DeezerPlaylistPageDto playlist(long id) {
        JsonNode root = fetchOk("/playlist/" + id, PAGE_TTL);
        if (root == null || root.path("id").asLong(0) <= 0) {
            return null;
        }
        DeezerPlaylistDto playlist = mapPlaylist(root);
        if (playlist == null) {
            return null;
        }
        return new DeezerPlaylistPageDto(playlist, attachFans(mapTracks(root.path("tracks"), null), List.of()));
    }

    /**
     * Track lists omit the artist's follower count. Reuse counts already loaded, then look up the rest.
     */
    private List<DeezerTrackDto> attachFans(List<DeezerTrackDto> tracks, List<DeezerArtistDto> known) {
        if (tracks == null || tracks.isEmpty()) {
            return tracks == null ? List.of() : tracks;
        }
        Map<Long, Long> fans = new HashMap<>();
        if (known != null) {
            for (DeezerArtistDto artist : known) {
                if (artist != null && artist.id() > 0) {
                    fans.put(artist.id(), Math.max(0L, artist.fanCount()));
                }
            }
        }
        List<Long> missing = new ArrayList<>();
        for (DeezerTrackDto track : tracks) {
            long artistId = track.artistId();
            if (artistId <= 0) {
                continue;
            }
            if (track.fanCount() > 0) {
                fans.putIfAbsent(artistId, track.fanCount());
            }
            if (!fans.containsKey(artistId) && !missing.contains(artistId)) {
                missing.add(artistId);
            }
        }
        if (!missing.isEmpty()) {
            fans.putAll(loadArtistFans(missing));
        }
        return applyFans(tracks, fans);
    }

    private Map<Long, Long> loadArtistFans(List<Long> ids) {
        Map<Long, Long> found = new ConcurrentHashMap<>();
        Semaphore gate = new Semaphore(8);
        List<Callable<Void>> tasks = new ArrayList<>();
        for (Long id : ids) {
            tasks.add(() -> {
                if (!gate.tryAcquire(8, TimeUnit.SECONDS)) {
                    return null;
                }
                try {
                    found.put(id, lookupArtistFans(id));
                } finally {
                    gate.release();
                }
                return null;
            });
        }
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            pool.invokeAll(tasks, 8, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return found;
    }

    private long lookupArtistFans(long artistId) {
        JsonNode root = optional("/artist/" + artistId, PAGE_TTL);
        return root == null ? 0L : fanCount(root);
    }

    static List<DeezerTrackDto> applyFans(List<DeezerTrackDto> tracks, Map<Long, Long> fans) {
        if (tracks == null || tracks.isEmpty() || fans == null || fans.isEmpty()) {
            return tracks == null ? List.of() : tracks;
        }
        List<DeezerTrackDto> filled = new ArrayList<>(tracks.size());
        boolean changed = false;
        for (DeezerTrackDto track : tracks) {
            Long count = fans.get(track.artistId());
            if (count != null && count > 0 && count != track.fanCount()) {
                filled.add(track.withFanCount(count));
                changed = true;
            } else {
                filled.add(track);
            }
        }
        return changed ? List.copyOf(filled) : tracks;
    }

    static long fanCount(JsonNode hit) {
        if (hit == null || hit.isMissingNode()) {
            return 0L;
        }
        long fans = hit.path("fans").asLong(0);
        if (fans <= 0) {
            fans = hit.path("nb_fan").asLong(0);
        }
        return Math.max(0L, fans);
    }

    static String normalizeType(String type) {
        String value = type == null ? "" : type.trim().toLowerCase(Locale.ROOT);
        return switch (value) {
            case "album", "artist", "playlist" -> value;
            default -> "track";
        };
    }

    static DeezerTrackDto mapTrack(JsonNode hit, DeezerAlbumDto albumFallback) {
        if (hit == null || hit.isMissingNode() || hit.isNull()) {
            return null;
        }
        long id = hit.path("id").asLong(0);
        String title = clean(hit.path("title").asText(""));
        if (id <= 0 || title.isEmpty()) {
            return null;
        }
        JsonNode artist = hit.path("artist");
        JsonNode album = hit.path("album");
        String artistName = clean(artist.path("name").asText(""));
        long artistId = artist.path("id").asLong(0);
        String albumTitle = clean(album.path("title").asText(""));
        long albumId = album.path("id").asLong(0);
        String cover = mediaUrl(firstText(album, "cover_xl", "cover_big", "cover_medium", "cover"));
        if (albumFallback != null) {
            if (artistName.isEmpty()) {
                artistName = albumFallback.artistName();
            }
            if (artistId <= 0) {
                artistId = albumFallback.artistId();
            }
            if (albumTitle.isEmpty()) {
                albumTitle = albumFallback.title();
            }
            if (albumId <= 0) {
                albumId = albumFallback.id();
            }
            if (cover.isEmpty()) {
                cover = albumFallback.coverUrl();
            }
        }
        String release = clean(hit.path("release_date").asText(""));
        if (release.isEmpty()) {
            release = clean(album.path("release_date").asText(""));
        }
        if (release.isEmpty() && albumFallback != null && albumFallback.releaseDate() != null) {
            release = albumFallback.releaseDate();
        }
        return new DeezerTrackDto(
                id,
                title,
                artistName,
                artistId,
                albumTitle,
                albumId,
                cover,
                mediaUrl(hit.path("preview").asText("")),
                Math.max(0, hit.path("duration").asInt(0)),
                hit.path("explicit_lyrics").asBoolean(false) || hit.path("explicit_content_lyrics").asInt(0) == 1,
                pageLink(hit.path("link").asText("")),
                release,
                fanCount(artist)
        );
    }

    private JsonNode optional(String path, Duration ttl) {
        try {
            return fetchOk(path, ttl);
        } catch (UpstreamException e) {
            return null;
        }
    }

    private JsonNode fetchOk(String path, Duration ttl) {
        JsonNode node = fetchRaw(path, ttl);
        if (node == null) {
            throw new UpstreamException();
        }
        if (isDataMissing(node)) {
            return null;
        }
        if (node.has("error")) {
            throw new UpstreamException();
        }
        return node;
    }

    private JsonNode fetchRaw(String path, Duration ttl) {
        long now = System.currentTimeMillis();
        Cached cached = cache.get(path);
        if (cached != null && cached.expiresAt > now) {
            return cached.node;
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(API + path))
                    .timeout(TIMEOUT)
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            String body = response.body();
            if (response.statusCode() < 200 || response.statusCode() >= 300 || body == null || body.isBlank() || body.length() > MAX_BODY) {
                return stale(cached, now);
            }
            JsonNode node = objectMapper.readTree(body);
            if (node == null || node.has("error")) {
                return node == null ? stale(cached, now) : node;
            }
            if (cache.size() > MAX_CACHE) {
                cache.clear();
            }
            cache.put(path, new Cached(node, now + ttl.toMillis(), now));
            return node;
        } catch (UpstreamException e) {
            throw e;
        } catch (Exception e) {
            log.debug("deezer fetch failed for {}: {}", path, e.toString());
            return stale(cached, now);
        }
    }

    private static JsonNode stale(Cached cached, long now) {
        if (cached != null && now - cached.storedAt < STALE_MS) {
            return cached.node;
        }
        return null;
    }

    private static boolean isDataMissing(JsonNode node) {
        int code = node.path("error").path("code").asInt(0);
        return code == 800;
    }

    private List<DeezerTrackDto> mapTracks(JsonNode root, DeezerAlbumDto albumFallback) {
        return mapTracks(root, albumFallback, TRACK_PAGE_DEFAULT);
    }

    private List<DeezerTrackDto> mapTracks(JsonNode root, DeezerAlbumDto albumFallback, int max) {
        List<DeezerTrackDto> tracks = new ArrayList<>();
        int cap = Math.max(0, max);
        for (JsonNode hit : arrayOf(root)) {
            if (tracks.size() >= cap) {
                break;
            }
            DeezerTrackDto track = mapTrack(hit, albumFallback);
            if (track != null) {
                tracks.add(track);
            }
        }
        return List.copyOf(tracks);
    }

    private List<DeezerAlbumDto> mapAlbums(JsonNode root, boolean discography) {
        return mapAlbums(root, discography, 40);
    }

    private List<DeezerAlbumDto> mapAlbums(JsonNode root, boolean discography, int max) {
        List<DeezerAlbumDto> albums = new ArrayList<>();
        int cap = Math.max(0, max);
        for (JsonNode hit : arrayOf(root)) {
            if (albums.size() >= cap) {
                break;
            }
            DeezerAlbumDto album = mapAlbum(hit);
            if (album != null) {
                albums.add(album);
            }
        }
        if (discography && albums.size() > 1) {
            albums.sort(Comparator.comparingInt(album -> recordRank(album.recordType())));
        }
        return List.copyOf(albums);
    }

    static DeezerAlbumDto mapAlbum(JsonNode hit) {
        if (hit == null || hit.isMissingNode()) {
            return null;
        }
        long id = hit.path("id").asLong(0);
        String title = clean(hit.path("title").asText(""));
        if (id <= 0 || title.isEmpty()) {
            return null;
        }
        JsonNode artist = hit.path("artist");
        int tracks = hit.path("nb_tracks").asInt(0);
        if (tracks <= 0 && hit.path("tracks").path("data").isArray()) {
            tracks = hit.path("tracks").path("data").size();
        }
        return new DeezerAlbumDto(
                id,
                title,
                clean(artist.path("name").asText("")),
                artist.path("id").asLong(0),
                mediaUrl(firstText(hit, "cover_xl", "cover_big", "cover_medium", "cover")),
                clean(hit.path("release_date").asText("")),
                Math.max(0, tracks),
                clean(hit.path("record_type").asText("")),
                pageLink(hit.path("link").asText("")),
                fanCount(hit)
        );
    }

    private List<DeezerArtistDto> mapArtists(JsonNode root) {
        return mapArtists(root, 30);
    }

    private List<DeezerArtistDto> mapArtists(JsonNode root, int max) {
        List<DeezerArtistDto> artists = new ArrayList<>();
        int cap = Math.max(0, max);
        for (JsonNode hit : arrayOf(root)) {
            if (artists.size() >= cap) {
                break;
            }
            DeezerArtistDto artist = mapArtist(hit);
            if (artist != null) {
                artists.add(artist);
            }
        }
        return List.copyOf(artists);
    }

    static DeezerArtistDto mapArtist(JsonNode hit) {
        if (hit == null || hit.isMissingNode()) {
            return null;
        }
        long id = hit.path("id").asLong(0);
        String name = clean(hit.path("name").asText(""));
        if (id <= 0 || name.isEmpty()) {
            return null;
        }
        return new DeezerArtistDto(
                id,
                name,
                mediaUrl(firstText(hit, "picture_xl", "picture_big", "picture_medium", "picture")),
                Math.max(0, hit.path("nb_album").asInt(0)),
                Math.max(0, hit.path("nb_fan").asLong(0)),
                pageLink(hit.path("link").asText(""))
        );
    }

    private List<DeezerPlaylistDto> mapPlaylists(JsonNode root) {
        return mapPlaylists(root, 30);
    }

    private List<DeezerPlaylistDto> mapPlaylists(JsonNode root, int max) {
        List<DeezerPlaylistDto> playlists = new ArrayList<>();
        int cap = Math.max(0, max);
        for (JsonNode hit : arrayOf(root)) {
            if (playlists.size() >= cap) {
                break;
            }
            DeezerPlaylistDto playlist = mapPlaylist(hit);
            if (playlist != null) {
                playlists.add(playlist);
            }
        }
        return List.copyOf(playlists);
    }

    static DeezerPlaylistDto mapPlaylist(JsonNode hit) {
        if (hit == null || hit.isMissingNode()) {
            return null;
        }
        long id = hit.path("id").asLong(0);
        String title = clean(hit.path("title").asText(""));
        if (id <= 0 || title.isEmpty()) {
            return null;
        }
        String user = clean(hit.path("user").path("name").asText(""));
        if (user.isEmpty()) {
            user = clean(hit.path("creator").path("name").asText(""));
        }
        int tracks = hit.path("nb_tracks").asInt(0);
        if (tracks <= 0 && hit.path("tracks").path("data").isArray()) {
            tracks = hit.path("tracks").path("data").size();
        }
        return new DeezerPlaylistDto(
                id,
                title,
                user,
                mediaUrl(firstText(hit, "picture_xl", "picture_big", "picture_medium", "picture")),
                Math.max(0, tracks),
                pageLink(hit.path("link").asText("")),
                fanCount(hit)
        );
    }

    private static List<JsonNode> arrayOf(JsonNode root) {
        if (root == null || root.isNull() || root.isMissingNode()) {
            return List.of();
        }
        JsonNode data = root.isArray() ? root : root.path("data");
        if (!data.isArray()) {
            return List.of();
        }
        List<JsonNode> items = new ArrayList<>();
        data.forEach(items::add);
        return items;
    }

    static String mediaUrl(String raw) {
        String url = https(raw);
        if (url.isEmpty()) {
            return "";
        }
        String host = hostOf(url);
        if (host.endsWith(".dzcdn.net") || "dzcdn.net".equals(host)) {
            return url;
        }
        return "";
    }

    static String pageLink(String raw) {
        String url = https(raw);
        if (url.isEmpty()) {
            return "";
        }
        String host = hostOf(url);
        if (host.equals("deezer.com") || host.endsWith(".deezer.com")) {
            return url;
        }
        return "";
    }

    private static String https(String raw) {
        if (raw == null) {
            return "";
        }
        String url = raw.trim();
        if (url.startsWith("http://")) {
            url = "https://" + url.substring("http://".length());
        }
        if (!url.startsWith("https://") || url.contains(" ")) {
            return "";
        }
        return url;
    }

    private static String hostOf(String url) {
        try {
            String host = URI.create(url).getHost();
            return host == null ? "" : host.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "";
        }
    }

    private static String firstText(JsonNode node, String... fields) {
        if (node == null) {
            return "";
        }
        for (String field : fields) {
            String value = node.path(field).asText("");
            if (!value.isBlank()) {
                return value;
            }
        }
        return "";
    }

    private static String clean(String value) {
        if (value == null) {
            return "";
        }
        return value.replace('\u00a0', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static int recordRank(String recordType) {
        if ("album".equalsIgnoreCase(recordType)) {
            return 0;
        }
        if ("ep".equalsIgnoreCase(recordType)) {
            return 1;
        }
        return 2;
    }

    private record Cached(JsonNode node, long expiresAt, long storedAt) {
    }
}
