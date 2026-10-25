package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerFavoriteItemDto;
import com.pat.controller.dto.DeezerPlaylistOrderRequest;
import com.pat.controller.dto.DeezerTrackDto;
import com.pat.controller.dto.DeezerUserPlaylistDto;
import com.pat.controller.dto.DeezerUserPlaylistsDto;
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
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Per-user Deezer playlists, stored in {@code appParameters}
 * under key {@code deezer.playlists.<username>}.
 */
@Service
public class DeezerPlaylistsService {

    private static final Logger log = LoggerFactory.getLogger(DeezerPlaylistsService.class);

    static final String PARAM_KEY_PREFIX = "deezer.playlists.";
    static final int MAX_PLAYLISTS = 30;
    static final int MAX_TRACKS = 100;
    static final int MAX_NAME = 80;
    private static final Pattern PLAYLIST_ID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public DeezerPlaylistsService(
            AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public DeezerUserPlaylistsDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new DeezerUserPlaylistsDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new DeezerUserPlaylistsDto();
        }
        try {
            return normalize(objectMapper.readValue(raw, DeezerUserPlaylistsDto.class));
        } catch (JsonProcessingException e) {
            log.debug("deezer.playlists unreadable JSON: {}", e.getMessage());
            return new DeezerUserPlaylistsDto();
        }
    }

    public DeezerUserPlaylistsDto create(String jwtSubject, String name, DeezerTrackDto track) {
        String playlistName = normalizeName(name);
        if (playlistName == null) {
            throw new IllegalArgumentException("invalid name");
        }
        DeezerTrackDto normalizedTrack = track == null ? null : normalizeTrack(track);
        if (track != null && normalizedTrack == null) {
            throw new IllegalArgumentException("invalid track");
        }
        DeezerUserPlaylistsDto current = findForSubject(jwtSubject);
        if (current.getPlaylists().size() >= MAX_PLAYLISTS) {
            throw new IllegalArgumentException("too many playlists");
        }
        DeezerUserPlaylistDto created = new DeezerUserPlaylistDto();
        created.setId(UUID.randomUUID().toString());
        created.setName(playlistName);
        if (normalizedTrack != null) {
            created.getTracks().add(normalizedTrack);
        }
        List<DeezerUserPlaylistDto> next = new ArrayList<>();
        next.add(created);
        next.addAll(current.getPlaylists());
        return saveForSubject(jwtSubject, new DeezerUserPlaylistsDto(next));
    }

    public DeezerUserPlaylistsDto rename(String jwtSubject, String playlistId, String name) {
        String id = requireId(playlistId);
        String playlistName = normalizeName(name);
        if (playlistName == null) {
            throw new IllegalArgumentException("invalid name");
        }
        DeezerUserPlaylistsDto current = findForSubject(jwtSubject);
        DeezerUserPlaylistDto playlist = findPlaylist(current, id);
        playlist.setName(playlistName);
        return saveForSubject(jwtSubject, current);
    }

    public DeezerUserPlaylistsDto delete(String jwtSubject, String playlistId) {
        String id = requireId(playlistId);
        DeezerUserPlaylistsDto current = findForSubject(jwtSubject);
        List<DeezerUserPlaylistDto> kept = new ArrayList<>();
        for (DeezerUserPlaylistDto playlist : current.getPlaylists()) {
            if (!id.equals(playlist.getId())) {
                kept.add(playlist);
            }
        }
        return saveForSubject(jwtSubject, new DeezerUserPlaylistsDto(kept));
    }

    public DeezerUserPlaylistsDto addTrack(String jwtSubject, String playlistId, DeezerTrackDto track) {
        String id = requireId(playlistId);
        DeezerTrackDto normalizedTrack = normalizeTrack(track);
        if (normalizedTrack == null) {
            throw new IllegalArgumentException("invalid track");
        }
        DeezerUserPlaylistsDto current = findForSubject(jwtSubject);
        DeezerUserPlaylistDto playlist = findPlaylist(current, id);
        for (DeezerTrackDto existing : playlist.getTracks()) {
            if (existing.id() == normalizedTrack.id()) {
                return current;
            }
        }
        if (playlist.getTracks().size() >= MAX_TRACKS) {
            throw new IllegalArgumentException("too many tracks");
        }
        playlist.getTracks().add(normalizedTrack);
        return saveForSubject(jwtSubject, current);
    }

    public DeezerUserPlaylistsDto removeTrack(String jwtSubject, String playlistId, long trackId) {
        String id = requireId(playlistId);
        if (trackId <= 0) {
            throw new IllegalArgumentException("invalid track");
        }
        DeezerUserPlaylistsDto current = findForSubject(jwtSubject);
        DeezerUserPlaylistDto playlist = findPlaylist(current, id);
        playlist.getTracks().removeIf(track -> track.id() == trackId);
        return saveForSubject(jwtSubject, current);
    }

    public DeezerUserPlaylistsDto reorder(String jwtSubject, String playlistId, DeezerPlaylistOrderRequest request) {
        String id = requireId(playlistId);
        DeezerUserPlaylistsDto current = findForSubject(jwtSubject);
        DeezerUserPlaylistDto playlist = findPlaylist(current, id);
        List<Long> requested = request == null || request.getTrackIds() == null
                ? List.of()
                : request.getTrackIds();
        Map<Long, DeezerTrackDto> byId = new LinkedHashMap<>();
        for (DeezerTrackDto track : playlist.getTracks()) {
            byId.putIfAbsent(track.id(), track);
        }
        List<DeezerTrackDto> ordered = new ArrayList<>();
        for (Long trackId : requested) {
            if (trackId == null) {
                continue;
            }
            DeezerTrackDto track = byId.remove(trackId);
            if (track != null) {
                ordered.add(track);
            }
        }
        ordered.addAll(byId.values());
        playlist.setTracks(ordered);
        return saveForSubject(jwtSubject, current);
    }

    static boolean validId(String id) {
        return id != null && PLAYLIST_ID.matcher(id.trim()).matches();
    }

    private DeezerUserPlaylistsDto saveForSubject(String jwtSubject, DeezerUserPlaylistsDto dto) {
        DeezerUserPlaylistsDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Deezer watcher: per-user playlists (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization Deezer playlists", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    private static DeezerUserPlaylistsDto normalize(DeezerUserPlaylistsDto dto) {
        if (dto == null || dto.getPlaylists() == null) {
            return new DeezerUserPlaylistsDto();
        }
        Map<String, DeezerUserPlaylistDto> byId = new LinkedHashMap<>();
        for (DeezerUserPlaylistDto playlist : dto.getPlaylists()) {
            DeezerUserPlaylistDto normalized = normalizePlaylist(playlist);
            if (normalized == null) {
                continue;
            }
            byId.putIfAbsent(normalized.getId().toLowerCase(Locale.ROOT), normalized);
            if (byId.size() >= MAX_PLAYLISTS) {
                break;
            }
        }
        return new DeezerUserPlaylistsDto(new ArrayList<>(byId.values()));
    }

    private static DeezerUserPlaylistDto normalizePlaylist(DeezerUserPlaylistDto playlist) {
        if (playlist == null || !validId(playlist.getId())) {
            return null;
        }
        String name = normalizeName(playlist.getName());
        if (name == null) {
            return null;
        }
        DeezerUserPlaylistDto out = new DeezerUserPlaylistDto();
        out.setId(playlist.getId().trim().toLowerCase(Locale.ROOT));
        out.setName(name);
        Map<Long, DeezerTrackDto> tracks = new LinkedHashMap<>();
        if (playlist.getTracks() != null) {
            for (DeezerTrackDto track : playlist.getTracks()) {
                DeezerTrackDto normalized = normalizeTrack(track);
                if (normalized == null) {
                    continue;
                }
                tracks.putIfAbsent(normalized.id(), normalized);
                if (tracks.size() >= MAX_TRACKS) {
                    break;
                }
            }
        }
        out.setTracks(new ArrayList<>(tracks.values()));
        return out;
    }

    private static DeezerUserPlaylistDto findPlaylist(DeezerUserPlaylistsDto current, String id) {
        String key = id.toLowerCase(Locale.ROOT);
        for (DeezerUserPlaylistDto playlist : current.getPlaylists()) {
            if (playlist.getId() != null && playlist.getId().equalsIgnoreCase(key)) {
                return playlist;
            }
        }
        throw new IllegalArgumentException("not found");
    }

    private static String requireId(String playlistId) {
        if (!validId(playlistId)) {
            throw new IllegalArgumentException("invalid playlist");
        }
        return playlistId.trim().toLowerCase(Locale.ROOT);
    }

    private static DeezerTrackDto normalizeTrack(DeezerTrackDto track) {
        if (track == null) {
            return null;
        }
        DeezerFavoriteItemDto item = new DeezerFavoriteItemDto();
        item.setKind("track");
        item.setTrack(track);
        DeezerFavoriteItemDto normalized = DeezerFavoritesService.normalizeItem(item);
        return normalized == null ? null : normalized.getTrack();
    }

    private static String normalizeName(String raw) {
        if (raw == null) {
            return null;
        }
        String name = raw.replaceAll("[\\p{Cntrl}]", "").trim();
        if (name.isEmpty()) {
            return null;
        }
        return name.length() > MAX_NAME ? name.substring(0, MAX_NAME) : name;
    }
}
