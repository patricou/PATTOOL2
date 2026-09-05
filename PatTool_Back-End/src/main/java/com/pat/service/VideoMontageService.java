package com.pat.service;

import com.mongodb.client.gridfs.model.GridFSFile;
import com.pat.controller.dto.VideoMontageExportRequest;
import com.pat.controller.dto.VideoMontageExportResponse;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.VideoMontageProjectRepository;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TvRecording;
import com.pat.repo.domain.VideoMontageClip;
import com.pat.repo.domain.VideoMontageProject;
import com.pat.repo.TvRecordingRepository;
import org.bson.Document;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.gridfs.GridFsResource;
import org.springframework.data.mongodb.gridfs.GridFsTemplate;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Builds MP4 montages from activity photos/videos and TV recordings using FFmpeg.
 */
@Service
public class VideoMontageService {

    private static final Logger log = LoggerFactory.getLogger(VideoMontageService.class);
    private static final Pattern SAFE_NAME = Pattern.compile("[^a-zA-Z0-9._-]+");
    private static final int DEFAULT_WIDTH = 1280;
    private static final int DEFAULT_HEIGHT = 720;
    private static final double DEFAULT_PHOTO_SEC = 3.0;

    @Value("${app.video.ffmpeg.path:ffmpeg}")
    private String ffmpegPath;

    @Value("${app.video.montage.enabled:true}")
    private boolean montageEnabled;

    @Value("${app.video.montage.max-clips:40}")
    private int maxClips;

    @Value("${app.video.montage.max-duration-sec:1800}")
    private int maxDurationSec;

    @Value("${app.video.montage.timeout-sec:900}")
    private int timeoutSec;

    @Value("${app.video.compression.tempdir:${java.io.tmpdir}}")
    private String tempDir;

    private final Semaphore exportSemaphore;

    @Autowired
    private GridFsTemplate gridFsTemplate;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @Autowired
    private TvRecordingRepository tvRecordingRepository;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private DiscussionService discussionService;

    @Autowired
    private VideoMontageProjectRepository projectRepository;

    public VideoMontageService(
            @Value("${app.video.montage.max-concurrency:1}") int maxConcurrency) {
        int permits = Math.max(1, maxConcurrency);
        this.exportSemaphore = new Semaphore(permits, true);
    }

    public boolean isMontageEnabled() {
        return montageEnabled;
    }

