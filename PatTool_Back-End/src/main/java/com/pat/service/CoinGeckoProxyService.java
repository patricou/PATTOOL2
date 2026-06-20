package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.CryptoCoinQuoteDto;
import com.pat.controller.dto.CryptoMarketChartDto;
import com.pat.controller.dto.CryptoMarketChartPointDto;
import com.pat.controller.dto.CryptoPricesDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Proxy CoinGecko pour afficher BTC, ETH et altcoins sans CORS ni clé côté navigateur.
 * <p>
 * Free tier ≈ 10–30 req/min : throttle global, cache long sur l'historique,
 * backoff 2 min après un 429, et renvoi du cache périmé si CoinGecko refuse.
 */
@Service
public class CoinGeckoProxyService {

    private static final Logger log = LoggerFactory.getLogger(CoinGeckoProxyService.class);

    private static final long TTL_PRICE_MS = 90_000;
    private static final long BACKOFF_ON_429_MS = 120_000L;
    /** Délai minimal entre deux appels upstream CoinGecko (toutes routes confondues). */
    private static final long MIN_UPSTREAM_GAP_MS = 2_000L;
    private static final int MAX_CACHE_ENTRIES = 80;

    private static final String BTC_ID = "bitcoin";
    private static final String ETH_ID = "ethereum";

    private record CoinDef(String id, String symbol, String name) {}

    private static final CoinDef BTC = new CoinDef(BTC_ID, "BTC", "Bitcoin");
    private static final CoinDef ETH = new CoinDef(ETH_ID, "ETH", "Ethereum");

    private static final List<CoinDef> ALTCOINS = List.of(
            new CoinDef("solana", "SOL", "Solana"),
            new CoinDef("ripple", "XRP", "XRP"),
            new CoinDef("cardano", "ADA", "Cardano"),
            new CoinDef("dogecoin", "DOGE", "Dogecoin"),
            new CoinDef("avalanche-2", "AVAX", "Avalanche"),
            new CoinDef("polkadot", "DOT", "Polkadot"),
            new CoinDef("chainlink", "LINK", "Chainlink"),
            new CoinDef("litecoin", "LTC", "Litecoin")
    );

    private static final Map<String, CoinDef> COINS_BY_ID = buildCoinIndex();
    private static final Set<Integer> ALLOWED_CHART_DAYS = Set.of(7, 30, 90, 365);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final ConcurrentMap<String, PriceCacheEntry> priceCache = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, ChartCacheEntry> chartCache = new ConcurrentHashMap<>();
    private final Object upstreamGate = new Object();

    private volatile long coingeckoBackoffUntilMs = 0;
    private volatile long lastUpstreamAtMs = 0;

    @Value("${app.coingecko.api-base:https://api.coingecko.com/api/v3}")
    private String apiBase;

    /** Clé CoinGecko (Demo ou Pro) — jamais exposée au front. */
    @Value("${app.coingecko.api-key:}")
    private String apiKey;

    /** {@code demo} (gratuit) ou {@code pro} (offre payante → {@code pro-api.coingecko.com}). */
    @Value("${app.coingecko.plan:demo}")
    private String apiPlan;

