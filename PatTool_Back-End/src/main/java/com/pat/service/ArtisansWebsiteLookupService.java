package com.pat.service;

import com.pat.config.RestTemplateConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves a likely official website for a nearby trade when OSM / SIRENE / Wikidata
 * have none. Google ranks official sites far better than laposte.fr (no public pro
 * directory anymore); DuckDuckGo HTML exposes the same open-web ranking without a key.
 */
@Service
public class ArtisansWebsiteLookupService {

    private static final Logger log = LoggerFactory.getLogger(ArtisansWebsiteLookupService.class);
    private static final String DDG_HTML = "https://html.duckduckgo.com/html/";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    private static final int MAX_HTML_BYTES = 250_000;
    private static final int MAX_CACHE = 400;
    private static final long HIT_TTL_MS = 6L * 60 * 60 * 1000;
    private static final long MISS_TTL_MS = 30L * 60 * 1000;
    private static final double MIN_SCORE = 1.45;
    private static final Pattern UDDG = Pattern.compile("uddg=([^&\"']+)");
    private static final Pattern LEGAL_FORM = Pattern.compile(
            "(?i)\\b(sarl|sasu|sas|eurl|sa|sci|snc|sarlu|gmbh|sprl)\\b");
    private static final Set<String> GENERIC_TOKENS = Set.of(
            "sarl", "sas", "sasu", "eurl", "sa", "sci", "snc", "sarlu", "gmbh", "sprl",
            "le", "la", "les", "de", "du", "des", "et", "the", "and",
            "shop", "store", "magasin", "commerce", "cafe", "bar", "pub", "hotel",
            "restaurant", "boulangerie", "patisserie", "pharmacie", "epicerie",
            "supermarche", "garage", "coiffure", "coiffeur", "fleuriste", "tabac",
            "presse", "pizzeria", "brasserie"
    );

    private final RestTemplate restTemplate;
    private final ConcurrentHashMap<String, Cached> cache = new ConcurrentHashMap<>();

    public ArtisansWebsiteLookupService(
            @Qualifier(RestTemplateConfig.ARTISANS_REST_TEMPLATE) RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public String lookup(String name, String city, String postalCode, String activity) {
        String query = searchQuery(name, city, postalCode, activity);
        if (!StringUtils.hasText(query)) {
            return "";
        }
        Cached cached = cache.get(query);
        long now = System.currentTimeMillis();
        if (cached != null && cached.until > now) {
            return cached.website;
        }
        String found = searchDuckDuckGo(query, name, city);
        cache.put(query, new Cached(found, now + (StringUtils.hasText(found) ? HIT_TTL_MS : MISS_TTL_MS)));
        if (cache.size() > MAX_CACHE) {
            cache.clear();
        }
        return found;
    }

    static String searchQuery(String name, String city, String postalCode, String activity) {
        String cleaned = LEGAL_FORM.matcher(name == null ? "" : name).replaceAll(" ");
        cleaned = cleaned.replaceAll("\\s+", " ").trim();
        if (cleaned.length() < 3) {
            return "";
        }
        StringBuilder q = new StringBuilder(cleaned);
        if (StringUtils.hasText(city)) {
            q.append(' ').append(city.trim());
        }
        if (StringUtils.hasText(postalCode)) {
            q.append(' ').append(postalCode.trim());
        }
        if (StringUtils.hasText(activity) && activity.length() <= 40
                && !cleaned.toLowerCase(Locale.ROOT).contains(activity.toLowerCase(Locale.ROOT))) {
            q.append(' ').append(activity.trim());
        }
        q.append(" site officiel");
        String out = q.toString().replaceAll("\\s+", " ").trim();
        return out.length() > 140 ? out.substring(0, 140).trim() : out;
    }

    static List<String> extractDuckDuckGoUrls(String html) {
        if (!StringUtils.hasText(html)) {
            return List.of();
        }
        Map<String, String> byHost = new LinkedHashMap<>();
        Matcher matcher = UDDG.matcher(html);
        while (matcher.find()) {
            String raw = matcher.group(1).replace("&amp;", "&");
            String decoded;
            try {
                decoded = URLDecoder.decode(raw, StandardCharsets.UTF_8);
            } catch (IllegalArgumentException ignored) {
                continue;
            }
            String href = ArtisansNearbyService.normalizeWebsite(decoded);
            if (!StringUtils.hasText(href)) {
                continue;
            }
            try {
                String host = URI.create(href).getHost();
                if (!StringUtils.hasText(host)) {
                    continue;
                }
                String key = host.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
                byHost.putIfAbsent(key, href);
            } catch (IllegalArgumentException ignored) {
                // skip
            }
        }
        return new ArrayList<>(byHost.values());
    }

    static String pickOfficialWebsite(String name, String city, List<String> urls) {
        String best = "";
        double bestScore = 0;
        int rank = 0;
        for (String url : urls) {
            rank += 1;
            double score = scoreCandidate(name, city, url, rank);
            if (score > bestScore) {
                bestScore = score;
                best = url;
            }
        }
        return bestScore >= MIN_SCORE ? best : "";
    }

    static double scoreCandidate(String name, String city, String url, int rank) {
        String href = ArtisansNearbyService.normalizeWebsite(url);
        if (!StringUtils.hasText(href)) {
            return 0;
        }
        URI uri;
        try {
            uri = URI.create(href);
        } catch (IllegalArgumentException e) {
            return 0;
        }
        String host = uri.getHost();
        if (!StringUtils.hasText(host) || ArtisansNearbyService.isJunkWebsiteHost(host)) {
            return 0;
        }
        double score = 0.35;
        if (domainLooksLikeName(host, name)) {
            score += 2.4;
        }
        if (hostLooksLocal(host)) {
            score += 0.25;
        }
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            score += 0.3;
        } else if (path.split("/").length > 4) {
            score -= 0.25;
        }
        if (StringUtils.hasText(city) && fold(host).contains(fold(city).replace(" ", ""))) {
            score += 0.35;
        }
        if (rank <= 3) {
            score += 0.2;
        }
        return score;
    }

