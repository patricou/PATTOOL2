package com.pat.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.CachedStockQuoteDto;
import com.pat.controller.dto.TwelveDataQuoteDto;
import com.pat.controller.dto.TwelveDataSymbolDto;
import com.pat.controller.dto.TwelveDataSymbolSearchDto;
import com.pat.controller.dto.TwelveDataTimeSeriesDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.ConcurrentMap;

/**
 * Appelle l'API Twelve Data (cotations actions / ETF / indices) depuis le
 * serveur pour éviter l'exposition de la clé API au front et lisser l'URL
 * exposée au UI.
 * <p>
 * Documentation : <a href="https://twelvedata.com/docs">twelvedata.com/docs</a>.
 * Free tier : 8 req/min, 800 req/jour — ajustez les TTL si vous passez sur une offre supérieure.
 * <p>
 * Mise en cache en mémoire avec TTL distincts :
 * <ul>
 *   <li>{@code /quote} (simple et batch) : 60 s — cotations intraday</li>
 *   <li>{@code /time_series} : 30 min — séries historiques, limitées en mémoire</li>
 *   <li>{@code /stocks} : 24 h — l'univers varie peu</li>
 * </ul>
 * La taille totale du cache est bornée ({@link #MAX_ENTRIES}). En cas d'erreur
 * API (réseau ou réponse {@code "status":"error"}), on ne met rien en cache
 * pour ne pas masquer un rétablissement du service.
 */
@Service
public class TwelveDataProxyService {

    private static final Logger log = LoggerFactory.getLogger(TwelveDataProxyService.class);

    /**
     * TTL pour {@code /quote} (unitaire et batch). Aligné sur la cadence de
     * rafraîchissement du ticker front (5 min) pour éviter qu'un toggle ON/OFF
     * répété ne vide le quota Twelve Data. Les cotations intraday restent
     * suffisamment fraîches à cette granularité.
     */
    private static final Duration TTL_QUOTE = Duration.ofMinutes(5);
    private static final Duration TTL_TIMESERIES = Duration.ofMinutes(30);
    private static final Duration TTL_SYMBOLS = Duration.ofHours(24);
    /** Résultats de /symbol_search : le mapping nom -> ticker est quasi immuable. */
    private static final Duration TTL_SEARCH = Duration.ofHours(6);
    private static final int MAX_ENTRIES = 500;

    private static final String STATUS_ERROR = "error";

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ConcurrentMap<String, CacheEntry<?>> cache = new ConcurrentHashMap<>();

    /**
     * Cache des erreurs upstream (ex. « symbole Pro/Venture uniquement »).
     * Empêche de re-consommer un crédit pour un symbole dont on sait déjà
     * qu'il est refusé par le plan courant. La clé est la même que celle de
     * la valeur ({@code Q|AAPL}, {@code T|AAPL|1day|30}…).
     */
    private final ConcurrentMap<String, CacheEntry<CachedUpstreamError>> errorCache = new ConcurrentHashMap<>();

    /**
     * Historique des initiales d'utilisateurs qui ont consulté chaque symbole,
     * du plus récent (tête) au plus ancien (queue). Dédupliqué et borné à
     * {@link #MAX_LOADERS_PER_SYMBOL} entrées pour éviter toute dérive mémoire.
     */
    private static final int MAX_LOADERS_PER_SYMBOL = 5;
    private final ConcurrentMap<String, Deque<String>> loadersBySymbol = new ConcurrentHashMap<>();

    @Value("${app.twelvedata.api-base:https://api.twelvedata.com}")
    private String apiBase;

    @Value("${app.twelvedata.api-key:demo}")
    private String apiKey;

    public TwelveDataProxyService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    // ===================================================================
    // Public API
    // ===================================================================

