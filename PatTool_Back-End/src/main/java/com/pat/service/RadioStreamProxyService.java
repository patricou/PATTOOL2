package com.pat.service;

import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Proxies internet-radio streams:
 * <ul>
 *   <li>HLS playlists ({@code .m3u8}) and finite TV segments ({@code .ts}, {@code .m4s}, {@code .mp4}) →
 *       {@link TvStreamProxyService} (buffered + playlist rewrite)</li>
 *   <li>Finite podcast files ({@code .m4a}, progressive MP3/AAC on podcast CDNs) → streamed pipe
 *       with {@code Range} / {@code Content-Length} (must not use the 12&nbsp;MiB TV buffer)</li>
 *   <li>Continuous Icecast / progressive live MP3-AAC → raw pipe (no ranges)</li>
 * </ul>
 * Writing continuous streams via {@code StreamingResponseBody} inside {@code ResponseEntity&lt;?&gt;}
 * breaks Spring (no converter for Content-Type like {@code video/mp2t}).
 */
@Service
public class RadioStreamProxyService {

    private static final Logger log = LoggerFactory.getLogger(RadioStreamProxyService.class);

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private static final int CONNECT_TIMEOUT_MS = 12_000;
    /**
     * Idle read timeout for continuous Icecast/MP3 pipes and progressive podcast downloads.
     * Non-zero so a silent/hung upstream cannot pin a Tomcat worker forever after the browser
     * already aborted (station change / leave page). Client abort is still detected on write.
     */
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final int MAX_REDIRECTS = 8;
    private static final int PLAYLIST_MAX_BYTES = 64 * 1024;

    private final TvStreamProxyService tvStreamProxyService;

    public RadioStreamProxyService(TvStreamProxyService tvStreamProxyService) {
        this.tvStreamProxyService = tvStreamProxyService;
    }

    /**
     * HLS playlist or finite media segment that must go through the buffered TV proxy.
     * <p>
     * Note: {@code .m4a} podcast files are intentionally excluded — they are often 50–100+&nbsp;MiB
     * and would hit the TV proxy's 12&nbsp;MiB cap. Use {@link #isProgressivePodcastFile(String)}.
     */
    public static boolean useBufferedProxy(String url) {
        if (url == null) {
            return false;
        }
        String u = url.toLowerCase(Locale.ROOT);
        // Strip query for extension checks
        int q = u.indexOf('?');
        String path = q >= 0 ? u.substring(0, q) : u;
        return path.contains(".m3u8")
                || path.endsWith(".ts")
                || path.endsWith(".m4s")
                || path.endsWith(".mp4")
                || path.endsWith(".cmfv")
                || path.endsWith(".cmfa");
    }

    /**
     * Finite on-demand audio (podcasts) that need Content-Length / Range, not live Icecast semantics.
     */
    public static boolean isProgressivePodcastFile(String url) {
        if (url == null) {
            return false;
        }
        String u = url.toLowerCase(Locale.ROOT);
        int q = u.indexOf('?');
        String path = q >= 0 ? u.substring(0, q) : u;
        if (path.endsWith(".m4a") || path.endsWith(".aac") || path.contains(".m4a?")) {
            return true;
        }
        // Radio France / podcast CDNs often serve MP3 enclosures too.
        if ((path.endsWith(".mp3") || path.contains("audio/mpeg"))
                && (u.contains("radiofrance")
                || u.contains("proxycast")
                || u.contains("podcast"))) {
            return true;
        }
        return false;
    }

    public static boolean isSimplePlaylistUrl(String url) {
        if (url == null) {
            return false;
        }
        String u = url.toLowerCase(Locale.ROOT);
        if (u.contains(".m3u8")) {
            return false;
        }
        return u.contains(".m3u") || u.contains(".pls");
    }

