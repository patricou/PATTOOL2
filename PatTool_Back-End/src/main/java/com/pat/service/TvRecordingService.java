package com.pat.service;

import com.pat.controller.dto.TvRecordingDto;
import com.pat.controller.dto.TvRecordingStartRequest;
import com.pat.repo.TvRecordingRepository;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Persists browser-captured TV recordings (MediaRecorder) into MongoDB GridFS.
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

    public Map<String, Object> statusInfo() {
        return Map.of(
                "enabled", recordingEnabled,
                "mode", "browser",
                "maxDurationSec", maxDurationSec,
                "defaultDurationSec", DEFAULT_DURATION_SEC,
                "maxUploadBytes", MAX_UPLOAD_BYTES
        );
    }

    public List<TvRecordingDto> listForSubject(String ownerSub) {
        return tvRecordingRepository.findByOwnerSubOrderByStartedAtDesc(ownerSub).stream()
                .map(this::toDto)
                .collect(Collectors.toList());
    }

    public Optional<TvRecordingDto> findForSubject(String id, String ownerSub) {
        return tvRecordingRepository.findByIdAndOwnerSub(id, ownerSub).map(this::toDto);
    }

    /**
     * Store a browser-recorded video blob (typically {@code video/webm}) in GridFS.
     */
    public TvRecordingDto upload(String ownerSub, TvRecordingStartRequest meta, MultipartFile file) {
        if (!recordingEnabled) {
            throw new IllegalStateException("tv_recording_disabled");
        }
        if (!StringUtils.hasText(ownerSub)) {
            throw new IllegalArgumentException("owner_required");
        }
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
            return toDto(rec);
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
        TvRecording rec = tvRecordingRepository.findByIdAndOwnerSub(id, ownerSub)
                .orElseThrow(() -> new IllegalArgumentException("not_found"));
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
     * Rename the display title (and download file base name) for an owned recording.
     */
    public TvRecordingDto rename(String id, String ownerSub, String newName) {
        if (!StringUtils.hasText(newName)) {
            throw new IllegalArgumentException("name_required");
        }
        String name = newName.trim();
        if (name.length() > 120) {
            name = name.substring(0, 120);
        }
        TvRecording rec = tvRecordingRepository.findByIdAndOwnerSub(id, ownerSub)
                .orElseThrow(() -> new IllegalArgumentException("not_found"));
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
        tvRecordingRepository.save(rec);
        return toDto(rec);
    }

    private TvRecordingDto toDto(TvRecording rec) {
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
        if (StringUtils.hasText(rec.getGridFsFileId()) && rec.getStatus() == TvRecording.Status.DONE) {
            dto.setMediaUrl("/api/video/" + rec.getGridFsFileId());
        }
        return dto;
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
