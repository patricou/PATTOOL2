package com.pat.service;

import com.pat.dto.PassiveCheckRow;
import com.pat.dto.PassiveProbeResponse;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.SSLException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Sonde HTTP « sécurité site » exécutée côté serveur PatTool, sous mandat explicite (API {@code authorizationConfirmed}).
 *
 * <h2>Garde-fous</h2>
 * Schémas {@code http}/{@code https} uniquement ; résolution DNS puis blocage des cibles non publiques (sauf si
 * {@code pat.passive-probe.allow-private-targets=true}) ; ports limités ; pas d’URL avec userinfo ; redirections
 * suivies manuellement avec plafond (évite SSRF via redirections).
 *
 * <h2>Contrôles passifs (toujours exécutés si la requête atteint une réponse finale)</h2>
 * <ul>
 *   <li>{@code REACHABILITY} / erreurs réseau — joignabilité après HEAD (+ GET si 405/501 sur HEAD).</li>
 *   <li>{@code REDIRECT_*} — chaîne de redirections invalide ou trop longue.</li>
 *   <li>{@code HTTP_STATUS} — code HTTP ≥ 400 sur la réponse HEAD finale.</li>
 *   <li>{@code FINAL_HTTPS} / {@code HTTP_TO_HTTPS_REDIRECT} — schéma final et passage HTTP→HTTPS.</li>
 *   <li>Récolte d’en-têtes : si réponse 2xx–3xx, GET optionnel sur l’URL finale pour enrichir (ex. {@code Set-Cookie}).</li>
 *   <li>{@code HTTP_PROTOCOL} — version HTTP négociée (HTTP/1.1 vs HTTP/2).</li>
 *   <li>{@code HEADER_HSTS} — présence HSTS sur HTTPS.</li>
 *   <li>{@code CERT_EXPIRY} — expiration du certificat feuille (TLS handshake dédié, hors corps HTTP).</li>
 *   <li>{@code HEADER_X_CONTENT_TYPE_OPTIONS} — valeur {@code nosniff} attendue.</li>
 *   <li>{@code HEADER_X_FRAME_OPTIONS} — XFO ou {@code frame-ancestors} dans la CSP.</li>
 *   <li>{@code HEADER_CSP} / {@code HEADER_REFERRER_POLICY} — présence recommandée (avis si absent).</li>
 *   <li>{@code HEADER_COOP} / {@code HEADER_PERMISSIONS_POLICY} — durcissement navigateur (HTTPS).</li>
 *   <li>{@code HEADER_CORP} — isolation cross-origin optionnelle (information).</li>
 *   <li>{@code HEADER_X_POWERED_BY} / {@code HEADER_ASPNET_VERSION} — fuites de pile logicielle.</li>
 *   <li>{@code COOKIE_SECURE_FLAG} / {@code COOKIE_SAMESITE} — analyse textuelle des en-têtes Set-Cookie (HTTPS).</li>
 *   <li>{@code SECURITY_TXT} — GET statut uniquement sur {@code /.well-known/security.txt}.</li>
 *   <li>{@code HEADER_SERVER_DISCLOSURE} — en-tête {@code Server} avec motif « version ».</li>
 * </ul>
 *
 * <h2>Contrôles actifs (uniquement si {@code includeActiveChecks=true})</h2>
 * Requêtes HTTP additionnelles sur la même origine ; pas d’injection ni de crawl applicatif.
 * <ul>
 *   <li>{@code HTTP_OPTIONS_ALLOW} — méthode OPTIONS, lecture {@code Allow} ; {@code HTTP_TRACE_IN_ALLOW} si TRACE est annoncé.</li>
 *   <li>{@code HTTP_TRACE_METHOD} — une requête TRACE ; avis si réponse 2xx.</li>
 *   <li>{@code ROBOTS_TXT} — GET {@code /robots.txt}, corps ignoré.</li>
 * </ul>
 *
 * <p>Ce n’est pas un outil de test d’intrusion : pas de fuzzing, pas d’énumération de chemins, pas de charge abusive.</p>
 */
@Service
public class PassiveSiteProbeService {

    private static final Logger log = LoggerFactory.getLogger(PassiveSiteProbeService.class);

