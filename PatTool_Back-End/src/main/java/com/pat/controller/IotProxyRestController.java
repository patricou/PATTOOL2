package com.pat.controller;

import com.pat.repo.IotProxyTargetRepository;
import com.pat.repo.domain.IotProxyTarget;
import com.pat.service.iot.IotProxyOpenTokenService;
import com.pat.service.iot.LanUpstreamUrlValidator;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.util.StringUtils;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Collectors;
import java.util.zip.GZIPInputStream;

/**
 * CRUD for LAN upstream configs and HTTP forwarding keyed by opaque {@link IotProxyTarget#getPublicSlug()}.
 * Browser flow: minted signed {@code ?iotOpen=}; after the first navigation per-slug HttpOnly cookies ({@code pat_iot_fwd_<slug>})
 * carry the token so relative CSS/JS (no query string) still authenticate ({@link IotProxyOpenTokenService}). A single shared
 * cookie would break when several proxies are used in one browser (last slug wins).
 */
@RestController
@RequestMapping("/api/iot-proxies")
public class IotProxyRestController {

    private static final Logger log = LoggerFactory.getLogger(IotProxyRestController.class);
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    private static final int READ_TIMEOUT_MS = 120_000;

    private static final Set<String> RESPONSE_HEADER_DENY = Set.of(
            "transfer-encoding", "connection", "keep-alive", "proxy-authenticate",
            "proxy-authorization", "upgrade", "te", "trailers", "host", "server"
    ).stream().map(String::toLowerCase).collect(Collectors.toSet());

    /** Client headers allowed downstream (excluding browser Bearer KC — not forwarded). {@code Cookie} carries device sessions. */
    private static final Set<String> REQ_HEADER_WHITELIST = Set.of(
            "accept", "accept-language", "user-agent",
            "if-modified-since", "if-none-match", "cache-control", "pragma", "range",
            "content-type", "cookie"
    );

    @Autowired
    private IotProxyTargetRepository repository;
    @Autowired
    private LanUpstreamUrlValidator upstreamUrlValidator;
    @Autowired
    private IotProxyOpenTokenService openTokenService;

    @Autowired
    private MongoTemplate mongoTemplate;

    @Value("${app.iot-proxy.max-response-bytes:52428800}")
    private long maxResponseBytes;

    /** Max POST/PUT/PATCH body relayed toward the LAN device (avoid abuse). */
    @Value("${app.iot-proxy.max-request-body-bytes:10485760}")
    private long maxForwardRequestBodyBytes;

    /** When upstream sends Content-Length ≤ this size, optionally rewrite DVR root paths (/flv?…) inside HTML/JS. */
    @Value("${app.iot-proxy.max-rewrite-body-bytes:5242880}")
    private long maxRewriteBodyBytes;

    @Value("${app.iot-proxy.redirect-max-hops:10}")
    private int redirectMaxHops;

    /** Prefix for forwarding cookies; actual name is {@code pat_iot_fwd_<publicSlug>} (see {@link #forwardCookieName}). Legacy sessions may still send plain {@code pat_iot_fwd}. */
    private static final String OPEN_COOKIE_BASE = "pat_iot_fwd";

    private static String forwardCookieName(String publicSlug) {
        return OPEN_COOKIE_BASE + "_" + publicSlug.trim();
    }