    public CoinGeckoProxyService(RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public CryptoPricesDto fetchPrices() {
        long now = System.currentTimeMillis();
        PriceCacheEntry entry = priceCache.get("prices");
        if (entry != null && entry.expiresAt > now) {
            return entry.value;
        }
        if (isInBackoff()) {
            if (entry != null) {
                log.debug("CoinGecko backoff — serving stale /simple/price");
                return entry.value;
            }
            return null;
        }
        waitUpstreamSlot();
        CryptoPricesDto dto = loadPricesFromApi();
        if (dto != null) {
            priceCache.put("prices", new PriceCacheEntry(dto, now + TTL_PRICE_MS));
            trimPriceCache();
            return dto;
        }
        if (entry != null) {
            log.debug("CoinGecko /simple/price failed — serving stale cache");
            return entry.value;
        }
        return null;
    }

    /**
     * Historique de cours ({@code /coins/{id}/market_chart}).
     */
    public CryptoMarketChartDto fetchMarketChart(String id, String vs, int days) {
        CoinDef def = resolveCoin(id);
        if (def == null || !isAllowedVs(vs) || !ALLOWED_CHART_DAYS.contains(days)) {
            return null;
        }
        String vsNorm = vs.trim().toLowerCase();
        String key = chartKey(def.id(), vsNorm, days);
        long now = System.currentTimeMillis();
        ChartCacheEntry entry = chartCache.get(key);

        if (entry != null && entry.expiresAt > now) {
            return copyChart(entry.value, false);
        }
        if (isInBackoff()) {
            if (entry != null) {
                log.debug("CoinGecko backoff — stale market_chart {}", key);
                return copyChart(entry.value, true);
            }
            return null;
        }

        waitUpstreamSlot();
        if (isInBackoff()) {
            if (entry != null) {
                return copyChart(entry.value, true);
            }
            return null;
        }

        CryptoMarketChartDto dto = loadChartFromApi(def, vsNorm, days);
        if (dto != null) {
            dto.setFetchedAt(Instant.now().toString());
            dto.setStale(false);
            chartCache.put(key, new ChartCacheEntry(dto, now + chartTtlMs(days)));
            trimChartCache();
            return copyChart(dto, false);
        }
        if (entry != null) {
            log.debug("CoinGecko market_chart failed — stale cache {}", key);
            return copyChart(entry.value, true);
        }
        return null;
    }

    public static boolean isAllowedCoinId(String id) {
        return id != null && !id.isBlank() && COINS_BY_ID.containsKey(id.trim().toLowerCase());
    }

    public static boolean isAllowedChartDays(int days) {
        return ALLOWED_CHART_DAYS.contains(days);
    }

    public static boolean isAllowedVsCurrency(String vs) {
        return isAllowedVs(vs);
    }

    private CryptoPricesDto loadPricesFromApi() {
        String ids = buildIdsParam();
        String url = UriComponentsBuilder
                .fromHttpUrl(effectiveApiBase() + "/simple/price")
                .queryParam("ids", ids)
                .queryParam("vs_currencies", "eur,usd")
                .queryParam("include_24hr_change", "true")
                .queryParam("include_market_cap", "true")
                .build()
                .toUriString();
        try {
            String raw = getForCoinGecko(url);
            if (raw == null || raw.isBlank()) {
                return null;
            }
            JsonNode root = objectMapper.readTree(raw);
            CryptoPricesDto out = new CryptoPricesDto();
            out.setUpdatedAt(Instant.now().toString());
            out.setBtc(toQuote(BTC.id(), BTC.symbol(), BTC.name(), root.get(BTC_ID)));
            out.setEth(toQuote(ETH.id(), ETH.symbol(), ETH.name(), root.get(ETH_ID)));
            List<CryptoCoinQuoteDto> alt = new ArrayList<>();
            for (CoinDef coinDef : ALTCOINS) {
                CryptoCoinQuoteDto q = toQuote(coinDef.id(), coinDef.symbol(), coinDef.name(), root.get(coinDef.id()));
                if (q != null && q.getPriceEur() != null) {
                    alt.add(q);
                }
            }
            out.setAltcoins(alt);
            if (out.getBtc() == null && out.getEth() == null && alt.isEmpty()) {
                return null;
            }
            return out;
        } catch (Exception e) {
            if (isRateLimited(e)) {
                markRateLimited();
                log.warn("CoinGecko /simple/price rate limited ({}): {}", url, e.toString());
            } else {
                log.warn("CoinGecko /simple/price failed ({}): {}", url, e.toString());
            }
            return null;
        }
    }

    private CryptoMarketChartDto loadChartFromApi(CoinDef def, String vs, int days) {
        String url = UriComponentsBuilder
                .fromHttpUrl(effectiveApiBase() + "/coins/" + def.id() + "/market_chart")
                .queryParam("vs_currency", vs)
                .queryParam("days", days)
                .build()
                .toUriString();
        try {
            String raw = getForCoinGecko(url);
            if (raw == null || raw.isBlank()) {
                return null;
            }
            JsonNode root = objectMapper.readTree(raw);
            JsonNode prices = root.get("prices");
            if (prices == null || !prices.isArray() || prices.isEmpty()) {
                return null;
            }
            List<CryptoMarketChartPointDto> points = new ArrayList<>();
            for (JsonNode pair : prices) {
                if (pair == null || !pair.isArray() || pair.size() < 2) {
                    continue;
                }
                long ts = pair.get(0).asLong(0L);
                Double price = readArrayDouble(pair, 1);
                if (ts <= 0 || price == null || !Double.isFinite(price)) {
                    continue;
                }
                CryptoMarketChartPointDto pt = new CryptoMarketChartPointDto();
                pt.setTimestampMs(ts);
                pt.setPrice(price);
                points.add(pt);
            }
            if (points.isEmpty()) {
                return null;
            }
            CryptoMarketChartDto out = new CryptoMarketChartDto();
            out.setId(def.id());
            out.setSymbol(def.symbol());
            out.setName(def.name());
            out.setVsCurrency(vs);
            out.setDays(days);
            out.setPoints(points);
            return out;
        } catch (Exception e) {
            if (isRateLimited(e)) {
                markRateLimited();
                log.warn("CoinGecko /market_chart rate limited ({}): {}", url, e.toString());
            } else {
                log.warn("CoinGecko /market_chart failed ({}): {}", url, e.toString());
            }
            return null;
        }
    }

    private static long chartTtlMs(int days) {
        return switch (days) {
            case 7 -> 20 * 60_000L;
            case 30 -> 60 * 60_000L;
            case 90 -> 3 * 60 * 60_000L;
            case 365 -> 12 * 60 * 60_000L;
            default -> 60 * 60_000L;
        };
    }

    private static String chartKey(String id, String vs, int days) {
        return "chart|" + id + "|" + vs + "|" + days;
    }

    private static CryptoMarketChartDto copyChart(CryptoMarketChartDto source, boolean stale) {
        CryptoMarketChartDto copy = new CryptoMarketChartDto();
        copy.setId(source.getId());
        copy.setSymbol(source.getSymbol());
        copy.setName(source.getName());
        copy.setVsCurrency(source.getVsCurrency());
        copy.setDays(source.getDays());
        copy.setPoints(new ArrayList<>(source.getPoints()));
        copy.setFetchedAt(source.getFetchedAt());
        copy.setStale(stale);
        return copy;
    }

    private boolean isInBackoff() {
        return System.currentTimeMillis() < coingeckoBackoffUntilMs;
    }

    private void markRateLimited() {
        coingeckoBackoffUntilMs = System.currentTimeMillis() + BACKOFF_ON_429_MS;
    }

    private void waitUpstreamSlot() {
        synchronized (upstreamGate) {
            long now = System.currentTimeMillis();
            long gap = hasApiKey() ? 350L : MIN_UPSTREAM_GAP_MS;
            long nextAllowed = Math.max(lastUpstreamAtMs + gap, coingeckoBackoffUntilMs);
            long waitMs = nextAllowed - now;
            if (waitMs > 0 && waitMs <= 90_000) {
                try {
                    Thread.sleep(waitMs);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
            }
            lastUpstreamAtMs = System.currentTimeMillis();
        }
    }

    private static boolean isRateLimited(Exception e) {
        if (e instanceof HttpClientErrorException.TooManyRequests) {
            return true;
        }
        if (e instanceof HttpClientErrorException ex && ex.getStatusCode().value() == 429) {
            return true;
        }
        return e.toString().contains("429");
    }

    private boolean hasApiKey() {
        return apiKey != null && !apiKey.isBlank();
    }

    private String trimmedApiKey() {
        return hasApiKey() ? apiKey.trim() : "";
    }

    private boolean isProPlan() {
        return apiPlan != null && "pro".equalsIgnoreCase(apiPlan.trim());
    }

    /** Base URL effective : Pro si plan payant + clé, sinon Demo/public. */
    private String effectiveApiBase() {
        if (hasApiKey() && isProPlan()) {
            String configured = normalizeBase(apiBase);
            if (configured.contains("pro-api.coingecko.com")) {
                return configured;
            }
            return "https://pro-api.coingecko.com/api/v3";
        }
        return normalizeBase(apiBase);
    }

    private String getForCoinGecko(String url) {
        HttpHeaders headers = new HttpHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        String key = trimmedApiKey();
        if (!key.isEmpty()) {
            if (isProPlan()) {
                headers.set("x-cg-pro-api-key", key);
            } else {
                headers.set("x-cg-demo-api-key", key);
            }
        }
        ResponseEntity<String> response = restTemplate.exchange(
                url,
                HttpMethod.GET,
                new HttpEntity<>(headers),
                String.class
        );
        return response.getBody();
    }

    private static String buildIdsParam() {
        StringBuilder sb = new StringBuilder(BTC_ID).append(',').append(ETH_ID);
        for (CoinDef def : ALTCOINS) {
            sb.append(',').append(def.id());
        }
        return sb.toString();
    }

    private static CryptoCoinQuoteDto toQuote(String id, String symbol, String name, JsonNode node) {
        if (node == null || node.isNull() || !node.isObject()) {
            return null;
        }
        Double eur = readDouble(node, "eur");
        Double usd = readDouble(node, "usd");
        if (eur == null && usd == null) {
            return null;
        }
        CryptoCoinQuoteDto dto = new CryptoCoinQuoteDto();
        dto.setId(id);
        dto.setSymbol(symbol);
        dto.setName(name);
        dto.setPriceEur(eur);
        dto.setPriceUsd(usd);
        dto.setChange24hPctEur(readDouble(node, "eur_24h_change"));
        dto.setChange24hPctUsd(readDouble(node, "usd_24h_change"));
        dto.setMarketCapEur(readDouble(node, "eur_market_cap"));
        return dto;
    }

    private static Double readDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) {
            return null;
        }
        if (v.isNumber()) {
            return v.doubleValue();
        }
        if (v.isTextual()) {
            try {
                return Double.parseDouble(v.asText());
            } catch (NumberFormatException ex) {
                return null;
            }
        }
        return null;
    }