    private static final int MAX_URL_LENGTH = 2048;

    private static final Pattern TRACE_IN_ALLOW = Pattern.compile("\\bTRACE\\b", Pattern.CASE_INSENSITIVE);

    private final boolean allowPrivateTargets;
    private final int maxRedirects;
    private final int connectTimeoutSeconds;
    private final int requestTimeoutSeconds;

    public PassiveSiteProbeService(
            @Value("${pat.passive-probe.allow-private-targets:false}") boolean allowPrivateTargets,
            @Value("${pat.passive-probe.max-redirects:5}") int maxRedirects,
            @Value("${pat.passive-probe.connect-timeout-seconds:5}") int connectTimeoutSeconds,
            @Value("${pat.passive-probe.request-timeout-seconds:15}") int requestTimeoutSeconds) {
        this.allowPrivateTargets = allowPrivateTargets;
        this.maxRedirects = Math.min(Math.max(maxRedirects, 0), 15);
        this.connectTimeoutSeconds = Math.max(connectTimeoutSeconds, 1);
        this.requestTimeoutSeconds = Math.max(requestTimeoutSeconds, 1);
    }

    /**
     * Lance la série de contrôles sur {@code rawTargetUrl}. Les identifiants de lignes ({@code REACHABILITY}, {@code HEADER_*}, …)
     * sont documentés dans la Javadoc de cette classe.
     *
     * @param includeActiveChecks si {@code true}, exécute en plus OPTIONS / TRACE / {@code /robots.txt} ({@link #runActiveChecks}).
     */
    public PassiveProbeResponse probe(String rawTargetUrl, boolean includeActiveChecks) {
        if (rawTargetUrl == null || rawTargetUrl.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "targetUrl required");
        }
        String trimmed = rawTargetUrl.trim();
        if (trimmed.length() > MAX_URL_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "targetUrl too long");
        }
        URI initial = normalizeUserUri(trimmed);
        validateUriAllowed(initial);

        HttpClient client =
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(connectTimeoutSeconds)).build();

        List<PassiveCheckRow> checks = new ArrayList<>();
        URI current = initial;
        HttpResponse<Void> lastResponse = null;
        Exception captured = null;

        /* --- Phase 1 : résolution des redirections (HEAD), même validation d’hôte à chaque saut --- */
        try {
            int hopsDone = 0;
            while (hopsDone <= maxRedirects) {
                validateUriAllowed(current);
                lastResponse = sendOnce(client, current, true);
                int code = lastResponse.statusCode();

                if (code >= 300 && code < 400) {
                    Optional<String> loc = lastResponse.headers().firstValue("Location");
                    if (loc.isEmpty()) {
                        checks.add(new PassiveCheckRow(
                                "REDIRECT_MISSING_LOCATION", "WARN", "Redirect without Location header."));
                        break;
                    }
                    URI next;
                    try {
                        next = current.resolve(new URI(loc.get().trim())).normalize();
                    } catch (URISyntaxException e) {
                        checks.add(new PassiveCheckRow(
                                "REDIRECT_INVALID", "FAIL", "Invalid Location header."));
                        break;
                    }
                    if (hopsDone >= maxRedirects) {
                        checks.add(new PassiveCheckRow("REDIRECT_LIMIT", "FAIL", "Too many redirects."));
                        break;
                    }
                    current = next;
                    hopsDone++;
                    continue;
                }

                if (code == 405 || code == 501) {
                    lastResponse = sendOnce(client, current, false);
                }
                break;
            }
        } catch (Exception e) {
            captured = e;
            log.debug("Passive probe failed: {}", e.toString());
        }

        String requested = initial.toString();
        if (lastResponse == null) {
            checks.add(0, probeErrorRow(captured));
            return new PassiveProbeResponse(requested, null, null, checks);
        }

        int status = lastResponse.statusCode();
        if (status >= 300 && status < 400) {
            checks.add(0, new PassiveCheckRow(
                    "REACHABILITY",
                    "WARN",
                    "Stopped on redirect before final response (HTTP " + status + ")."));
            return new PassiveProbeResponse(requested, current.toString(), status, checks);
        }

        URI finalUri = current;

        /* --- Phase 2 : indicateurs de base sur l’URL finale (HTTPS, statut HTTP joignabilité) --- */
        if (status >= 400) {
            checks.add(0, new PassiveCheckRow(
                    "HTTP_STATUS",
                    status >= 500 ? "FAIL" : "WARN",
                    "HTTP status " + status));
        } else {
            checks.add(0, new PassiveCheckRow(
                    "REACHABILITY", "PASS", "HTTP status " + status));
        }

        String scheme = finalUri.getScheme() != null ? finalUri.getScheme().toLowerCase(Locale.ROOT) : "";
        if ("https".equals(scheme)) {
            checks.add(new PassiveCheckRow("FINAL_HTTPS", "PASS", finalUri.getHost()));
        } else if ("http".equals(scheme)) {
            checks.add(new PassiveCheckRow(
                    "FINAL_HTTPS",
                    "WARN",
                    "Final URL uses HTTP — prefer HTTPS for transport encryption."));
        }

        if ("http".equalsIgnoreCase(initial.getScheme()) && "https".equals(scheme)) {
            checks.add(new PassiveCheckRow(
                    "HTTP_TO_HTTPS_REDIRECT", "INFO", "Upgraded from HTTP to HTTPS via redirect."));
        }

        /* --- Phase 3 : en-têtes de réponse — préfère un GET 2xx sur l’URL finale pour voir Set-Cookie etc. --- */
        HttpResponse<Void> headerProbe = lastResponse;
        if (status >= 200 && status < 400) {
            try {
                validateUriAllowed(finalUri);
                HttpResponse<Void> getHarvest = sendOnce(client, finalUri, false);
                if (getHarvest.statusCode() >= 200 && getHarvest.statusCode() < 400) {
                    headerProbe = getHarvest;
                }
            } catch (Exception e) {
                log.debug("GET header harvest skipped: {}", e.toString());
            }
        }

        var headers = headerProbe.headers();
        checks.add(new PassiveCheckRow(
                "HTTP_PROTOCOL", "INFO", headerProbe.version().name()));

        if ("https".equals(scheme)) {
            headerHsts(checks, headers.firstValue("Strict-Transport-Security"));
            checkCertificateExpiry(checks, finalUri);
        }
        headerXContentTypeOptions(checks, headers.firstValue("X-Content-Type-Options"));
        headerFrameOrCsp(checks, headers);
        headerPresent(checks, "HEADER_CSP", headers.firstValue("Content-Security-Policy"));
        headerPresent(checks, "HEADER_REFERRER_POLICY", headers.firstValue("Referrer-Policy"));

        headerPoweredBy(checks, headers);
        headerAspNetLeak(checks, headers);

        if ("https".equals(scheme)) {
            headerPresent(checks, "HEADER_COOP", headers.firstValue("Cross-Origin-Opener-Policy"));
            Optional<String> perm = headers.firstValue("Permissions-Policy");
            if (perm.isEmpty()) {
                perm = headers.firstValue("Feature-Policy");
            }
            headerPresent(checks, "HEADER_PERMISSIONS_POLICY", perm);
        }
        headerCorp(checks, headers);

        setCookieChecks(checks, scheme, headers);

        /* --- Phase 4 : fichier security.txt public (RFC 9116) — GET minimal, statut HTTP uniquement --- */
        probeSecurityTxt(client, finalUri, checks);

        /* --- Phase 5 : contrôles actifs optionnels (OPTIONS, TRACE, robots.txt) --- */
        if (includeActiveChecks) {
            runActiveChecks(client, finalUri, checks);
        }

        headers.firstValue("Server").ifPresent(server -> {
            if (looksLikeVersionDisclosure(server)) {
                checks.add(new PassiveCheckRow(
                        "HEADER_SERVER_DISCLOSURE",
                        "WARN",
                        "Server header may expose product/version: "
                                + truncate(server, 120)));
            } else {
                checks.add(new PassiveCheckRow(
                        "HEADER_SERVER_DISCLOSURE", "PASS", "Server header present without obvious version."));
            }
        });

        return new PassiveProbeResponse(requested, finalUri.toString(), status, checks);
    }

    private static PassiveCheckRow probeErrorRow(Exception e) {
        if (e == null) {
            return new PassiveCheckRow("REACHABILITY", "ERROR", "Request failed.");
        }
        String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        if (e instanceof java.net.http.HttpTimeoutException) {
            return new PassiveCheckRow("REACHABILITY", "ERROR", "Timeout: " + msg);
        }
        if (e instanceof SSLException) {
            return new PassiveCheckRow("TLS_HANDSHAKE", "ERROR", msg);
        }
        return new PassiveCheckRow("REACHABILITY", "ERROR", truncate(msg, 200));
    }

    private static String truncate(String s, int max) {
        if (s.length() <= max) {
            return s;
        }
        return s.substring(0, max) + "...";
    }

    private static boolean looksLikeVersionDisclosure(String server) {
        return server.matches(".*\\d+\\.\\d+.*") || server.toLowerCase(Locale.ROOT).matches(".*apache/\\d.*");
    }

    private static void headerXContentTypeOptions(List<PassiveCheckRow> checks, Optional<String> header) {
        String id = "HEADER_X_CONTENT_TYPE_OPTIONS";
        if (header.isEmpty()) {
            checks.add(new PassiveCheckRow(id, "WARN", "Missing X-Content-Type-Options."));
            return;
        }
        String v = header.get().trim();
        if ("nosniff".equalsIgnoreCase(v)) {
            checks.add(new PassiveCheckRow(id, "PASS", v));
        } else {
            checks.add(new PassiveCheckRow(id, "WARN", "Expected nosniff, got: " + truncate(v, 80)));
        }
    }

    private static void headerPresent(List<PassiveCheckRow> checks, String id, Optional<String> header) {
        if (header.isEmpty()) {
            checks.add(new PassiveCheckRow(id, "WARN", "Missing."));
            return;
        }
        checks.add(new PassiveCheckRow(id, "PASS", truncate(header.get().trim(), 120)));
    }

    private static void headerHsts(List<PassiveCheckRow> checks, Optional<String> header) {
        String id = "HEADER_HSTS";
        if (header.isEmpty()) {
            checks.add(new PassiveCheckRow(id, "WARN", "Missing Strict-Transport-Security on HTTPS."));
            return;
        }
        checks.add(new PassiveCheckRow(id, "PASS", truncate(header.get().trim(), 120)));
    }

    private static void headerFrameOrCsp(List<PassiveCheckRow> checks, java.net.http.HttpHeaders headers) {
        Optional<String> xfo = headers.firstValue("X-Frame-Options");
        Optional<String> csp = headers.firstValue("Content-Security-Policy");
        if (xfo.isPresent()) {
            checks.add(new PassiveCheckRow("HEADER_X_FRAME_OPTIONS", "PASS", truncate(xfo.get().trim(), 120)));
            return;
        }
        if (csp.isPresent() && csp.get().toLowerCase(Locale.ROOT).contains("frame-ancestors")) {
            checks.add(new PassiveCheckRow(
                    "HEADER_X_FRAME_OPTIONS", "PASS", "frame-ancestors defined in CSP."));
            return;
        }
        checks.add(new PassiveCheckRow(
                "HEADER_X_FRAME_OPTIONS",
                "WARN",
                "No X-Frame-Options and no frame-ancestors in CSP — clickjacking risk."));
    }

    private static void headerPoweredBy(List<PassiveCheckRow> checks, java.net.http.HttpHeaders headers) {
        Optional<String> xp = headers.firstValue("X-Powered-By");
        if (xp.isPresent()) {
            checks.add(new PassiveCheckRow(
                    "HEADER_X_POWERED_BY",
                    "WARN",
                    "Technology hint disclosed: " + truncate(xp.get().trim(), 120)));
        } else {
            checks.add(new PassiveCheckRow("HEADER_X_POWERED_BY", "PASS", "Not sent."));
        }
    }

    private static void headerAspNetLeak(List<PassiveCheckRow> checks, java.net.http.HttpHeaders headers) {
        Optional<String> mvc = headers.firstValue("X-AspNetMvc-Version");
        Optional<String> asp = headers.firstValue("X-AspNet-Version");
        if (mvc.isEmpty() && asp.isEmpty()) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        mvc.ifPresent(v -> sb.append("X-AspNetMvc-Version=").append(v.trim()));
        if (mvc.isPresent() && asp.isPresent()) {
            sb.append("; ");
        }
        asp.ifPresent(v -> sb.append("X-AspNet-Version=").append(v.trim()));
        checks.add(new PassiveCheckRow("HEADER_ASPNET_VERSION", "WARN", truncate(sb.toString(), 120)));
    }

    private static void headerCorp(List<PassiveCheckRow> checks, java.net.http.HttpHeaders headers) {
        Optional<String> corp = headers.firstValue("Cross-Origin-Resource-Policy");
        if (corp.isEmpty()) {
            checks.add(new PassiveCheckRow(
                    "HEADER_CORP",
                    "INFO",
                    "No Cross-Origin-Resource-Policy (optional cross-origin isolation hint)."));
        } else {
            checks.add(new PassiveCheckRow("HEADER_CORP", "PASS", truncate(corp.get().trim(), 120)));
        }
    }

    private static void setCookieChecks(List<PassiveCheckRow> checks, String scheme, java.net.http.HttpHeaders headers) {
        if (!"https".equals(scheme)) {
            return;
        }
        List<String> cookies = headers.allValues("Set-Cookie");
        if (cookies.isEmpty()) {
            return;
        }
        boolean allSecure = true;
        boolean allSameSite = true;
        for (String line : cookies) {
            String lower = line.toLowerCase(Locale.ROOT);
            if (!lower.contains("secure")) {
                allSecure = false;
            }
            if (!lower.contains("samesite")) {
                allSameSite = false;
            }
        }
        checks.add(new PassiveCheckRow(
                "COOKIE_SECURE_FLAG",
                allSecure ? "PASS" : "WARN",
                allSecure ? "All Set-Cookie use Secure." : "Some Set-Cookie omit Secure."));
        checks.add(new PassiveCheckRow(
                "COOKIE_SAMESITE",
                allSameSite ? "PASS" : "WARN",
                allSameSite ? "SameSite present on cookies." : "Some Set-Cookie omit SameSite."));
    }

    /** TLS séparé vers {@code host:443} pour lire la date d’expiration du certificat feuille ({@code CERT_EXPIRY}). */
    private void checkCertificateExpiry(List<PassiveCheckRow> checks, URI httpsUri) {
        String host = httpsUri.getHost();
        int port = httpsUri.getPort();
        if (port < 0) {
            port = 443;
        }
        try {
            SSLSocketFactory sf = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket socket = (SSLSocket) sf.createSocket(host, port)) {
                socket.setSoTimeout(Math.min(requestTimeoutSeconds * 1000, 60_000));
                socket.startHandshake();
                java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
                if (chain.length > 0 && chain[0] instanceof X509Certificate x509) {
                    Instant notAfter = x509.getNotAfter().toInstant();
                    long days = Duration.between(Instant.now(), notAfter).toDays();
                    if (days < 0) {
                        checks.add(new PassiveCheckRow("CERT_EXPIRY", "FAIL", "Leaf certificate has expired."));
                    } else if (days < 7) {
                        checks.add(new PassiveCheckRow(
                                "CERT_EXPIRY", "FAIL", "Leaf certificate expires in " + days + " days."));
                    } else if (days < 30) {
                        checks.add(new PassiveCheckRow(
                                "CERT_EXPIRY", "WARN", "Leaf certificate expires in " + days + " days."));
                    } else {
                        checks.add(new PassiveCheckRow(
                                "CERT_EXPIRY", "PASS", "Leaf certificate valid ~" + days + " more days."));
                    }
                }
            }
        } catch (Exception e) {
            checks.add(new PassiveCheckRow(
                    "CERT_EXPIRY",
                    "WARN",
                    "Could not inspect certificate (separate TLS handshake): "
                            + truncate(e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(), 120)));
        }
    }

    /**
     * Vérifie la présence de {@code /.well-known/security.txt} (contact sécurité — pas de lecture du corps pour limiter la charge).
     * ID résultat : {@code SECURITY_TXT}.
     */
    private void probeSecurityTxt(HttpClient client, URI baseUri, List<PassiveCheckRow> checks) {
        try {
            URI st =
                    new URI(
                                    baseUri.getScheme(),
                                    null,
                                    baseUri.getHost(),
                                    baseUri.getPort(),
                                    "/.well-known/security.txt",
                                    null,
                                    null)
                            .normalize();
            validateUriAllowed(st);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(st)
                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                    .header("User-Agent", "PatTool-PassiveProbe/1.0")
                    .GET()
                    .build();
            HttpResponse<Void> r = client.send(req, BodyHandlers.discarding());
            int code = r.statusCode();
            if (code == 200) {
                checks.add(new PassiveCheckRow(
                        "SECURITY_TXT", "PASS", "Published (HTTP 200, /.well-known/security.txt)."));
            } else if (code == 404) {
                checks.add(new PassiveCheckRow(
                        "SECURITY_TXT", "WARN", "Not found — consider publishing /.well-known/security.txt."));
            } else {
                checks.add(new PassiveCheckRow("SECURITY_TXT", "INFO", "HTTP " + code));
            }
        } catch (Exception e) {
            checks.add(new PassiveCheckRow(
                    "SECURITY_TXT",
                    "INFO",
                    "Could not fetch security.txt: "
                            + truncate(e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(), 80)));
        }
    }

    /**
     * Contrôles actifs bornés : une requête OPTIONS (analyse {@code Allow}), une TRACE, un GET {@code /robots.txt}.
     * Même validation d’URL que le reste de la sonde ; pas de fuzzing ni d’énumération de chemins.
     */
    private void runActiveChecks(HttpClient client, URI finalUri, List<PassiveCheckRow> checks) {
        probeOptionsAllow(client, finalUri, checks);
        probeTraceMethod(client, finalUri, checks);
        probeRobotsTxtActive(client, finalUri, checks);
    }

    /**
     * OPTIONS sur l’URL finale : rapporte le statut et l’en-tête {@code Allow} ({@code HTTP_OPTIONS_ALLOW}) ;
     * si TRACE apparaît dans Allow → {@code HTTP_TRACE_IN_ALLOW}.
     */
    private void probeOptionsAllow(HttpClient client, URI finalUri, List<PassiveCheckRow> checks) {
        try {
            validateUriAllowed(finalUri);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(finalUri)
                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .header("User-Agent", "PatTool-PassiveProbe/1.0-active")
                    .build();
            HttpResponse<Void> r = client.send(req, BodyHandlers.discarding());
            int code = r.statusCode();
            Optional<String> allow = r.headers().firstValue("Allow");
            if (allow.isPresent()) {
                String a = allow.get().trim();
                checks.add(new PassiveCheckRow(
                        "HTTP_OPTIONS_ALLOW", "INFO", "OPTIONS HTTP " + code + " — Allow: " + truncate(a, 160)));
                if (TRACE_IN_ALLOW.matcher(a).find()) {
                    checks.add(new PassiveCheckRow(
                            "HTTP_TRACE_IN_ALLOW", "WARN", "Allow lists TRACE — disable if unused."));
                }
            } else {
                checks.add(new PassiveCheckRow(
                        "HTTP_OPTIONS_ALLOW", "INFO", "OPTIONS HTTP " + code + " — no Allow header."));
            }
        } catch (Exception e) {
            checks.add(new PassiveCheckRow(
                    "HTTP_OPTIONS_ALLOW",
                    "WARN",
                    "OPTIONS failed: "
                            + truncate(e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(), 120)));
        }
    }

    /**
     * Une requête TRACE sur l’URL finale : si réponse 2xx, signale un risque XST ({@code HTTP_TRACE_METHOD}) ;
     * sinon considéré comme rejeté ou non implémenté (PASS).
     */
    private void probeTraceMethod(HttpClient client, URI finalUri, List<PassiveCheckRow> checks) {
        try {
            validateUriAllowed(finalUri);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(finalUri)
                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                    .method("TRACE", HttpRequest.BodyPublishers.noBody())
                    .header("User-Agent", "PatTool-PassiveProbe/1.0-active")
                    .build();
            HttpResponse<Void> r = client.send(req, BodyHandlers.discarding());
            int code = r.statusCode();
            if (code >= 200 && code < 300) {
                checks.add(new PassiveCheckRow(
                        "HTTP_TRACE_METHOD",
                        "WARN",
                        "TRACE returned HTTP " + code + " — cross-site tracing risk; disable if unused."));
            } else {
                checks.add(new PassiveCheckRow(
                        "HTTP_TRACE_METHOD", "PASS", "TRACE rejected or not implemented (HTTP " + code + ")."));
            }
        } catch (Exception e) {
            checks.add(new PassiveCheckRow(
                    "HTTP_TRACE_METHOD",
                    "PASS",
                    "TRACE not usable: "
                            + truncate(e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(), 100)));
        }
    }

    /** GET {@code /robots.txt} sur la même origine ; corps ignoré — existence / code HTTP ({@code ROBOTS_TXT}). */
    private void probeRobotsTxtActive(HttpClient client, URI baseUri, List<PassiveCheckRow> checks) {
        try {
            URI rb =
                    new URI(baseUri.getScheme(), null, baseUri.getHost(), baseUri.getPort(), "/robots.txt", null, null)
                            .normalize();
            validateUriAllowed(rb);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(rb)
                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                    .header("User-Agent", "PatTool-PassiveProbe/1.0-active")
                    .GET()
                    .build();
            HttpResponse<Void> r = client.send(req, BodyHandlers.discarding());
            int code = r.statusCode();
            if (code == 200) {
                checks.add(new PassiveCheckRow("ROBOTS_TXT", "PASS", "Present (HTTP 200, /robots.txt)."));
            } else if (code == 404) {
                checks.add(new PassiveCheckRow("ROBOTS_TXT", "INFO", "Not found (HTTP 404)."));
            } else {
                checks.add(new PassiveCheckRow("ROBOTS_TXT", "INFO", "HTTP " + code));
            }
        } catch (Exception e) {
            checks.add(new PassiveCheckRow(
                    "ROBOTS_TXT",
                    "INFO",
                    "Could not fetch robots.txt: "
                            + truncate(e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName(), 80)));
        }
    }

    private HttpResponse<Void> sendOnce(HttpClient client, URI uri, boolean head) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(uri)
                .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                .header("User-Agent", "PatTool-PassiveProbe/1.0");
        HttpRequest req =
                head ? b.method("HEAD", HttpRequest.BodyPublishers.noBody()).build()
                        : b.GET().build();
        return client.send(req, BodyHandlers.discarding());
    }

    private void validateUriAllowed(URI uri) {
        String scheme = uri.getScheme();
        if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only http and https URLs are allowed.");
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid host.");
        }
        if (uri.getUserInfo() != null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "URLs with user info are not allowed.");
        }
        int port = uri.getPort();
        if (port != -1 && port != 80 && port != 443 && port != 8080 && port != 8443) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "Port not allowed (use 80, 443, 8080 or 8443).");
        }

        if (allowPrivateTargets) {
            return;
        }
        try {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            for (InetAddress addr : addresses) {
                if (isBlockedAddress(addr)) {
                    throw new ResponseStatusException(
                            HttpStatus.BAD_REQUEST, "Target host resolves to a non-public address.");
                }
            }
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Could not resolve host: " + host);
        }
    }

    private static boolean isBlockedAddress(InetAddress addr) {
        if (addr.isLoopbackAddress()
                || addr.isAnyLocalAddress()
                || addr.isLinkLocalAddress()
                || addr.isMulticastAddress()) {
            return true;
        }
        if (addr.isSiteLocalAddress()) {
            return true;
        }
        if (addr instanceof Inet6Address ia6) {
            return ia6.isIPv4CompatibleAddress()
                    || isIpv6UniqueLocal(ia6)
                    || ia6.isMulticastAddress();
        }
        String host = addr.getHostAddress();
        return "0.0.0.0".equals(host);
    }

    private static boolean isIpv6UniqueLocal(Inet6Address ia6) {
        byte[] b = ia6.getAddress();
        return (b[0] & 0xfe) == 0xfc;
    }

    private static URI normalizeUserUri(String input) {
        String s = input.trim();
        if (!s.matches("(?i)https?://.*")) {
            s = "https://" + s;
        }
        try {
            return new URI(s).normalize();
        } catch (URISyntaxException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid URL syntax.");
        }
    }
}
