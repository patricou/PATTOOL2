package com.pat.service;

import com.pat.controller.dto.TvRecordingDto;
import com.pat.controller.dto.TvRecordingRenameRequest;
import com.pat.controller.dto.TvRecordingStartRequest;
import com.pat.repo.FriendGroupRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.TvRecordingRepository;
import com.pat.repo.domain.FriendGroup;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TvRecording;
import org.bson.Document;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Persists browser-captured TV recordings (MediaRecorder) into MongoDB GridFS.
 * List/get honor the same visibility model as activities (private / public / friends / friendGroups).
 */
@Service
public class TvRecordingService {

    private static final Logger log = LoggerFactory.getLogger(TvRecordingService.class);

    private static final int DEFAULT_DURATION_SEC = 300;
    private static final long MAX_UPLOAD_BYTES = 800L * 1024L * 1024L; // 800 MB safety cap

    @Value("${app.tv.recording.enabled:true}")
    private boolean recordingEnabled;

    @Value("${app.tv.recording.max-duration-sec:1800}")
    private int maxDurationSec;

    @Autowired
    private TvRecordingRepository tvRecordingRepository;

    @Autowired
    private GridFsTemplate gridFsTemplate;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private FriendGroupRepository friendGroupRepository;

    @Autowired
    private UserOwnerService userOwnerService;

    public Map<String, Object> statusInfo() {
        return Map.of(
                "enabled", recordingEnabled,
                "mode", "browser",
                "maxDurationSec", maxDurationSec,
                "defaultDurationSec", DEFAULT_DURATION_SEC,
                "maxUploadBytes", MAX_UPLOAD_BYTES
        );
    }

    public List<TvRecordingDto> listAccessible(String jwtSubject, String memberId) {
        return tvRecordingRepository.findAccessible(jwtSubject, memberId).stream()
                .map(rec -> toDto(rec, jwtSubject))
                .collect(Collectors.toList());
    }

    public Optional<TvRecordingDto> findAccessible(String id, String jwtSubject, String memberId) {
        return tvRecordingRepository.findAccessibleById(id, jwtSubject, memberId)
                .map(rec -> toDto(rec, jwtSubject));
    }

