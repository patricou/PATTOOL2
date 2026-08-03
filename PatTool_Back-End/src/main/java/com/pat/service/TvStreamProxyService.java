package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import jakarta.servlet.http.HttpServletResponse;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
    /**
     * Slow IPTV mirrors (e.g. TF1 HD on 151.80) need ~12–20s for a single ~4 MiB segment.
     * Keep above hls.js {@code fragLoadingTimeOut} so the proxy finishes before the player aborts.
     */
    private static final int READ_TIMEOUT_MS = 90_000;
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
            return Optional.of(normalizeShareVirtualUrl(url));
        } catch (IllegalArgumentException e) {
            try {
                String decoded = URLDecoder.decode(encoded, StandardCharsets.UTF_8);
                if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
                    return Optional.of(decoded);
                }
                String normalized = normalizeShareVirtualUrl(decoded);
                if (!normalized.equals(decoded) || normalized.contains(":")) {
                    return Optional.of(normalized);
                }
            } catch (Exception ignored) {
                // fall through
            }
            return Optional.empty();
        }
    }

    /**
     * WhatsApp-safe share tokens use {@code arte~id} instead of {@code arte:id}.
     * Restore the colon before resolving / proxying.
     */
    public static String normalizeShareVirtualUrl(String url) {
        if (url == null || url.isBlank()) {
            return url;
        }
        return url.replaceFirst(
                "(?i)^(francetv|tf1|canalgroup|radiofrance|m6group|rts|eurosport|arte|ia)~",
                "$1:");
    }

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
        return ResponseEntity.status(status).headers(headers).body(json.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String jsonEscape(String value) {
        return value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    /**
     * Write a {@link #proxy} / {@link #jsonError} result to the servlet response.
     */
    public static void writeTo(ResponseEntity<?> entity, HttpServletResponse response) throws IOException {
        if (entity == null) {
            response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
            return;
        }
        response.setStatus(entity.getStatusCode().value());
        HttpHeaders headers = entity.getHeaders();
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            String name = entry.getKey();
            if (name == null
                    || HttpHeaders.TRANSFER_ENCODING.equalsIgnoreCase(name)
                    || HttpHeaders.CONTENT_LENGTH.equalsIgnoreCase(name)) {
                continue;
            }
            for (String value : entry.getValue()) {
                response.addHeader(name, value);
            }
        }
        Object body = entity.getBody();
        if (body instanceof byte[] bytes && bytes.length > 0) {
            response.getOutputStream().write(bytes);
            response.getOutputStream().flush();
        }
    }

    /**
     * Fetch upstream media and return bytes (rewriting HLS playlists when needed).
     *
     * @param upstreamUrl absolute http(s) stream URL
     * @param proxyBase   absolute base of this proxy endpoint ending with {@code /stream/}
     * @param rangeHeader optional browser {@code Range} header
     */
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
        contentType = stripSpuriousCharset(contentType);

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

    /**
     * Lightweight upstream probe for the TV channel status button.
     * Does not rewrite playlists; only checks reachability and playlist/media shape.
     *
     * @return structured map: {@code ok}, {@code layer}, {@code error}, {@code message},
     *         optional {@code host}, {@code upstreamStatus}, {@code playlist}, {@code contentType}
     */
    public Map<String, Object> diagnose(String upstreamUrl) {
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("ok", false);
        out.put("backendReachable", true);

        URI uri;
        try {
            uri = URI.create(upstreamUrl);
        } catch (Exception e) {
            out.put("layer", "pattool");
            out.put("error", "invalid_url");
            out.put("message", "URL de flux invalide");
            return out;
        }

        String scheme = uri.getScheme();
        if (scheme == null
                || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            out.put("layer", "pattool");
            out.put("error", "invalid_scheme");
            out.put("message", "L’URL du flux doit être http ou https");
            return out;
        }

        String host = uri.getHost();
        if (host == null || host.isBlank() || isBlockedHost(host)) {
            out.put("layer", "pattool");
            out.put("error", "host_blocked");
            out.put("host", host);
            out.put("message", "Hôte de flux non autorisé"
                    + (host != null && !host.isBlank() ? " (" + host + ")" : ""));
            return out;
        }

        out.put("host", host);
        boolean catalogIptv = looksLikePublicIptvHost(host);
        String referer = resolveReferer(host);
        FetchResult fetched = fetch(upstreamUrl, null, referer);
        if (fetched == null) {
            out.put("layer", catalogIptv ? "iptv" : "upstream");
            out.put("error", "upstream_unreachable");
            out.put("message", catalogIptv
                    ? "Lien IPTV public inaccessible ou bloqué (" + host + ")"
                    : "Flux distant inaccessible ou bloqué (" + host + ")");
            return out;
        }

        out.put("upstreamStatus", fetched.status);
        if (fetched.contentType != null && !fetched.contentType.isBlank()) {
            out.put("contentType", stripSpuriousCharset(fetched.contentType));
        }

        if (fetched.status >= 400) {
            out.put("layer", catalogIptv ? "iptv" : "upstream");
            out.put("error", "upstream_http_error");
            out.put("message", "Le flux distant a répondu HTTP " + fetched.status + " (" + host + ")");
            return out;
        }
        if (fetched.body == null || fetched.body.length == 0) {
            out.put("layer", catalogIptv ? "iptv" : "upstream");
            out.put("error", "upstream_empty");
            out.put("message", "Le flux distant a renvoyé une réponse vide (" + host + ")");
            return out;
        }

        boolean playlist = isPlaylist(upstreamUrl, fetched.contentType, fetched.body);
        out.put("playlist", playlist);
        if (playlist) {
            String head = new String(fetched.body, 0, Math.min(fetched.body.length, 96), StandardCharsets.UTF_8)
                    .trim();
            if (!head.startsWith("#EXTM3U") && !head.startsWith("#EXTINF")) {
                out.put("layer", catalogIptv ? "iptv" : "upstream");
                out.put("error", "invalid_playlist");
                out.put("message", "Réponse playlist invalide (pas de manifeste HLS) (" + host + ")");
                return out;
            }
        }

        out.put("ok", true);
        out.put("layer", "ok");
        out.put("error", null);
        out.put("message", playlist
                ? "Manifeste HLS joignable"
                : "Flux distant joignable");
        return out;
    }

    /** Heuristic: public IPTV / free CDN hosts vs official broadcaster CDNs. */
    private static boolean looksLikePublicIptvHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith("ftven.fr") || h.endsWith("francetelevisions.fr")
                || h.contains("ssai.ftven") || h.endsWith("tf1.fr") || h.contains("diff.tf1.fr")
                || h.contains("tf1info.fr") || h.contains("dailymotion.com") || h.contains("dmcdn.net")
                || h.contains("6cloud.fr") || h.contains("6play.fr") || h.contains("m6web")
                || h.contains("radiofrance.fr") || h.contains("arte.tv") || h.contains("arte-")
                || h.equals("archive.org") || h.endsWith(".archive.org")
                || h.contains("akamaized.net") || h.contains("akamai")
                || h.contains("cloudfront.net") || h.contains("fastly")) {
            return false;
        }
        return true;
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
                    } else if (ref.contains("arte.tv")) {
                        conn.setRequestProperty("Origin", "https://www.arte.tv");
                    } else if (ref.contains("archive.org")) {
                        conn.setRequestProperty("Origin", "https://archive.org");
                    } else if (ref.contains("netplus.ch")) {
                        conn.setRequestProperty("Origin", "https://www.netplus.ch");
                    }
                } else if (defaultReferrer != null && !defaultReferrer.isBlank()) {
                    conn.setRequestProperty("Referer", defaultReferrer);
                }
                if (rangeHeader != null && !rangeHeader.isBlank()) {
                    conn.setRequestProperty("Range", rangeHeader);
                } else if (looksLikeProgressiveMedia(current)) {
                    // Progressive MP4 (e.g. Internet Archive) can be hundreds of MB.
                    // Without Range the 12 MiB cap would abort; seed a first chunk instead.
                    conn.setRequestProperty("Range", "bytes=0-" + (MAX_BYTES - 1));
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
                    boolean progressive = looksLikeProgressiveMedia(current);
                    boolean allowTruncate = progressive
                            || (rangeHeader != null && !rangeHeader.isBlank());
                    ReadChunk chunk = readLimited(stream, MAX_BYTES);
                    if (chunk.truncated && !allowTruncate) {
                        log.warn("TV proxy response too large for {}", current);
                        return null;
                    }
                    if (chunk.truncated) {
                        // Upstream ignored Range (common on some Archive.org CDN nodes) and
                        // streamed the whole VOD. Return the first chunk as 206 so the browser
                        // can continue with subsequent Range requests instead of failing.
                        log.debug("TV proxy truncated {} to {} bytes (progressive/ranged)",
                                current, chunk.body.length);
                    }
                    FetchResult result = new FetchResult();
                    result.status = code;
                    result.body = chunk.body;
                    result.contentType = conn.getContentType();
                    result.contentRange = conn.getHeaderField("Content-Range");
                    result.acceptRanges = conn.getHeaderField("Accept-Ranges");
                    long declaredLength = conn.getContentLengthLong();
                    if (chunk.truncated && chunk.body != null && chunk.body.length > 0) {
                        result.status = 206;
                        result.contentRange = contentRangeForTruncated(
                                result.contentRange, declaredLength, chunk.body.length);
                        if (result.acceptRanges == null || result.acceptRanges.isBlank()) {
                            result.acceptRanges = "bytes";
                        }
                    } else if (progressive && (result.acceptRanges == null || result.acceptRanges.isBlank())) {
                        result.acceptRanges = "bytes";
                    }
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
        if (h.endsWith("radiofrance.fr")
                || h.contains("stream.radiofrance")
                || h.contains("radiofrance-podcast")
                || h.contains("proxycast.radiofrance")
                || h.contains("media.radiofrance")) {
            return "https://www.radiofrance.fr/";
        }
        if (h.contains("6cloud.fr") || h.contains("6play.fr") || h.contains("m6web")) {
            return "https://www.6play.fr/";
        }
        if (h.contains("arte.tv") || h.contains("arte-")
                || (h.contains("akamaized.net") && h.contains("arte"))) {
            return "https://www.arte.tv/";
        }
        if (h.equals("archive.org") || h.endsWith(".archive.org")) {
            return "https://archive.org/";
        }
        if (h.contains("netplus.ch") || h.contains("viamotion")) {
            return "https://www.netplus.ch/";
        }
        if (h.contains("viewsurf.com")) {
            return "https://gieat.viewsurf.com/";
        }
        return defaultReferrer;
    }

    private static boolean looksLikeProgressiveMedia(String url) {
        if (url == null) {
            return false;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.contains(".m3u8") || lower.contains("/manifest") || lower.contains(".mpd")) {
            return false;
        }
        // NAPSPAN / French SANEF: Viewsurf mediaRedirect → short MP4 clip
        if (lower.contains("action=mediaredirect") || lower.contains("viewsurf.com")) {
            return true;
        }
        return lower.contains(".mp4") || lower.contains(".webm") || lower.contains(".ogv")
                || lower.contains("archive.org/download/")
                || (lower.contains(".archive.org/") && lower.contains("/items/"));
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

    /**
     * HttpURLConnection sometimes appends {@code ;charset=UTF-8} to binary types like
     * {@code video/mp4}, which confuses MSE / some players.
     */
    private static String stripSpuriousCharset(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            return contentType;
        }
        String lower = contentType.toLowerCase(Locale.ROOT);
        if (!(lower.startsWith("video/") || lower.startsWith("audio/") || lower.startsWith("application/octet-stream")
                || lower.contains("mp2t") || lower.contains("mp4"))) {
            return contentType;
        }
        int semi = contentType.indexOf(';');
        return semi >= 0 ? contentType.substring(0, semi).trim() : contentType;
    }

    /**
     * Read at most {@code maxBytes}. If the stream is longer, return the prefix and mark truncated
     * (callers that allow progressive VOD can answer 206 instead of failing).
     */
    private static ReadChunk readLimited(InputStream in, int maxBytes) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        int n;
        while ((n = in.read(buf)) >= 0) {
            if (total + n > maxBytes) {
                int allow = maxBytes - total;
                if (allow > 0) {
                    out.write(buf, 0, allow);
                }
                ReadChunk chunk = new ReadChunk();
                chunk.body = out.toByteArray();
                chunk.truncated = true;
                return chunk;
            }
            total += n;
            out.write(buf, 0, n);
        }
        ReadChunk chunk = new ReadChunk();
        chunk.body = out.toByteArray();
        chunk.truncated = false;
        return chunk;
    }

    /**
     * Build a {@code Content-Range} for a truncated progressive response so the video element
     * knows more bytes remain and can issue further Range requests.
     */
    private static String contentRangeForTruncated(String upstreamRange, long contentLength, int bodyLen) {
        long start = 0L;
        String total = "*";
        if (upstreamRange != null && !upstreamRange.isBlank()) {
            // bytes 0-123/456 or bytes 0-123/*
            String raw = upstreamRange.trim();
            int sp = raw.toLowerCase(Locale.ROOT).startsWith("bytes") ? raw.indexOf(' ') : -1;
            String spec = sp >= 0 ? raw.substring(sp + 1).trim() : raw;
            int slash = spec.indexOf('/');
            String rangePart = slash >= 0 ? spec.substring(0, slash) : spec;
            if (slash >= 0 && slash + 1 < spec.length()) {
                total = spec.substring(slash + 1).trim();
            }
            int dash = rangePart.indexOf('-');
            if (dash > 0) {
                try {
                    start = Long.parseLong(rangePart.substring(0, dash).trim());
                } catch (NumberFormatException ignored) {
                    start = 0L;
                }
            }
        }
        if ("*".equals(total) && contentLength > 0) {
            total = Long.toString(contentLength);
        }
        long end = start + Math.max(0, bodyLen - 1);
        return "bytes " + start + "-" + end + "/" + total;
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

    private static final class ReadChunk {
        private byte[] body;
        private boolean truncated;
    }
}