    static boolean domainLooksLikeName(String hostname, String name) {
        String host = hostname == null ? "" : hostname.toLowerCase(Locale.ROOT).replaceFirst("^www\\.", "");
        String compactHost = fold(host.split("\\.")[0]).replaceAll("[^a-z0-9]", "");
        if (compactHost.length() < 4) {
            return false;
        }
        List<String> tokens = distinctiveTokens(name);
        if (tokens.isEmpty()) {
            return false;
        }
        String compactName = String.join("", tokens);
        if (compactHost.contains(compactName) || compactName.contains(compactHost)) {
            return true;
        }
        for (String token : tokens) {
            if (token.length() >= 4 && (compactHost.contains(token) || token.contains(compactHost))) {
                return true;
            }
        }
        return false;
    }

    private String searchDuckDuckGo(String query, String name, String city) {
        URI uri = UriComponentsBuilder.fromHttpUrl(DDG_HTML)
                .queryParam("q", query)
                .build()
                .encode()
                .toUri();
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.setAccept(List.of(MediaType.TEXT_HTML));
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), byte[].class);
            byte[] body = response.getBody();
            if (body == null || body.length == 0 || body.length > MAX_HTML_BYTES) {
                return "";
            }
            String html = new String(body, StandardCharsets.UTF_8);
            return pickOfficialWebsite(name, city, extractDuckDuckGoUrls(html));
        } catch (RestClientException e) {
            log.warn("Artisans website lookup failed: {}", e.toString());
            return "";
        }
    }

    private static boolean hostLooksLocal(String hostname) {
        String host = hostname.toLowerCase(Locale.ROOT);
        return host.endsWith(".fr") || host.endsWith(".eu") || host.endsWith(".corsica")
                || host.endsWith(".bzh") || host.endsWith(".paris");
    }

    private static List<String> distinctiveTokens(String name) {
        List<String> out = new ArrayList<>();
        for (String token : fold(name).split("[^a-z0-9]+")) {
            if (token.length() >= 3 && !GENERIC_TOKENS.contains(token)) {
                out.add(token);
            }
        }
        return out;
    }

    private static String fold(String value) {
        if (value == null) {
            return "";
        }
        return java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "")
                .toLowerCase(Locale.ROOT)
                .replace('\'', ' ')
                .trim();
    }

    private record Cached(String website, long until) {
    }
}