    /**
     * Whether the caller may stream a GridFS video that belongs to a TV recording.
     * Non-recording GridFS files are not gated here (return empty → caller keeps legacy behaviour).
     */
    public Optional<Boolean> canAccessGridFsMedia(String gridFsFileId, String jwtSubject, String memberId) {
        if (!StringUtils.hasText(gridFsFileId)) {
            return Optional.empty();
        }
        Optional<TvRecording> opt = tvRecordingRepository.findByGridFsFileId(gridFsFileId);
        if (opt.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(
                tvRecordingRepository.findAccessibleById(opt.get().getId(), jwtSubject, memberId).isPresent()
        );
    }

    /**
     * Store a browser-recorded video blob (typically {@code video/webm}) in GridFS.
     */
    public TvRecordingDto upload(String ownerSub, String ownerMemberId, TvRecordingStartRequest meta, MultipartFile file) {
        if (!recordingEnabled) {
            throw new IllegalStateException("tv_recording_disabled");
        }
        if (!StringUtils.hasText(ownerSub)) {
            throw new IllegalArgumentException("owner_required");
        }
        ownerSub = userOwnerService.require(ownerSub).username();
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("file_required");
        }
        if (file.getSize() > MAX_UPLOAD_BYTES) {
            throw new IllegalArgumentException("file_too_large");
        }

        String originalName = file.getOriginalFilename();
        String contentType = StringUtils.hasText(file.getContentType())
                ? file.getContentType()
                : guessContentType(originalName);
        String channelName = meta != null && StringUtils.hasText(meta.getChannelName())
                ? meta.getChannelName().trim()
                : "TV";
        int durationSec = meta != null && meta.getDurationSec() != null && meta.getDurationSec() > 0
                ? Math.min(meta.getDurationSec(), Math.max(1, maxDurationSec))
                : 0;

        Instant now = Instant.now();
        Instant startedAt = durationSec > 0 ? now.minusSeconds(durationSec) : now;

        TvRecording rec = new TvRecording();
        rec.setOwnerSub(ownerSub);
        rec.setOwnerMemberId(trimToNull(ownerMemberId));
        rec.setChannelId(meta != null ? trimToNull(meta.getChannelId()) : null);
        rec.setChannelName(channelName);
        rec.setChannelLogo(meta != null ? trimToNull(meta.getChannelLogo()) : null);
        rec.setCountry(meta != null ? trimToNull(meta.getCountry()) : null);
        rec.setStreamUrl(meta != null ? trimToNull(meta.getStreamUrl()) : null);
        rec.setStatus(TvRecording.Status.PENDING);
        rec.setStartedAt(startedAt);
        rec.setDurationSec(durationSec > 0 ? durationSec : DEFAULT_DURATION_SEC);
        rec.setActualDurationSec(durationSec > 0 ? durationSec : null);
        rec.setContentType(contentType);
        rec.setFileName(safeFileName(channelName) + "-" + now.toEpochMilli() + extensionFor(contentType, originalName));
        // Default sharing is private unless the client explicitly chooses otherwise.
        applySharingFields(
                rec,
                meta != null && StringUtils.hasText(meta.getVisibility()) ? meta.getVisibility() : "private",
                meta != null ? meta.getFriendGroupId() : null,
                meta != null ? meta.getFriendGroupIds() : null,
                ownerMemberId);
        rec = tvRecordingRepository.save(rec);

        Document metaDoc = new Document();
        metaDoc.put("ownerSub", ownerSub);
        metaDoc.put("tvRecordingId", rec.getId());
        metaDoc.put("channelId", rec.getChannelId());
        metaDoc.put("channelName", rec.getChannelName());
        metaDoc.put("kind", "tv-recording");
        metaDoc.put("source", "browser-mediarecorder");

        try (InputStream in = file.getInputStream()) {
            String gridFsId = gridFsTemplate.store(in, rec.getFileName(), contentType, metaDoc).toString();
            rec.setGridFsFileId(gridFsId);
            rec.setByteLength(file.getSize());
            rec.setStatus(TvRecording.Status.DONE);
            rec.setEndedAt(now);
            rec.setError(null);
            tvRecordingRepository.save(rec);
            log.info("TV recording {} uploaded to GridFS {} ({} bytes, {})",
                    rec.getId(), gridFsId, file.getSize(), contentType);
            return toDto(rec, ownerSub);
        } catch (Exception e) {
            log.error("TV recording upload failed: {}", e.getMessage(), e);
            rec.setStatus(TvRecording.Status.FAILED);
            rec.setError(truncate(e.getMessage(), 400));
            rec.setEndedAt(Instant.now());
            tvRecordingRepository.save(rec);
            throw new IllegalStateException("upload_failed");
        }
    }

    public void delete(String id, String ownerSub) {
        TvRecording rec = requireOwned(id, ownerSub);
        if (StringUtils.hasText(rec.getGridFsFileId())) {
            try {
                ObjectId oid = new ObjectId(rec.getGridFsFileId());
                gridFsTemplate.delete(new Query(Criteria.where("_id").is(oid)));
            } catch (Exception e) {
                log.warn("Failed to delete GridFS file {} for recording {}: {}",
                        rec.getGridFsFileId(), id, e.getMessage());
            }
        }
        tvRecordingRepository.delete(rec);
    }

    /**
     * Rename and/or update sharing for an owned recording.
     */
    public TvRecordingDto update(String id, String ownerSub, String ownerMemberId, TvRecordingRenameRequest body) {
        TvRecording rec = requireOwned(id, ownerSub);

        boolean touched = false;
        if (body != null && StringUtils.hasText(body.getChannelName())) {
            applyRename(rec, body.getChannelName());
            touched = true;
        }
        if (body != null && (body.getVisibility() != null
                || body.getFriendGroupId() != null
                || body.getFriendGroupIds() != null)) {
            if (!StringUtils.hasText(rec.getOwnerMemberId()) && StringUtils.hasText(ownerMemberId)) {
                rec.setOwnerMemberId(ownerMemberId.trim());
            }
            applySharingFields(
                    rec,
                    body.getVisibility() != null ? body.getVisibility() : rec.getVisibility(),
                    body.getFriendGroupId(),
                    body.getFriendGroupIds(),
                    StringUtils.hasText(rec.getOwnerMemberId()) ? rec.getOwnerMemberId() : ownerMemberId);
            touched = true;
        }
        if (!touched) {
            throw new IllegalArgumentException("nothing_to_update");
        }
        tvRecordingRepository.save(rec);
        return toDto(rec, ownerSub);
    }

