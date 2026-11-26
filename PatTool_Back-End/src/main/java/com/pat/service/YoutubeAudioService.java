package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.restclient.RestTemplateBuilder;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Plays a YouTube clip as sound only. The picture is never forwarded.
 * Phones get the audio file itself (Opus in WebM, or AAC in a fragmented MP4).
 * A raw ADTS stream has no timestamps: the mobile decoder then loses the frame
 * edges and the sound saturates or crackles.
 */
@Service
public class YoutubeAudioService {

    private static final Logger log = LoggerFactory.getLogger(YoutubeAudioService.class);
    private static final String PLAYER = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
    private static final Duration CACHE_TTL = Duration.ofMinutes(10);
    private static final String UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

    private final RestTemplate http;
    private final ObjectMapper objectMapper;
    private final String configuredFfmpeg;
    private final ConcurrentHashMap<String, CachedAudio> cache = new ConcurrentHashMap<>();
    private volatile String ffmpegBin;

    public YoutubeAudioService(
            RestTemplateBuilder builder,
            ObjectMapper objectMapper,
            @Value("${app.video.ffmpeg.path:ffmpeg}") String configuredFfmpeg) {
        this.http = builder.connectTimeout(Duration.ofSeconds(5)).readTimeout(Duration.ofSeconds(12)).build();
        this.objectMapper = objectMapper;
        this.configuredFfmpeg = configuredFfmpeg;
    }

    public void stream(String videoId, String range, String format, HttpServletResponse response) throws IOException {
        String id = safeId(videoId);
        if (id.isEmpty()) {
            response.sendError(HttpServletResponse.SC_BAD_REQUEST);
            return;
        }
        if (wantsWebm(format) && proxy(id, range, response)) {
            return;
        }
        if (response.isCommitted()) {
            return;
        }
        CachedAudio aac = resolve(id, false);
        if (aac != null && remuxMp4(aac, response)) {
            return;
        }
        if (response.isCommitted()) {
            return;
        }
        streamProgressive(id, response);
    }

    /**
     * Opus/WebM is one finite file. The phone can buffer it and keep the sample
     * clock, which a live AAC pipe cannot do.
     */
    private boolean proxy(String id, String clientRange, HttpServletResponse response) throws IOException {
        CachedAudio audio = fresh(id, true);
        if (audio == null || !audio.mime().startsWith("audio/webm")) {
            return false;
        }
        HttpURLConnection conn = openAudio(audio, clientRange);
        int status = conn.getResponseCode();
        if (status == 403 || status == 410 || status == 400) {
            conn.disconnect();
            cache.remove(id + "|webm");
            audio = fresh(id, true);
            if (audio == null || !audio.mime().startsWith("audio/webm")) {
                return false;
            }
            conn = openAudio(audio, clientRange);
            status = conn.getResponseCode();
        }
        if (status != 200 && status != 206) {
            log.warn("YouTube audio upstream HTTP {} for {}", status, id);
            conn.disconnect();
            cache.remove(id + "|webm");
            return false;
        }
        boolean partial = partialRequest(clientRange, audio.bytes()) && status == 206;
        response.setStatus(partial ? HttpServletResponse.SC_PARTIAL_CONTENT : HttpServletResponse.SC_OK);
        response.setCharacterEncoding((String) null);
        response.setBufferSize(32 * 1024);
        response.setHeader(HttpHeaders.CONTENT_TYPE, "audio/webm");
        response.setHeader(HttpHeaders.CACHE_CONTROL, "private, no-store");
        response.setHeader(HttpHeaders.ACCEPT_RANGES, "bytes");
        if (partial) {
            copyHeader(conn, response, HttpHeaders.CONTENT_RANGE);
            copyHeader(conn, response, HttpHeaders.CONTENT_LENGTH);
        } else {
            long len = conn.getContentLengthLong();
            if (len <= 0 && !partialRequest(clientRange, audio.bytes())) {
                len = audio.bytes();
            }
            if (len > 0) {
                response.setContentLengthLong(len);
            }
        }
        try (InputStream in = conn.getInputStream(); OutputStream out = response.getOutputStream()) {
            copyFlush(in, out, response);
        } catch (IOException e) {
            log.debug("YouTube audio pipe closed for {}", id);
        } finally {
            conn.disconnect();
        }
        return true;
    }