    private static Map<String, CoinDef> buildCoinIndex() {
        Map<String, CoinDef> map = new LinkedHashMap<>();
        map.put(BTC.id(), BTC);
        map.put(ETH.id(), ETH);
        for (CoinDef def : ALTCOINS) {
            map.put(def.id(), def);
        }
        return Map.copyOf(map);
    }

    private static CoinDef resolveCoin(String id) {
        if (id == null || id.isBlank()) {
            return null;
        }
        return COINS_BY_ID.get(id.trim().toLowerCase());
    }

    private static boolean isAllowedVs(String vs) {
        if (vs == null || vs.isBlank()) {
            return false;
        }
        String v = vs.trim().toLowerCase();
        return "eur".equals(v) || "usd".equals(v);
    }

    private static Double readArrayDouble(JsonNode node, int index) {
        if (node == null || !node.isArray() || index >= node.size()) {
            return null;
        }
        JsonNode v = node.get(index);
        if (v == null || v.isNull()) {
            return null;
        }
        if (v.isNumber()) {
            return v.doubleValue();
        }
        if (v.isTextual()) {
            try {
                return Double.parseDouble(v.asText());
            } catch (NumberFormatException ex) {
                return null;
            }
        }
        return null;
    }

    private void trimPriceCache() {
        if (priceCache.size() > MAX_CACHE_ENTRIES) {
            priceCache.clear();
        }
    }

    private void trimChartCache() {
        if (chartCache.size() > MAX_CACHE_ENTRIES) {
            chartCache.clear();
        }
    }

    private static String normalizeBase(String base) {
        if (base == null || base.isBlank()) {
            return "https://api.coingecko.com/api/v3";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static final class PriceCacheEntry {
        final CryptoPricesDto value;
        final long expiresAt;

        PriceCacheEntry(CryptoPricesDto value, long expiresAt) {
            this.value = value;
            this.expiresAt = expiresAt;
        }
    }

    private static final class ChartCacheEntry {
        final CryptoMarketChartDto value;
        final long expiresAt;

        ChartCacheEntry(CryptoMarketChartDto value, long expiresAt) {
            this.value = value;
            this.expiresAt = expiresAt;
        }
    }
}
