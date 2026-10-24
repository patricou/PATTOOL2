package com.pat.service;

import com.pat.controller.dto.DeezerYoutubeLookupRequest;
import com.pat.controller.dto.DeezerYoutubeLookupResponse;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import com.pat.repo.DeezerYoutubeLinkRepository;
import com.pat.repo.domain.DeezerYoutubeLink;
import org.springframework.stereotype.Service;

import java.time.Duration;
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
    private static final Duration MISS_TTL = Duration.ofDays(7);

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
        if (fresh(stored, query)) {
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
        String videoId = pickVideoId(page.items(), track.title());
        DeezerYoutubeLink row = stored == null ? new DeezerYoutubeLink() : stored;
        row.setId(key);
        row.setTrackId(track.id());
        row.setVideoId(videoId);
        row.setQuery(query);
        row.setUpdatedAt(Instant.now());
        repository.save(row);
        return new DeezerYoutubeLookupResponse.Link(track.id(), videoId, false);
    }

    static boolean fresh(DeezerYoutubeLink stored, String query) {
        if (stored == null || stored.getUpdatedAt() == null || !query.equals(stored.getQuery())) {
            return false;
        }
        String videoId = stored.getVideoId() == null ? "" : stored.getVideoId().trim();
        if (!videoId.isEmpty()) {
            return true;
        }
        return stored.getUpdatedAt().isAfter(Instant.now().minus(MISS_TTL));
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
}
