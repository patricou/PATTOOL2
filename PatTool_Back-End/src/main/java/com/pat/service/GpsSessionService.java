package com.pat.service;

import com.pat.controller.dto.GpsRecordedPointDto;
import com.pat.controller.dto.GpsSessionDto;
import com.pat.repo.GpsSessionRepository;
import com.pat.repo.domain.GpsRecordedPoint;
import com.pat.repo.domain.GpsSession;
import com.pat.repo.domain.Member;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

@Service
public class GpsSessionService {

    private static final int MAX_PLANNED = 8_000;
    private static final int MAX_RECORDED = 25_000;
    private static final int MAX_SYNC_BATCH = 4_000;
    private static final Set<String> STATUSES = Set.of("idle", "recording", "paused", "finished");
    private static final Set<String> SOURCES = Set.of("import", "file", "session");

    private final GpsSessionRepository repository;

    public GpsSessionService(GpsSessionRepository repository) {
        this.repository = repository;
    }

    public List<GpsSessionDto> listForMember(Member me) {
        List<GpsSession> list = repository.findByOwnerMemberIdOrderByUpdatedAtDesc(me.getId());
        List<GpsSessionDto> out = new ArrayList<>(list.size());
        for (GpsSession s : list) {
            out.add(toDto(s, false));
        }
        return out;
    }

    public Optional<GpsSessionDto> getForMember(String id, Member me) {
        return repository.findById(id)
                .filter(s -> me.getId().equals(s.getOwnerMemberId()))
                .map(s -> toDto(s, true));
    }

    /**
     * Upsert by {@code clientSessionId} and merge recorded points (idempotent).
     */
    public GpsSessionDto sync(Member me, GpsSessionDto body) {
        if (body == null || !StringUtils.hasText(body.getClientSessionId())) {
            throw new IllegalArgumentException("client_session_required");
        }
        String clientId = body.getClientSessionId().trim();
        if (clientId.length() > 80) {
            throw new IllegalArgumentException("client_session_too_long");
        }
        GpsSession entity = repository.findByOwnerMemberIdAndClientSessionId(me.getId(), clientId)
                .orElseGet(GpsSession::new);
        Date now = new Date();
        if (entity.getId() == null) {
            entity.setOwnerMemberId(me.getId());
            entity.setClientSessionId(clientId);
            entity.setCreatedAt(now);
        } else if (!me.getId().equals(entity.getOwnerMemberId())) {
            throw new SecurityException("not_owner");
        }
        applyMeta(entity, body, me);
        mergePoints(entity, body.getRecordedPoints());
        entity.setUpdatedAt(now);
        if ("recording".equals(entity.getStatus()) && entity.getStartedAt() == null) {
            entity.setStartedAt(now);
        }
        if ("finished".equals(entity.getStatus()) && entity.getFinishedAt() == null) {
            entity.setFinishedAt(now);
        }
        return toDto(repository.save(entity), true);
    }

    public boolean delete(String id, Member me) {
        Optional<GpsSession> opt = repository.findById(id);
        if (opt.isEmpty()) {
            return false;
        }
        GpsSession entity = opt.get();
        if (!me.getId().equals(entity.getOwnerMemberId())) {
            throw new SecurityException("not_owner");
        }
        repository.delete(entity);
        return true;
    }

