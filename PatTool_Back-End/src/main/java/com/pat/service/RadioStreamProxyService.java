package com.pat.service;

import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

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
 *   <li>HLS playlists ({@code .m3u8}) and finite segments ({@code .ts}, {@code .m4s}) →
 *       {@link TvStreamProxyService} (buffered + playlist rewrite)</li>
 *   <li>Continuous Icecast / progressive MP3-AAC → raw pipe to {@link HttpServletResponse}
 *       (must not buffer; live radio never ends)</li>
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
    /** Live Icecast: do not idle-timeout the read while the client is listening. */
    private static final int READ_TIMEOUT_MS = 0;
    private static final int MAX_REDIRECTS = 8;
    private static final int PLAYLIST_MAX_BYTES = 64 * 1024;

    private final TvStreamProxyService tvStreamProxyService;

    public RadioStreamProxyService(TvStreamProxyService tvStreamProxyService) {
        this.tvStreamProxyService = tvStreamProxyService;
    }

    /**
     * HLS playlist or finite media segment that must go through the buffered TV proxy.
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

        if (useBufferedProxy(url)) {
            writeEntity(tvStreamProxyService.proxy(url, proxyBase, rangeHeader), response);
            return;
        }

        writeContinuous(url, response);
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
            opened = openUpstream(upstreamUrl);
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
            OpenedStream opened = openUpstream(playlistUrl);
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

    private OpenedStream openUpstream(String url) throws Exception {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            URI uri = URI.create(current);
            if (isBlockedHost(uri.getHost())) {
                return null;
            }
            URL u = uri.toURL();
            HttpURLConnection conn = (HttpURLConnection) u.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            conn.setRequestProperty("Accept", "*/*");
            conn.setRequestProperty("Icy-MetaData", "0");

            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.isBlank()) {
                    return null;
                }
                current = uri.resolve(location).toString();
                continue;
            }
            if (code >= 400) {
                conn.disconnect();
                return null;
            }
            InputStream in = conn.getInputStream();
            OpenedStream opened = new OpenedStream();
            opened.connection = conn;
            opened.inputStream = in;
            opened.contentType = conn.getContentType();
            return opened;
        }
        return null;
    }

    private static String guessAudioContentType(String url) {
        String u = url.toLowerCase(Locale.ROOT);
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
    }
}
