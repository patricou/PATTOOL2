package com.pat.service;

import com.pat.controller.dto.FrankfurterRatesDto;
import com.pat.controller.dto.FrankfurterTimeseriesDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Appelle l'API publique Frankfurter (taux de change BCE) depuis le serveur
 * pour éviter le CORS côté front et exposer une URL PatTool homogène.
 * <p>
 * Documentation : <a href="https://www.frankfurter.app">frankfurter.app</a>
 * <p>
 * Les réponses sont mises en cache en mémoire avec des TTL distincts :
 * <ul>
 *   <li>{@code /currencies} : 24h (la liste varie rarement)</li>
 *   <li>{@code /latest} : 30 min (la BCE publie 1x/jour vers 16h CET)</li>
 *   <li>historique &amp; timeseries : 2h (données figées, borne haute pour limiter la mémoire)</li>
 * </ul>
 * La taille totale du cache est bornée ({@link #MAX_ENTRIES}) — les entrées les plus anciennes
 * sont purgées lors d'un nettoyage déclenché au dépassement.
 */
@Service
public class FrankfurterProxyService {

    private static final Logger log = LoggerFactory.getLogger(FrankfurterProxyService.class);

    private static final Duration TTL_LATEST = Duration.ofMinutes(30);
    private static final Duration TTL_HISTORICAL = Duration.ofHours(2);
    private static final Duration TTL_CURRENCIES = Duration.ofHours(24);
    private static final int MAX_ENTRIES = 500;

    private final RestTemplate restTemplate;
    private final ConcurrentMap<String, CacheEntry<?>> cache = new ConcurrentHashMap<>();

    @Value("${app.frankfurter.api-base:https://api.frankfurter.app}")
    private String apiBase;

    public FrankfurterProxyService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    /**
     * Taux les plus récents. {@code base} et {@code symbols} optionnels (par défaut EUR et toutes devises).
     */
    public FrankfurterRatesDto fetchLatest(String base, Set<String> symbols) {
        String url = buildRatesUrl("latest", base, symbols);
        return getOrLoad("L|" + url, TTL_LATEST, () -> callForType(url, FrankfurterRatesDto.class));
    }

    /**
     * Taux à une date donnée (ISO {@code yyyy-MM-dd}).
     */
    public FrankfurterRatesDto fetchHistorical(String isoDate, String base, Set<String> symbols) {
        String url = buildRatesUrl(isoDate, base, symbols);
        return getOrLoad("H|" + url, TTL_HISTORICAL, () -> callForType(url, FrankfurterRatesDto.class));
    }

    /**
     * Liste des devises disponibles : code ISO → libellé anglais.
     */
    public Map<String, String> fetchCurrencies() {
        String url = normalizeBase(apiBase) + "/currencies";
        Map<String, String> cached = getOrLoad("C|" + url, TTL_CURRENCIES, () -> {
            try {
                @SuppressWarnings("unchecked")
                Map<String, String> m = restTemplate.getForObject(url, Map.class);
                return m;
            } catch (Exception e) {
                log.warn("Frankfurter /currencies failed ({}): {}", url, e.toString());
                return null;
            }
        });
        return cached != null ? cached : Collections.emptyMap();
    }

    /**
     * Série temporelle entre deux dates ISO (inclusives). Les week-ends / jours fériés BCE sont omis par l'API.
     */
    public FrankfurterTimeseriesDto fetchTimeseries(String startIso, String endIso, String base, Set<String> symbols) {
        String path = startIso + ".." + (endIso == null ? "" : endIso);
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(apiBase) + "/" + path);
        if (base != null && !base.isBlank()) {
            builder.queryParam("base", base.toUpperCase());
        }
        if (symbols != null && !symbols.isEmpty()) {
            builder.queryParam("symbols", String.join(",", normalize(symbols)));
        }
        String url = builder.build().toUriString();
        return getOrLoad("T|" + url, TTL_HISTORICAL, () -> callForType(url, FrankfurterTimeseriesDto.class));
    }

    /** Vide l'intégralité du cache (outil de maintenance). */
    public void clearCache() {
        cache.clear();
    }

    // ----------------- Internals -----------------

    private String buildRatesUrl(String pathSegment, String base, Set<String> symbols) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(apiBase) + "/" + pathSegment);
        if (base != null && !base.isBlank()) {
            builder.queryParam("base", base.toUpperCase());
        }
        if (symbols != null && !symbols.isEmpty()) {
            builder.queryParam("symbols", String.join(",", normalize(symbols)));
        }
        return builder.build().toUriString();
    }

    private <T> T callForType(String url, Class<T> type) {
        try {
            return restTemplate.getForObject(url, type);
        } catch (Exception e) {
            log.warn("Frankfurter call failed ({}): {}", url, e.toString());
            return null;
        }
    }

    /** Normalise un set de codes devises (trim + upper, ordre préservé). */
    private static Set<String> normalize(Set<String> symbols) {
        Map<String, Boolean> out = new LinkedHashMap<>();
        for (String s : symbols) {
            if (s == null) continue;
            String t = s.trim().toUpperCase();
            if (!t.isEmpty()) {
                out.put(t, Boolean.TRUE);
            }
        }
        return out.keySet();
    }

    private static String normalizeBase(String base) {
        if (base == null || base.isBlank()) {
            return "https://api.frankfurter.app";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    /**
     * Service un résultat depuis le cache, ou délègue au loader si absent/expiré.
     * Si le loader renvoie {@code null}, rien n'est mis en cache (on ne mémorise
     * pas les pannes pour éviter de masquer le rétablissement du service).
     */
    @SuppressWarnings("unchecked")
    private <T> T getOrLoad(String key, Duration ttl, java.util.function.Supplier<T> loader) {
        long now = System.currentTimeMillis();
        CacheEntry<?> entry = cache.get(key);
        if (entry != null && entry.expiresAt > now) {
            return (T) entry.value;
        }
        T value = loader.get();
        if (value != null) {
            cache.put(key, new CacheEntry<>(value, now + ttl.toMillis()));
            if (cache.size() > MAX_ENTRIES) {
                evictOldest();
            }
        }
        return value;
    }

    /**
     * Stratégie de purge simple au dépassement de {@link #MAX_ENTRIES} :
     * on supprime l'entrée la plus proche de l'expiration (≈ la plus ancienne).
     */
    private void evictOldest() {
        cache.entrySet().stream()
                .min(Map.Entry.comparingByValue((a, b) -> Long.compare(a.expiresAt, b.expiresAt)))
                .ifPresent(e -> cache.remove(e.getKey()));
    }

    private static final class CacheEntry<T> {
        final T value;
        final long expiresAt;

        CacheEntry(T value, long expiresAt) {
            this.value = value;
            this.expiresAt = expiresAt;
        }
    }
}