    /**
     * Write the proxied radio stream directly to the servlet response.
     */
    public void proxyRadio(String upstreamUrl, String proxyBase, String rangeHeader,
                           HttpServletResponse response) throws IOException {
        String url = upstreamUrl != null ? upstreamUrl.trim() : "";
        if (url.isEmpty()) {
            writeJsonError(response, HttpStatus.BAD_REQUEST, "missing_url", "URL de flux manquante");
            return;
        }

        if (isSimplePlaylistUrl(url)) {
            Optional<String> resolved = resolveSimplePlaylist(url);
            if (resolved.isEmpty()) {
                writeJsonError(response, HttpStatus.BAD_GATEWAY, "playlist_unresolved",
                        "Impossible de résoudre la playlist radio");
                return;
            }
            url = resolved.get();
        }

        if (isProgressivePodcastFile(url)) {
            writeProgressive(url, rangeHeader, response);
            return;
        }

        if (useBufferedProxy(url)) {
            writeEntity(tvStreamProxyService.proxy(url, proxyBase, rangeHeader), response);
            return;
        }

        writeContinuous(url, response);
    }

    /**
     * Stream a finite podcast file with optional HTTP Range (no in-memory size cap).
     */
    private void writeProgressive(String upstreamUrl, String rangeHeader,
                                  HttpServletResponse response) throws IOException {
        URI uri;
        try {
            uri = URI.create(upstreamUrl);
        } catch (Exception e) {
            writeJsonError(response, HttpStatus.BAD_REQUEST, "invalid_url", "URL de flux invalide");
            return;
        }
        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            writeJsonError(response, HttpStatus.BAD_REQUEST, "invalid_scheme",
                    "L’URL du flux doit être http ou https");
            return;
        }
        if (uri.getHost() == null || isBlockedHost(uri.getHost())) {
            writeJsonError(response, HttpStatus.FORBIDDEN, "host_blocked", "Hôte de flux non autorisé");
            return;
        }

        OpenedStream opened;
        try {
            opened = openUpstream(upstreamUrl, rangeHeader);
        } catch (Exception e) {
            log.debug("radio progressive open failed for {}: {}", upstreamUrl, e.toString());
            writeJsonError(response, HttpStatus.BAD_GATEWAY, "upstream_unreachable",
                    "Flux distant inaccessible ou bloqué");
            return;
        }
        if (opened == null || opened.connection == null || opened.inputStream == null) {
            writeJsonError(response, HttpStatus.BAD_GATEWAY, "upstream_unreachable",
                    "Flux distant inaccessible ou bloqué");
            return;
        }
        if (opened.status == 416) {
            opened.connection.disconnect();
            writeJsonError(response, HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "range_not_satisfiable",
                    "Plage d’octets demandée indisponible");
            return;
        }
        if (opened.status >= 400) {
            opened.connection.disconnect();
            writeJsonError(response, HttpStatus.BAD_GATEWAY, "upstream_http_error",
                    "Le flux distant a répondu HTTP " + opened.status);
            return;
        }

        String contentType = opened.contentType;
        if (contentType == null || contentType.isBlank()
                || contentType.toLowerCase(Locale.ROOT).contains("text/html")) {
            contentType = guessAudioContentType(upstreamUrl);
        }
        contentType = stripSpuriousCharset(contentType);

        int status = opened.status == 206 ? 206 : HttpServletResponse.SC_OK;
        response.setStatus(status);
        response.setContentType(contentType);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader(HttpHeaders.ACCEPT_RANGES,
                StringUtils.hasText(opened.acceptRanges) ? opened.acceptRanges : "bytes");
        if (StringUtils.hasText(opened.contentRange)) {
            response.setHeader(HttpHeaders.CONTENT_RANGE, opened.contentRange);
        }
        if (opened.contentLength >= 0) {
            response.setContentLengthLong(opened.contentLength);
        }

        try (InputStream in = opened.inputStream; OutputStream out = response.getOutputStream()) {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (Exception e) {
            log.debug("radio progressive pipe ended: {}", e.toString());
        } finally {
            opened.connection.disconnect();
        }
    }