    public boolean isFFmpegAvailable() {
        try {
            Process process = new ProcessBuilder(ffmpegPath, "-version")
                    .redirectErrorStream(true)
                    .start();
            boolean finished = process.waitFor(8, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0;
        } catch (Exception e) {
            log.debug("FFmpeg not available: {}", e.getMessage());
            return false;
        }
    }

    public VideoMontageExportResponse export(
            String ownerMemberId,
            String jwtSubject,
            VideoMontageExportRequest request) throws Exception {
        if (!montageEnabled) {
            throw new IllegalStateException("montage_disabled");
        }
        if (!isFFmpegAvailable()) {
            throw new IllegalStateException("ffmpeg_unavailable");
        }
        if (request == null || request.getClips() == null || request.getClips().isEmpty()) {
            throw new IllegalArgumentException("clips_required");
        }
        if (request.getClips().size() > maxClips) {
            throw new IllegalArgumentException("too_many_clips");
        }

        List<VideoMontageClip> clips = request.getClips();
        double totalSec = 0;
        for (VideoMontageClip clip : clips) {
            authorizeClip(clip, ownerMemberId, jwtSubject);
            totalSec += clipDuration(clip);
        }
        if (totalSec <= 0) {
            throw new IllegalArgumentException("empty_duration");
        }
        if (totalSec > maxDurationSec) {
            throw new IllegalArgumentException("duration_too_long");
        }

        int width = normalizeDim(request.getWidth(), DEFAULT_WIDTH, 480, 1920);
        int height = normalizeDim(request.getHeight(), DEFAULT_HEIGHT, 270, 1080);
        if (width % 2 != 0) {
            width -= 1;
        }
        if (height % 2 != 0) {
            height -= 1;
        }

        boolean acquired = false;
        try {
            acquired = exportSemaphore.tryAcquire(15, TimeUnit.SECONDS);
            if (!acquired) {
                throw new IllegalStateException("montage_busy");
            }
            return render(ownerMemberId, request, clips, width, height);
        } finally {
            if (acquired) {
                exportSemaphore.release();
            }
        }
    }

    private VideoMontageExportResponse render(
            String ownerMemberId,
            VideoMontageExportRequest request,
            List<VideoMontageClip> clips,
            int width,
            int height) throws Exception {
        Path workDir = Files.createTempDirectory(Path.of(tempDir), "pat-montage-");
        List<Path> clipFiles = new ArrayList<>();
        Path concatList = workDir.resolve("concat.txt");
        Path output = workDir.resolve("montage.mp4");
        try {
            for (int i = 0; i < clips.size(); i++) {
                VideoMontageClip clip = clips.get(i);
                Path source = copySourceToTemp(workDir, clip, i);
                Path encoded = workDir.resolve(String.format(Locale.ROOT, "clip-%03d.mp4", i));
                encodeClip(source, encoded, clip, width, height);
                clipFiles.add(encoded);
                Files.deleteIfExists(source);
            }
            writeConcatList(concatList, clipFiles);
            concatClips(concatList, output);

            String title = StringUtils.hasText(request.getTitle()) ? request.getTitle().trim() : "montage";
            String fileName = safeFileName(title) + ".mp4";
            Member uploader = membersRepository.findById(ownerMemberId).orElse(null);
            Document meta = new Document();
            if (uploader != null) {
                String name = ((uploader.getFirstName() != null ? uploader.getFirstName() : "") + " "
                        + (uploader.getLastName() != null ? uploader.getLastName() : "")).trim();
                meta.put("UploaderName", name);
                meta.put("UploaderId", uploader.getId());
            }
            meta.put("kind", "video-montage");
            ObjectId storedId;
            try (InputStream in = Files.newInputStream(output)) {
                storedId = gridFsTemplate.store(in, fileName, "video/mp4", meta);
            }
            long bytes = Files.size(output);

            boolean attached = false;
            String attachEventId = trimToNull(request.getEvenementId());
            if (request.isAttachToEvent() && attachEventId != null) {
                attached = attachToEvent(attachEventId, ownerMemberId, storedId.toHexString(), fileName, uploader);
            }

            if (StringUtils.hasText(request.getProjectId())) {
                projectRepository.findByIdAndOwnerMemberId(request.getProjectId(), ownerMemberId).ifPresent(p -> {
                    p.setOutputGridFsFileId(storedId.toHexString());
                    p.setOutputFileName(fileName);
                    p.setOutputByteLength(bytes);
                    p.setUpdatedAt(new java.util.Date());
                    projectRepository.save(p);
                });
            }

            VideoMontageExportResponse resp = new VideoMontageExportResponse();
            resp.setFileId(storedId.toHexString());
            resp.setFileName(fileName);
            resp.setMediaUrl("/api/video/" + storedId.toHexString());
            resp.setByteLength(bytes);
            resp.setEvenementId(attachEventId);
            resp.setAttachedToEvent(attached);
            resp.setProjectId(trimToNull(request.getProjectId()));
            return resp;
        } finally {
            deleteQuietly(workDir);
        }
    }

    private boolean attachToEvent(
            String eventId,
            String ownerMemberId,
            String fileId,
            String fileName,
            Member uploader) {
        if (!discussionService.canUserAccessEventForDetail(eventId, ownerMemberId)) {
            log.warn("Montage attach skipped: no access to event {}", eventId);
            return false;
        }
        Evenement event = evenementsRepository.findById(eventId).orElse(null);
        if (event == null) {
            return false;
        }
        if (event.getFileUploadeds() == null) {
            event.setFileUploadeds(new ArrayList<>());
        }
        FileUploaded uploaded = new FileUploaded(fileId, fileName, "video/mp4", uploader);
        event.getFileUploadeds().add(uploaded);
        evenementsRepository.save(event);
        return true;
    }

    private void authorizeClip(VideoMontageClip clip, String ownerMemberId, String jwtSubject) {
        if (clip == null || !StringUtils.hasText(clip.getFileId())) {
            throw new IllegalArgumentException("clip_file_required");
        }
        String kind = clip.getKind() != null ? clip.getKind().trim().toLowerCase(Locale.ROOT) : "";
        if ("recording".equals(kind)) {
            if (!StringUtils.hasText(clip.getRecordingId())) {
                throw new IllegalArgumentException("recording_id_required");
            }
            Optional<TvRecording> rec = tvRecordingRepository.findAccessibleById(
                    clip.getRecordingId().trim(), jwtSubject, ownerMemberId);
            if (rec.isEmpty()) {
                throw new SecurityException("recording_forbidden");
            }
            String gridId = rec.get().getGridFsFileId();
            if (!clip.getFileId().equals(gridId)) {
                throw new SecurityException("recording_file_mismatch");
            }
            return;
        }
        if (!"photo".equals(kind) && !"video".equals(kind)) {
            throw new IllegalArgumentException("clip_kind_invalid");
        }
        String eventId = trimToNull(clip.getEvenementId());
        if (eventId == null) {
            throw new IllegalArgumentException("event_id_required");
        }
        if (!discussionService.canUserAccessEventForDetail(eventId, ownerMemberId)) {
            throw new SecurityException("event_forbidden");
        }
        Evenement event = evenementsRepository.findById(eventId)
                .orElseThrow(() -> new IllegalArgumentException("event_not_found"));
        if (!eventContainsFile(event, clip.getFileId())) {
            throw new SecurityException("file_not_in_event");
        }
        if (isYoutubePlaceholder(clip)) {
            throw new IllegalArgumentException("youtube_not_supported");
        }
    }

    private boolean eventContainsFile(Evenement event, String fileId) {
        if (fileId == null) {
            return false;
        }
        if (event.getThumbnail() != null && fileId.equals(event.getThumbnail().getFieldId())) {
            return true;
        }
        if (event.getFileUploadeds() == null) {
            return false;
        }
        return event.getFileUploadeds().stream()
                .anyMatch(f -> f != null && fileId.equals(f.getFieldId()));
    }

    private boolean isYoutubePlaceholder(VideoMontageClip clip) {
        String type = clip.getFileType() != null ? clip.getFileType().toLowerCase(Locale.ROOT) : "";
        String id = clip.getFileId() != null ? clip.getFileId() : "";
        return type.contains("youtube") || id.startsWith("yt:");
    }

    private Path copySourceToTemp(Path workDir, VideoMontageClip clip, int index) throws IOException {
        ObjectId objectId;
        try {
            objectId = new ObjectId(clip.getFileId());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("invalid_file_id");
        }
        GridFSFile gf = gridFsTemplate.findOne(new Query(Criteria.where("_id").is(objectId)));
        if (gf == null) {
            throw new IllegalArgumentException("file_not_found");
        }
        String ext = extensionFor(clip.getFileName(), clip.getFileType(), gf.getFilename());
        Path dest = workDir.resolve(String.format(Locale.ROOT, "src-%03d%s", index, ext));
        GridFsResource resource = gridFsTemplate.getResource(gf);
        try (InputStream in = resource.getInputStream()) {
            Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
        }
        return dest;
    }

    private void encodeClip(Path source, Path dest, VideoMontageClip clip, int width, int height)
            throws IOException, InterruptedException {
        String kind = clip.getKind() != null ? clip.getKind().trim().toLowerCase(Locale.ROOT) : "";
        double duration = clipDuration(clip);
        double start = clip.getStartSec() != null && clip.getStartSec() > 0 ? clip.getStartSec() : 0;
        String vf = String.format(Locale.ROOT,
                "scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
                width, height, width, height);

        List<String> cmd = new ArrayList<>();
        cmd.add(ffmpegPath);
        cmd.add("-y");
        cmd.add("-hide_banner");
        cmd.add("-loglevel");
        cmd.add("error");
        if ("photo".equals(kind)) {
            cmd.add("-loop");
            cmd.add("1");
            cmd.add("-t");
            cmd.add(formatSec(duration));
            cmd.add("-i");
            cmd.add(source.toAbsolutePath().toString());
            cmd.add("-f");
            cmd.add("lavfi");
            cmd.add("-t");
            cmd.add(formatSec(duration));
            cmd.add("-i");
            cmd.add("anullsrc=channel_layout=stereo:sample_rate=44100");
            cmd.add("-vf");
            cmd.add(vf);
            cmd.add("-c:v");
            cmd.add("libx264");
            cmd.add("-pix_fmt");
            cmd.add("yuv420p");
            cmd.add("-c:a");
            cmd.add("aac");
            cmd.add("-ar");
            cmd.add("44100");
            cmd.add("-ac");
            cmd.add("2");
            cmd.add("-shortest");
            cmd.add(dest.toAbsolutePath().toString());
        } else {
            boolean hasAudio = sourceHasAudio(source);
            if (start > 0) {
                cmd.add("-ss");
                cmd.add(formatSec(start));
            }
            cmd.add("-t");
            cmd.add(formatSec(duration));
            cmd.add("-i");
            cmd.add(source.toAbsolutePath().toString());
            if (!hasAudio) {
                cmd.add("-f");
                cmd.add("lavfi");
                cmd.add("-t");
                cmd.add(formatSec(duration));
                cmd.add("-i");
                cmd.add("anullsrc=channel_layout=stereo:sample_rate=44100");
            }
            cmd.add("-vf");
            cmd.add(vf);
            cmd.add("-c:v");
            cmd.add("libx264");
            cmd.add("-pix_fmt");
            cmd.add("yuv420p");
            cmd.add("-c:a");
            cmd.add("aac");
            cmd.add("-ar");
            cmd.add("44100");
            cmd.add("-ac");
            cmd.add("2");
            if (!hasAudio) {
                cmd.add("-map");
                cmd.add("0:v:0");
                cmd.add("-map");
                cmd.add("1:a:0");
                cmd.add("-shortest");
            }
            cmd.add("-movflags");
            cmd.add("+faststart");
            cmd.add(dest.toAbsolutePath().toString());
        }
        runFfmpeg(cmd, timeoutSec);
        if (!Files.exists(dest) || Files.size(dest) == 0) {
            throw new IllegalStateException("clip_encode_failed");
        }
    }

    private boolean sourceHasAudio(Path source) {
        try {
            Process process = new ProcessBuilder(
                    ffmpegPath, "-hide_banner", "-i", source.toAbsolutePath().toString())
                    .redirectErrorStream(true)
                    .start();
            StringBuilder out = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    out.append(line).append('\n');
                }
            }
            process.waitFor(12, TimeUnit.SECONDS);
            return out.toString().toLowerCase(Locale.ROOT).contains("audio:");
        } catch (Exception e) {
            log.debug("Audio probe failed for {}: {}", source, e.getMessage());
            return false;
        }
    }

    private void writeConcatList(Path concatList, List<Path> clipFiles) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (Path clip : clipFiles) {
            String escaped = clip.toAbsolutePath().toString().replace("\\", "/").replace("'", "'\\''");
            sb.append("file '").append(escaped).append("'\n");
        }
        Files.writeString(concatList, sb.toString(), StandardCharsets.UTF_8);
    }

    private void concatClips(Path concatList, Path output) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<>();
        cmd.add(ffmpegPath);
        cmd.add("-y");
        cmd.add("-hide_banner");
        cmd.add("-loglevel");
        cmd.add("error");
        cmd.add("-f");
        cmd.add("concat");
        cmd.add("-safe");
        cmd.add("0");
        cmd.add("-i");
        cmd.add(concatList.toAbsolutePath().toString());
        cmd.add("-c");
        cmd.add("copy");
        cmd.add("-movflags");
        cmd.add("+faststart");
        cmd.add(output.toAbsolutePath().toString());
        runFfmpeg(cmd, timeoutSec);
        if (!Files.exists(output) || Files.size(output) == 0) {
            throw new IllegalStateException("concat_failed");
        }
    }

    private void runFfmpeg(List<String> command, int timeout) throws IOException, InterruptedException {
        log.debug("FFmpeg: {}", String.join(" ", command));
        Process process = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .start();
        StringBuilder output = new StringBuilder();
        Thread drain = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (output.length() < 8000) {
                        output.append(line).append('\n');
                    }
                }
            } catch (IOException ignored) {
                // process ended
            }
        }, "ffmpeg-montage-drain");
        drain.setDaemon(true);
        drain.start();
        boolean finished = process.waitFor(Math.max(30, timeout), TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new IllegalStateException("ffmpeg_timeout");
        }
        if (process.exitValue() != 0) {
            log.error("FFmpeg failed ({}): {}", process.exitValue(), output);
            throw new IllegalStateException("ffmpeg_failed");
        }
    }

    private static double clipDuration(VideoMontageClip clip) {
        if (clip == null || clip.getDurationSec() == null || clip.getDurationSec() <= 0) {
            String kind = clip != null && clip.getKind() != null ? clip.getKind().toLowerCase(Locale.ROOT) : "";
            return "photo".equals(kind) ? DEFAULT_PHOTO_SEC : 1.0;
        }
        return Math.min(clip.getDurationSec(), 600);
    }

    private static int normalizeDim(Integer value, int fallback, int min, int max) {
        if (value == null) {
            return fallback;
        }
        return Math.min(max, Math.max(min, value));
    }

    private static String formatSec(double sec) {
        return String.format(Locale.ROOT, "%.3f", sec);
    }

    private static String extensionFor(String fileName, String fileType, String gridName) {
        String fromName = extOf(fileName);
        if (fromName != null) {
            return fromName;
        }
        fromName = extOf(gridName);
        if (fromName != null) {
            return fromName;
        }
        String type = fileType != null ? fileType.toLowerCase(Locale.ROOT) : "";
        if (type.contains("jpeg") || type.contains("jpg")) {
            return ".jpg";
        }
        if (type.contains("png")) {
            return ".png";
        }
        if (type.contains("webp")) {
            return ".webp";
        }
        if (type.contains("webm")) {
            return ".webm";
        }
        if (type.contains("quicktime") || type.contains("mov")) {
            return ".mov";
        }
        if (type.startsWith("image/")) {
            return ".jpg";
        }
        return ".mp4";
    }

    private static String extOf(String name) {
        if (!StringUtils.hasText(name) || !name.contains(".")) {
            return null;
        }
        String ext = name.substring(name.lastIndexOf('.')).toLowerCase(Locale.ROOT);
        if (ext.length() > 8 || ext.length() < 2) {
            return null;
        }
        return ext;
    }

    private static String safeFileName(String title) {
        String base = SAFE_NAME.matcher(title.trim()).replaceAll("-");
        if (base.isBlank()) {
            base = "montage";
        }
        if (base.length() > 80) {
            base = base.substring(0, 80);
        }
        return base;
    }

    private static String trimToNull(String s) {
        if (!StringUtils.hasText(s)) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static void deleteQuietly(Path dir) {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        try (var walk = Files.walk(dir)) {
            walk.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort
                }
            });
        } catch (IOException ignored) {
            // best effort
        }
    }
}