    /** @deprecated Prefer {@link #update}; kept for callers that only rename. */
    public TvRecordingDto rename(String id, String ownerSub, String newName) {
        TvRecordingRenameRequest body = new TvRecordingRenameRequest();
        body.setChannelName(newName);
        return update(id, ownerSub, null, body);
    }

    private void applyRename(TvRecording rec, String newName) {
        if (!StringUtils.hasText(newName)) {
            throw new IllegalArgumentException("name_required");
        }
        String name = newName.trim();
        if (name.length() > 120) {
            name = name.substring(0, 120);
        }
        rec.setChannelName(name);
        String ext = extensionFor(rec.getContentType(), rec.getFileName());
        String stamp = "";
        if (StringUtils.hasText(rec.getFileName())) {
            String base = rec.getFileName();
            int dash = base.lastIndexOf('-');
            int dot = base.lastIndexOf('.');
            if (dash >= 0 && dot > dash + 1) {
                String maybeTs = base.substring(dash + 1, dot);
                if (maybeTs.matches("\\d{10,}")) {
                    stamp = "-" + maybeTs;
                }
            }
        }
        if (stamp.isEmpty()) {
            stamp = "-" + Instant.now().toEpochMilli();
        }
        rec.setFileName(safeFileName(name) + stamp + ext);
    }

    private void applySharingFields(TvRecording entity, String visibilityRaw, String friendGroupIdRaw,
            List<String> friendGroupIdsRaw, String ownerMemberId) {
        if (!StringUtils.hasText(visibilityRaw)) {
            entity.setVisibility("private");
            entity.setFriendGroupId(null);
            entity.setFriendGroupIds(null);
            return;
        }
        String v = visibilityRaw.trim();
        entity.setVisibility(v);
        if ("public".equals(v) || "private".equals(v) || "friends".equals(v)) {
            entity.setFriendGroupId(null);
            entity.setFriendGroupIds(null);
            return;
        }
        if ("friendGroups".equals(v)) {
            List<String> ids = normalizeIdList(friendGroupIdsRaw);
            if (ids.isEmpty() && StringUtils.hasText(friendGroupIdRaw)) {
                ids = List.of(friendGroupIdRaw.trim());
            }
            if (ids.isEmpty()) {
                entity.setVisibility("private");
                entity.setFriendGroupId(null);
                entity.setFriendGroupIds(null);
                return;
            }
            assertCanUseFriendGroups(ownerMemberId, ids);
            entity.setFriendGroupIds(ids);
            entity.setFriendGroupId(ids.get(0));
            return;
        }
        // Legacy: visibility holds a friend-group display name.
        if (StringUtils.hasText(friendGroupIdRaw)) {
            String one = friendGroupIdRaw.trim();
            assertCanUseFriendGroups(ownerMemberId, List.of(one));
            entity.setFriendGroupId(one);
        } else {
            entity.setFriendGroupId(null);
        }
        entity.setFriendGroupIds(null);
    }

    private void assertCanUseFriendGroups(String ownerMemberId, List<String> groupIds) {
        if (!StringUtils.hasText(ownerMemberId)) {
            throw new IllegalStateException("FRIEND_GROUP_UNAUTHORIZED");
        }
        for (String groupId : groupIds) {
            if (!StringUtils.hasText(groupId)) {
                continue;
            }
            Optional<FriendGroup> groupOpt = friendGroupRepository.findById(groupId.trim());
            if (groupOpt.isEmpty()) {
                throw new IllegalArgumentException("friend_group_not_found");
            }
            FriendGroup group = groupOpt.get();
            boolean isOwner = group.getOwner() != null && ownerMemberId.equals(group.getOwner().getId());
            boolean isAuthorized = group.getAuthorizedUsers() != null
                    && group.getAuthorizedUsers().stream()
                    .anyMatch(u -> u != null && ownerMemberId.equals(u.getId()));
            if (!isOwner && !isAuthorized) {
                throw new IllegalStateException("FRIEND_GROUP_UNAUTHORIZED");
            }
        }
    }

