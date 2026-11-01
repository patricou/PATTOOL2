package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerConcertDto;
import com.pat.controller.dto.DeezerConcertTrackDto;
import com.pat.controller.dto.DeezerFavoriteItemDto;
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
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Per-user concert list, stored in {@code appParameters}
 * under key {@code deezer.concert.<username>}. Titles come from the other Deezer tabs.
 */
@Service
public class DeezerConcertService {

    private static final Logger log = LoggerFactory.getLogger(DeezerConcertService.class);

    static final String PARAM_KEY_PREFIX = "deezer.concert.";
    static final int MAX_TRACKS = 200;
    static final int MAX_NAME = 120;
    static final int MAX_URL = 500;
    /** Player ids sit above any Deezer catalog id so they never collide in the YouTube link map. */
    static final long PLAY_ID_BASE = 1_000_000_000_000L;

    private static final Pattern TRACK_ID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern BARE_VIDEO_ID = Pattern.compile("^[a-zA-Z0-9_-]{11}$");
    private static final Pattern VIDEO_IN_URL = Pattern.compile(
            "(?i)(?:youtu\\.be/|(?:youtube(?:-nocookie)?\\.com|music\\.youtube\\.com)/(?:embed/|shorts/|live/|v/)|[?&]v=)([a-zA-Z0-9_-]{11})");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public DeezerConcertService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public DeezerConcertDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return new DeezerConcertDto();
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return new DeezerConcertDto();
        }
        try {
            return normalize(objectMapper.readValue(raw, DeezerConcertDto.class));
        } catch (JsonProcessingException e) {
            log.debug("deezer.concert unreadable JSON: {}", e.getMessage());
            return new DeezerConcertDto();
        }
    }

    public DeezerConcertDto add(String jwtSubject, DeezerTrackDto track, String name, String videoId) {
        DeezerTrackDto source = normalizeSource(track);
        if (source == null) {
            throw new IllegalArgumentException("invalid track");
        }
        String trackName = normalizeName(name);
        if (trackName == null) {
            throw new IllegalArgumentException("invalid name");
        }
        DeezerConcertDto current = findForSubject(jwtSubject);
        if (current.getTracks().size() >= MAX_TRACKS) {
            throw new IllegalArgumentException("too many tracks");
        }
        DeezerConcertTrackDto created = new DeezerConcertTrackDto();
        created.setId(UUID.randomUUID().toString());
        created.setPlayId(nextPlayId(current.getTracks()));
        created.setVideoId(videoIdFrom(videoId));
        created.setName(trackName);
        created.setTrack(source);
        List<DeezerConcertTrackDto> next = new ArrayList<>(current.getTracks());
        next.add(created);
        return saveForSubject(jwtSubject, new DeezerConcertDto(next));
    }

    public DeezerConcertDto rename(String jwtSubject, String trackId, String name) {
        String id = requireId(trackId);
        String trackName = normalizeName(name);
        if (trackName == null) {
            throw new IllegalArgumentException("invalid name");
        }
        DeezerConcertDto current = findForSubject(jwtSubject);
        DeezerConcertTrackDto track = findTrack(current, id);
        track.setName(trackName);
        return saveForSubject(jwtSubject, current);
    }

    public DeezerConcertDto delete(String jwtSubject, String trackId) {
        String id = requireId(trackId);
        DeezerConcertDto current = findForSubject(jwtSubject);
        List<DeezerConcertTrackDto> kept = new ArrayList<>();
        for (DeezerConcertTrackDto track : current.getTracks()) {
            if (!id.equalsIgnoreCase(track.getId())) {
                kept.add(track);
            }
        }
        return saveForSubject(jwtSubject, new DeezerConcertDto(kept));
    }

    static String videoIdFrom(String raw) {
        if (raw == null) {
            return null;
        }
        String text = raw.trim();
        if (text.isEmpty() || text.length() > MAX_URL) {
            return null;
        }
        if (BARE_VIDEO_ID.matcher(text).matches()) {
            return text;
        }
        String lower = text.toLowerCase(Locale.ROOT);
        boolean youtube = lower.contains("youtube.com")
                || lower.contains("youtube-nocookie.com")
                || lower.contains("youtu.be");
        if (!youtube) {
            return null;
        }
        Matcher match = VIDEO_IN_URL.matcher(text);
        if (!match.find()) {
            return null;
        }
        return match.group(1);
    }

    private DeezerConcertDto saveForSubject(String jwtSubject, DeezerConcertDto dto) {
        DeezerConcertDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            String json = objectMapper.writeValueAsString(normalized);
            appParameterService.setJson(
                    key,
                    json,
                    "Deezer watcher: per-user concert titles (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization Deezer concert", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return normalized;
    }

    private static DeezerConcertDto normalize(DeezerConcertDto dto) {
        if (dto == null || dto.getTracks() == null) {
            return new DeezerConcertDto();
        }
        Map<String, DeezerConcertTrackDto> byId = new LinkedHashMap<>();
        for (DeezerConcertTrackDto track : dto.getTracks()) {
            DeezerConcertTrackDto normalized = normalizeTrack(track, byId);
            if (normalized == null) {
                continue;
            }
            byId.put(normalized.getId(), normalized);
            if (byId.size() >= MAX_TRACKS) {
                break;
            }
        }
        return new DeezerConcertDto(new ArrayList<>(byId.values()));
    }

    private static DeezerConcertTrackDto normalizeTrack(
            DeezerConcertTrackDto track, Map<String, DeezerConcertTrackDto> accepted) {
        if (track == null || !validId(track.getId())) {
            return null;
        }
        DeezerTrackDto source = normalizeSource(track.getTrack());
        if (source == null) {
            return null;
        }
        String name = normalizeName(track.getName());
        if (name == null) {
            return null;
        }
        String id = track.getId().trim().toLowerCase(Locale.ROOT);
        if (accepted.containsKey(id)) {
            return null;
        }
        DeezerConcertTrackDto out = new DeezerConcertTrackDto();
        out.setId(id);
        out.setVideoId(videoIdFrom(track.getVideoId()));
        out.setName(name);
        out.setTrack(source);
        out.setPlayId(usablePlayId(track.getPlayId(), accepted) ? track.getPlayId() : nextPlayId(accepted.values()));
        return out;
    }

    private static DeezerTrackDto normalizeSource(DeezerTrackDto track) {
        DeezerFavoriteItemDto item = new DeezerFavoriteItemDto();
        item.setKind("track");
        item.setTrack(track);
        DeezerFavoriteItemDto normalized = DeezerFavoritesService.normalizeItem(item);
        return normalized == null ? null : normalized.getTrack();
    }

    private static boolean usablePlayId(long playId, Map<String, DeezerConcertTrackDto> accepted) {
        if (playId < PLAY_ID_BASE || playId > PLAY_ID_BASE + 0xFFFF_FFFFL) {
            return false;
        }
        for (DeezerConcertTrackDto track : accepted.values()) {
            if (track.getPlayId() == playId) {
                return false;
            }
        }
        return true;
    }

    private static long nextPlayId(Iterable<DeezerConcertTrackDto> tracks) {
        for (int attempt = 0; attempt < 8; attempt++) {
            long candidate = PLAY_ID_BASE + (UUID.randomUUID().getLeastSignificantBits() & 0xFFFF_FFFFL);
            boolean used = false;
            for (DeezerConcertTrackDto track : tracks) {
                if (track.getPlayId() == candidate) {
                    used = true;
                    break;
                }
            }
            if (!used) {
                return candidate;
            }
        }
        throw new IllegalArgumentException("too many tracks");
    }

    private static DeezerConcertTrackDto findTrack(DeezerConcertDto current, String id) {
        for (DeezerConcertTrackDto track : current.getTracks()) {
            if (track.getId() != null && track.getId().equalsIgnoreCase(id)) {
                return track;
            }
        }
        throw new IllegalArgumentException("not found");
    }

    private static String requireId(String trackId) {
        if (!validId(trackId)) {
            throw new IllegalArgumentException("invalid track");
        }
        return trackId.trim().toLowerCase(Locale.ROOT);
    }

    private static boolean validId(String id) {
        return id != null && TRACK_ID.matcher(id.trim()).matches();
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
