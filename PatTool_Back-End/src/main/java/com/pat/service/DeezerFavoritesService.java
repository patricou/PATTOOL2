package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerAlbumDto;
import com.pat.controller.dto.DeezerArtistDto;
import com.pat.controller.dto.DeezerFavoriteItemDto;
import com.pat.controller.dto.DeezerFavoritesDto;
import com.pat.controller.dto.DeezerPlaylistDto;
import com.pat.controller.dto.DeezerTrackDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Per-user Deezer favorites, stored in {@code appParameters}
 * under key {@code deezer.favorites.<username>}.
 */
@Service
public class DeezerFavoritesService {

    private static final Logger log = LoggerFactory.getLogger(DeezerFavoritesService.class);

    static final String PARAM_KEY_PREFIX = "deezer.favorites.";
    private static final int MAX_FAVORITES = 200;
    private static final int MAX_TEXT = 200;
    private static final long MAX_ID = 10_000_000_000L;
    private static final int MAX_DURATION_SEC = 20_000;
    private static final int MAX_TRACK_COUNT = 10_000;
    private static final long MAX_FAN_COUNT = 2_000_000_000L;
    private static final Set<String> SAFE_KINDS = Set.of("track", "album", "artist", "playlist");
    private static final Pattern RELEASE_DATE = Pattern.compile("\\d{4}(-\\d{2}(-\\d{2})?)?");
    private static final Pattern RECORD_TYPE = Pattern.compile("[A-Za-z0-9 _-]{1,40}");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public DeezerFavoritesService(
            AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public DeezerFavoritesDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new DeezerFavoritesDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new DeezerFavoritesDto();
        }
        try {
            DeezerFavoritesDto dto = objectMapper.readValue(raw, DeezerFavoritesDto.class);
            return normalize(dto);
        } catch (JsonProcessingException e) {
            log.debug("deezer.favorites unreadable JSON: {}", e.getMessage());
            return new DeezerFavoritesDto();
        }
    }

    public DeezerFavoritesDto saveForSubject(String jwtSubject, DeezerFavoritesDto dto) {
        DeezerFavoritesDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Deezer watcher: per-user favorites (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization Deezer favorites", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    public DeezerFavoritesDto addFavorite(String jwtSubject, DeezerFavoriteItemDto item) {
        DeezerFavoriteItemDto normalizedItem = normalizeItem(item);
        if (normalizedItem == null) {
            throw new IllegalArgumentException("invalid item");
        }
        DeezerFavoritesDto current = findForSubject(jwtSubject);
        Map<String, DeezerFavoriteItemDto> byKey = new LinkedHashMap<>();
        byKey.put(favoriteKey(normalizedItem), normalizedItem);
        for (DeezerFavoriteItemDto existing : current.getItems()) {
            String key = favoriteKey(existing);
            if (!byKey.containsKey(key)) {
                byKey.put(key, existing);
            }
        }
        List<DeezerFavoriteItemDto> list = new ArrayList<>(byKey.values());
        if (list.size() > MAX_FAVORITES) {
            list = new ArrayList<>(list.subList(0, MAX_FAVORITES));
        }
        return saveForSubject(jwtSubject, new DeezerFavoritesDto(list));
    }

    public DeezerFavoritesDto removeFavorite(String jwtSubject, long id, String kind) {
        if (!validId(id)) {
            return findForSubject(jwtSubject);
        }
        String kindKey = normalizeKind(kind);
        DeezerFavoritesDto current = findForSubject(jwtSubject);
        List<DeezerFavoriteItemDto> kept = new ArrayList<>();
        for (DeezerFavoriteItemDto item : current.getItems()) {
            if (kindKey != null && kindKey.equals(item.getKind()) && itemId(item) == id) {
                continue;
            }
            kept.add(item);
        }
        return saveForSubject(jwtSubject, new DeezerFavoritesDto(kept));
    }

    private DeezerFavoritesDto normalize(DeezerFavoritesDto dto) {
        if (dto == null || dto.getItems() == null) {
            return new DeezerFavoritesDto();
        }
        Map<String, DeezerFavoriteItemDto> byKey = new LinkedHashMap<>();
        for (DeezerFavoriteItemDto item : dto.getItems()) {
            DeezerFavoriteItemDto n = normalizeItem(item);
            if (n == null) {
                continue;
            }
            byKey.putIfAbsent(favoriteKey(n), n);
            if (byKey.size() >= MAX_FAVORITES) {
                break;
            }
        }
        return new DeezerFavoritesDto(new ArrayList<>(byKey.values()));
    }

    static DeezerFavoriteItemDto normalizeItem(DeezerFavoriteItemDto item) {
        if (item == null) {
            return null;
        }
        String kind = normalizeKind(item.getKind());
        if (kind == null) {
            return null;
        }
        DeezerFavoriteItemDto out = new DeezerFavoriteItemDto();
        out.setKind(kind);
        switch (kind) {
            case "track" -> {
                DeezerTrackDto track = normalizeTrack(item.getTrack());
                if (track == null) {
                    return null;
                }
                out.setTrack(track);
            }
            case "album" -> {
                DeezerAlbumDto album = normalizeAlbum(item.getAlbum());
                if (album == null) {
                    return null;
                }
                out.setAlbum(album);
            }
            case "artist" -> {
                DeezerArtistDto artist = normalizeArtist(item.getArtist());
                if (artist == null) {
                    return null;
                }
                out.setArtist(artist);
            }
            default -> {
                DeezerPlaylistDto playlist = normalizePlaylist(item.getPlaylist());
                if (playlist == null) {
                    return null;
                }
                out.setPlaylist(playlist);
            }
        }
        return out;
    }

    static String favoriteKey(DeezerFavoriteItemDto item) {
        return item.getKind() + "|" + itemId(item);
    }

    private static long itemId(DeezerFavoriteItemDto item) {
        if (item == null || item.getKind() == null) {
            return 0L;
        }
        return switch (item.getKind()) {
            case "track" -> item.getTrack() == null ? 0L : item.getTrack().id();
            case "album" -> item.getAlbum() == null ? 0L : item.getAlbum().id();
            case "artist" -> item.getArtist() == null ? 0L : item.getArtist().id();
            case "playlist" -> item.getPlaylist() == null ? 0L : item.getPlaylist().id();
            default -> 0L;
        };
    }

    private static DeezerTrackDto normalizeTrack(DeezerTrackDto track) {
        if (track == null || !validId(track.id())) {
            return null;
        }
        String title = trimTo(track.title(), MAX_TEXT);
        if (!StringUtils.hasText(title)) {
            return null;
        }
        return new DeezerTrackDto(
                track.id(),
                title,
                trimTo(track.artistName(), MAX_TEXT),
                validId(track.artistId()) ? track.artistId() : 0L,
                trimTo(track.albumTitle(), MAX_TEXT),
                validId(track.albumId()) ? track.albumId() : 0L,
                media(track.coverUrl()),
                media(track.previewUrl()),
                clamp(track.durationSec(), 0, MAX_DURATION_SEC),
                track.explicit(),
                page(track.link())
        );
    }

    private static DeezerAlbumDto normalizeAlbum(DeezerAlbumDto album) {
        if (album == null || !validId(album.id())) {
            return null;
        }
        String title = trimTo(album.title(), MAX_TEXT);
        if (!StringUtils.hasText(title)) {
            return null;
        }
        return new DeezerAlbumDto(
                album.id(),
                title,
                trimTo(album.artistName(), MAX_TEXT),
                validId(album.artistId()) ? album.artistId() : 0L,
                media(album.coverUrl()),
                releaseDate(album.releaseDate()),
                clamp(album.trackCount(), 0, MAX_TRACK_COUNT),
                recordType(album.recordType()),
                page(album.link())
        );
    }

    private static DeezerArtistDto normalizeArtist(DeezerArtistDto artist) {
        if (artist == null || !validId(artist.id())) {
            return null;
        }
        String name = trimTo(artist.name(), MAX_TEXT);
        if (!StringUtils.hasText(name)) {
            return null;
        }
        long fans = artist.fanCount();
        if (fans < 0) {
            fans = 0;
        } else if (fans > MAX_FAN_COUNT) {
            fans = MAX_FAN_COUNT;
        }
        return new DeezerArtistDto(
                artist.id(),
                name,
                media(artist.pictureUrl()),
                clamp(artist.albumCount(), 0, MAX_TRACK_COUNT),
                fans,
                page(artist.link())
        );
    }

    private static DeezerPlaylistDto normalizePlaylist(DeezerPlaylistDto playlist) {
        if (playlist == null || !validId(playlist.id())) {
            return null;
        }
        String title = trimTo(playlist.title(), MAX_TEXT);
        if (!StringUtils.hasText(title)) {
            return null;
        }
        return new DeezerPlaylistDto(
                playlist.id(),
                title,
                trimTo(playlist.userName(), MAX_TEXT),
                media(playlist.pictureUrl()),
                clamp(playlist.trackCount(), 0, MAX_TRACK_COUNT),
                page(playlist.link())
        );
    }

    private static String normalizeKind(String kind) {
        if (!StringUtils.hasText(kind)) {
            return null;
        }
        String value = kind.trim().toLowerCase(Locale.ROOT);
        return SAFE_KINDS.contains(value) ? value : null;
    }

    private static boolean validId(long id) {
        return id > 0 && id < MAX_ID;
    }

    private static String media(String raw) {
        String url = DeezerCatalogService.mediaUrl(raw);
        return StringUtils.hasText(url) ? url : null;
    }

    private static String page(String raw) {
        String url = DeezerCatalogService.pageLink(raw);
        return StringUtils.hasText(url) ? url : null;
    }

    private static String releaseDate(String raw) {
        String value = trimTo(raw, 10);
        if (!StringUtils.hasText(value) || !RELEASE_DATE.matcher(value).matches()) {
            return null;
        }
        return value;
    }

    private static String recordType(String raw) {
        String value = trimTo(raw, 40);
        if (!StringUtils.hasText(value) || !RECORD_TYPE.matcher(value).matches()) {
            return null;
        }
        return value;
    }

    private static int clamp(int value, int min, int max) {
        if (value < min) {
            return min;
        }
        return Math.min(value, max);
    }

    private static String trimTo(String value, int max) {
        if (value == null) {
            return null;
        }
        String t = value.replaceAll("[\\p{Cntrl}]", "").trim();
        if (t.isEmpty()) {
            return null;
        }
        return t.length() > max ? t.substring(0, max) : t;
    }
}
