package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.Set;

/**
 * Closed relay for the Maptoolkit community styles.
 * The browser calls this only after a direct request is refused (office networks).
 * Hosts are fixed: this is not an open URL proxy.
 */
@Service
public class MaptoolkitProxyService {

    private static final Logger log = LoggerFactory.getLogger(MaptoolkitProxyService.class);

    static final Set<String> HOSTS = Set.of(
            "styles.maptoolkit.org",
            "tiles.maptoolkit.org",
            "fonts.maptoolkit.org",
            "icons.maptoolkit.org",
            "tiles.mapterhorn.com"
    );

    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(12);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    public ResponseEntity<byte[]> fetch(String rawUrl) {
        URI uri = allowedUri(rawUrl);
        if (uri == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .timeout(REQUEST_TIMEOUT)
                    .header(HttpHeaders.USER_AGENT, "PatTool-MaptoolkitProxy/1.0 (contact via patrickdeschamps.com)")
                    .header(HttpHeaders.ACCEPT, "application/json,application/x-protobuf,image/png,image/webp,*/*;q=0.5")
                    .GET()
                    .build();
            HttpResponse<InputStream> response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
            int status = response.statusCode();
            if (status >= 300 && status < 400) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            if (status < 200 || status >= 300) {
                return ResponseEntity.status(status).build();
            }
            byte[] body = readLimited(response.body());
            if (body == null || body.length == 0) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            String contentType = response.headers().firstValue(HttpHeaders.CONTENT_TYPE).orElse(guessType(uri));
            if (contentType.toLowerCase(Locale.ROOT).startsWith("text/html")) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            HttpHeaders out = new HttpHeaders();
            out.set(HttpHeaders.CONTENT_TYPE, contentType);
            boolean json = contentType.toLowerCase(Locale.ROOT).contains("json");
            out.setCacheControl(CacheControl.maxAge(json ? Duration.ofHours(1) : Duration.ofHours(6)).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        } catch (Exception e) {
            log.debug("Maptoolkit fetch failed ({}): {}", uri.getHost(), e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /**
     * Accepts only https URLs on the Maptoolkit hosts used by the community styles,
     * plus the Mapterhorn terrain tiles those styles point at.
     * Rejects other hosts, credentials, odd ports, traversal and redirects targets.
     */
    public static URI allowedUri(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.length() < 12 || trimmed.length() > 4000) {
            return null;
        }
        if (trimmed.indexOf('\n') >= 0 || trimmed.indexOf('\r') >= 0 || trimmed.indexOf('\\') >= 0) {
            return null;
        }
        final URI uri;
        try {
            uri = URI.create(trimmed);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            return null;
        }
        if (uri.getUserInfo() != null || uri.getRawUserInfo() != null) {
            return null;
        }
        if (uri.getHost() == null) {
            return null;
        }
        if (uri.getPort() != -1 && uri.getPort() != 443) {
            return null;
        }
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        if (!HOSTS.contains(host)) {
            return null;
        }
        String path = uri.getRawPath();
        if (path == null || path.length() < 2 || !path.startsWith("/")) {
            return null;
        }
        String decodedPath = decode(path);
        if (decodedPath == null || decodedPath.contains("..") || decodedPath.indexOf('\0') >= 0) {
            return null;
        }
        String query = uri.getRawQuery();
        if (query != null) {
            if (query.length() > 512) {
                return null;
            }
            String decodedQuery = decode(query);
            if (decodedQuery == null || decodedQuery.contains("://") || decodedQuery.contains("..") || decodedQuery.indexOf('\0') >= 0) {
                return null;
            }
        }
        return uri;
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static byte[] readLimited(InputStream in) throws IOException {
        try (in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) >= 0) {
                total += read;
                if (total > MAX_BYTES) {
                    return null;
                }
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    private static String guessType(URI uri) {
        String path = uri.getPath().toLowerCase(Locale.ROOT);
        if (path.endsWith(".json")) {
            return "application/json";
        }
        if (path.endsWith(".pbf") || path.endsWith(".mvt")) {
            return "application/x-protobuf";
        }
        if (path.endsWith(".webp")) {
            return "image/webp";
        }
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        return "image/png";
    }
}
