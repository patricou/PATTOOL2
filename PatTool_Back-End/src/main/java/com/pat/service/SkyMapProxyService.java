package com.pat.service;

import com.pat.config.RestTemplateConfig;
import com.pat.controller.dto.SkyMapPreviewDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;
import org.springframework.web.util.UriComponentsBuilder;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import jakarta.servlet.http.HttpServletRequest;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Server-side proxy for <a href="https://www.wikisky.org/api?locale=EN">Sky-Map.org</a>
 * XML search, DSS2 image cutouts, and Sky Window HTML.
 * Tile/label XHR is rewritten to {@code /api/external/skymap/upstream} so the iframe stays same-origin.
 */
@Service
public class SkyMapProxyService {

    private static final Logger log = LoggerFactory.getLogger(SkyMapProxyService.class);

    private static final Pattern SAFE_QUERY = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{Z}+\\-]{1,80}$");
    private static final Pattern HTTP_SKYMAP_HOST = Pattern.compile(
            "http://((?:[\\w-]+\\.)?(?:sky-map\\.org|wikisky\\.org)(?::\\d+)?)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern SKYMAP_TILE_SERVER = Pattern.compile(
            "https://server[1-9]\\.sky-map\\.org",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern UPSTREAM_PATH = Pattern.compile("^(areas|imgcut|map)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern GTAG_BLOCK = Pattern.compile(
            "(?is)<!--\\s*Google tag.*?-->\\s*<script async src=\"https://www\\.googletagmanager\\.com[^\"]*\"></script>\\s*<script>.*?</script>");
    private static final Set<String> SURVEYS = Set.of("DSS2", "SDSS", "GALEX", "IRAS", "HALPHA", "RASS");
    private static final String USER_AGENT = "PATTOOL/1.0 (+https://www.patrickdeschamps.com)";
    private static final int MAX_SKYWINDOW_BYTES = 512_000;
    private static final int MAX_UPSTREAM_QUERY = 12_000;
    /** Sky Window slider 1–18; URL zoom 4 puts the handle near the top (wide field). */
    private static final int DEFAULT_WINDOW_ZOOM = 4;

    private static final int MIN_SIZE = 64;
    private static final int MAX_SIZE = 800;
    private static final int DEFAULT_SIZE = 400;
    private static final double MIN_ANGLE = 0.05;
    private static final double MAX_ANGLE = 40.0;
    private static final double DEFAULT_ANGLE = 1.2;

    private final RestTemplate restTemplate;

    @Value("${app.skymap.search-base:https://www.wikisky.org}")
    private String searchBase;

    @Value("${app.skymap.imgcut-base:https://server1.sky-map.org}")
    private String imgcutBase;

    @Value("${app.skymap.atlas-base:https://www.wikisky.org}")
    private String atlasBase;

    public SkyMapProxyService(
            @Qualifier(RestTemplateConfig.SKYMAP_REST_TEMPLATE) RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public SkyMapPreviewDto preview(
            String query,
            Double ra,
            Double de,
            String raUnit,
            Double angle,
            Integer width,
            Integer height,
            String survey) {
        String trimmedQuery = query == null ? "" : query.trim();
        if (StringUtils.hasText(trimmedQuery) && !SAFE_QUERY.matcher(trimmedQuery).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_query");
        }

        String resolvedSurvey = normalizeSurvey(survey);
        int w = clampSize(width);
        int h = clampSize(height);

        SkyObject found = StringUtils.hasText(trimmedQuery) ? searchObject(trimmedQuery) : null;
        boolean haveCoords = ra != null && de != null && isValidRaDe(ra, de, raUnit);

        double raHours;
        double deDeg;
        // Prefer the coordinates PatTool is actually aiming at. Name search is only
        // a fallback (and metadata): searching "Ursa Major" would otherwise snap
        // to a random star instead of the constellation centre.
        if (haveCoords) {
            raHours = toRaHours(ra, raUnit);
            deDeg = clampDec(de);
        } else if (found != null) {
            raHours = found.raHours;
            deDeg = found.deDeg;
        } else {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "object_not_found");
        }

        double fov = angle != null
                ? clampAngle(angle)
                : (found != null && found.radiusDeg != null
                        ? clampAngle(found.radiusDeg * 2.4)
                        : DEFAULT_ANGLE);

        String objectName = found != null
                ? firstNonBlank(found.name, found.catalogId, trimmedQuery)
                : (StringUtils.hasText(trimmedQuery) ? trimmedQuery : null);

        String cutoutUrl = UriComponentsBuilder
                .fromPath("external/skymap/cutout")
                .queryParam("ra", formatCoord(raHours))
                .queryParam("de", formatCoord(deDeg))
                .queryParam("angle", formatCoord(fov))
                .queryParam("w", w)
                .queryParam("h", h)
                .queryParam("survey", resolvedSurvey)
                .build()
                .encode()
                .toUriString();

        String atlasUrl = buildAtlasUrl(objectName, raHours, deDeg, fov, resolvedSurvey);
        String embedUrl = buildEmbedUrl(objectName, raHours, deDeg, fov, resolvedSurvey);

        return new SkyMapPreviewDto(
                StringUtils.hasText(trimmedQuery) ? trimmedQuery : null,
                objectName,
                found != null ? found.catalogId : null,
                found != null ? found.type : null,
                found != null ? found.constellation : null,
                raHours,
                deDeg,
                found != null ? found.magnitude : null,
                fov,
                resolvedSurvey,
                atlasUrl,
                cutoutUrl,
                embedUrl
        );
    }

    public ResponseEntity<byte[]> cutout(
            double raHours,
            double deDeg,
            Double angle,
            Integer width,
            Integer height,
            String survey) {
        if (!isValidHoursDec(raHours, deDeg)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_coords");
        }
        String resolvedSurvey = normalizeSurvey(survey);
        int w = clampSize(width);
        int h = clampSize(height);
        double fov = clampAngle(angle != null ? angle : DEFAULT_ANGLE);

        String url = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(imgcutBase) + "/imgcut")
                .queryParam("survey", resolvedSurvey)
                .queryParam("ra", formatCoord(clampRaHours(raHours)))
                .queryParam("de", formatCoord(clampDec(deDeg)))
                .queryParam("angle", formatCoord(fov))
                .queryParam("width", w)
                .queryParam("height", h)
                .build()
                .encode()
                .toUriString();

        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
        headers.set(HttpHeaders.ACCEPT, "image/jpeg,image/png,image/gif,*/*");

        try {
            ResponseEntity<byte[]> upstream = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
            byte[] body = upstream.getBody();
            if (body == null || body.length < 32 || !looksLikeImage(body)) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_invalid");
            }
            MediaType mediaType = upstream.getHeaders().getContentType();
            if (mediaType == null || !mediaType.getType().equalsIgnoreCase("image")) {
                mediaType = MediaType.IMAGE_JPEG;
            }
            return ResponseEntity.ok()
                    .contentType(mediaType)
                    .cacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic())
                    .body(body);
        } catch (ResponseStatusException e) {
            throw e;
        } catch (RestClientException e) {
            log.debug("Sky-Map cutout failed for {}: {}", url, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_unavailable");
        }
    }

    /**
     * Proxies Sky Window HTML and rewrites {@code http://*.sky-map.org} to HTTPS.
     * Their viewer hardcodes HTTP image servers; Chrome would otherwise log mixed-content upgrades.
     */
    public ResponseEntity<String> skyWindow(
            String object,
            Double raHours,
            Double deDeg,
            Integer zoom,
            String survey,
            HttpServletRequest request) {
        String trimmedObject = object == null ? "" : object.trim();
        boolean haveObject = StringUtils.hasText(trimmedObject);
        if (haveObject && !SAFE_QUERY.matcher(trimmedObject).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_query");
        }
        boolean haveCoords = raHours != null && deDeg != null && isValidHoursDec(raHours, deDeg);
        if (!haveObject && !haveCoords) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "missing_target");
        }

        String resolvedSurvey = normalizeSurvey(survey);
        int z = zoom == null ? DEFAULT_WINDOW_ZOOM : Math.max(1, Math.min(18, zoom));

        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(normalizeBase(imgcutBase) + "/skywindow");
        // Coordinates win: a name lookup like "Phecda" often misses and Sky-Map
        // falls back to RA 12h / Dec 0°.
        if (haveCoords) {
            builder.queryParam("ra", formatCoord(clampRaHours(raHours)));
            builder.queryParam("de", formatCoord(clampDec(deDeg)));
        } else {
            builder.queryParam("object", trimmedObject);
        }
        String url = builder
                .queryParam("zoom", z)
                .queryParam("img_source", resolvedSurvey)
                .build()
                .encode()
                .toUriString();

        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
        headers.set(HttpHeaders.ACCEPT, "text/html,application/xhtml+xml,*/*");

        try {
            ResponseEntity<byte[]> upstream = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
            byte[] raw = upstream.getBody();
            if (raw == null || raw.length < 64 || raw.length > MAX_SKYWINDOW_BYTES) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_invalid");
            }
            String html = new String(raw, StandardCharsets.UTF_8);
            if (!looksLikeSkyWindowHtml(html)) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_invalid");
            }
            MediaType htmlType = new MediaType("text", "html", StandardCharsets.UTF_8);
            return ResponseEntity.ok()
                    .contentType(htmlType)
                    .cacheControl(CacheControl.maxAge(10, TimeUnit.MINUTES).cachePublic())
                    .body(rewriteSkyWindowHtml(html, publicUpstreamBase(request),
                            haveCoords ? raHours : null, haveCoords ? deDeg : null, z));
        } catch (ResponseStatusException e) {
            throw e;
        } catch (RestClientException e) {
            log.debug("Sky-Map skywindow failed for {}: {}", url, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_unavailable");
        }
    }

    /**
     * Forwards Sky Window tile/label requests to Sky-Map.org (same-origin for the iframe).
     */
    public ResponseEntity<byte[]> upstream(String path, String queryString) {
        if (path == null || !UPSTREAM_PATH.matcher(path).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_path");
        }
        if (queryString != null && queryString.length() > MAX_UPSTREAM_QUERY) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "query_too_long");
        }
        String url = normalizeBase(imgcutBase) + "/" + path.toLowerCase(Locale.ROOT);
        if (StringUtils.hasText(queryString)) {
            url += "?" + queryString;
        }

        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
        boolean labels = "areas".equalsIgnoreCase(path);
        if (labels) {
            headers.set(HttpHeaders.ACCEPT, "text/xml,application/xml;q=0.9,*/*;q=0.1");
            headers.set(HttpHeaders.CONTENT_TYPE, "text/xml;charset=UTF-8");
        } else {
            headers.set(HttpHeaders.ACCEPT, "image/jpeg,image/png,image/gif,*/*");
        }

        try {
            ResponseEntity<byte[]> upstream = restTemplate.exchange(
                    URI.create(url), HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
            byte[] body = upstream.getBody();
            if (body == null || body.length < 8) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_invalid");
            }
            MediaType mediaType;
            if (labels) {
                mediaType = new MediaType("text", "xml", StandardCharsets.UTF_8);
            } else {
                mediaType = upstream.getHeaders().getContentType();
                if (mediaType == null) {
                    mediaType = looksLikeImage(body) ? MediaType.IMAGE_JPEG : MediaType.APPLICATION_OCTET_STREAM;
                }
            }
            var response = ResponseEntity.ok().contentType(mediaType);
            if ("imgcut".equalsIgnoreCase(path)) {
                response = response.cacheControl(CacheControl.maxAge(1, TimeUnit.DAYS).cachePublic());
            } else {
                response = response.cacheControl(CacheControl.noStore());
            }
            return response.body(body);
        } catch (ResponseStatusException e) {
            throw e;
        } catch (IllegalArgumentException | RestClientException e) {
            log.debug("Sky-Map upstream {} failed: {}", path, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_unavailable");
        }
    }

    private SkyObject searchObject(String query) {
        String url = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(searchBase) + "/search")
                .queryParam("star", query)
                .build()
                .encode()
                .toUriString();
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
        headers.set(HttpHeaders.ACCEPT, "application/xml,text/xml,*/*");
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            String xml = response.getBody();
            if (!StringUtils.hasText(xml)) {
                return null;
            }
            return parseSearchXml(xml);
        } catch (RestClientException e) {
            log.debug("Sky-Map search failed for {}: {}", query, e.getMessage());
            return null;
        }
    }

    private SkyObject parseSearchXml(String xml) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setExpandEntityReferences(false);
            Document doc = factory.newDocumentBuilder()
                    .parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
            Element root = doc.getDocumentElement();
            if (root == null) {
                return null;
            }
            String status = textOf(root, "status");
            if (status != null && !"0".equals(status.trim())) {
                return null;
            }
            NodeList objects = root.getElementsByTagName("object");
            if (objects.getLength() == 0) {
                return null;
            }
            Element object = (Element) objects.item(0);
            Double raHours = parseDouble(textOf(object, "ra"));
            Double deDeg = parseDouble(textOf(object, "de"));
            if (raHours == null || deDeg == null) {
                return null;
            }
            return new SkyObject(
                    firstNonBlank(textOf(object, "name"), textOf(object, "catId")),
                    textOf(object, "catId"),
                    textOf(object, "type"),
                    textOf(object, "constellation"),
                    clampRaHours(raHours),
                    clampDec(deDeg),
                    parseDouble(textOf(object, "mag")),
                    parseDouble(textOf(object, "radius"))
            );
        } catch (Exception e) {
            log.debug("Sky-Map XML parse failed: {}", e.getMessage());
            return null;
        }
    }

    private String buildAtlasUrl(String objectName, double raHours, double deDeg, double angle, String survey) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(normalizeBase(atlasBase) + "/");
        if (StringUtils.hasText(objectName)) {
            builder.queryParam("object", objectName);
        }
        return builder
                .queryParam("ra", formatCoord(raHours))
                .queryParam("de", formatCoord(deDeg))
                .queryParam("img_source", survey)
                .queryParam("zoom", atlasZoom(angle))
                .queryParam("show_box", 1)
                .build()
                .encode()
                .toUriString();
    }

    private String buildEmbedUrl(String objectName, double raHours, double deDeg, double angle, String survey) {
        return UriComponentsBuilder.fromPath("external/skymap/skywindow")
                .queryParam("ra", formatCoord(raHours))
                .queryParam("de", formatCoord(deDeg))
                .queryParam("zoom", DEFAULT_WINDOW_ZOOM)
                .queryParam("img_source", survey)
                .build()
                .encode()
                .toUriString();
    }

    private String rewriteSkyWindowHtml(String html, String proxyBase, Double raHours, Double deDeg, int zoom) {
        String proxy = proxyBase.endsWith("/") ? proxyBase.substring(0, proxyBase.length() - 1) : proxyBase;
        String withoutAnalytics = GTAG_BLOCK.matcher(html).replaceAll("");
        String httpsHtml = HTTP_SKYMAP_HOST.matcher(withoutAnalytics).replaceAll("https://$1");
        httpsHtml = SKYMAP_TILE_SERVER.matcher(httpsHtml).replaceAll(Matcher.quoteReplacement(proxy));
        httpsHtml = httpsHtml.replace("var base_url='';", "var base_url='" + jsString(proxy) + "/';");
        int slider = Math.max(1, Math.min(18, 18 - zoom));
        httpsHtml = patchJsNumber(httpsHtml, "cur_value", slider);
        if (raHours != null && deDeg != null) {
            double ra = clampRaHours(raHours);
            double de = clampDec(deDeg);
            httpsHtml = patchJsNumber(httpsHtml, "initRA", ra);
            httpsHtml = patchJsNumber(httpsHtml, "initDE", de);
            httpsHtml = patchJsNumber(httpsHtml, "boxRA", ra);
            httpsHtml = patchJsNumber(httpsHtml, "boxDE", de);
        }
        String inject = "<base href=\"" + normalizeBase(imgcutBase) + "/\">"
                + "<style>#img_button_max{display:none!important}</style>"
                + "<script>(function(){var p='" + jsString(proxy) + "';"
                + "function rw(u){return typeof u==='string'"
                + "?u.replace(/^https?:\\/\\/(?:[\\w-]+\\.)?(?:sky-map\\.org|wikisky\\.org)(?::\\d+)?(?=\\/|$)/i,p):u}"
                + "var o=XMLHttpRequest.prototype.open;"
                + "XMLHttpRequest.prototype.open=function(m,u){arguments[1]=rw(u);return o.apply(this,arguments)};"
                + "})();</script>";
        int headAt = indexOfIgnoreCase(httpsHtml, "<head>");
        if (headAt >= 0) {
            int insertAt = headAt + 6;
            return httpsHtml.substring(0, insertAt) + inject + httpsHtml.substring(insertAt);
        }
        return inject + httpsHtml;
    }

    private static String publicUpstreamBase(HttpServletRequest request) {
        return ServletUriComponentsBuilder.fromRequest(request)
                .replacePath(request.getContextPath() + "/api/external/skymap/upstream")
                .replaceQuery(null)
                .fragment(null)
                .build()
                .toUriString();
    }

    private static String patchJsNumber(String html, String varName, double value) {
        Pattern pattern = Pattern.compile("var " + Pattern.quote(varName) + "=[^;]+;");
        return pattern.matcher(html).replaceAll("var " + varName + "=" + formatCoord(value) + ";");
    }

    private static String jsString(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\\", "\\\\").replace("'", "\\'").replace("<", "\\u003c");
    }

    private static boolean looksLikeSkyWindowHtml(String html) {
        String lower = html.toLowerCase(Locale.ROOT);
        return lower.contains("<html") && (lower.contains("activeimgservers") || lower.contains("sky window"));
    }

    private static int indexOfIgnoreCase(String haystack, String needle) {
        return haystack.toLowerCase(Locale.ROOT).indexOf(needle.toLowerCase(Locale.ROOT));
    }

    private static int atlasZoom(double angleDeg) {
        if (angleDeg >= 20) {
            return 4;
        }
        if (angleDeg >= 8) {
            return 6;
        }
        if (angleDeg >= 2.5) {
            return 8;
        }
        if (angleDeg >= 0.8) {
            return 10;
        }
        return 12;
    }

    private static String normalizeSurvey(String survey) {
        if (!StringUtils.hasText(survey)) {
            return "DSS2";
        }
        String upper = survey.trim().toUpperCase(Locale.ROOT);
        if (!SURVEYS.contains(upper)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_survey");
        }
        return upper;
    }

    private static boolean isValidRaDe(double ra, double de, String raUnit) {
        if (de < -90.0 || de > 90.0) {
            return false;
        }
        if (isHoursUnit(raUnit)) {
            return ra >= 0.0 && ra <= 24.0;
        }
        return ra >= 0.0 && ra <= 360.0;
    }

    private static boolean isValidHoursDec(double raHours, double deDeg) {
        return raHours >= 0.0 && raHours <= 24.0 && deDeg >= -90.0 && deDeg <= 90.0;
    }

    private static double toRaHours(double ra, String raUnit) {
        if (isHoursUnit(raUnit)) {
            return clampRaHours(ra);
        }
        return clampRaHours(ra / 15.0);
    }

    private static boolean isHoursUnit(String raUnit) {
        if (!StringUtils.hasText(raUnit)) {
            return true;
        }
        String unit = raUnit.trim().toLowerCase(Locale.ROOT);
        return "hour".equals(unit) || "hours".equals(unit) || "h".equals(unit);
    }

    private static int clampSize(Integer size) {
        int value = size == null ? DEFAULT_SIZE : size;
        return Math.max(MIN_SIZE, Math.min(MAX_SIZE, value));
    }

    private static double clampAngle(double angle) {
        return Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, angle));
    }

    private static double clampRaHours(double raHours) {
        double wrapped = raHours % 24.0;
        if (wrapped < 0) {
            wrapped += 24.0;
        }
        return wrapped;
    }

    private static double clampDec(double de) {
        return Math.max(-90.0, Math.min(90.0, de));
    }

    private static String formatCoord(double value) {
        return String.format(Locale.ROOT, "%.6f", value);
    }

    private static String normalizeBase(String base) {
        if (base == null) {
            return "";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static String textOf(Element parent, String tag) {
        NodeList nodes = parent.getElementsByTagName(tag);
        if (nodes.getLength() == 0) {
            return null;
        }
        String text = nodes.item(0).getTextContent();
        return StringUtils.hasText(text) ? text.trim() : null;
    }

    private static Double parseDouble(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        try {
            return Double.parseDouble(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String value : values) {
            if (StringUtils.hasText(value)) {
                return value.trim();
            }
        }
        return null;
    }

    private static boolean looksLikeImage(byte[] body) {
        // JPEG SOI, PNG signature, or GIF header.
        return (body[0] == (byte) 0xFF && body[1] == (byte) 0xD8)
                || (body[0] == (byte) 0x89 && body[1] == 0x50 && body[2] == 0x4E && body[3] == 0x47)
                || (body[0] == 'G' && body[1] == 'I' && body[2] == 'F');
    }

    private record SkyObject(
            String name,
            String catalogId,
            String type,
            String constellation,
            double raHours,
            double deDeg,
            Double magnitude,
            Double radiusDeg
    ) {}
}
