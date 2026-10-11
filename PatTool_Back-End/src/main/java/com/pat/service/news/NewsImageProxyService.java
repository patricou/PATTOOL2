package com.pat.service.news;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import com.pat.util.SsrfGuard;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.time.Duration;
import java.util.Locale;

/**
 * Server-side image proxy used by the News page to work around the two most
 * common reasons NewsAPI article images fail to render in the browser:
 *
 * 1. Mixed content: publishers often return {@code http://} image URLs even
 *    though the app is served over {@code https://}. Modern browsers block
 *    those as mixed content. This proxy re-fetches them server-side and
 *    serves them back over the same origin as the app.
 * 2. Hotlink / {@code Referer} blocking: some CDNs refuse cross-origin
 *    requests. Our server does not forward the browser {@code Referer}, so
 *    the image comes through.
 *
 * Safety:
 *  - HTTP/HTTPS only; other schemes are rejected.
 *  - Private, loopback and link-local addresses are rejected (SSRF guard).
 *  - Response must declare an {@code image/*} content-type.
 *  - Max response size capped ({@link #MAX_IMAGE_BYTES}).
 *  - Hard connect / read timeouts prevent slow-loris abuse.
 *  - No cookies / auth headers are ever forwarded upstream.
 *
 * The response is served with a short public {@code Cache-Control} so the
 * browser (and intermediaries) can reuse it across the session without hitting
 * the backend on every scroll.
 */
@Service
public class NewsImageProxyService {

    private static final Logger log = LoggerFactory.getLogger(NewsImageProxyService.class);

    /** 10 MB hard cap on a single image response. */
    public static final int MAX_IMAGE_BYTES = 10 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 8_000;
    private static final String USER_AGENT = "PATTOOL/1.0 (+https://www.patrickdeschamps.com)";

    /**
     * Fetch a remote image and return it as a {@link ResponseEntity} the
     * Spring MVC dispatcher can stream directly to the client. Returns a
     * 4xx/5xx response (with an empty body) when anything goes wrong so the
     * browser's {@code onerror} handler triggers the placeholder UI.
     */
    public ResponseEntity<byte[]> proxy(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            return ResponseEntity.badRequest().build();
        }

        URI uri;
        try {
            uri = new URI(rawUrl);
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }

        if (!SsrfGuard.isPublicHttpUrl(uri.toString())) {
            log.warn("News image proxy rejected non-public URL");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }

        String scheme = uri.getScheme();

        // Opportunistic https upgrade so mixed-content URLs still work for most CDNs.
        if ("http".equalsIgnoreCase(scheme)) {
            String httpsUrl = "https://" + rawUrl.substring("http://".length());
            ResponseEntity<byte[]> upgraded = doFetch(httpsUrl, 3);
            if (upgraded != null) return upgraded;
        }

        ResponseEntity<byte[]> resp = doFetch(rawUrl, 3);
        return resp != null ? resp : ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
    }

    /** Core fetch: returns null on any transport-level failure. Redirects are checked again. */
    private ResponseEntity<byte[]> doFetch(String url, int redirectsLeft) {
        if (!SsrfGuard.isPublicHttpUrl(url)) {
            log.warn("News image proxy rejected non-public URL");
            return null;
        }
        HttpURLConnection conn = null;
        try {
            URL u = new URL(url);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            conn.setRequestProperty("Accept", "image/*,*/*;q=0.5");

            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                if (redirectsLeft <= 0) {
                    return null;
                }
                String location = conn.getHeaderField("Location");
                if (location == null || location.isBlank()) {
                    return null;
                }
                URI next = URI.create(url).resolve(location.trim());
                conn.disconnect();
                conn = null;
                return doFetch(next.toString(), redirectsLeft - 1);
            }
            if (code < 200 || code >= 400) {
                return null;
            }

            String contentType = conn.getContentType();
            if (contentType == null
                    || !contentType.toLowerCase(Locale.ROOT).startsWith("image/")) {
                return null;
            }

            int declared = conn.getContentLength();
            if (declared > MAX_IMAGE_BYTES) {
                log.debug("Image proxy refused oversized response ({} bytes) from {}", declared, url);
                return null;
            }

            try (InputStream is = conn.getInputStream();
                 ByteArrayOutputStream bos = new ByteArrayOutputStream(declared > 0 ? declared : 8192)) {
                byte[] buf = new byte[8192];
                int read;
                int total = 0;
                while ((read = is.read(buf)) != -1) {
                    total += read;
                    if (total > MAX_IMAGE_BYTES) {
                        log.debug("Image proxy aborted oversized stream from {}", url);
                        return null;
                    }
                    bos.write(buf, 0, read);
                }

                HttpHeaders headers = new HttpHeaders();
                try {
                    headers.setContentType(MediaType.parseMediaType(contentType));
                } catch (Exception e) {
                    headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
                }
                headers.setCacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic());
                headers.set("X-Content-Type-Options", "nosniff");
                headers.setContentLength(total);
                return new ResponseEntity<>(bos.toByteArray(), headers, HttpStatus.OK);
            }
        } catch (Exception e) {
            log.debug("Image proxy fetch failed for {}: {}", url, e.getMessage());
            return null;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignore) { /* noop */ }
            }
        }
    }
}