    /**
     * Cotation unique pour un symbole (ex. {@code AAPL}).
     * <p>
     * <b>Ne jette jamais d'exception pour une erreur applicative Twelve Data.</b>
     * Si l'upstream répond {@code status=error} (symbole hors plan gratuit,
     * quota dépassé, symbole inconnu…), on renvoie le DTO tel quel avec ses
     * champs {@code status}, {@code message} et {@code code} renseignés : le
     * controller passera le tout au front en {@code 200 OK} afin que l'UI
     * puisse afficher une alerte explicite sans déclencher d'interceptor ou de
     * redirection HTTP parasite.
     * <p>
     * L'erreur est <em>aussi</em> mise en cache sous la même clé (via
     * {@link #errorCache}) pour ne pas re-facturer un crédit Twelve Data à
     * chaque rechargement du même ticker invalide pendant {@link #TTL_QUOTE}.
     *
     * @return DTO (succès ou erreur) ; {@code null} uniquement si l'appel
     *         réseau a totalement échoué (timeout, DNS…).
     */
    public TwelveDataQuoteDto fetchQuote(String symbol) {
        String key = "Q|" + symbol.toUpperCase();

        TwelveDataQuoteDto cachedError = loadCachedErrorDto(key, symbol);
        if (cachedError != null) return cachedError;

        TwelveDataQuoteDto cached = (TwelveDataQuoteDto) loadFromCache(key);
        if (cached != null) return cached;

        String url = UriComponentsBuilder.fromHttpUrl(normalizeBase(apiBase) + "/quote")
                .queryParam("symbol", symbol.toUpperCase())
                .queryParam("apikey", apiKey)
                .build().toUriString();

        TwelveDataQuoteDto dto = callForType(url, TwelveDataQuoteDto.class);
        if (dto == null) return null;
        if (STATUS_ERROR.equalsIgnoreCase(dto.getStatus())) {
            log.warn("Twelve Data /quote returned error for {} : {} (code {})",
                    symbol, dto.getMessage(), dto.getCode());
            cacheUpstreamError(key, symbol, dto.getCode(), dto.getMessage(), TTL_QUOTE);
            ensureErrorSymbol(dto, symbol);
            return dto;
        }
        putInCache(key, dto, TTL_QUOTE);
        return dto;
    }

    /**
     * Cotations batch : Twelve Data renvoie un objet {@code {"AAPL":{...},"MSFT":{...}}}
     * lorsque plusieurs symboles sont passés, sinon un {@link TwelveDataQuoteDto} direct.
     * Cette méthode normalise les deux cas.
     */
    public Map<String, TwelveDataQuoteDto> fetchBatchQuote(Set<String> symbols) {
        if (symbols == null || symbols.isEmpty()) {
            return Collections.emptyMap();
        }
        Set<String> normalized = normalize(symbols);
        String joined = String.join(",", normalized);
        String cacheKey = "B|" + joined;

        @SuppressWarnings("unchecked")
        Map<String, TwelveDataQuoteDto> cached = (Map<String, TwelveDataQuoteDto>) loadFromCache(cacheKey);
        if (cached != null) return cached;

        String url = UriComponentsBuilder.fromHttpUrl(normalizeBase(apiBase) + "/quote")
                .queryParam("symbol", joined)
                .queryParam("apikey", apiKey)
                .build().toUriString();

        try {
            String raw = restTemplate.getForObject(url, String.class);
            if (raw == null || raw.isBlank()) {
                log.warn("Twelve Data batch /quote returned empty body for {}", joined);
                return Collections.emptyMap();
            }
            Map<String, TwelveDataQuoteDto> result = parseBatchResponse(raw, normalized);
            if (result.isEmpty()) {
                // Body was parseable but yielded no entries (global error or
                // unrecognized shape). Log a hint of the raw response so the
                // quota / invalid-symbol case can be diagnosed without turning
                // on DEBUG for RestTemplate.
                log.warn("Twelve Data batch /quote yielded no entries for {}. Raw head: {}",
                        joined, snippet(raw, 240));
                return result;
            }
            putInCache(cacheKey, result, TTL_QUOTE);
            return result;
        } catch (Exception e) {
            // Typical culprits here: HTTP 429 (quota exhausted) — the free
            // tier allows 8 credits/min and /quote costs 1 credit per symbol,
            // so a batch > 8 symbols is rejected immediately.
            log.warn("Twelve Data batch /quote failed for {} ({}): {}", joined, url, e.toString());
            return Collections.emptyMap();
        }
    }

