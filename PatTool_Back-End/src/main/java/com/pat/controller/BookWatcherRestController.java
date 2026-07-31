package com.pat.controller;

import com.pat.controller.dto.BookItemDto;
import com.pat.controller.dto.BookSearchPageDto;
import com.pat.service.BookCatalogService;
import com.pat.service.RadioStreamProxyService;
import com.pat.service.TvStreamProxyService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;

/**
 * Book watcher: Open Library, Project Gutenberg (Gutendex) and LibriVox audiobooks.
 * <p>
 * Public read-only:
 * <ul>
 *   <li>{@code GET /api/external/book/openlibrary/search?q=...}</li>
 *   <li>{@code GET /api/external/book/gutenberg/search?q=...}</li>
 *   <li>{@code GET /api/external/book/librivox/search?title=...&amp;author=...}</li>
 *   <li>{@code GET /api/external/book/content/{base64url}} — text/html proxy</li>
 *   <li>{@code GET /api/external/book/stream/{base64url}} — audio proxy (LibriVox)</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/book")
public class BookWatcherRestController {

    @Autowired
    private BookCatalogService bookCatalogService;

    @Autowired
    private RadioStreamProxyService radioStreamProxyService;

    @GetMapping("/openlibrary/search")
    public ResponseEntity<BookSearchPageDto> openLibrarySearch(
            @RequestParam(required = false, defaultValue = "") String q,
            @RequestParam(required = false, defaultValue = "20") int limit,
            @RequestParam(required = false, defaultValue = "0") int offset,
            @RequestParam(required = false) String language,
            @RequestParam(required = false) String genre) {
        BookSearchPageDto page = bookCatalogService.searchOpenLibrary(q, limit, offset, language, genre);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(page);
    }

    @GetMapping("/openlibrary/work")
    public ResponseEntity<?> openLibraryWork(@RequestParam String key) {
        Optional<BookItemDto> item = bookCatalogService.getOpenLibraryWork(key);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(30)).cachePublic())
                .body(item.get());
    }

    @GetMapping("/gutenberg/search")
    public ResponseEntity<BookSearchPageDto> gutenbergSearch(
            @RequestParam(required = false, defaultValue = "") String q,
            @RequestParam(required = false) String languages,
            @RequestParam(required = false, defaultValue = "1") int page,
            @RequestParam(required = false) String genre) {
        BookSearchPageDto result = bookCatalogService.searchGutenberg(q, languages, page, genre);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(result);
    }

    @GetMapping("/gutenberg/{id}")
    public ResponseEntity<?> gutenbergBook(@PathVariable int id) {
        Optional<BookItemDto> item = bookCatalogService.getGutenbergBook(id);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(30)).cachePublic())
                .body(item.get());
    }

    @GetMapping("/librivox/search")
    public ResponseEntity<BookSearchPageDto> librivoxSearch(
            @RequestParam(required = false, defaultValue = "") String title,
            @RequestParam(required = false, defaultValue = "") String author,
            @RequestParam(required = false, defaultValue = "") String q,
            @RequestParam(required = false) String genre,
            @RequestParam(required = false, defaultValue = "25") int limit,
            @RequestParam(required = false, defaultValue = "0") int offset) {
        // Convenience: q fills title when title is empty
        String t = StringUtils.hasText(title) ? title : q;
        BookSearchPageDto page = bookCatalogService.searchLibriVox(t, author, limit, offset, genre);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                .body(page);
    }

    @GetMapping("/librivox/{id}")
    public ResponseEntity<?> librivoxBook(@PathVariable String id) {
        Optional<BookItemDto> item = bookCatalogService.getLibriVoxBook(id);
        if (item.isEmpty()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not_found"));
        }
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofMinutes(30)).cachePublic())
                .body(item.get());
    }

    @GetMapping(value = "/content/{encodedUrl:.+}")
    public ResponseEntity<?> content(@PathVariable("encodedUrl") String encodedUrl) {
        Optional<String> upstream = TvStreamProxyService.decodeUpstreamUrl(encodedUrl);
        if (upstream.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "invalid_encoded_url",
                    "message", "URL de contenu encodée invalide"));
        }
        Optional<BookCatalogService.FetchedContent> fetched = bookCatalogService.fetchContent(upstream.get());
        if (fetched.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "fetch_failed",
                    "message", "Impossible de récupérer le contenu du livre"));
        }
        BookCatalogService.FetchedContent c = fetched.get();
        boolean html = c.getContentType() != null
                && c.getContentType().toLowerCase().contains("html");
        MediaType mediaType = html
                ? new MediaType("text", "html", StandardCharsets.UTF_8)
                : new MediaType("text", "plain", StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic())
                .contentType(mediaType)
                .body(c.getBody());
    }

    @GetMapping(value = "/content")
    public ResponseEntity<?> contentQuery(@RequestParam("url") String url) {
        if (!StringUtils.hasText(url)) {
            return ResponseEntity.badRequest().body(Map.of("error", "missing_url"));
        }
        Optional<BookCatalogService.FetchedContent> fetched = bookCatalogService.fetchContent(url.trim());
        if (fetched.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of(
                    "error", "fetch_failed",
                    "message", "Impossible de récupérer le contenu du livre"));
        }
        BookCatalogService.FetchedContent c = fetched.get();
        boolean html = c.getContentType() != null
                && c.getContentType().toLowerCase().contains("html");
        MediaType mediaType = html
                ? new MediaType("text", "html", StandardCharsets.UTF_8)
                : new MediaType("text", "plain", StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic())
                .contentType(mediaType)
                .body(c.getBody());
    }

    @GetMapping(value = "/stream/{encodedUrl:.+}")
    public void stream(
            @PathVariable("encodedUrl") String encodedUrl,
            @RequestHeader(value = "Range", required = false) String range,
            HttpServletRequest request,
            HttpServletResponse response) throws IOException {
        Optional<String> upstream = TvStreamProxyService.decodeUpstreamUrl(encodedUrl);
        if (upstream.isEmpty()) {
            response.setStatus(HttpStatus.BAD_REQUEST.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getOutputStream().write(
                    "{\"error\":\"invalid_encoded_url\",\"message\":\"URL audio encodée invalide\"}"
                            .getBytes(StandardCharsets.UTF_8));
            return;
        }
        String proxyBase = buildProxyBase(request);
        radioStreamProxyService.proxyRadio(upstream.get(), proxyBase, range, response);
    }

    @GetMapping(value = "/stream")
    public void streamQuery(
            @RequestParam("url") String url,
            @RequestHeader(value = "Range", required = false) String range,
            HttpServletRequest request,
            HttpServletResponse response) throws IOException {
        if (!StringUtils.hasText(url)) {
            response.setStatus(HttpStatus.BAD_REQUEST.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getOutputStream().write(
                    "{\"error\":\"missing_url\",\"message\":\"URL audio manquante\"}"
                            .getBytes(StandardCharsets.UTF_8));
            return;
        }
        String trimmed = url.trim();
        if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) {
            response.setStatus(HttpStatus.BAD_REQUEST.value());
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getOutputStream().write(
                    "{\"error\":\"invalid_url\",\"message\":\"L’URL doit être http(s)\"}"
                            .getBytes(StandardCharsets.UTF_8));
            return;
        }
        String proxyBase = buildProxyBase(request);
        radioStreamProxyService.proxyRadio(trimmed, proxyBase, range, response);
    }

    private String buildProxyBase(HttpServletRequest request) {
        String forwardedProto = request.getHeader("X-Forwarded-Proto");
        String forwardedHost = request.getHeader("X-Forwarded-Host");
        String scheme = StringUtils.hasText(forwardedProto) ? forwardedProto : request.getScheme();
        String host = StringUtils.hasText(forwardedHost) ? forwardedHost : request.getServerName();
        int port = request.getServerPort();
        boolean defaultPort = ("http".equalsIgnoreCase(scheme) && port == 80)
                || ("https".equalsIgnoreCase(scheme) && port == 443)
                || StringUtils.hasText(forwardedHost);
        String portPart = defaultPort ? "" : (":" + port);
        String context = request.getContextPath() != null ? request.getContextPath() : "";
        return scheme + "://" + host + portPart + context + "/api/external/book/stream/";
    }
}
