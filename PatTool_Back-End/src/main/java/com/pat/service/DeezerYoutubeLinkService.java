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
    public static final int MAX_STORED = 400;
    /** How many clips one YouTube search may ask for. The badge uses the stored list, not this cap. */
    static final int SEARCH_RESULTS = 10;
    /** Stored when a search page has no following page. */
    static final String NO_MORE = "-";
    private static final int MAX_CANDIDATES = 200;

    private final DeezerYoutubeLinkRepository repository;
    private final YoutubeProxyService youtubeProxyService;
    private final ConcurrentHashMap<Long, Object> locks = new ConcurrentHashMap<>();

    public DeezerYoutubeLinkService(
            DeezerYoutubeLinkRepository repository,
            YoutubeProxyService youtubeProxyService) {
        this.repository = repository;
        this.youtubeProxyService = youtubeProxyService;
    }

    public long countStoredLinks() {
        return repository.countWithVideo();
    }

    /** Drops every saved Deezer → YouTube choice, including empty misses. */
    public int clearStoredLinks() {
        long links = repository.countWithVideo();
        repository.deleteAll();
        locks.clear();
        return links > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) links;
    }

    /** Drops the stored clip list for one Deezer track. */
    public boolean clearStoredLink(long trackId) {
        if (trackId <= 0) {
            return false;
        }
        String key = Long.toString(trackId);
        if (!repository.existsById(key)) {
            locks.remove(trackId);
            return false;
        }
        repository.deleteById(key);
        locks.remove(trackId);
        return true;
    }

    /** Drops one clip from a title's stored list. The row goes away when nothing remains. */
    public boolean dropStoredClip(long trackId, String videoId) {
        String clip = videoId == null ? "" : videoId.trim();
        if (trackId <= 0 || !clip.matches("^[a-zA-Z0-9_-]{11}$")) {
            return false;
        }
        String key = Long.toString(trackId);
        DeezerYoutubeLink row = repository.findById(key).orElse(null);
        if (row == null) {
            return false;
        }
        List<String> ids = new ArrayList<>(idsOf(row));
        String chosen = row.getVideoId() == null ? "" : row.getVideoId().trim();
        if (ids.isEmpty() && chosen.matches("^[a-zA-Z0-9_-]{11}$")) {
            ids.add(chosen);
        }
        if (!ids.remove(clip)) {
            return false;
        }
        if (clip.equals(chosen)) {
            chosen = ids.isEmpty() ? "" : ids.get(0);
        }
        if (chosen.isEmpty() && ids.isEmpty()) {
            repository.deleteById(key);
            locks.remove(trackId);
            return true;
        }
        row.setVideoId(chosen);
        row.setVideoIds(ids);
        row.setUpdatedAt(Instant.now());
        repository.save(row);
        locks.remove(trackId);
        return true;
    }

    /** Video ids already stored for these Deezer tracks. Empty misses are omitted. */
    public DeezerYoutubeLookupResponse stored(List<Long> ids) {
        List<DeezerYoutubeLookupResponse.Link> links = new ArrayList<>();
        if (ids == null || ids.isEmpty()) {
            return new DeezerYoutubeLookupResponse(links);
        }
        List<String> keys = new ArrayList<>();
        for (Long id : ids) {
            if (id == null || id <= 0) {
                continue;
            }
            keys.add(Long.toString(id));
            if (keys.size() >= MAX_STORED) {
                break;
            }
        }
        if (keys.isEmpty()) {
            return new DeezerYoutubeLookupResponse(links);
        }
        for (DeezerYoutubeLink row : repository.findAllById(keys)) {
            if (row == null || row.getTrackId() <= 0) {
                continue;
            }
            String videoId = row.getVideoId() == null ? "" : row.getVideoId().trim();
            if (videoId.isEmpty()) {
                continue;
            }
            links.add(new DeezerYoutubeLookupResponse.Link(row.getTrackId(), videoId, true, idsOf(row), hasMore(row)));
        }
        return new DeezerYoutubeLookupResponse(links);
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
            return store(track, stored, key, query, commit, idsOf(stored), true);
        }
        if (track.more()) {
            return fetchMore(track, stored, key, query);
        }
        String skip = skipVideoId(track);
        List<String> known = fresh(stored, query) ? idsOf(stored) : List.of();
        if (!skip.isEmpty()) {
            String next = nextCandidate(known, skip);
            if (!next.isEmpty()) {
                return new DeezerYoutubeLookupResponse.Link(track.id(), next, true, known, hasMore(stored));
            }
        } else if (fresh(stored, query)) {
            return new DeezerYoutubeLookupResponse.Link(
                    track.id(),
                    stored.getVideoId() == null ? "" : stored.getVideoId(),
                    true,
                    known,
                    hasMore(stored));
        }
        if (!search || youtubeProxyService == null || !youtubeProxyService.isConfigured()) {
            return null;
        }
        YoutubeSearchPageDto page = searchPage(query, null);
        if (page == null || page.error() != null) {
            return null;
        }
        List<String> found = candidateIds(page.items());
        String videoId = pickVideoId(page.items(), track.title(), skip);
        if (!skip.isEmpty()) {
            if (videoId.isEmpty() || videoId.equals(skip)) {
                if (stored != null && stored.getVideoId() != null && !stored.getVideoId().isBlank()) {
                    List<String> kept = found.isEmpty() ? idsOf(stored) : found;
                    rememberCandidates(track, stored, key, query, kept, page.nextPageToken(), true);
                    return new DeezerYoutubeLookupResponse.Link(
                            track.id(), stored.getVideoId(), true, idsOf(stored), hasMore(stored));
                }
                return null;
            }
            rememberCandidates(track, stored, key, query, found, page.nextPageToken(), true);
            List<String> listed = stored == null ? found : idsOf(stored);
            return new DeezerYoutubeLookupResponse.Link(
                    track.id(), videoId, false, listed, stored != null && hasMore(stored));
        }
        return store(track, stored, key, query, videoId, found, false, page.nextPageToken(), true);
    }

    /** Appends the next page of clips. The chosen video stays the one already saved. */
    private DeezerYoutubeLookupResponse.Link fetchMore(
            DeezerYoutubeLookupRequest.Track track,
            DeezerYoutubeLink stored,
            String key,
            String query) {
        if (stored == null || !fresh(stored, query)) {
            return null;
        }
        String chosen = stored.getVideoId() == null ? "" : stored.getVideoId().trim();
        if (chosen.isEmpty() && idsOf(stored).isEmpty()) {
            return null;
        }
        if (NO_MORE.equals(stored.getNextToken())) {
            return new DeezerYoutubeLookupResponse.Link(track.id(), chosen, true, idsOf(stored), false);
        }
        if (youtubeProxyService == null || !youtubeProxyService.isConfigured()) {
            return new DeezerYoutubeLookupResponse.Link(track.id(), chosen, true, idsOf(stored), hasMore(stored));
        }
        String token = stored.getNextToken() == null ? "" : stored.getNextToken().trim();
        List<String> known = idsOf(stored);
        if (token.isEmpty()) {
            YoutubeSearchPageDto first = searchPage(query, null);
            if (first == null || first.error() != null) {
                return new DeezerYoutubeLookupResponse.Link(track.id(), chosen, true, known, true);
            }
            known = merge(known, candidateIds(first.items()));
            token = first.nextPageToken() == null ? "" : first.nextPageToken().trim();
            if (token.isEmpty()) {
                stored.setVideoIds(known);
                stored.setNextToken(NO_MORE);
                stored.setUpdatedAt(Instant.now());
                repository.save(stored);
                return new DeezerYoutubeLookupResponse.Link(track.id(), chosen, true, idsOf(stored), false);
            }
        }
        YoutubeSearchPageDto page = searchPage(query, token);
        if (page == null || page.error() != null) {
            stored.setVideoIds(known);
            stored.setNextToken(token);
            stored.setUpdatedAt(Instant.now());
            repository.save(stored);
            return new DeezerYoutubeLookupResponse.Link(track.id(), chosen, true, idsOf(stored), true);
        }
        List<String> extra = candidateIds(page.items());
        known = merge(known, extra);
        String next = page.nextPageToken() == null ? "" : page.nextPageToken().trim();
        boolean exhausted = extra.isEmpty() || next.isEmpty() || next.equals(token) || known.size() >= MAX_CANDIDATES;
        stored.setId(key);
        stored.setTrackId(track.id());
        stored.setQuery(query);
        stored.setVideoIds(known);
        stored.setNextToken(exhausted ? NO_MORE : next);
        stored.setUpdatedAt(Instant.now());
        repository.save(stored);
        return new DeezerYoutubeLookupResponse.Link(track.id(), chosen, true, idsOf(stored), hasMore(stored));
    }

    private YoutubeSearchPageDto searchPage(String query, String pageToken) {
        String token = pageToken == null || pageToken.isBlank() || NO_MORE.equals(pageToken.trim()) ? null : pageToken.trim();
        return youtubeProxyService.search(
                query, "video", "FR", "fr", null, token, SEARCH_RESULTS, null, null, false);
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

    /** The following id in a result list already fetched for this track. Empty when the list cannot answer. */
    static String nextCandidate(List<String> ids, String skipVideoId) {
        if (ids == null || ids.size() < 2) {
            return "";
        }
        String skip = skipVideoId == null ? "" : skipVideoId.trim();
        if (skip.isEmpty()) {
            return "";
        }
        int at = ids.indexOf(skip);
        if (at >= 0) {
            String next = ids.get((at + 1) % ids.size());
            return skip.equals(next) ? "" : next;
        }
        for (String id : ids) {
            if (!skip.equals(id)) {
                return id;
            }
        }
        return "";
    }

    static List<String> candidateIds(List<YoutubeItemDto> items) {
        List<String> ids = new ArrayList<>();
        if (items == null) {
            return ids;
        }
        for (YoutubeItemDto item : items) {
            if (item == null || item.id() == null || !item.id().matches("^[a-zA-Z0-9_-]{11}$")) {
                continue;
            }
            String kind = item.kind() == null ? "" : item.kind();
            if ("channel".equals(kind) || "playlist".equals(kind)) {
                continue;
            }
            if (!ids.contains(item.id())) {
                ids.add(item.id());
            }
        }
        return ids;
    }

    private DeezerYoutubeLookupResponse.Link store(
            DeezerYoutubeLookupRequest.Track track,
            DeezerYoutubeLink stored,
            String key,
            String query,
            String videoId,
            List<String> candidates,
            boolean cached) {
        return store(track, stored, key, query, videoId, candidates, cached, null, false);
    }

    private DeezerYoutubeLookupResponse.Link store(
            DeezerYoutubeLookupRequest.Track track,
            DeezerYoutubeLink stored,
            String key,
            String query,
            String videoId,
            List<String> candidates,
            boolean cached,
            String nextToken,
            boolean replaceToken) {
        DeezerYoutubeLink row = stored == null ? new DeezerYoutubeLink() : stored;
        row.setId(key);
        row.setTrackId(track.id());
        row.setVideoId(videoId);
        row.setVideoIds(candidates == null ? List.of() : candidates);
        if (replaceToken) {
            row.setNextToken(tokenOrNone(nextToken));
        }
        row.setQuery(query);
        row.setUpdatedAt(Instant.now());
        repository.save(row);
        return new DeezerYoutubeLookupResponse.Link(track.id(), videoId, cached, idsOf(row), hasMore(row));
    }

    /** Keeps the saved clip and writes the result list, so the next click does not search again. */
    private void rememberCandidates(
            DeezerYoutubeLookupRequest.Track track,
            DeezerYoutubeLink stored,
            String key,
            String query,
            List<String> candidates,
            String nextToken,
            boolean replaceToken) {
        if (stored == null || candidates == null || candidates.isEmpty()) {
            return;
        }
        stored.setId(key);
        stored.setTrackId(track.id());
        stored.setQuery(query);
        stored.setVideoIds(merge(idsOf(stored), candidates));
        if (replaceToken) {
            stored.setNextToken(tokenOrNone(nextToken));
        }
        stored.setUpdatedAt(Instant.now());
        repository.save(stored);
    }

    /** A blank token means the next page is unknown. {@link #NO_MORE} means it was already loaded. */
    static boolean hasMore(DeezerYoutubeLink row) {
        if (row == null) {
            return false;
        }
        String token = row.getNextToken() == null ? "" : row.getNextToken().trim();
        if (NO_MORE.equals(token)) {
            return false;
        }
        if (!token.isEmpty()) {
            return true;
        }
        String video = row.getVideoId() == null ? "" : row.getVideoId().trim();
        return !video.isEmpty() || !idsOf(row).isEmpty();
    }

    private static String tokenOrNone(String token) {
        if (token == null || token.isBlank() || NO_MORE.equals(token.trim())) {
            return NO_MORE;
        }
        String value = token.trim();
        return value.length() > 4000 ? NO_MORE : value;
    }

    private static List<String> merge(List<String> base, List<String> extra) {
        List<String> ids = new ArrayList<>();
        if (base != null) {
            ids.addAll(base);
        }
        if (extra != null) {
            for (String id : extra) {
                if (id != null && !ids.contains(id)) {
                    ids.add(id);
                }
            }
        }
        if (ids.size() > MAX_CANDIDATES) {
            return new ArrayList<>(ids.subList(0, MAX_CANDIDATES));
        }
        return ids;
    }

    private static List<String> idsOf(DeezerYoutubeLink stored) {
        if (stored == null || stored.getVideoIds() == null) {
            return List.of();
        }
        List<String> ids = new ArrayList<>();
        for (String id : stored.getVideoIds()) {
            if (id != null && id.matches("^[a-zA-Z0-9_-]{11}$") && !ids.contains(id)) {
                ids.add(id);
            }
        }
        return ids;
    }

    private static String skipVideoId(DeezerYoutubeLookupRequest.Track track) {
        return track.skipVideoId() == null ? "" : track.skipVideoId().trim();
    }

    private static String saveVideoId(DeezerYoutubeLookupRequest.Track track) {
        return track.saveVideoId() == null ? "" : track.saveVideoId().trim();
    }
}