    private void writeContinuous(String upstreamUrl, HttpServletResponse response) throws IOException {
        URI uri;
        try {
            uri = URI.create(upstreamUrl);
        } catch (Exception e) {
            writeJsonError(response, HttpStatus.BAD_REQUEST, "invalid_url", "URL de flux invalide");
            return;
        }
        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            writeJsonError(response, HttpStatus.BAD_REQUEST, "invalid_scheme",
                    "L’URL du flux doit être http ou https");
            return;
        }
        if (uri.getHost() == null || isBlockedHost(uri.getHost())) {
            writeJsonError(response, HttpStatus.FORBIDDEN, "host_blocked", "Hôte de flux non autorisé");
            return;
        }

        OpenedStream opened;
        try {
            opened = openUpstream(upstreamUrl, null);
        } catch (Exception e) {
            log.debug("radio continuous open failed for {}: {}", upstreamUrl, e.toString());
            writeJsonError(response, HttpStatus.BAD_GATEWAY, "upstream_unreachable",
                    "Flux distant inaccessible ou bloqué");
            return;
        }
        if (opened == null || opened.connection == null || opened.inputStream == null) {
            writeJsonError(response, HttpStatus.BAD_GATEWAY, "upstream_unreachable",
                    "Flux distant inaccessible ou bloqué");
            return;
        }

        String contentType = opened.contentType;
        if (contentType == null || contentType.isBlank()
                || contentType.toLowerCase(Locale.ROOT).contains("text/html")) {
            contentType = guessAudioContentType(upstreamUrl);
        }

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(contentType);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader(HttpHeaders.ACCEPT_RANGES, "none");
        response.setHeader("Connection", "close");