    /** Short, single-line preview of an upstream body for warning logs. */
    private static String snippet(String s, int max) {
        if (s == null) return "";
        String flat = s.replaceAll("\\s+", " ").trim();
        return flat.length() <= max ? flat : flat.substring(0, max) + "…";
    }

    /**
     * Série temporelle. {@code interval} est whitelisté par le controller
     * (ex. {@code 1min, 5min, 1h, 1day, 1week}).
     */
    public TwelveDataTimeSeriesDto fetchTimeSeries(String symbol, String interval, int outputsize) {
        String key = "T|" + symbol.toUpperCase() + "|" + interval + "|" + outputsize;

        TwelveDataTimeSeriesDto cachedError = loadCachedErrorTimeSeries(key);
        if (cachedError != null) return cachedError;

        TwelveDataTimeSeriesDto cached = (TwelveDataTimeSeriesDto) loadFromCache(key);
        if (cached != null) return cached;

        String url = UriComponentsBuilder.fromHttpUrl(normalizeBase(apiBase) + "/time_series")
                .queryParam("symbol", symbol.toUpperCase())
                .queryParam("interval", interval)
                .queryParam("outputsize", outputsize)
                .queryParam("apikey", apiKey)
                .build().toUriString();

        TwelveDataTimeSeriesDto dto = callForType(url, TwelveDataTimeSeriesDto.class);
        if (dto == null) return null;
        if (STATUS_ERROR.equalsIgnoreCase(dto.getStatus())) {
            log.warn("Twelve Data /time_series returned error for {} : {} (code {})",
                    symbol, dto.getMessage(), dto.getCode());
            cacheUpstreamError(key, symbol, dto.getCode(), dto.getMessage(), TTL_TIMESERIES);
            return dto;
        }
        putInCache(key, dto, TTL_TIMESERIES);
        return dto;
    }

    /**
     * Liste des symboles disponibles (filtrable par pays). La réponse brute de
     * Twelve Data est {@code { "data": [...], "status":"ok" }} — on ne garde
     * que le tableau {@code data}.
     */
    public List<TwelveDataSymbolDto> fetchSymbols(String country) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(normalizeBase(apiBase) + "/stocks")
                .queryParam("apikey", apiKey);
        if (country != null && !country.isBlank()) {
            builder.queryParam("country", country);
        }
        String url = builder.build().toUriString();
        String key = "S|" + (country == null ? "" : country.toLowerCase());

        @SuppressWarnings("unchecked")
        List<TwelveDataSymbolDto> cached = (List<TwelveDataSymbolDto>) loadFromCache(key);
        if (cached != null) return cached;

