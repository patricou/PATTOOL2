package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;
import java.util.Optional;

/**
 * Proxies free IPTV / HLS media through the backend (CORS + mixed-content safe).
 * Rewrites {@code .m3u8} playlists so segment / variant URIs keep going through this proxy.
 */
@Service
public class TvStreamProxyService {

    private static final Logger log = LoggerFactory.getLogger(TvStreamProxyService.class);

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    /** TF1 mediainfo forces HLS with an iPhone UA — CDN JWTs often expect the same UA on playlist/segments. */
    private static final String IPHONE_USER_AGENT =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
                    + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 45_000;
    private static final int MAX_REDIRECTS = 8;
    /** Hard cap for a single proxied response (playlists + media segments). */
    private static final int MAX_BYTES = 12 * 1024 * 1024;

    @Value("${app.tv.proxy-referrer:}")
    private String defaultReferrer;

    public static String encodeUpstreamUrl(String url) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(url.getBytes(StandardCharsets.UTF_8));
    }

    public static Optional<String> decodeUpstreamUrl(String encoded) {
        if (encoded == null || encoded.isBlank()) {
            return Optional.empty();
        }
        try {
            String padded = encoded;
            int mod = encoded.length() % 4;
            if (mod > 0) {
                padded = encoded + "====".substring(mod);
            }
            byte[] bytes = Base64.getUrlDecoder().decode(padded);
            String url = new String(bytes, StandardCharsets.UTF_8).trim();
            if (url.isEmpty()) {
                return Optional.empty();
            }
            return Optional.of(url);
        } catch (IllegalArgumentException e) {
            try {
                String decoded = URLDecoder.decode(encoded, StandardCharsets.UTF_8);
                if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
                    return Optional.of(decoded);
                }
            } catch (Exception ignored) {
                // fall through
            }
            return Optional.empty();
        }
    }

    /**
     * Fetch upstream media and return bytes (rewriting HLS playlists when needed).
     *
     * @param upstreamUrl absolute http(s) stream URL
     * @param proxyBase   absolute base of this proxy endpoint ending with {@code /stream/}
     *                    e.g. {@code https://host/api/external/tv/stream/}
     * @param rangeHeader optional browser {@code Range} header
     */
    /**
     * JSON error payload for the TV watcher UI:
     * {@code error}, {@code message}, optional {@code status}, optional {@code host}.
     */
    public static ResponseEntity<byte[]> jsonError(HttpStatus status, String error, String message) {
        return jsonError(status, error, message, null, null);
    }

    public static ResponseEntity<byte[]> jsonError(HttpStatus status, String error, String message,
                                                   String host, Integer upstreamStatus) {
        String safeError = error != null ? error : "tv_stream_error";
        String safeMessage = message != null && !message.isBlank() ? message : safeError;
        StringBuilder json = new StringBuilder(160);
        json.append("{\"error\":\"").append(jsonEscape(safeError)).append('"');
        json.append(",\"message\":\"").append(jsonEscape(safeMessage)).append('"');
        if (status != null) {
            json.append(",\"status\":").append(status.value());
        }
        if (upstreamStatus != null && upstreamStatus > 0) {
            json.append(",\"upstreamStatus\":").append(upstreamStatus);
        }
        if (host != null && !host.isBlank()) {
            json.append(",\"host\":\"").append(jsonEscape(host.trim())).append('"');
        }
        json.append('}');
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE);
        headers.set(HttpHeaders.CACHE_CONTROL, "no-store");
        // Do not set Access-Control-Allow-Origin here: Spring CorsFilter already adds it.
        // A second value ("*, http://localhost:4200") breaks browser CORS checks.
        return ResponseEntity.status(status).headers(headers).body(json.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String jsonEscape(String value) {
        return value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    public ResponseEntity<byte[]> proxy(String upstreamUrl, String proxyBase, String rangeHeader) {
        URI uri;
        try {
            uri = URI.create(upstreamUrl);
        } catch (Exception e) {
            return jsonError(HttpStatus.BAD_REQUEST, "invalid_url", "URL de flux invalide");
        }

        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            return jsonError(HttpStatus.BAD_REQUEST, "invalid_scheme",
                    "L’URL du flux doit être http ou https");
        }
        String host = uri.getHost();
        if (host == null || host.isBlank() || isBlockedHost(host)) {
            return jsonError(HttpStatus.FORBIDDEN, "host_blocked",
                    "Hôte de flux non autorisé" + (host != null && !host.isBlank() ? " (" + host + ")" : ""),
                    host, null);
        }

        String referer = resolveReferer(host);
        FetchResult fetched = fetch(upstreamUrl, rangeHeader, referer);
        if (fetched == null) {
            return jsonError(HttpStatus.BAD_GATEWAY, "upstream_unreachable",
                    "Flux distant inaccessible ou bloqué (" + host + ")", host, null);
        }
        if (fetched.status == 416) {
            return jsonError(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "range_not_satisfiable",
                    "Plage d’octets demandée indisponible (" + host + ")", host, fetched.status);
        }
        if (fetched.status >= 400) {
            HttpStatus mapped = HttpStatus.resolve(fetched.status);
            if (mapped == null || mapped.is2xxSuccessful()) {
                mapped = HttpStatus.BAD_GATEWAY;
            }
            return jsonError(mapped, "upstream_http_error",
                    "Le flux distant a répondu HTTP " + fetched.status + " (" + host + ")",
                    host, fetched.status);
        }
        if (fetched.body == null || fetched.body.length == 0) {
            return jsonError(HttpStatus.BAD_GATEWAY, "upstream_empty",
                    "Le flux distant a renvoyé une réponse vide (" + host + ")", host, fetched.status);
        }

        byte[] body = fetched.body;
        String contentType = fetched.contentType != null ? fetched.contentType : MediaType.APPLICATION_OCTET_STREAM_VALUE;

        if (isPlaylist(upstreamUrl, contentType, body)) {
            String rewritten = rewritePlaylist(new String(body, StandardCharsets.UTF_8), upstreamUrl, proxyBase);
            body = rewritten.getBytes(StandardCharsets.UTF_8);
            contentType = "application/vnd.apple.mpegurl; charset=utf-8";
        }

        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.CONTENT_TYPE, contentType);
        headers.set(HttpHeaders.CACHE_CONTROL, "no-store");
        // CORS is handled solely by Spring CorsFilter (SecurityConfig). Setting "*" here
        // would duplicate Access-Control-Allow-Origin and break HLS.js / audio XHR.
        if (fetched.contentRange != null) {
            headers.set(HttpHeaders.CONTENT_RANGE, fetched.contentRange);
        }
        if (fetched.acceptRanges != null) {
            headers.set(HttpHeaders.ACCEPT_RANGES, fetched.acceptRanges);
        }

        HttpStatus status = fetched.status == 206 ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK;
        return ResponseEntity.status(status).headers(headers).body(body);
    }

    private FetchResult fetch(String url, String rangeHeader, String referer) {
        String current = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = null;
            try {
                URI uri = URI.create(current);
                if (isBlockedHost(uri.getHost())) {
                    log.warn("TV proxy rejected host: {}", uri.getHost());
                    return null;
                }
                URL u = uri.toURL();
                conn = (HttpURLConnection) u.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", userAgentForHost(uri.getHost()));
                conn.setRequestProperty("Accept", "*/*");
                String ref = referer != null ? referer : resolveReferer(uri.getHost());
                if (ref != null && !ref.isBlank()) {
                    conn.setRequestProperty("Referer", ref);
                    if (ref.contains("france.tv")) {
                        conn.setRequestProperty("Origin", "https://www.france.tv");
                    } else if (ref.contains("tf1.fr")) {
                        conn.setRequestProperty("Origin", "https://www.tf1.fr");
                    } else if (ref.contains("dailymotion.com") || ref.contains("cnews.fr") || ref.contains("cstar.fr")) {
                        conn.setRequestProperty("Origin", "https://www.dailymotion.com");
                        conn.setRequestProperty("priority", "u=1, i");
                    } else if (ref.contains("20minutes.fr")) {
                        conn.setRequestProperty("Origin", "https://www.20minutes.fr");
                    }
                } else if (defaultReferrer != null && !defaultReferrer.isBlank()) {
                    conn.setRequestProperty("Referer", defaultReferrer);
                }
                if (rangeHeader != null && !rangeHeader.isBlank()) {
                    conn.setRequestProperty("Range", rangeHeader);
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

                InputStream raw = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (raw == null) {
                    FetchResult empty = new FetchResult();
                    empty.status = code;
                    return empty;
                }
                try (InputStream stream = raw) {
                    byte[] body = readLimited(stream, MAX_BYTES);
                    if (body == null) {
                        log.warn("TV proxy response too large for {}", current);
                        return null;
                    }
                    FetchResult result = new FetchResult();
                    result.status = code;
                    result.body = body;
                    result.contentType = conn.getContentType();
                    result.contentRange = conn.getHeaderField("Content-Range");
                    result.acceptRanges = conn.getHeaderField("Accept-Ranges");
                    return result;
                }
            } catch (Exception e) {
                log.debug("TV proxy fetch failed for {}: {}", current, e.toString());
                return null;
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        return null;
    }

    private String resolveReferer(String host) {
        if (host == null) {
            return defaultReferrer;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith("ftven.fr") || h.endsWith("francetelevisions.fr")
                || h.contains("ssai.ftven") || h.contains("live-ssai")) {
            return "https://www.france.tv/";
        }
        if (h.endsWith("tf1.fr") || h.contains("diff.tf1.fr") || h.contains("tf1info.fr")
                || h.contains("cdn-0.diff") || h.contains("cdn-1.diff")) {
            return "https://www.tf1.fr/";
        }
        if (h.contains("dailymotion.com") || h.contains("dmcdn.net") || h.contains("dmxleo.com")) {
            return "https://www.dailymotion.com/";
        }
        if (h.contains("digiteka.com") || h.contains("20minutestv") || h.contains("20minutes.fr")) {
            return "https://www.20minutes.fr/";
        }
        if (h.endsWith("radiofrance.fr") || h.contains("stream.radiofrance")) {
            return "https://www.radiofrance.fr/";
        }
        if (h.contains("6cloud.fr") || h.contains("6play.fr") || h.contains("m6web")
                || h.contains("haititivi") || h.contains("m6.fr")) {
            return "https://www.6play.fr/";
        }
        return defaultReferrer;
    }

    private static String userAgentForHost(String host) {
        if (host == null) {
            return USER_AGENT;
        }
        String h = host.toLowerCase(Locale.ROOT);
        // Official TF1 Group CDN streams are issued for the iPhone UA used by mediainfo.
        if (h.endsWith("tf1.fr") || h.contains("diff.tf1.fr") || h.contains("tf1info.fr")) {
            return IPHONE_USER_AGENT;
        }
        return USER_AGENT;
    }

    private static byte[] readLimited(InputStream in, int maxBytes) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        int n;
        while ((n = in.read(buf)) >= 0) {
            total += n;
            if (total > maxBytes) {
                return null;
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static boolean isPlaylist(String url, String contentType, byte[] body) {
        String lowerUrl = url.toLowerCase(Locale.ROOT);
        if (lowerUrl.contains(".m3u8") || lowerUrl.contains(".m3u")) {
            return true;
        }
        if (contentType != null) {
            String ct = contentType.toLowerCase(Locale.ROOT);
            if (ct.contains("mpegurl") || ct.contains("m3u8") || ct.contains("x-mpegURL".toLowerCase(Locale.ROOT))) {
                return true;
            }
        }
        if (body == null || body.length == 0 || body.length > 2 * 1024 * 1024) {
            return false;
        }
        String head = new String(body, 0, Math.min(body.length, 64), StandardCharsets.UTF_8).trim();
        return head.startsWith("#EXTM3U");
    }

    private String rewritePlaylist(String playlist, String playlistUrl, String proxyBase) {
        URI base;
        try {
            base = URI.create(playlistUrl);
        } catch (Exception e) {
            return playlist;
        }
        String[] lines = playlist.split("\\R", -1);
        StringBuilder out = new StringBuilder(playlist.length() + 256);
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            if (i > 0) {
                out.append('\n');
            }
            if (line == null) {
                continue;
            }
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#EXTM3U")) {
                out.append(line);
                continue;
            }
            if (trimmed.startsWith("#")) {
                out.append(rewritePlaylistTagUris(line, base, proxyBase));
                continue;
            }
            out.append(toProxyUrl(resolveUri(base, trimmed), proxyBase));
        }
        return out.toString();
    }

    private String rewritePlaylistTagUris(String line, URI base, String proxyBase) {
        // Rewrite URI="..." attributes in tags such as #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
        StringBuilder sb = new StringBuilder();
        int idx = 0;
        String lower = line.toLowerCase(Locale.ROOT);
        while (true) {
            int uriPos = lower.indexOf("uri=\"", idx);
            if (uriPos < 0) {
                sb.append(line.substring(idx));
                break;
            }
            int valueStart = uriPos + 5;
            int valueEnd = line.indexOf('"', valueStart);
            if (valueEnd < 0) {
                sb.append(line.substring(idx));
                break;
            }
            sb.append(line, idx, valueStart);
            String rawUri = line.substring(valueStart, valueEnd);
            sb.append(toProxyUrl(resolveUri(base, rawUri), proxyBase));
            idx = valueEnd;
        }
        return sb.toString();
    }

    private static URI resolveUri(URI base, String ref) {
        try {
            return base.resolve(ref.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static String toProxyUrl(URI absolute, String proxyBase) {
        if (absolute == null) {
            return "";
        }
        String abs = absolute.toString();
        if (!(abs.startsWith("http://") || abs.startsWith("https://"))) {
            return abs;
        }
        return proxyBase + encodeUpstreamUrl(abs);
    }

    private static boolean isBlockedHost(String host) {
        if (host == null || host.isBlank()) {
            return true;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if ("localhost".equals(h) || h.endsWith(".localhost") || h.endsWith(".local")
                || h.endsWith(".internal") || h.endsWith(".intranet")) {
            return true;
        }
        try {
            InetAddress[] addrs = InetAddress.getAllByName(host);
            for (InetAddress addr : addrs) {
                if (addr.isAnyLocalAddress()
                        || addr.isLoopbackAddress()
                        || addr.isLinkLocalAddress()
                        || addr.isSiteLocalAddress()
                        || addr.isMulticastAddress()) {
                    return true;
                }
            }
            return false;
        } catch (UnknownHostException e) {
            return true;
        }
    }

    /** Encode for use inside a query string if needed. */
    public static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static final class FetchResult {
        private int status;
        private byte[] body;
        private String contentType;
        private String contentRange;
        private String acceptRanges;
    }
}