    private Optional<ResponseEntity<?>> ensureIotRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return Optional.of(ResponseEntity.status(HttpStatus.UNAUTHORIZED).build());
        }
        if (!hasIotRole(authentication)) {
            return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
        }
        return Optional.empty();
    }

    /** Same semantics as IoT guards on {@code /api/cameras} — realm/client role Iot / iot. */
    private static boolean hasIotRole(Authentication authentication) {
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(a -> a.equalsIgnoreCase("ROLE_Iot") || a.equalsIgnoreCase("ROLE_iot"));
    }

    private boolean hasAdminRole(Authentication authentication) {
        return authentication != null && authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(a -> a.equalsIgnoreCase("ROLE_Admin") || a.equalsIgnoreCase("ROLE_admin"));
    }

    private String resolveOwner(Authentication auth, String userIdHeader) {
        if (auth instanceof JwtAuthenticationToken jwt) {
            String preferred = jwt.getToken().getClaimAsString("preferred_username");
            if (StringUtils.hasText(preferred)) {
                return preferred.trim();
            }
            return jwt.getName();
        }
        if (StringUtils.hasText(userIdHeader)) {
            return userIdHeader.trim();
        }
        return auth != null ? auth.getName() : "";
    }

    private boolean ownsOrAdmin(IotProxyTarget doc, Authentication auth, String userIdHeader) {
        if (auth != null && hasAdminRole(auth)) {
            return true;
        }
        return doc.getOwner() != null && doc.getOwner().equals(resolveOwner(auth, userIdHeader));
    }

    /**
     * Authorize forward streaming: (1) valid signed open token ({@code iotOpen} query or HttpOnly forwarding cookie),
     * matching row owner; (2) else authenticated JWT + IoT role + owner/Admin ({@link #ownsOrAdmin}).
     */
    private Optional<IotProxyTarget> resolveTargetForForward(String slug,
                                                             HttpServletRequest request,
                                                             String userIdHeader) {
        Optional<IotProxyTarget> rowOpt = repository.findByPublicSlug(slug);
        if (rowOpt.isEmpty()) {
            return Optional.empty();
        }
        IotProxyTarget row = rowOpt.get();

        String open = resolveForwardOpenToken(request, slug.trim());
        if (StringUtils.hasText(open)) {
            try {
                String owner = openTokenService.verifyAndExtractOwner(open, slug.trim(), System.currentTimeMillis());
                if (owner.equals(row.getOwner())) {
                    return Optional.of(row);
                }
            } catch (Exception e) {
                log.debug("Open token denied: {}", e.getMessage());
            }
        }

        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken jwt && jwt.isAuthenticated()) {
            if (ensureIotRole().isPresent()) {
                log.warn("JWT forward denied (missing Iot role): slug={}", slug);
                return Optional.empty();
            }
            if (ownsOrAdmin(row, auth, userIdHeader)) {
                return Optional.of(row);
            }
            log.warn("JWT forward denied (not owner): slug={}", slug);
            return Optional.empty();
        }

        return Optional.empty();
    }

    /**
     * Open token source: explicit {@code iotOpen} query wins, then per-slug cookie, then legacy {@code pat_iot_fwd}.
     */
    private static String resolveForwardOpenToken(HttpServletRequest request, String pathSlug) {
        String qp = request.getParameter("iotOpen");
        if (StringUtils.hasText(qp)) {
            return qp.trim();
        }
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        String expectedName = forwardCookieName(pathSlug);
        for (Cookie ck : cookies) {
            if (expectedName.equals(ck.getName()) && StringUtils.hasText(ck.getValue())) {
                return ck.getValue().trim();
            }
        }
        for (Cookie ck : cookies) {
            if (OPEN_COOKIE_BASE.equals(ck.getName()) && StringUtils.hasText(ck.getValue())) {
                return ck.getValue().trim();
            }
        }
        return null;
    }

    private void issueForwardingOpenCookie(HttpServletRequest request,
                                          HttpServletResponse response,
                                          String publicSlug,
                                          String compactToken) {
        long maxSec = openTokenService.validitySeconds();
        long maxAge = Math.min(maxSec, Integer.MAX_VALUE);
        boolean secure = isEffectivelyHttps(request);
        ResponseCookie c = ResponseCookie.from(forwardCookieName(publicSlug), compactToken)
                .path("/api/iot-proxies/forward")
                .httpOnly(true)
                .maxAge(maxAge)
                .sameSite("Lax")
                .secure(secure)
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, c.toString());
    }

    /** True behind reverse proxies terminating TLS ({@code X-Forwarded-Proto}) or direct HTTPS. */
    private static boolean isEffectivelyHttps(HttpServletRequest request) {
        if (request.isSecure()) {
            return true;
        }
        String xf = request.getHeader("X-Forwarded-Proto");
        if (!StringUtils.hasText(xf)) {
            return false;
        }
        String first = xf.trim().split(",")[0].trim();
        return "https".equalsIgnoreCase(first);
    }

    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> listAll(@RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        boolean admin = hasAdminRole(auth);
        String owner = resolveOwner(auth, userId);
        return ResponseEntity.ok(listIotProxyTargetsForApi(admin ? null : owner, admin));
    }

    /**
     * List proxies with stable sort and without loading {@link IotProxyTarget#getUpstreamPassword()} from Mongo
     * (smaller docs + less BSON); {@code hasUpstreamPassword} JSON comes from {@code upstreamAuthPasswordPresent}.
     */
    private List<IotProxyTarget> listIotProxyTargetsForApi(String ownerFilterOrNull, boolean admin) {
        Query q = new Query();
        if (!admin) {
            q.addCriteria(Criteria.where("owner").is(ownerFilterOrNull));
        }
        q.with(Sort.by(Sort.Direction.DESC, "creationDate"));
        q.fields().exclude("upstreamPassword");
        return mongoTemplate.find(q, IotProxyTarget.class);
    }

    @GetMapping(value = "/target/{mongoId}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getTarget(@PathVariable String mongoId,
                                       @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return repository.findById(mongoId)
                .filter(d -> ownsOrAdmin(d, auth, userId))
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> create(@RequestBody IotProxyTarget body,
                                    @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (!StringUtils.hasText(body.getUpstreamBaseUrl())) {
            return ResponseEntity.badRequest().body(Map.of("error", "upstreamBaseUrlRequired"));
        }
        if (!upstreamUrlValidator.isAllowedLanUrl(body.getUpstreamBaseUrl())) {
            return ResponseEntity.badRequest().body(Map.of("error", "upstreamUrlNotLan"));
        }
        if (body.getDescription() != null && body.getDescription().length() > 512) {
            return ResponseEntity.badRequest().body(Map.of("error", "descriptionTooLong"));
        }
        Date now = new Date();
        IotProxyTarget e = new IotProxyTarget();
        e.setId(null);
        e.setPublicSlug(UUID.randomUUID().toString());
        e.setDescription(body.getDescription() == null ? "" : truncate(body.getDescription(), 512));
        e.setUpstreamBaseUrl(body.getUpstreamBaseUrl().trim());
        e.setUpstreamUsername(body.getUpstreamUsername());
        if (StringUtils.hasText(body.getUpstreamPassword())) {
            e.setUpstreamPassword(body.getUpstreamPassword());
        }
        e.setUpstreamAuthPasswordPresent(StringUtils.hasText(body.getUpstreamPassword()));
        e.setOwner(resolveOwner(auth, userId));
        e.setCreationDate(now);
        e.setUpdateDate(now);
        try {
            IotProxyTarget saved = repository.save(e);
            return new ResponseEntity<>(saved, HttpStatus.CREATED);
        } catch (Exception ex) {
            log.warn("Persist iot-proxy failed", ex);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    @PutMapping(value = "/target/{mongoId}", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> update(@PathVariable String mongoId,
                                    @RequestBody IotProxyTarget body,
                                    @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        Optional<IotProxyTarget> opt = repository.findById(mongoId);
        if (opt.isEmpty() || !ownsOrAdmin(opt.get(), auth, userId)) {
            return ResponseEntity.notFound().build();
        }
        IotProxyTarget e = opt.get();
        if (StringUtils.hasText(body.getUpstreamBaseUrl())) {
            if (!upstreamUrlValidator.isAllowedLanUrl(body.getUpstreamBaseUrl())) {
                return ResponseEntity.badRequest().body(Map.of("error", "upstreamUrlNotLan"));
            }
            e.setUpstreamBaseUrl(body.getUpstreamBaseUrl().trim());
        }
        if (body.getDescription() != null) {
            e.setDescription(truncate(body.getDescription(), 512));
        }
        if (body.getUpstreamUsername() != null) {
            e.setUpstreamUsername(body.getUpstreamUsername());
        }
        if (StringUtils.hasText(body.getUpstreamPassword())) {
            e.setUpstreamPassword(body.getUpstreamPassword());
            e.setUpstreamAuthPasswordPresent(true);
        }
        e.setUpdateDate(new Date());
        return ResponseEntity.ok(repository.save(e));
    }

    @DeleteMapping("/target/{mongoId}")
    public ResponseEntity<?> delete(@PathVariable String mongoId,
                                    @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return repository.findById(mongoId)
                .filter(d -> ownsOrAdmin(d, auth, userId))
                .map(d -> {
                    repository.deleteById(d.getId());
                    return ResponseEntity.noContent().build();
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping(value = "/{publicSlug}/browser-open-url",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> mintBrowserOpenUrl(@PathVariable String publicSlug,
                                                 @RequestBody(required = false) Map<String, String> body,
                                                 @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        Optional<IotProxyTarget> row = repository.findByPublicSlug(publicSlug);
        if (row.isEmpty() || !ownsOrAdmin(row.get(), auth, userId)) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String ownerKey = StringUtils.hasText(row.get().getOwner())
                ? row.get().getOwner()
                : resolveOwner(auth, userId);
        String pathExtra = body != null ? body.get("path") : null;
        String forwardQuery = body != null ? body.get("forwardQuery") : null;
        try {
            String token = openTokenService.mint(publicSlug, ownerKey);
            String pathSuffix = "/";
            if (pathExtra != null && StringUtils.hasText(pathExtra)) {
                String p = pathExtra.trim();
                if (p.contains("..") || p.indexOf('?') >= 0) {
                    return ResponseEntity.badRequest().body(Map.of("error", "badPath"));
                }
                pathSuffix = p.startsWith("/") ? p : "/" + p;
            }
            String queryString = mergeIotOpenQueryString(forwardQuery, token);
            String rel = "/api/iot-proxies/forward/" + publicSlug + pathSuffix + "?" + queryString;
            return ResponseEntity.ok(Map.of(
                    "relativeUrlWithQuery", rel,
                    "expiresInSeconds", openTokenService.validitySeconds()));
        } catch (Exception e) {
            log.warn("mint failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    @RequestMapping(method = {
            RequestMethod.GET, RequestMethod.HEAD,
            RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE
    }, value = {"/forward/{slug}", "/forward/{slug}/{*remainder}"})
    public void forward(@PathVariable String slug,
                        @PathVariable(required = false, name = "remainder") Optional<String> remainder,
                        HttpServletRequest request,
                        HttpServletResponse response,
                        @RequestHeader(value = "user-id", required = false) String userIdHeader) throws Exception {
        Optional<IotProxyTarget> targetOpt = resolveTargetForForward(slug.trim(), request, userIdHeader);
        if (targetOpt.isEmpty()) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Unauthorized");
            return;
        }
        String qpTok = request.getParameter("iotOpen");
        if (StringUtils.hasText(qpTok)) {
            issueForwardingOpenCookie(request, response, slug.trim(), qpTok.trim());
        }
        IotProxyTarget t = targetOpt.get();
        String remainderPath = remainder.map(String::trim).filter(StringUtils::hasText).orElse("");
        if (remainderPath.contains("..")) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            return;
        }
        String upstreamBase = trimTrailingSlash(t.getUpstreamBaseUrl());
        String pathSegment = remainderPath.isEmpty()
                ? ""
                : (remainderPath.startsWith("/") ? remainderPath.substring(1) : remainderPath);
        Optional<String> sanitizedQuery = sanitizeQueryRemovingIotOpen(request.getQueryString());
        String pathAndQuery = buildUpstreamPath(upstreamBase, pathSegment, sanitizedQuery);
        URI upstreamUri = safeUri(pathAndQuery, response);
        if (upstreamUri == null) {
            return;
        }
        if (!upstreamUrlValidator.isAllowedLanUrl(upstreamUri.toString())) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            return;
        }
        String method = request.getMethod();

        replay(method, upstreamUri.toString(), t, request, response, slug.trim());
    }

    /** Whether we should open an output stream and copy the servlet input toward the LAN device for this hop. */
    private static boolean shouldRelayRequestBody(String method, HttpServletRequest req) {
        switch (method) {
            case "POST":
            case "PUT":
            case "PATCH":
                return true;
            case "DELETE":
                long cl = req.getContentLengthLong();
                if (cl > 0) {
                    return true;
                }
                if (cl == 0) {
                    return false;
                }
                String te = req.getHeader("Transfer-Encoding");
                return te != null && te.toLowerCase(Locale.ROOT).contains("chunked");
            default:
                return false;
        }
    }

    /** Copy at most {@code maxBytes}; returns bytes copied, or {@code -1} if limit exceeded (partial write). */
    private static long copyLimited(InputStream from, OutputStream to, long maxBytes) throws IOException {
        byte[] buf = new byte[8192];
        long total = 0;
        int n;
        while ((n = from.read(buf)) != -1) {
            total += n;
            if (total > maxBytes) {
                return -1;
            }
            to.write(buf, 0, n);
        }
        return total;
    }

    private URI safeUri(String pathAndQuery, HttpServletResponse response) {
        try {
            URI u = URI.create(pathAndQuery.replace(" ", "%20"));
            String s = u.getScheme();
            if (s == null || !(s.equalsIgnoreCase("http") || s.equalsIgnoreCase("https"))) {
                response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
                return null;
            }
            return u;
        } catch (IllegalArgumentException e) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            return null;
        }
    }

    /** upstreamBase without trailing slash, path segments after device root, optional query (iotOpen stripped). */
    static String buildUpstreamPath(String upstreamBaseTrimmed, String pathSegmentTail,
                                    Optional<String> queryWithoutSensitive) {
        StringBuilder sb = new StringBuilder(upstreamBaseTrimmed);
        if (!pathSegmentTail.isEmpty()) {
            if (!upstreamBaseTrimmed.endsWith("/")) {
                sb.append('/');
            }
            sb.append(pathSegmentTail);
        }
        queryWithoutSensitive.ifPresent(q -> sb.append('?').append(q));
        return sb.toString();
    }

    private Optional<String> sanitizeQueryRemovingIotOpen(String rawQs) {
        if (rawQs == null || rawQs.isEmpty()) {
            return Optional.empty();
        }
        String[] parts = rawQs.split("&");
        List<String> kept = new ArrayList<>();
        for (String part : parts) {
            String key = part;
            int eq = part.indexOf('=');
            if (eq >= 0) {
                key = part.substring(0, eq);
            }
            if ("iotOpen".equalsIgnoreCase(key)) {
                continue;
            }
            kept.add(part);
        }
        if (kept.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(String.join("&", kept));
    }

    /** Appends {@code iotOpen}; strips any {@code iotOpen} from {@code forwardQueryRaw} first. */
    private static String mergeIotOpenQueryString(String forwardQueryRaw, String token) {
        StringBuilder qs = new StringBuilder();
        if (StringUtils.hasText(forwardQueryRaw)) {
            String stripped = stripIotOpenFromRawQuery(forwardQueryRaw.trim());
            if (StringUtils.hasText(stripped)) {
                qs.append(stripped);
            }
        }
        if (qs.length() > 0) {
            qs.append('&');
        }
        qs.append("iotOpen=").append(java.net.URLEncoder.encode(token, StandardCharsets.UTF_8));
        return qs.toString();
    }

    private static String stripIotOpenFromRawQuery(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        String[] parts = raw.split("&");
        List<String> kept = new ArrayList<>();
        for (String part : parts) {
            String key = part;
            int eq = part.indexOf('=');
            if (eq >= 0) {
                key = part.substring(0, eq);
            }
            if ("iotOpen".equalsIgnoreCase(key)) {
                continue;
            }
            kept.add(part);
        }
        return String.join("&", kept);
    }

    private void replay(String method, String seedUrl,
                        IotProxyTarget t,
                        HttpServletRequest request,
                        HttpServletResponse browser,
                        String publicSlugForPathRewrite) throws Exception {
        String current = seedUrl;
        for (int hop = 0; hop <= redirectMaxHops; hop++) {
            URI uri = URI.create(current);
            if (!upstreamUrlValidator.isAllowedLanUrl(uri.toString())) {
                browser.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
                return;
            }
            HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            copyForwardedRequestHeaders(request, conn);

            boolean hasCred = StringUtils.hasText(t.getUpstreamUsername())
                    && StringUtils.hasText(t.getUpstreamPassword());
            if (hasCred) {
                String basic = Base64.getEncoder().encodeToString(
                        (t.getUpstreamUsername() + ":" + t.getUpstreamPassword()).getBytes(StandardCharsets.UTF_8));
                conn.setRequestProperty(Uh.AUTHORIZATION, "Basic " + basic);
            }

            boolean attachBody = hop == 0 && shouldRelayRequestBody(method, request);
            if (attachBody) {
                long bodyLenHint = request.getContentLengthLong();
                if (bodyLenHint >= 0 && bodyLenHint > maxForwardRequestBodyBytes) {
                    browser.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
                    return;
                }
                conn.setDoOutput(true);
                if (bodyLenHint >= 0) {
                    conn.setFixedLengthStreamingMode(bodyLenHint);
                } else {
                    conn.setChunkedStreamingMode(8192);
                }
                try (OutputStream os = conn.getOutputStream()) {
                    long copied = copyLimited(request.getInputStream(), os, maxForwardRequestBodyBytes);
                    if (copied < 0) {
                        browser.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
                        conn.disconnect();
                        return;
                    }
                }
            }

            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField(Uh.LOCATION);
                conn.disconnect();
                if (loc == null || loc.isBlank()) {
                    browser.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
                    return;
                }
                URI next = uri.resolve(loc);
                current = next.toString();
                if (!upstreamUrlValidator.isAllowedLanUrl(current)) {
                    browser.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
                    return;
                }
                continue;
            }

            browser.setStatus(code);

            InputStream raw = code >= HttpURLConnection.HTTP_BAD_REQUEST ? conn.getErrorStream() : conn.getInputStream();
            String ct = conn.getHeaderField("Content-Type");
            String ce = conn.getHeaderField("Content-Encoding");
            String clHdr = conn.getHeaderField("Content-Length");
            long clParsed = parsePositiveLongOrNegOne(clHdr);
            boolean gzip = ce != null && ce.toLowerCase(Locale.ROOT).contains("gzip");
            boolean tryRewrite = StringUtils.hasText(publicSlugForPathRewrite)
                    && "GET".equals(method)
                    && code >= 200 && code < 300
                    && !"HEAD".equals(method)
                    && raw != null
                    && isRewriteCandidateContentType(ct)
                    && ((clParsed >= 0 && clParsed <= maxRewriteBodyBytes && clParsed <= Integer.MAX_VALUE)
                        || clParsed < 0);

            byte[] boxed = null;
            byte[] outbound = null;
            if (tryRewrite) {
                try {
                    if (clParsed >= 0 && clParsed <= maxRewriteBodyBytes && clParsed <= Integer.MAX_VALUE) {
                        boxed = readExactly(raw, (int) clParsed);
                    } else {
                        boxed = readStreamUpToLimit(raw, maxRewriteBodyBytes);
                    }
                } catch (Exception ex) {
                    log.debug("IoT forward buffering failed: {}", ex.getMessage());
                    conn.disconnect();
                    browser.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
                    return;
                }
                try {
                    byte[] decoded = gzip ? gunzipLimited(boxed, maxRewriteBodyBytes) : boxed;
                    Charset cs = charsetFromContentType(ct);
                    String text = new String(decoded, cs);
                    String rewritten = rewriteUnqualifiedLanFlvRoots(text, publicSlugForPathRewrite);
                    outbound = rewritten.getBytes(cs);
                } catch (Exception ex) {
                    outbound = null;
                    log.debug("IoT forward path rewrite skipped: {}", ex.getMessage());
                }
            }

            if (tryRewrite && outbound != null) {
                copyUpstreamResponseHeadersForReplay(conn, browser, true);
                browser.setHeader("Content-Length", String.valueOf(outbound.length));
                browser.getOutputStream().write(outbound);
                browser.flushBuffer();
                conn.disconnect();
                return;
            }

            if (tryRewrite && boxed != null) {
                copyUpstreamResponseHeadersForReplay(conn, browser, false);
                browser.setHeader("Content-Length", String.valueOf(boxed.length));
                browser.getOutputStream().write(boxed);
                browser.flushBuffer();
                conn.disconnect();
                return;
            }

            copyUpstreamResponseHeadersForReplay(conn, browser, false);

            long max = maxResponseBytes;
            long totalRead = 0;
            try {
                if (raw == null || "HEAD".equals(method)) {
                    return;
                }
                byte[] buf = new byte[8192];
                int n;
                while ((n = raw.read(buf)) != -1) {
                    totalRead += n;
                    if (totalRead > max) {
                        browser.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
                        return;
                    }
                    browser.getOutputStream().write(buf, 0, n);
                    browser.flushBuffer();
                }
            } finally {
                conn.disconnect();
            }
            return;
        }
        browser.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
    }

    private static long parsePositiveLongOrNegOne(String clHdr) {
        if (!StringUtils.hasText(clHdr)) {
            return -1;
        }
        try {
            long v = Long.parseLong(clHdr.trim());
            return v >= 0 ? v : -1;
        } catch (NumberFormatException ex) {
            return -1;
        }
    }

    /** Copy LAN response headers; when {@code stripLengthAndEncoding}, omit lengths we replace after rewriting the body. */
    private static void copyUpstreamResponseHeadersForReplay(HttpURLConnection conn, HttpServletResponse browser,
                                                             boolean stripLengthAndEncoding) {
        for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
            String name = e.getKey();
            if (name == null) {
                continue;
            }
            String lower = name.toLowerCase(Locale.ROOT);
            if (RESPONSE_HEADER_DENY.contains(lower) || Uh.SET_COOKIE.equalsIgnoreCase(name)) {
                continue;
            }
            if (stripLengthAndEncoding
                    && ("content-length".equals(lower) || "content-encoding".equals(lower) || "transfer-encoding".equals(lower))) {
                continue;
            }
            for (String v : e.getValue()) {
                browser.addHeader(name, v);
            }
        }
        browser.setHeader("Cache-Control", "no-store");
    }

    private static boolean isRewriteCandidateContentType(String ct) {
        if (!StringUtils.hasText(ct)) {
            return false;
        }
        String n = ct.toLowerCase(Locale.ROOT);
        return n.contains("text/html")
                || n.contains("javascript")
                || (n.startsWith("text/") && (n.contains("css") || n.contains("plain")));
    }

    private static Charset charsetFromContentType(String ct) {
        try {
            if (!StringUtils.hasText(ct)) {
                return StandardCharsets.UTF_8;
            }
            int idx = ct.toLowerCase(Locale.ROOT).indexOf("charset=");
            if (idx < 0) {
                return StandardCharsets.UTF_8;
            }
            String raw = ct.substring(idx + "charset=".length()).trim();
            int semi = raw.indexOf(';');
            if (semi >= 0) {
                raw = raw.substring(0, semi).trim();
            }
            raw = raw.replace("\"", "").trim();
            return Charset.forName(raw);
        } catch (Exception ex) {
            return StandardCharsets.UTF_8;
        }
    }

    private static byte[] readStreamUpToLimit(InputStream in, long maxBytes) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        long total = 0;
        int r;
        while ((r = in.read(buf)) != -1) {
            if (total + r > maxBytes) {
                throw new IOException("upstream body exceeds rewrite cap");
            }
            baos.write(buf, 0, r);
            total += r;
        }
        return baos.toByteArray();
    }

    private static byte[] readExactly(InputStream in, int len) throws IOException {
        byte[] buf = new byte[len];
        int pos = 0;
        while (pos < len) {
            int r = in.read(buf, pos, len - pos);
            if (r < 0) {
                throw new IOException("truncated upstream body expected " + len + " got " + pos);
            }
            pos += r;
        }
        return buf;
    }

    private static byte[] gunzipLimited(byte[] compressed, long maxDecompressed) throws IOException {
        try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(compressed));
             ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.min(compressed.length * 2, 8192))) {
            byte[] buf = new byte[8192];
            long total = 0;
            int r;
            while ((r = gis.read(buf)) != -1) {
                total += r;
                if (total > maxDecompressed) {
                    throw new IOException("gunzip exceeds cap");
                }
                bos.write(buf, 0, r);
            }
            return bos.toByteArray();
        }
    }

    /**
     * HTTP-FLV and similar UIs use root-relative {@code /flv?…}; through PatTool those must hit
     * {@code /api/iot-proxies/forward/&lt;slug&gt;/flv?…}.
     */
    static String rewriteUnqualifiedLanFlvRoots(String htmlOrJs, String publicSlugTrimmed) {
        if (htmlOrJs == null || htmlOrJs.isEmpty()) {
            return htmlOrJs;
        }
        String pxSlash = "/api/iot-proxies/forward/" + publicSlugTrimmed.trim() + "/";
        String needle = "/flv?";
        int nl = needle.length();
        StringBuilder sb = new StringBuilder(htmlOrJs.length() + 64);
        int pos = 0;
        while (true) {
            int ix = htmlOrJs.indexOf(needle, pos);
            if (ix < 0) {
                sb.append(htmlOrJs, pos, htmlOrJs.length());
                break;
            }
            boolean already = ix >= pxSlash.length()
                    && htmlOrJs.regionMatches(ix - pxSlash.length(), pxSlash, 0, pxSlash.length());
            sb.append(htmlOrJs, pos, ix);
            int nextPos;
            if (already) {
                sb.append(htmlOrJs, ix, ix + nl);
                nextPos = ix + nl;
            } else {
                sb.append(pxSlash, 0, pxSlash.length() - 1);
                sb.append(needle);
                nextPos = ix + nl;
            }
            pos = nextPos;
        }
        return sb.toString();
    }

    private static final class Uh {
        static final String LOCATION = "Location";
        static final String SET_COOKIE = "Set-Cookie";
        static final String AUTHORIZATION = "Authorization";
    }

    private static void copyForwardedRequestHeaders(HttpServletRequest from, HttpURLConnection to) {
        Enumeration<String> names = from.getHeaderNames();
        while (names.hasMoreElements()) {
            String h = names.nextElement();
            if (h != null && REQ_HEADER_WHITELIST.contains(h.toLowerCase(Locale.ROOT))) {
                Enumeration<String> vals = from.getHeaders(h);
                while (vals.hasMoreElements()) {
                    String v = vals.nextElement();
                    if ("cookie".equalsIgnoreCase(h)) {
                        String cleaned = stripPatToolForwardCookies(v);
                        if (!StringUtils.hasText(cleaned)) {
                            continue;
                        }
                        v = cleaned;
                    }
                    to.addRequestProperty(h, v);
                }
            }
        }
    }

    /** Remove IoT-proxy open cookies ({@link #OPEN_COOKIE_BASE}…) so DVRs upstream do not choke on unrelated host cookies / huge headers. */
    static String stripPatToolForwardCookies(String cookieHeader) {
        if (!StringUtils.hasText(cookieHeader)) {
            return "";
        }
        String baseLower = OPEN_COOKIE_BASE.toLowerCase(Locale.ROOT);
        String prefixChecksLower = (OPEN_COOKIE_BASE + "_").toLowerCase(Locale.ROOT);
        List<String> kept = new ArrayList<>();
        for (String chunk : cookieHeader.split(";")) {
            String piece = chunk.trim();
            if (piece.isEmpty()) {
                continue;
            }
            int eq = piece.indexOf('=');
            String nameTrim = eq < 0 ? piece : piece.substring(0, eq).trim();
            String nl = nameTrim.toLowerCase(Locale.ROOT);
            if (baseLower.equals(nl)) {
                continue;
            }
            if (nl.startsWith(prefixChecksLower)) {
                continue;
            }
            kept.add(piece);
        }
        return String.join("; ", kept);
    }

    private static String trimTrailingSlash(String url) {
        if (url == null) {
            return "";
        }
        String x = url.trim();
        while (x.endsWith("/")) {
            x = x.substring(0, x.length() - 1);
        }
        return x.isEmpty() ? "" : x;
    }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
