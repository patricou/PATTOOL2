package com.pat.controller;

import com.pat.controller.dto.CachedStockQuoteDto;
import com.pat.controller.dto.TwelveDataQuoteDto;
import com.pat.controller.dto.TwelveDataSymbolDto;
import com.pat.controller.dto.TwelveDataSymbolSearchDto;
import com.pat.controller.dto.TwelveDataTimeSeriesDto;
import com.pat.service.TwelveDataProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Proxy des cotations boursières Twelve Data pour l'UI PatTool.
 * <p>
 * Endpoints :
 * <ul>
 *   <li>{@code GET /api/external/stock/symbols?country=United States} — univers filtrable</li>
 *   <li>{@code GET /api/external/stock/search?q=airbus} — recherche ticker par nom (autocomplete)</li>
 *   <li>{@code GET /api/external/stock/quote?symbol=AAPL} — cotation temps réel</li>
 *   <li>{@code GET /api/external/stock/quote/batch?symbols=AAPL,MSFT} — cotations batch</li>
 *   <li>{@code GET /api/external/stock/quote/cached} — cotations du cache (aucun appel upstream)</li>
 *   <li>{@code GET /api/external/stock/timeseries?symbol=AAPL&interval=1day&outputsize=30} — série historique</li>
 * </ul>
 * <p>
 * Validation stricte côté serveur pour ne pas propager n'importe quoi à
 * l'API upstream :
 * <ul>
 *   <li>Symbole : lettres / chiffres / {@code . - /} — 1 à 16 caractères.</li>
 *   <li>Intervalle : whitelist Twelve Data ({@code 1min, 5min, 15min, 30min, 45min, 1h, 2h, 4h, 1day, 1week, 1month}).</li>
 *   <li>outputsize : 1 à 5000.</li>
 *   <li>Batch : au maximum {@link #MAX_BATCH_SYMBOLS} symboles.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/stock")
public class StockRestController {

    private static final Pattern SYMBOL = Pattern.compile("^[A-Za-z0-9.\\-/]{1,16}$");
    private static final Set<String> ALLOWED_INTERVALS = new HashSet<>(Arrays.asList(
            "1min", "5min", "15min", "30min", "45min",
            "1h", "2h", "4h",
            "1day", "1week", "1month"
    ));
    private static final int MAX_BATCH_SYMBOLS = 20;
    private static final int MIN_OUTPUTSIZE = 1;
    private static final int MAX_OUTPUTSIZE = 5000;

    /** Longueur mini de la requête de recherche pour éviter de "brûler" du quota. */
    private static final int MIN_SEARCH_LEN = 2;
    private static final int MAX_SEARCH_LEN = 64;
    private static final int DEFAULT_SEARCH_OUTPUTSIZE = 20;
    private static final int MAX_SEARCH_OUTPUTSIZE = 50;

    @Autowired
    private TwelveDataProxyService twelveDataProxyService;

    @GetMapping("/symbols")
    public ResponseEntity<List<TwelveDataSymbolDto>> symbols(
            @RequestParam(required = false) String country) {
        List<TwelveDataSymbolDto> list = twelveDataProxyService.fetchSymbols(country);
        return ResponseEntity.ok(list);
    }

    /**
     * Recherche plein-texte (ticker ou nom d'entreprise) pour l'autocomplete.
     * Ex. {@code /search?q=airbus} → Airbus SE (AIR — Euronext Paris), etc.
     * <p>
     * Bornes :
     * <ul>
     *   <li>{@code q} : 2–64 caractères (requêtes plus courtes → 400 pour éviter
     *       de vider le quota avec une lettre unique).</li>
     *   <li>{@code size} : 1–50 (défaut 20).</li>
     * </ul>
     */
    @GetMapping("/search")
    public ResponseEntity<List<TwelveDataSymbolSearchDto>> search(
            @RequestParam("q") String q,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_SEARCH_OUTPUTSIZE) int size) {
        if (!StringUtils.hasText(q)) {
            return ResponseEntity.badRequest().build();
        }
        String trimmed = q.trim();
        if (trimmed.length() < MIN_SEARCH_LEN || trimmed.length() > MAX_SEARCH_LEN) {
            return ResponseEntity.badRequest().build();
        }
        int bounded = Math.max(1, Math.min(MAX_SEARCH_OUTPUTSIZE, size));
        List<TwelveDataSymbolSearchDto> list = twelveDataProxyService.searchSymbols(trimmed, bounded);
        return ResponseEntity.ok(list);
    }

    /**
     * Cotation ponctuelle. <b>Toujours 200 OK</b> dès que l'appel réseau a
     * abouti : si Twelve Data a renvoyé un refus applicatif (symbole hors
     * plan, quota, etc.), le DTO contient {@code status="error"} + {@code
     * message} + {@code code} et le front se charge d'afficher une alerte.
     * Ce choix évite que le navigateur, un {@code HttpInterceptor} ou le
     * router Angular n'interprètent un 4xx/5xx comme une erreur réseau
     * "dure" et ne déclenchent une redirection (ex. retour à la route par
     * défaut {@code '/'} puis {@code '/photos'}).
     */
    @GetMapping("/quote")
    public ResponseEntity<TwelveDataQuoteDto> quote(@RequestParam String symbol) {
        if (!isValidSymbol(symbol)) {
            return ResponseEntity.badRequest().build();
        }
        TwelveDataQuoteDto dto = twelveDataProxyService.fetchQuote(symbol);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        if (!isUpstreamError(dto)) {
            // Tag the cache entry with the caller's initials so the global
            // ticker can surface "who last looked it up". Anonymous callers
            // are ignored. We purposely skip this on error DTOs so Twelve
            // Data-rejected symbols never appear in the ticker.
            currentUserInitials().ifPresent(ini ->
                    twelveDataProxyService.recordLoader(symbol, ini));
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/quote/batch")
    public ResponseEntity<Map<String, TwelveDataQuoteDto>> batchQuote(
            @RequestParam String symbols) {
        Set<String> set = parseSymbols(symbols);
        if (set == null) {
            return ResponseEntity.badRequest().build();
        }
        if (set.isEmpty()) {
            return ResponseEntity.ok(Collections.emptyMap());
        }
        Map<String, TwelveDataQuoteDto> result = twelveDataProxyService.fetchBatchQuote(set);

        // Record the caller as a loader for every symbol we actually got a
        // valid quote for (don't credit them for symbols Twelve Data rejected).
        currentUserInitials().ifPresent(ini ->
                result.forEach((sym, q) -> {
                    if (!isUpstreamError(q)) {
                        twelveDataProxyService.recordLoader(sym, ini);
                    }
                }));
        return ResponseEntity.ok(result);
    }

    /**
     * Renvoie uniquement ce qui est déjà dans le cache, <b>sans appeler Twelve Data</b>.
     * <p>
     * Sert à alimenter le ticker global : aucune consommation de quota, la vue
     * affiche ce que les utilisateurs ont consulté récemment (chaque /quote peuple
     * le cache, qui est ici ré-exposé, avec les initiales des derniers loaders).
     */
    @GetMapping("/quote/cached")
    public ResponseEntity<Map<String, CachedStockQuoteDto>> cachedQuotes() {
        return ResponseEntity.ok(twelveDataProxyService.getCachedQuotes());
    }

    /**
     * Purge immédiate du cache qui alimente le ticker (cotations, séries
     * historiques, historique des loaders et erreurs upstream mémorisées).
     * Exposé pour le bouton « Clear ticker cache » de la page Stock Exchange.
     * <p>
     * Les caches statiques ({@code /symbols}, {@code /search}) sont
     * <b>volontairement</b> conservés : les vider ne gagne rien côté UX et
     * forcerait à re-dépenser des crédits Twelve Data pour les reconstruire.
     */
    @DeleteMapping("/quote/cached")
    public ResponseEntity<Map<String, Object>> clearCachedQuotes() {
        int removed = twelveDataProxyService.clearQuoteCache();
        return ResponseEntity.ok(Map.of("removed", removed));
    }

    @GetMapping("/timeseries")
    public ResponseEntity<TwelveDataTimeSeriesDto> timeseries(
            @RequestParam String symbol,
            @RequestParam(required = false, defaultValue = "1day") String interval,
            @RequestParam(required = false, defaultValue = "30") int outputsize) {
        if (!isValidSymbol(symbol)) {
            return ResponseEntity.badRequest().build();
        }
        if (!ALLOWED_INTERVALS.contains(interval)) {
            return ResponseEntity.badRequest().build();
        }
        if (outputsize < MIN_OUTPUTSIZE || outputsize > MAX_OUTPUTSIZE) {
            return ResponseEntity.badRequest().build();
        }
        TwelveDataTimeSeriesDto dto = twelveDataProxyService.fetchTimeSeries(symbol, interval, outputsize);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    // ----------- helpers -----------

    private static boolean isValidSymbol(String code) {
        return StringUtils.hasText(code) && SYMBOL.matcher(code.trim()).matches();
    }

    /** Twelve Data signale une erreur applicative via {@code status="error"}. */
    private static boolean isUpstreamError(TwelveDataQuoteDto dto) {
        return dto != null && "error".equalsIgnoreCase(dto.getStatus());
    }

    /**
     * Compute 1-2 letter initials for the currently authenticated Keycloak user.
     * <p>
     * Falls back from {@code given_name + family_name} → {@code name} (split
     * on whitespace) → first letter of {@code preferred_username}. Returns
     * {@link Optional#empty()} when the request is anonymous (which is the
     * common case here since {@code /api/external/stock/**} is {@code permitAll}),
     * so no loader entry is recorded.
     */
    private static Optional<String> currentUserInitials() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated()) return Optional.empty();
        if (!(auth.getPrincipal() instanceof Jwt jwt)) return Optional.empty();

        String given = jwt.getClaimAsString("given_name");
        String family = jwt.getClaimAsString("family_name");
        if (StringUtils.hasText(given) && StringUtils.hasText(family)) {
            return Optional.of(("" + given.charAt(0) + family.charAt(0)).toUpperCase());
        }
        String name = jwt.getClaimAsString("name");
        if (StringUtils.hasText(name)) {
            String[] parts = name.trim().split("\\s+");
            if (parts.length >= 2) {
                return Optional.of(("" + parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase());
            }
            return Optional.of(String.valueOf(parts[0].charAt(0)).toUpperCase());
        }
        String user = jwt.getClaimAsString("preferred_username");
        if (StringUtils.hasText(user)) {
            return Optional.of(String.valueOf(user.charAt(0)).toUpperCase());
        }
        return Optional.empty();
    }

    /**
     * Parse la chaîne {@code symbols} (ex. "AAPL,MSFT,GOOGL").
     * Renvoie {@code null} si un symbole est invalide (400),
     * un set vide si la chaîne est vide.
     */
    private static Set<String> parseSymbols(String symbols) {
        if (!StringUtils.hasText(symbols)) {
            return Collections.emptySet();
        }
        String[] parts = symbols.split(",");
        if (parts.length > MAX_BATCH_SYMBOLS) {
            return null;
        }
        Set<String> out = new LinkedHashSet<>();
        for (String p : parts) {
            if (!isValidSymbol(p)) return null;
            out.add(p.trim().toUpperCase());
        }
        return out;
    }
}