    /** AAC wrapped as a fragmented MP4, so Safari gets timestamps instead of raw ADTS. */
    private boolean remuxMp4(CachedAudio audio, HttpServletResponse response) throws IOException {
        String ffmpeg = ffmpegBin();
        if (ffmpeg == null || audio.url() == null || audio.url().isBlank()) {
            return false;
        }
        List<String> cmd = new ArrayList<>();
        cmd.add(ffmpeg);
        cmd.add("-hide_banner");
        cmd.add("-loglevel");
        cmd.add("error");
        cmd.add("-nostdin");
        cmd.add("-rw_timeout");
        cmd.add("20000000");
        cmd.add("-user_agent");
        cmd.add(UA);
        String range = fileRange(null, audio.bytes());
        if (range != null) {
            cmd.add("-headers");
            cmd.add("Range: " + range + "\r\n");
        }
        cmd.add("-i");
        cmd.add(audio.url());
        cmd.add("-vn");
        cmd.add("-c:a");
        cmd.add("copy");
        cmd.add("-movflags");
        cmd.add("frag_keyframe+empty_moov+default_base_moof");
        cmd.add("-frag_duration");
        cmd.add("1000000");
        cmd.add("-f");
        cmd.add("mp4");
        cmd.add("pipe:1");
        Process process;
        try {
            process = new ProcessBuilder(cmd)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException e) {
            log.warn("ffmpeg could not remux audio");
            return false;
        }
        try (InputStream in = process.getInputStream()) {
            byte[] buf = new byte[64 * 1024];
            int n = in.read(buf);
            if (n < 0) {
                process.destroy();
                return false;
            }
            response.setStatus(HttpServletResponse.SC_OK);
            response.setCharacterEncoding((String) null);
            response.setBufferSize(32 * 1024);
            response.setHeader(HttpHeaders.CONTENT_TYPE, "audio/mp4");
            response.setHeader(HttpHeaders.CACHE_CONTROL, "private, no-store");
            response.setHeader(HttpHeaders.ACCEPT_RANGES, "none");
            OutputStream out = response.getOutputStream();
            out.write(buf, 0, n);
            response.flushBuffer();
            copyFlush(in, out, response);
            return true;
        } catch (IOException e) {
            log.debug("YouTube audio remux closed");
            return true;
        } finally {
            if (process.isAlive()) {
                process.destroy();
            }
        }
    }