        try (InputStream in = opened.inputStream; OutputStream out = response.getOutputStream()) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (Exception e) {
            // Client abort / upstream drop is normal for live radio.
            log.debug("radio continuous pipe ended: {}", e.toString());
        } finally {
            opened.connection.disconnect();
        }
    }

    private void writeEntity(ResponseEntity<byte[]> entity, HttpServletResponse response) throws IOException {
        response.setStatus(entity.getStatusCode().value());
        HttpHeaders headers = entity.getHeaders();
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            String name = entry.getKey();
            if (name == null) {
                continue;
            }
            // Transfer-Encoding / Content-Length managed by container when writing body
            if (HttpHeaders.TRANSFER_ENCODING.equalsIgnoreCase(name)
                    || HttpHeaders.CONTENT_LENGTH.equalsIgnoreCase(name)) {
                continue;
            }
            for (String value : entry.getValue()) {
                response.addHeader(name, value);
            }
        }
        byte[] body = entity.getBody();
        if (body != null && body.length > 0) {
            response.getOutputStream().write(body);
            response.getOutputStream().flush();
        }
    }

    private static void writeJsonError(HttpServletResponse response, HttpStatus status,
                                       String error, String message) throws IOException {
        ResponseEntity<byte[]> entity = TvStreamProxyService.jsonError(status, error, message);
        response.setStatus(entity.getStatusCode().value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        byte[] body = entity.getBody();
        if (body != null) {
            response.getOutputStream().write(body);
        }
    }

    private Optional<String> resolveSimplePlaylist(String playlistUrl) {
        try {
            OpenedStream opened = openUpstream(playlistUrl, null);
            if (opened == null || opened.inputStream == null) {
                return Optional.empty();
            }
            try (InputStream in = opened.inputStream;
                 BufferedReader reader = new BufferedReader(
                         new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                int total = 0;
                while ((line = reader.readLine()) != null) {
                    total += line.length() + 1;
                    if (total > PLAYLIST_MAX_BYTES) {
                        break;
                    }
                    String t = line.trim();
                    if (t.isEmpty()) {
                        continue;
                    }
                    String candidate = t;
                    String upper = t.toUpperCase(Locale.ROOT);
                    if (upper.startsWith("FILE") && t.contains("=")) {
                        candidate = t.substring(t.indexOf('=') + 1).trim();
                    } else if (t.startsWith("#")) {
                        continue;
                    }
                    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
                        String host = URI.create(candidate).getHost();
                        if (host != null && !isBlockedHost(host)) {
                            return Optional.of(candidate);
                        }
                    }
                }
            } finally {
                opened.connection.disconnect();
            }
        } catch (Exception e) {
            log.debug("radio playlist resolve failed for {}: {}", playlistUrl, e.toString());
        }
        return Optional.empty();
    }

    private OpenedStream openUpstream(String url, String rangeHeader) throws Exception {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URI uri = URI.create(current);
            if (isBlockedHost(uri.getHost())) {
                return null;
            }
            URL u = uri.toURL();
            HttpURLConnection conn = (HttpURLConnection) u.openConnection();
            boolean retainConnection = false;
            try {
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", USER_AGENT);
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Icy-MetaData", "0");
                String referer = resolveReferer(uri.getHost());
                if (referer != null) {
                    conn.setRequestProperty("Referer", referer);
                    if (referer.contains("radiofrance.fr")) {
                        conn.setRequestProperty("Origin", "https://www.radiofrance.fr");
                    }
                }
                if (StringUtils.hasText(rangeHeader)) {
                    conn.setRequestProperty("Range", rangeHeader.trim());
                }

                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = conn.getHeaderField("Location");
                    if (location == null || location.isBlank()) {
                        return null;
                    }
                    current = uri.resolve(location).toString();
                    continue;
                }
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (in == null && code >= 400) {
                    OpenedStream err = new OpenedStream();
                    err.connection = conn;
                    err.status = code;
                    retainConnection = true;
                    return err;
                }
                if (in == null) {
                    return null;
                }
                OpenedStream opened = new OpenedStream();
                opened.connection = conn;
                opened.inputStream = in;
                opened.status = code;
                opened.contentType = conn.getContentType();
                opened.contentRange = conn.getHeaderField("Content-Range");
                opened.acceptRanges = conn.getHeaderField("Accept-Ranges");
                long cl = conn.getContentLengthLong();
                opened.contentLength = cl;
                retainConnection = true;
                return opened;
            } catch (Exception e) {
                throw e;
            } finally {
                if (!retainConnection) {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {
                        /* ignore */
                    }
                }
            }
        }
        return null;
    }

    private static String resolveReferer(String host) {
        if (host == null || host.isBlank()) {
            return null;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith("radiofrance.fr")
                || h.contains("radiofrance-podcast")
                || h.contains("proxycast.radiofrance")
                || h.contains("media.radiofrance")) {
            return "https://www.radiofrance.fr/";
        }
        return null;
    }

    private static String stripSpuriousCharset(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            return contentType;
        }
        String lower = contentType.toLowerCase(Locale.ROOT);
        if (!(lower.startsWith("audio/") || lower.startsWith("video/")
                || lower.startsWith("application/octet-stream") || lower.contains("mp4"))) {
            return contentType;
        }
        int semi = contentType.indexOf(';');
        return semi >= 0 ? contentType.substring(0, semi).trim() : contentType;
    }

    private static String guessAudioContentType(String url) {
        String u = url.toLowerCase(Locale.ROOT);
        if (u.contains(".m4a") || u.contains("audio/mp4") || u.contains("audio/x-m4a")) {
            return "audio/mp4";
        }
        if (u.contains(".aac") || u.contains("audio/aac") || u.contains("aacp")) {
            return "audio/aac";
        }
        if (u.contains(".ogg") || u.contains(".opus")) {
            return "audio/ogg";
        }
        if (u.contains(".flac")) {
            return "audio/flac";
        }
        if (u.contains(".mp3") || u.contains("mp3")) {
            return "audio/mpeg";
        }
        return "audio/mpeg";
    }

    private static boolean isBlockedHost(String host) {
        if (host == null || host.isBlank()) {
            return true;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(h) || h.endsWith(".localhost") || h.endsWith(".local")) {
            return true;
        }
        try {
            InetAddress addr = InetAddress.getByName(h);
            if (addr.isAnyLocalAddress() || addr.isLoopbackAddress() || addr.isLinkLocalAddress()
                    || addr.isSiteLocalAddress()) {
                return true;
            }
        } catch (UnknownHostException e) {
            return true;
        }
        return false;
    }

    private static final class OpenedStream {
        private HttpURLConnection connection;
        private InputStream inputStream;
        private String contentType;
        private int status = 200;
        private long contentLength = -1;
        private String contentRange;
        private String acceptRanges;
    }
}