    private void applyMeta(GpsSession entity, GpsSessionDto body, Member me) {
        entity.setOwnerUsername(resolveUsername(me));
        if (StringUtils.hasText(body.getTitle())) {
            entity.setTitle(body.getTitle().trim().substring(0, Math.min(body.getTitle().trim().length(), 200)));
        } else if (!StringUtils.hasText(entity.getTitle())) {
            entity.setTitle("GPS");
        }
        String source = normalize(body.getSourceType(), SOURCES, entity.getSourceType(), "import");
        entity.setSourceType(source);
        String status = normalize(body.getStatus(), STATUSES, entity.getStatus(), "idle");
        entity.setStatus(status);
        if (body.getSourceFileId() != null) {
            entity.setSourceFileId(trimTo(body.getSourceFileId(), 80));
        }
        if (body.getSourceFileName() != null) {
            entity.setSourceFileName(trimTo(body.getSourceFileName(), 240));
        }
        if (body.getPlannedTrack() != null && !body.getPlannedTrack().isEmpty()) {
            List<double[]> coords = body.getPlannedTrack();
            if (coords.size() > MAX_PLANNED) {
                coords = downsample(coords, MAX_PLANNED);
            }
            entity.setPlannedTrack(new ArrayList<>(coords));
        }
        if (body.getPlannedDistanceM() != null) {
            entity.setPlannedDistanceM(body.getPlannedDistanceM());
        }
        if (body.getPlannedAscentM() != null) {
            entity.setPlannedAscentM(body.getPlannedAscentM());
        }
        if (body.getPlannedDescentM() != null) {
            entity.setPlannedDescentM(body.getPlannedDescentM());
        }
        if (body.getDoneM() != null) {
            entity.setDoneM(body.getDoneM());
        }
        if (body.getRemainingM() != null) {
            entity.setRemainingM(body.getRemainingM());
        }
        if (body.getAscentDoneM() != null) {
            entity.setAscentDoneM(body.getAscentDoneM());
        }
        if (body.getDescentDoneM() != null) {
            entity.setDescentDoneM(body.getDescentDoneM());
        }
        if (body.getDurationSec() != null) {
            entity.setDurationSec(body.getDurationSec());
        }
        if (body.getStartedAt() != null && entity.getStartedAt() == null) {
            entity.setStartedAt(body.getStartedAt());
        }
        if (body.getFinishedAt() != null) {
            entity.setFinishedAt(body.getFinishedAt());
        }
    }

    private void mergePoints(GpsSession entity, List<GpsRecordedPointDto> incoming) {
        if (incoming == null || incoming.isEmpty()) {
            return;
        }
        List<GpsRecordedPointDto> batch = incoming.size() > MAX_SYNC_BATCH
                ? incoming.subList(incoming.size() - MAX_SYNC_BATCH, incoming.size())
                : incoming;
        LinkedHashMap<String, GpsRecordedPoint> byId = new LinkedHashMap<>();
        for (GpsRecordedPoint existing : entity.getRecordedPoints()) {
            String key = existing.getClientPointId();
            if (StringUtils.hasText(key)) {
                byId.put(key, existing);
            }
        }
        HashSet<String> seen = new HashSet<>(byId.keySet());
        for (GpsRecordedPointDto dto : batch) {
            if (dto == null || !isValidLatLon(dto.getLat(), dto.getLon())) {
                continue;
            }
            String key = StringUtils.hasText(dto.getClientPointId())
                    ? dto.getClientPointId().trim()
                    : null;
            if (key == null || key.length() > 80 || seen.contains(key)) {
                continue;
            }
            seen.add(key);
            byId.put(key, toPoint(dto, key));
        }
        List<GpsRecordedPoint> merged = new ArrayList<>(byId.values());
        if (merged.size() > MAX_RECORDED) {
            merged = new ArrayList<>(merged.subList(merged.size() - MAX_RECORDED, merged.size()));
        }
        entity.setRecordedPoints(merged);
    }

    private static GpsRecordedPoint toPoint(GpsRecordedPointDto dto, String key) {
        GpsRecordedPoint p = new GpsRecordedPoint();
        p.setClientPointId(key);
        p.setLat(dto.getLat());
        p.setLon(dto.getLon());
        p.setEleM(dto.getEleM());
        p.setTimeMs(dto.getTimeMs());
        p.setSpeedKmh(dto.getSpeedKmh());
        p.setAccuracyM(dto.getAccuracyM());
        p.setSlopePct(dto.getSlopePct());
        return p;
    }

