package com.pat.service;

import com.pat.controller.dto.DeezerYoutubeLookupRequest;
import com.pat.controller.dto.DeezerYoutubeLookupResponse;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import com.pat.repo.DeezerYoutubeLinkRepository;
import com.pat.repo.domain.DeezerYoutubeLink;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resolves a YouTube video for the Deezer tracks on screen and stores the choice.
 * A later visit of the same track reads the database and does not call YouTube.
 */
@Service
public class DeezerYoutubeLinkService {

    public static final int MAX_TRACKS = 20;

    private final DeezerYoutubeLinkRepository repository;
    private final YoutubeProxyService youtubeProxyService;
    private final ConcurrentHashMap<Long, Object> locks = new ConcurrentHashMap<>();

    public DeezerYoutubeLinkService(
            DeezerYoutubeLinkRepository repository,
            YoutubeProxyService youtubeProxyService) {
        this.repository = repository;
        this.youtubeProxyService = youtubeProxyService;
    }

    public DeezerYoutubeLookupResponse resolve(List<DeezerYoutubeLookupRequest.Track> tracks, boolean search) {
        List<DeezerYoutubeLookupResponse.Link> links = new ArrayList<>();
        if (tracks == null || tracks.isEmpty()) {
            return new DeezerYoutubeLookupResponse(links);
        }
        int kept = 0;
        Map<Long, DeezerYoutubeLookupRequest.Track> unique = new LinkedHashMap<>();
        for (DeezerYoutubeLookupRequest.Track track : tracks) {
            if (track == null || track.id() <= 0 || unique.containsKey(track.id())) {
                continue;
            }
            if (queryOf(track.artist(), track.title()).length() < 2) {
                continue;
            }
            unique.put(track.id(), track);
            if (++kept >= MAX_TRACKS) {
                break;
            }
        }
        for (DeezerYoutubeLookupRequest.Track track : unique.values()) {
            DeezerYoutubeLookupResponse.Link link = resolveOne(track, search);
            if (link != null) {
                links.add(link);
            }
        }
        return new DeezerYoutubeLookupResponse(links);
    }

    private DeezerYoutubeLookupResponse.Link resolveOne(DeezerYoutubeLookupRequest.Track track, boolean search) {
        Object lock = locks.computeIfAbsent(track.id(), id -> new Object());
        synchronized (lock) {
            try {
                return resolveLocked(track, search);
            } finally {
                locks.remove(track.id(), lock);
            }
        }
    }

    private DeezerYoutubeLookupResponse.Link resolveLocked(DeezerYoutubeLookupRequest.Track track, boolean search) {
        String query = queryOf(track.artist(), track.title());
        String key = Long.toString(track.id());
        DeezerYoutubeLink stored = repository.findById(key).orElse(null);
        String commit = saveVideoId(track);
        if (!commit.isEmpty()) {
            if (!commit.matches("^[a-zA-Z0-9_-]{11}$")) {
                return null;
            }
            return store(track, stored, key, query, commit, true);
        }
        if (skipVideoId(track).isEmpty() && fresh(stored, query)) {
            return new DeezerYoutubeLookupResponse.Link(
                    track.id(),
                    stored.getVideoId() == null ? "" : stored.getVideoId(),
                    true);
        }
        if (!search || youtubeProxyService == null || !youtubeProxyService.isConfigured()) {
            return null;
        }
        YoutubeSearchPageDto page = youtubeProxyService.search(query, "video", null, null, null, null, 5, null, null);
        if (page == null || page.error() != null) {
            return null;
        }
        String skip = skipVideoId(track);
        String videoId = pickVideoId(page.items(), track.title(), skip);
        if (!skip.isEmpty()) {
            if (videoId.isEmpty() || videoId.equals(skip)) {
                if (stored != null && stored.getVideoId() != null && !stored.getVideoId().isBlank()) {
                    return new DeezerYoutubeLookupResponse.Link(track.id(), stored.getVideoId(), true);
                }
                return null;
            }
            return new DeezerYoutubeLookupResponse.Link(track.id(), videoId, false);
        }
        return store(track, stored, key, query, videoId, false);
    }

    static boolean fresh(DeezerYoutubeLink stored, String query) {
        return stored != null
                && stored.getUpdatedAt() != null
                && query.equals(stored.getQuery());
    }

    static String queryOf(String artist, String title) {
        String raw = ((artist == null ? "" : artist) + " " + (title == null ? "" : title))
                .replaceAll("\\s+", " ")
                .trim();
        if (raw.length() > 100) {
            raw = raw.substring(0, 100).trim();
        }
        return raw;
    }

    static String pickVideoId(List<YoutubeItemDto> items, String title) {
        return pickVideoId(items, title, "");
    }

    /** The next video after {@code skipVideoId}, or the best title match when nothing is skipped. */
    static String pickVideoId(List<YoutubeItemDto> items, String title, String skipVideoId) {
        if (items == null || items.isEmpty()) {
            return "";
        }
        List<YoutubeItemDto> videos = new ArrayList<>();
        for (YoutubeItemDto item : items) {
            if (item == null || item.id() == null || !item.id().matches("^[a-zA-Z0-9_-]{11}$")) {
                continue;
            }
            String kind = item.kind() == null ? "" : item.kind();
            if ("channel".equals(kind) || "playlist".equals(kind)) {
                continue;
            }
            videos.add(item);
        }
        if (videos.isEmpty()) {
            return "";
        }
        String skip = skipVideoId == null ? "" : skipVideoId.trim();
        if (!skip.isEmpty()) {
            int at = -1;
            for (int i = 0; i < videos.size(); i++) {
                if (skip.equals(videos.get(i).id())) {
                    at = i;
                    break;
                }
            }
            if (at >= 0) {
                return videos.size() == 1 ? skip : videos.get((at + 1) % videos.size()).id();
            }
            for (YoutubeItemDto item : videos) {
                if (!skip.equals(item.id())) {
                    return item.id();
                }
            }
            return "";
        }
        String[] words = (title == null ? "" : title).toLowerCase(Locale.ROOT).split("\\s+");
        for (YoutubeItemDto item : videos) {
            String hay = item.title() == null ? "" : item.title().toLowerCase(Locale.ROOT);
            for (String word : words) {
                if (word.length() > 2 && hay.contains(word)) {
                    return item.id();
                }
            }
        }
        return videos.get(0).id();
    }

    private DeezerYoutubeLookupResponse.Link store(
            DeezerYoutubeLookupRequest.Track track,
            DeezerYoutubeLink stored,
            String key,
            String query,
            String videoId,
            boolean cached) {
        DeezerYoutubeLink row = stored == null ? new DeezerYoutubeLink() : stored;
        row.setId(key);
        row.setTrackId(track.id());
        row.setVideoId(videoId);
        row.setQuery(query);
        row.setUpdatedAt(Instant.now());
        repository.save(row);
        return new DeezerYoutubeLookupResponse.Link(track.id(), videoId, cached);
    }

    private static String skipVideoId(DeezerYoutubeLookupRequest.Track track) {
        return track.skipVideoId() == null ? "" : track.skipVideoId().trim();
    }

    private static String saveVideoId(DeezerYoutubeLookupRequest.Track track) {
        return track.saveVideoId() == null ? "" : track.saveVideoId().trim();
    }
}