    private TvRecording requireOwned(String id, String ownerHint) {
        TvRecording rec = tvRecordingRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("not_found"));
        if (!userOwnerService.ownsStored(rec.getOwnerSub(), ownerHint)) {
            throw new IllegalArgumentException("not_found");
        }
        return rec;
    }

    public Optional<Member> resolveMemberByKeycloakId(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return Optional.empty();
        }
        String id = jwtSubject.trim();
        Member m = membersRepository.findByKeycloakId(id);
        if (m == null) {
            m = membersRepository.findByUserName(id);
        }
        if (m == null) {
            String username = userOwnerService.resolve(id).username();
            if (StringUtils.hasText(username)) {
                m = membersRepository.findByUserName(username);
            }
        }
        return Optional.ofNullable(m);
    }

    private TvRecordingDto toDto(TvRecording rec, String viewerSub) {
        TvRecordingDto dto = new TvRecordingDto();
        dto.setId(rec.getId());
        dto.setChannelId(rec.getChannelId());
        dto.setChannelName(rec.getChannelName());
        dto.setChannelLogo(rec.getChannelLogo());
        dto.setCountry(rec.getCountry());
        dto.setStreamUrl(rec.getStreamUrl());
        dto.setStatus(rec.getStatus() != null ? rec.getStatus().name() : null);
        dto.setStartedAt(rec.getStartedAt());
        dto.setEndedAt(rec.getEndedAt());
        dto.setDurationSec(rec.getDurationSec());
        dto.setActualDurationSec(rec.getActualDurationSec());
        dto.setGridFsFileId(rec.getGridFsFileId());
        dto.setContentType(rec.getContentType());
        dto.setFileName(rec.getFileName());
        dto.setByteLength(rec.getByteLength());
        dto.setError(rec.getError());
        dto.setVisibility(StringUtils.hasText(rec.getVisibility()) ? rec.getVisibility() : "private");
        dto.setFriendGroupId(rec.getFriendGroupId());
        dto.setFriendGroupIds(rec.getFriendGroupIds());
        dto.setOwnerMemberId(rec.getOwnerMemberId());
        dto.setOwnedByMe(userOwnerService.ownsStored(rec.getOwnerSub(), viewerSub));
        if (StringUtils.hasText(rec.getGridFsFileId()) && rec.getStatus() == TvRecording.Status.DONE) {
            dto.setMediaUrl("/api/video/" + rec.getGridFsFileId());
        }
        return dto;
    }

    private static List<String> normalizeIdList(List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String id : ids) {
            if (StringUtils.hasText(id)) {
                String t = id.trim();
                if (!out.contains(t)) {
                    out.add(t);
                }
            }
        }
        return out;
    }

    private static String trimToNull(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        return value.trim();
    }

    private static String safeFileName(String name) {
        String base = name != null ? name : "tv";
        String cleaned = base.replaceAll("[^a-zA-Z0-9._-]+", "_");
        if (cleaned.length() > 40) {
            cleaned = cleaned.substring(0, 40);
        }
        return cleaned.isEmpty() ? "tv" : cleaned.toLowerCase(Locale.ROOT);
    }

    private static String extensionFor(String contentType, String originalName) {
        if (originalName != null) {
            String lower = originalName.toLowerCase(Locale.ROOT);
            int dot = lower.lastIndexOf('.');
            if (dot >= 0 && dot < lower.length() - 1) {
                String ext = lower.substring(dot);
                if (ext.matches("\\.[a-z0-9]{2,5}")) {
                    return ext;
                }
            }
        }
        if (contentType != null) {
            String ct = contentType.toLowerCase(Locale.ROOT);
            if (ct.contains("webm")) {
                return ".webm";
            }
            if (ct.contains("mp4")) {
                return ".mp4";
            }
            if (ct.contains("ogg")) {
                return ".ogv";
            }
        }
        return ".webm";
    }

    private static String guessContentType(String fileName) {
        if (fileName == null) {
            return "video/webm";
        }
        String lower = fileName.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mp4")) {
            return "video/mp4";
        }
        if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) {
            return "video/ogg";
        }
        return "video/webm";
    }

    private static String truncate(String msg, int max) {
        if (msg == null) {
            return null;
        }
        return msg.length() <= max ? msg : msg.substring(0, max);
    }
}