        try {
            String raw = restTemplate.getForObject(url, String.class);
            if (raw == null) return Collections.emptyList();
            Map<String, Object> root = objectMapper.readValue(raw, new TypeReference<Map<String, Object>>() {});
            if (STATUS_ERROR.equalsIgnoreCase(String.valueOf(root.get("status")))) {
                log.warn("Twelve Data /stocks error: {}", root.get("message"));
                return Collections.emptyList();
            }
            Object data = root.get("data");
            if (data == null) return Collections.emptyList();
            List<TwelveDataSymbolDto> list = objectMapper.convertValue(
                    data, new TypeReference<List<TwelveDataSymbolDto>>() {});
            if (list != null && !list.isEmpty()) {
                putInCache(key, list, TTL_SYMBOLS);
                return list;
            }
            return Collections.emptyList();
        } catch (Exception e) {
            log.warn("Twelve Data /stocks failed ({}): {}", url, e.toString());
            return Collections.emptyList();
        }
    }

    /**
     * Recherche plein-texte de symboles Twelve Data (ticker ou nom
     * d'entreprise, ex. {@code "airbus"} → {@code AIR} sur Euronext Paris).
     * <p>
     * Endpoint upstream : {@code /symbol_search?symbol=<query>&outputsize=<n>}.
     * La réponse est de la forme {@code { "data": [...], "status": "ok" }}.
     * On ne garde que le tableau {@code data} et on filtre les réponses
     * d'erreur (quota, paramètre invalide, etc.).
     *
     * @param query      texte saisi par l'utilisateur (nom ou ticker)
     * @param outputsize nombre maximum de résultats (borné côté controller)
     * @return liste de correspondances (jamais {@code null})
     */
    public List<TwelveDataSymbolSearchDto> searchSymbols(String query, int outputsize) {
        if (query == null || query.isBlank()) {
            return Collections.emptyList();
        }
        String normalized = query.trim();
        String cacheKey = "SS|" + outputsize + "|" + normalized.toLowerCase();

        @SuppressWarnings("unchecked")
        List<TwelveDataSymbolSearchDto> cached =
                (List<TwelveDataSymbolSearchDto>) loadFromCache(cacheKey);
        if (cached != null) return cached;

        String url = UriComponentsBuilder.fromHttpUrl(normalizeBase(apiBase) + "/symbol_search")
                .queryParam("symbol", normalized)
                .queryParam("outputsize", outputsize)
                .queryParam("apikey", apiKey)
                .build().toUriString();

        try {
            String raw = restTemplate.getForObject(url, String.class);
            if (raw == null || raw.isBlank()) return Collections.emptyList();

            Map<String, Object> root = objectMapper.readValue(raw, new TypeReference<Map<String, Object>>() {});
            if (STATUS_ERROR.equalsIgnoreCase(String.valueOf(root.get("status")))) {
                log.warn("Twelve Data /symbol_search error for '{}': {}", normalized, root.get("message"));
                return Collections.emptyList();
            }

            Object data = root.get("data");
            if (data == null) return Collections.emptyList();

            List<TwelveDataSymbolSearchDto> list = objectMapper.convertValue(
                    data, new TypeReference<List<TwelveDataSymbolSearchDto>>() {});
            if (list == null) return Collections.emptyList();

            putInCache(cacheKey, list, TTL_SEARCH);
            return list;
        } catch (Exception e) {
            log.warn("Twelve Data /symbol_search failed ({}): {}", url, e.toString());
            return Collections.emptyList();
        }
    }

    /**
     * Renvoie la photo instantanée des cotations actuellement dans le cache,
     * <b>sans jamais appeler Twelve Data</b>, enrichies des initiales des
     * utilisateurs qui les ont consultées récemment.
     * <p>
     * Utilisé par le ticker front pour afficher « ce que les utilisateurs
     * viennent de consulter » : chaque /quote servi par {@link #fetchQuote(String)}
     * peuple le cache ({@code Q|SYMBOLE}) et (si le porteur d'appel est
     * authentifié) l'historique des loaders via {@link #recordLoader}. Cette
     * méthode énumère ensuite toutes les entrées non expirées en y recollant
     * les initiales. Approche zéro quota : la vue ne consomme aucun crédit,
     * elle reflète l'activité organique des utilisateurs.
     *
     * @return map {@code SYMBOLE -> cotation enrichie} ; jamais {@code null}.
     */
    /**
     * Vide tout ce qui alimente le ticker : cotations unitaires et batch, cache
     * d'erreurs upstream et historique des loaders. Les caches {@code /symbols}
     * et {@code /search} sont <b>conservés</b> : ils ne consomment rien en
     * lecture et ré-interroger Twelve Data pour les re-remplir gâcherait du
     * quota sans bénéfice utilisateur.
     *
     * @return nombre d'entrées supprimées (informatif, pour les logs).
     */
    public int clearQuoteCache() {
        int removed = 0;
        for (Map.Entry<String, CacheEntry<?>> e : cache.entrySet()) {
            String key = e.getKey();
            if (key.startsWith("Q|") || key.startsWith("B|") || key.startsWith("T|")) {
                cache.remove(key);
                removed++;
            }
        }
        int errs = errorCache.size();
        errorCache.clear();
        int loaders = loadersBySymbol.size();
        loadersBySymbol.clear();
        log.info("clearQuoteCache: removed {} quote/timeseries entries, {} cached errors, {} loader histories",
                removed, errs, loaders);
        return removed;
    }

    public Map<String, CachedStockQuoteDto> getCachedQuotes() {
        long now = System.currentTimeMillis();
        Map<String, QuoteWithExpiry> merged = new LinkedHashMap<>();

        for (Map.Entry<String, CacheEntry<?>> e : cache.entrySet()) {
            CacheEntry<?> entry = e.getValue();
            if (entry == null || entry.expiresAt <= now) continue;

            String key = e.getKey();
            if (key.startsWith("Q|")) {
                if (entry.value instanceof TwelveDataQuoteDto dto) {
                    keepLatest(merged, extractSymbol(dto, key.substring(2)), dto, entry.expiresAt);
                }
            } else if (key.startsWith("B|")) {
                if (entry.value instanceof Map<?, ?> raw) {
                    for (Map.Entry<?, ?> re : raw.entrySet()) {
                        if (!(re.getKey() instanceof String sym)) continue;
                        if (!(re.getValue() instanceof TwelveDataQuoteDto dto)) continue;
                        keepLatest(merged, extractSymbol(dto, sym), dto, entry.expiresAt);
                    }
                }
            }
        }

        Map<String, CachedStockQuoteDto> out = new LinkedHashMap<>();
        merged.entrySet().stream()
                .sorted((a, b) -> Long.compare(b.getValue().expiresAt, a.getValue().expiresAt))
                .forEach(m -> out.put(m.getKey(), enrichWithLoaders(m.getKey(), m.getValue().dto)));
        return out;
    }

    /**
     * Enregistre qu'un utilisateur (identifié par ses initiales) vient de
     * consulter {@code symbol}. Appelé par le controller après un {@code /quote}
     * réussi, <em>seulement</em> si la requête est authentifiée. Les anonymes
     * n'apparaissent pas dans le ticker.
     * <p>
     * L'historique est bornée à {@link #MAX_LOADERS_PER_SYMBOL} initiales
     * uniques par symbole : si {@code initials} est déjà en tête, on ne fait
     * rien ; sinon on le promeut en tête, on déduplique, et on tronque la
     * queue. Thread-safe via un {@link ConcurrentLinkedDeque} par symbole et
     * une section critique courte.
     */
    public void recordLoader(String symbol, String initials) {
        if (symbol == null || symbol.isBlank()) return;
        if (initials == null || initials.isBlank()) return;
        String sym = symbol.toUpperCase();
        String who = initials.trim();

        Deque<String> deque = loadersBySymbol.computeIfAbsent(sym, k -> new ConcurrentLinkedDeque<>());
        synchronized (deque) {
            deque.remove(who);
            deque.addFirst(who);
            while (deque.size() > MAX_LOADERS_PER_SYMBOL) {
                deque.pollLast();
            }
        }
    }

    /** Enrichit une cotation avec l'historique des initiales pour ce symbole. */
    private CachedStockQuoteDto enrichWithLoaders(String symbol, TwelveDataQuoteDto source) {
        CachedStockQuoteDto copy = new CachedStockQuoteDto();
        copy.setSymbol(source.getSymbol());
        copy.setName(source.getName());
        copy.setExchange(source.getExchange());
        copy.setCurrency(source.getCurrency());
        copy.setDatetime(source.getDatetime());
        copy.setTimestamp(source.getTimestamp());
        copy.setOpen(source.getOpen());
        copy.setHigh(source.getHigh());
        copy.setLow(source.getLow());
        copy.setClose(source.getClose());
        copy.setVolume(source.getVolume());
        copy.setPreviousClose(source.getPreviousClose());
        copy.setChange(source.getChange());
        copy.setPercentChange(source.getPercentChange());
        copy.setAverageVolume(source.getAverageVolume());
        copy.setIsMarketOpen(source.getIsMarketOpen());
        copy.setStatus(source.getStatus());
        copy.setMessage(source.getMessage());
        copy.setCode(source.getCode());

        Deque<String> deque = loadersBySymbol.get(symbol);
        if (deque != null && !deque.isEmpty()) {
            List<String> snapshot;
            synchronized (deque) {
                snapshot = new ArrayList<>(deque);
            }
            if (!snapshot.isEmpty()) {
                copy.setLastLoadedBy(snapshot.get(0));
                copy.setLoadedBy(snapshot);
            }
        }
        return copy;
    }

    /** Replace the entry for {@code symbol} only if the new one is fresher. */
    private static void keepLatest(Map<String, QuoteWithExpiry> merged,
                                   String symbol,
                                   TwelveDataQuoteDto dto,
                                   long expiresAt) {
        if (symbol == null || symbol.isBlank()) return;
        String key = symbol.toUpperCase();
        QuoteWithExpiry existing = merged.get(key);
        if (existing == null || existing.expiresAt < expiresAt) {
            merged.put(key, new QuoteWithExpiry(dto, expiresAt));
        }
    }

    /** Prefer the symbol embedded in the DTO (Twelve Data's canonical form). */
    private static String extractSymbol(TwelveDataQuoteDto dto, String fallback) {
        if (dto != null && dto.getSymbol() != null && !dto.getSymbol().isBlank()) {
            return dto.getSymbol();
        }
        return fallback;
    }

    /** Vide l'intégralité du cache (outil de maintenance). */
    public void clearCache() {
        cache.clear();
    }

    // ===================================================================
    // Internals
    // ===================================================================

    /**
     * Parse la réponse batch de Twelve Data, qui change de forme selon le
     * nombre de symboles demandés :
     * <ul>
     *   <li>1 symbole : objet quote plat {@code { "symbol":"AAPL", ... }}</li>
     *   <li>N symboles : objet indexé {@code { "AAPL":{...}, "MSFT":{...} }}</li>
     * </ul>
     * On n'inclut pas les entrées en erreur ({@code "status":"error"}).
     */
    private Map<String, TwelveDataQuoteDto> parseBatchResponse(String raw, Set<String> requested) throws Exception {
        Map<String, TwelveDataQuoteDto> out = new LinkedHashMap<>();

        // Cas 1 symbole : réponse aplatie
        if (requested.size() == 1) {
            TwelveDataQuoteDto dto = objectMapper.readValue(raw, TwelveDataQuoteDto.class);
            if (dto != null && !STATUS_ERROR.equalsIgnoreCase(dto.getStatus()) && dto.getSymbol() != null) {
                out.put(dto.getSymbol().toUpperCase(), dto);
            }
            return out;
        }

        // Cas N symboles : objet indexé par symbole
        Map<String, Object> root = objectMapper.readValue(raw, new TypeReference<Map<String, Object>>() {});

        // Si le body entier est une réponse d'erreur, on renvoie une map vide
        if (STATUS_ERROR.equalsIgnoreCase(String.valueOf(root.get("status")))) {
            log.warn("Twelve Data batch /quote global error: {}", root.get("message"));
            return out;
        }

        for (String sym : requested) {
            Object entry = root.get(sym);
            if (entry == null) continue;
            TwelveDataQuoteDto dto = objectMapper.convertValue(entry, TwelveDataQuoteDto.class);
            if (dto != null && !STATUS_ERROR.equalsIgnoreCase(dto.getStatus())) {
                out.put(sym, dto);
            }
        }
        return out;
    }

    private <T> T callForType(String url, Class<T> type) {
        try {
            return restTemplate.getForObject(url, type);
        } catch (Exception e) {
            log.warn("Twelve Data call failed ({}): {}", url, e.toString());
            return null;
        }
    }

    /** Normalise un set de symboles (trim + upper, ordre d'insertion préservé). */
    private static Set<String> normalize(Set<String> symbols) {
        Map<String, Boolean> out = new LinkedHashMap<>();
        for (String s : symbols) {
            if (s == null) continue;
            String t = s.trim().toUpperCase();
            if (!t.isEmpty()) out.put(t, Boolean.TRUE);
        }
        return out.keySet();
    }

    private static String normalizeBase(String base) {
        if (base == null || base.isBlank()) {
            return "https://api.twelvedata.com";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private Object loadFromCache(String key) {
        CacheEntry<?> entry = cache.get(key);
        if (entry != null && entry.expiresAt > System.currentTimeMillis()) {
            return entry.value;
        }
        return null;
    }

    private void putInCache(String key, Object value, Duration ttl) {
        cache.put(key, new CacheEntry<>(value, System.currentTimeMillis() + ttl.toMillis()));
        if (cache.size() > MAX_ENTRIES) {
            evictOldest();
        }
    }

    private void evictOldest() {
        cache.entrySet().stream()
                .min(Map.Entry.comparingByValue((a, b) -> Long.compare(a.expiresAt, b.expiresAt)))
                .ifPresent(e -> cache.remove(e.getKey()));
    }

    /**
     * Si une erreur upstream pour ce symbole est encore fraîche, renvoie un
     * {@link TwelveDataQuoteDto} porteur de l'erreur (status/code/message)
     * pour que le controller l'envoie au front en 200 OK sans retouer à
     * Twelve Data. Renvoie {@code null} si aucune erreur n'est cachée.
     */
    private TwelveDataQuoteDto loadCachedErrorDto(String key, String symbol) {
        CachedUpstreamError err = peekCachedError(key);
        if (err == null) return null;
        TwelveDataQuoteDto dto = new TwelveDataQuoteDto();
        dto.setSymbol(symbol.toUpperCase());
        dto.setStatus(STATUS_ERROR);
        dto.setCode(err.code);
        dto.setMessage(err.message);
        return dto;
    }

    /** Same as {@link #loadCachedErrorDto(String, String)} but for time series. */
    private TwelveDataTimeSeriesDto loadCachedErrorTimeSeries(String key) {
        CachedUpstreamError err = peekCachedError(key);
        if (err == null) return null;
        TwelveDataTimeSeriesDto dto = new TwelveDataTimeSeriesDto();
        dto.setStatus(STATUS_ERROR);
        dto.setCode(err.code);
        dto.setMessage(err.message);
        return dto;
    }

    private CachedUpstreamError peekCachedError(String key) {
        CacheEntry<CachedUpstreamError> entry = errorCache.get(key);
        if (entry == null) return null;
        if (entry.expiresAt <= System.currentTimeMillis()) {
            errorCache.remove(key);
            return null;
        }
        return entry.value;
    }

    private void cacheUpstreamError(String key, String symbol, Integer code, String message, Duration ttl) {
        errorCache.put(key, new CacheEntry<>(
                new CachedUpstreamError(code, message),
                System.currentTimeMillis() + ttl.toMillis()));
    }

    /** Guarantee the symbol is present on error DTOs so the frontend can display it. */
    private static void ensureErrorSymbol(TwelveDataQuoteDto dto, String symbol) {
        if (dto.getSymbol() == null || dto.getSymbol().isBlank()) {
            dto.setSymbol(symbol.toUpperCase());
        }
    }

    private static final class CacheEntry<T> {
        final T value;
        final long expiresAt;

        CacheEntry(T value, long expiresAt) {
            this.value = value;
            this.expiresAt = expiresAt;
        }
    }

    /** Snapshot of an upstream error, used to short-circuit repeat calls. */
    private static final class CachedUpstreamError {
        final Integer code;
        final String message;

        CachedUpstreamError(Integer code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    /** Temporary holder used by {@link #getCachedQuotes()} to de-duplicate entries. */
    private static final class QuoteWithExpiry {
        final TwelveDataQuoteDto dto;
        final long expiresAt;

        QuoteWithExpiry(TwelveDataQuoteDto dto, long expiresAt) {
            this.dto = dto;
            this.expiresAt = expiresAt;
        }
    }
}
