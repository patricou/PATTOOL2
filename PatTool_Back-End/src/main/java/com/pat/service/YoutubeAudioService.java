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
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Plays a YouTube clip as sound only. The backend downloads the whole
 * picture-and-sound file, drops the picture, and forwards the audio.
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
                    "-i", "pipe:0",
                    "-vn",
                    "-c:a", "copy",
                    "-f", "adts",
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
        response.setHeader(HttpHeaders.CONTENT_TYPE, "audio/aac");
        response.setHeader(HttpHeaders.CACHE_CONTROL, "private, no-store");
        response.setHeader(HttpHeaders.ACCEPT_RANGES, "none");
        try (InputStream audio = ffmpegProcess.getInputStream(); OutputStream out = response.getOutputStream()) {
            audio.transferTo(out);
        } catch (IOException e) {
            log.debug("YouTube audio pipe closed for {}", id);
            ffmpegProcess.destroy();
        } finally {
            try {
                feeder.join(Duration.ofSeconds(5).toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
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
        cache.put(key, new CachedAudio(url, "video/mp4", Instant.now().plus(CACHE_TTL)));
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
                best = new CachedAudio(url, type, Instant.now().plus(CACHE_TTL));
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

    record CachedAudio(String url, String mime, Instant expires) {}
}