    /**
     * Last resort: the combined picture file, re-encoded to 48 kHz AAC in a
     * fragmented MP4. 44.1 kHz ADTS is what makes phone decoders crackle.
     */
    private void streamProgressive(String id, HttpServletResponse response) throws IOException {
        String ffmpeg = ffmpegBin();
        if (ffmpeg == null) {
            log.warn("ffmpeg is not available, audio-only playback cannot drop the picture");
            response.sendError(HttpServletResponse.SC_BAD_GATEWAY);
            return;
        }
        String videoUrl = resolveVideoUrl(id);
        if (videoUrl == null) {
            response.sendError(HttpServletResponse.SC_NOT_FOUND);
            return;
        }
        HttpURLConnection conn = open(videoUrl, null);
        int status = conn.getResponseCode();
        if (status == 403 || status == 410) {
            cache.remove(id + "|picture");
            conn.disconnect();
            videoUrl = resolveVideoUrl(id);
            if (videoUrl == null) {
                response.sendError(HttpServletResponse.SC_NOT_FOUND);
                return;
            }
            conn = open(videoUrl, null);
            status = conn.getResponseCode();
        }
        if (status != 200 && status != 206) {
            log.warn("YouTube picture upstream HTTP {} for {}", status, id);
            conn.disconnect();
            response.sendError(HttpServletResponse.SC_BAD_GATEWAY);
            return;
        }
        final HttpURLConnection source = conn;
        Process ffmpegProcess;
        try {
            ffmpegProcess = new ProcessBuilder(
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel", "error",
                    "-nostdin",
                    "-i", "pipe:0",
                    "-vn",
                    "-af", "aresample=async=1:first_pts=0",
                    "-c:a", "aac",
                    "-b:a", "160k",
                    "-ar", "48000",
                    "-ac", "2",
                    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                    "-frag_duration", "1000000",
                    "-f", "mp4",
                    "pipe:1")
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException e) {
            conn.disconnect();
            log.warn("ffmpeg could not start for {}", id);
            response.sendError(HttpServletResponse.SC_BAD_GATEWAY);
            return;
        }
        Thread feeder = Thread.startVirtualThread(() -> {
            try (InputStream in = source.getInputStream(); OutputStream toFfmpeg = ffmpegProcess.getOutputStream()) {
                in.transferTo(toFfmpeg);
            } catch (IOException e) {
                log.debug("YouTube picture feed closed for {}", id);
            } finally {
                source.disconnect();
                try {
                    ffmpegProcess.getOutputStream().close();
                } catch (IOException ignored) {
                    /* the encoder already stopped */
                }
            }
        });
        response.setStatus(HttpServletResponse.SC_OK);
        response.setCharacterEncoding((String) null);
        response.setBufferSize(32 * 1024);
        response.setHeader(HttpHeaders.CONTENT_TYPE, "audio/mp4");
        response.setHeader(HttpHeaders.CACHE_CONTROL, "private, no-store");
        response.setHeader(HttpHeaders.ACCEPT_RANGES, "none");
        try (InputStream audio = ffmpegProcess.getInputStream(); OutputStream out = response.getOutputStream()) {
            copyFlush(audio, out, response);
        } catch (IOException e) {
            log.debug("YouTube audio pipe closed for {}", id);
            ffmpegProcess.destroy();
        } finally {
            if (ffmpegProcess.isAlive()) {
                ffmpegProcess.destroy();
            }
            try {
                feeder.join(Duration.ofSeconds(5).toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private HttpURLConnection openAudio(CachedAudio audio, String clientRange) throws IOException {
        String closed = fileRange(clientRange, audio.bytes());
        HttpURLConnection conn = open(audio.url(), closed);
        int status = conn.getResponseCode();
        if (closed != null && (status == 400 || status == 403 || status == 416)) {
            conn.disconnect();
            return open(audio.url(), null);
        }
        return conn;
    }

    /** A cached URL, fetched again when the previous one has expired. */
    private CachedAudio fresh(String id, boolean webm) {
        return resolve(id, webm);
    }

    private static void copyFlush(InputStream in, OutputStream out, HttpServletResponse response) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) >= 0) {
            out.write(buf, 0, n);
            response.flushBuffer();
        }
    }

    private String resolveVideoUrl(String id) {
        String key = id + "|picture";
        CachedAudio cached = cache.get(key);
        if (cached != null && cached.expires.isAfter(Instant.now())) {
            return cached.url();
        }
        JsonNode root = postPlayer(id, "ANDROID", "20.10.38", UA, client -> {
            client.put("androidSdkVersion", 30);
            client.put("osName", "Android");
            client.put("osVersion", "11");
        });
        String url = pickProgressiveUrl(root);
        if (url == null) {
            cache.remove(key);
            return null;
        }
        cache.put(key, new CachedAudio(url, "video/mp4", Instant.now().plus(CACHE_TTL), -1));
        return url;
    }

    private String ffmpegBin() {
        String cached = ffmpegBin;
        if (cached != null) {
            return cached.isBlank() ? null : cached;
        }
        String found = firstWorking(
                configuredFfmpeg,
                "ffmpeg",
                "C:\\Program Files\\BluOS Controller\\resources\\bin\\ffmpeg.exe");
        ffmpegBin = found == null ? "" : found;
        return found;
    }

    private static String firstWorking(String... candidates) {
        for (String candidate : candidates) {
            if (candidate == null || candidate.isBlank()) {
                continue;
            }
            try {
                Process process = new ProcessBuilder(candidate, "-version")
                        .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                        .redirectError(ProcessBuilder.Redirect.DISCARD)
                        .start();
                if (process.waitFor() == 0) {
                    return candidate;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            } catch (IOException ignored) {
                /* try the next location */
            }
        }
        return null;
    }

    private CachedAudio resolve(String id, boolean webm) {
        String key = id + (webm ? "|webm" : "|mp4");
        CachedAudio cached = cache.get(key);
        if (cached != null && cached.expires.isAfter(Instant.now())) {
            return cached;
        }
        CachedAudio fresh = fetch(id, webm);
        if (fresh == null) {
            cache.remove(key);
            return null;
        }
        cache.put(key, fresh);
        return fresh;
    }

    private CachedAudio fetch(String id, boolean webm) {
        CachedAudio android = readPlayer(id, webm, "ANDROID", "20.10.38",
                "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
                client -> {
                    client.put("androidSdkVersion", 30);
                    client.put("osName", "Android");
                    client.put("osVersion", "11");
                });
        if (android != null) {
            return android;
        }
        return readPlayer(id, webm, "IOS", "20.10.4",
                "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
                client -> {
                    client.put("deviceModel", "iPhone16,2");
                    client.put("osName", "iPhone");
                    client.put("osVersion", "18.3.2.22D82");
                });
    }

    private CachedAudio readPlayer(
            String id,
            boolean webm,
            String clientName,
            String clientVersion,
            String userAgent,
            Consumer<ObjectNode> extras) {
        JsonNode root = postPlayer(id, clientName, clientVersion, userAgent, extras);
        return root == null ? null : pickAudio(root, webm);
    }

    private JsonNode postPlayer(
            String id,
            String clientName,
            String clientVersion,
            String userAgent,
            Consumer<ObjectNode> extras) {
        ObjectNode root = objectMapper.createObjectNode();
        ObjectNode client = root.putObject("context").putObject("client");
        client.put("clientName", clientName);
        client.put("clientVersion", clientVersion);
        client.put("hl", "fr");
        client.put("gl", "FR");
        extras.accept(client);
        root.put("videoId", id);
        root.put("contentCheckOk", true);
        root.put("racyCheckOk", true);
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.set(HttpHeaders.USER_AGENT, userAgent);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = http.postForEntity(PLAYER, new HttpEntity<>(root.toString(), headers), String.class);
            String body = response.getBody();
            if (body == null || body.isBlank()) {
                return null;
            }
            return objectMapper.readTree(body);
        } catch (RestClientException | IOException e) {
            log.warn("YouTube audio lookup failed for {}", id);
            return null;
        }
    }

    /** Combined picture-and-sound file. Itag 18 is the small one YouTube still sends whole. */
    static String pickProgressiveUrl(JsonNode root) {
        JsonNode formats = root == null ? null : root.path("streamingData").path("formats");
        if (formats == null || !formats.isArray()) {
            return null;
        }
        String smallest = null;
        long smallestLen = Long.MAX_VALUE;
        for (JsonNode format : formats) {
            String url = format.path("url").asText("");
            String mime = format.path("mimeType").asText("");
            if (!mime.startsWith("video/") || !url.startsWith("https://") || !googlevideo(url)) {
                continue;
            }
            if (format.path("itag").asInt(0) == 18) {
                return url;
            }
            long len = format.path("contentLength").asLong(Long.MAX_VALUE);
            if (len < smallestLen) {
                smallestLen = len;
                smallest = url;
            }
        }
        return smallest;
    }

    /** An audio-only adaptive format. Video itags are ignored. */
    static CachedAudio pickAudio(JsonNode root) {
        return pickAudio(root, true);
    }

    /** WebM Opus plays in the page audio element. The MP4 from YouTube is a video fragment and does not. */
    static CachedAudio pickAudio(JsonNode root, boolean webm) {
        JsonNode formats = root == null ? null : root.path("streamingData").path("adaptiveFormats");
        if (formats == null || !formats.isArray()) {
            return null;
        }
        CachedAudio best = null;
        int bestRank = -1;
        for (JsonNode format : formats) {
            String mime = format.path("mimeType").asText("");
            String url = format.path("url").asText("");
            if (!mime.startsWith("audio/") || !url.startsWith("https://") || !googlevideo(url)) {
                continue;
            }
            int rank = audioRank(format.path("itag").asInt(0), mime, webm);
            if (rank > bestRank) {
                bestRank = rank;
                String type = mime.split(";")[0].trim().toLowerCase(Locale.ROOT);
                best = new CachedAudio(url, type, Instant.now().plus(CACHE_TTL), contentLength(format));
            }
        }
        return best;
    }

    private static int audioRank(int itag, String mime, boolean webm) {
        boolean opus = mime.startsWith("audio/webm");
        if (webm && itag == 251) {
            return 4;
        }
        boolean aac = itag == 140 || mime.startsWith("audio/mp4");
        if (webm) {
            if (opus) {
                return 3;
            }
            if (aac) {
                return 2;
            }
        } else if (aac) {
            return 3;
        } else if (opus) {
            return 2;
        }
        return 1;
    }

    /** Chrome and the Android WebView ask for webm. Safari asks for mp4. */
    static boolean wantsWebm(String format) {
        if (format == null || format.isBlank()) {
            return true;
        }
        String fmt = format.trim().toLowerCase(Locale.ROOT);
        return !fmt.equals("mp4") && !fmt.equals("m4a") && !fmt.equals("aac");
    }

    /**
     * Closed byte range covering the whole file, or the slice the player asked for.
     * YouTube rejects an open-ended {@code bytes=0-}.
     */
    static String fileRange(String clientRange, long total) {
        if (total <= 0) {
            return null;
        }
        long start = 0;
        long end = total - 1;
        if (clientRange != null && clientRange.startsWith("bytes=")) {
            String spec = clientRange.substring("bytes=".length()).trim();
            int comma = spec.indexOf(',');
            if (comma >= 0) {
                spec = spec.substring(0, comma).trim();
            }
            int dash = spec.indexOf('-');
            if (dash >= 0) {
                String left = spec.substring(0, dash).trim();
                String right = spec.substring(dash + 1).trim();
                if (left.isEmpty()) {
                    long suffix = 0;
                    try {
                        suffix = right.isEmpty() ? 0 : Long.parseLong(right);
                    } catch (NumberFormatException ignored) {
                        suffix = 0;
                    }
                    if (suffix > 0) {
                        start = Math.max(0, total - suffix);
                    }
                } else {
                    try {
                        start = Long.parseLong(left);
                    } catch (NumberFormatException ignored) {
                        start = 0;
                    }
                    if (!right.isEmpty()) {
                        try {
                            end = Long.parseLong(right);
                        } catch (NumberFormatException ignored) {
                            end = total - 1;
                        }
                    }
                }
            }
        }
        if (start < 0) {
            start = 0;
        }
        if (start >= total) {
            start = total - 1;
        }
        if (end < start || end >= total) {
            end = total - 1;
        }
        return "bytes=" + start + "-" + end;
    }

    /** True when the player asked for a slice, not the whole file. */
    static boolean partialRequest(String clientRange, long total) {
        if (clientRange == null || !clientRange.startsWith("bytes=") || total <= 0) {
            return false;
        }
        String closed = fileRange(clientRange, total);
        return closed != null && !closed.equals("bytes=0-" + (total - 1));
    }

    static long contentLength(JsonNode format) {
        long len = format == null ? -1 : format.path("contentLength").asLong(-1);
        if (len > 0) {
            return len;
        }
        String url = format == null ? "" : format.path("url").asText("");
        int at = url.indexOf("clen=");
        if (at < 0) {
            return -1;
        }
        int start = at + "clen=".length();
        int end = start;
        while (end < url.length() && Character.isDigit(url.charAt(end))) {
            end++;
        }
        if (end == start) {
            return -1;
        }
        try {
            long parsed = Long.parseLong(url.substring(start, end));
            return parsed > 0 ? parsed : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** YouTube rejects an open-ended range. Keep each pull to one megabyte. */
    static String upstreamRange(String clientRange) {
        long chunk = 1024L * 1024L;
        long start = 0;
        long end = chunk - 1;
        if (clientRange != null && clientRange.startsWith("bytes=")) {
            String spec = clientRange.substring("bytes=".length()).trim();
            int dash = spec.indexOf('-');
            if (dash > 0) {
                try {
                    start = Long.parseLong(spec.substring(0, dash).trim());
                } catch (NumberFormatException ignored) {
                    start = 0;
                }
                String tail = spec.substring(dash + 1).trim();
                int comma = tail.indexOf(',');
                if (comma >= 0) {
                    tail = tail.substring(0, comma).trim();
                }
                if (!tail.isEmpty()) {
                    try {
                        end = Long.parseLong(tail);
                    } catch (NumberFormatException ignored) {
                        end = start + chunk - 1;
                    }
                } else {
                    end = start + chunk - 1;
                }
            }
        }
        if (start < 0) {
            start = 0;
        }
        if (end < start || end - start + 1 > chunk) {
            end = start + chunk - 1;
        }
        return "bytes=" + start + "-" + end;
    }

    static boolean googlevideo(String url) {
        try {
            String host = URI.create(url).getHost();
            if (host == null) {
                return false;
            }
            host = host.toLowerCase(Locale.ROOT);
            return host.equals("googlevideo.com") || host.endsWith(".googlevideo.com");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static HttpURLConnection open(String url, String range) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(8_000);
        conn.setReadTimeout(180_000);
        conn.setRequestProperty("User-Agent", "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip");
        conn.setRequestProperty("Accept", "*/*");
        if (range != null && range.startsWith("bytes=")) {
            conn.setRequestProperty("Range", range);
        }
        return conn;
    }

    private static void copyHeader(HttpURLConnection conn, HttpServletResponse response, String name) {
        String value = conn.getHeaderField(name);
        if (value != null && !value.isBlank()) {
            response.setHeader(name, value);
        }
    }

    static String safeId(String raw) {
        if (raw == null) {
            return "";
        }
        String id = raw.trim();
        return id.matches("[a-zA-Z0-9_-]{11}") ? id : "";
    }

    record CachedAudio(String url, String mime, Instant expires, long bytes) {}
}