    private GpsSessionDto toDto(GpsSession entity, boolean includePoints) {
        GpsSessionDto dto = new GpsSessionDto();
        dto.setId(entity.getId());
        dto.setOwnerMemberId(entity.getOwnerMemberId());
        dto.setOwnerUsername(entity.getOwnerUsername());
        dto.setClientSessionId(entity.getClientSessionId());
        dto.setTitle(entity.getTitle());
        dto.setSourceType(entity.getSourceType());
        dto.setSourceFileId(entity.getSourceFileId());
        dto.setSourceFileName(entity.getSourceFileName());
        dto.setStatus(entity.getStatus());
        dto.setPlannedTrack(entity.getPlannedTrack() != null ? entity.getPlannedTrack() : List.of());
        dto.setPlannedDistanceM(entity.getPlannedDistanceM());
        dto.setPlannedAscentM(entity.getPlannedAscentM());
        dto.setPlannedDescentM(entity.getPlannedDescentM());
        List<GpsRecordedPoint> pts = entity.getRecordedPoints() != null ? entity.getRecordedPoints() : List.of();
        dto.setRecordedPointCount(pts.size());
        if (includePoints) {
            List<GpsRecordedPointDto> list = new ArrayList<>(pts.size());
            for (GpsRecordedPoint p : pts) {
                list.add(toPointDto(p));
            }
            dto.setRecordedPoints(list);
        } else {
            dto.setRecordedPoints(List.of());
        }
        dto.setDoneM(entity.getDoneM());
        dto.setRemainingM(entity.getRemainingM());
        dto.setAscentDoneM(entity.getAscentDoneM());
        dto.setDescentDoneM(entity.getDescentDoneM());
        dto.setDurationSec(entity.getDurationSec());
        dto.setStartedAt(entity.getStartedAt());
        dto.setFinishedAt(entity.getFinishedAt());
        dto.setCreatedAt(entity.getCreatedAt());
        dto.setUpdatedAt(entity.getUpdatedAt());
        return dto;
    }

    private static GpsRecordedPointDto toPointDto(GpsRecordedPoint p) {
        GpsRecordedPointDto dto = new GpsRecordedPointDto();
        dto.setClientPointId(p.getClientPointId());
        dto.setLat(p.getLat());
        dto.setLon(p.getLon());
        dto.setEleM(p.getEleM());
        dto.setTimeMs(p.getTimeMs());
        dto.setSpeedKmh(p.getSpeedKmh());
        dto.setAccuracyM(p.getAccuracyM());
        dto.setSlopePct(p.getSlopePct());
        return dto;
    }

    private static String normalize(String raw, Set<String> allowed, String fallback, String def) {
        String v = raw != null ? raw.trim().toLowerCase(Locale.ROOT) : "";
        if (allowed.contains(v)) {
            return v;
        }
        if (StringUtils.hasText(fallback) && allowed.contains(fallback)) {
            return fallback;
        }
        return def;
    }

    private static String trimTo(String raw, int max) {
        if (raw == null) {
            return null;
        }
        String t = raw.trim();
        return t.length() <= max ? t : t.substring(0, max);
    }

    private static String resolveUsername(Member m) {
        if (m == null) {
            return null;
        }
        if (StringUtils.hasText(m.getUserName())) {
            return m.getUserName().trim();
        }
        String first = m.getFirstName() != null ? m.getFirstName().trim() : "";
        String last = m.getLastName() != null ? m.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        return StringUtils.hasText(full) ? full : m.getId();
    }

    private static List<double[]> downsample(List<double[]> coords, int max) {
        if (coords.size() <= max) {
            return coords;
        }
        List<double[]> out = new ArrayList<>(max);
        int last = coords.size() - 1;
        for (int i = 0; i < max - 1; i++) {
            int idx = (int) Math.round((double) i * last / (max - 1));
            out.add(coords.get(idx));
        }
        out.add(coords.get(last));
        return out;
    }

    private static boolean isValidLatLon(double lat, double lon) {
        return Double.isFinite(lat) && Double.isFinite(lon)
                && lat >= -90 && lat <= 90
                && lon >= -180 && lon <= 180;
    }
}
