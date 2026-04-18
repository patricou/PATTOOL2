package com.pat.controller;

import com.pat.controller.dto.FrankfurterRatesDto;
import com.pat.controller.dto.FrankfurterTimeseriesDto;
import com.pat.service.FrankfurterProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Proxy des taux de change Frankfurter (BCE) pour l'UI PatTool.
 * <p>
 * Endpoints :
 * <ul>
 *   <li>{@code GET /api/external/currency/currencies} — devises supportées</li>
 *   <li>{@code GET /api/external/currency/latest?base=EUR&symbols=USD,GBP} — taux du jour</li>
 *   <li>{@code GET /api/external/currency/historical?date=2026-01-15&base=EUR&symbols=USD} — taux à une date</li>
 *   <li>{@code GET /api/external/currency/timeseries?start=2026-01-01&end=2026-01-31&base=EUR&symbols=USD,GBP}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/currency")
public class CurrencyRateRestController {

    private static final Pattern CURRENCY_CODE = Pattern.compile("^[A-Za-z]{3}$");
    private static final Pattern ISO_DATE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");
    private static final int MAX_SYMBOLS = 40;

    @Autowired
    private FrankfurterProxyService frankfurterProxyService;

    @GetMapping("/currencies")
    public ResponseEntity<Map<String, String>> currencies() {
        return ResponseEntity.ok(frankfurterProxyService.fetchCurrencies());
    }

    @GetMapping("/latest")
    public ResponseEntity<FrankfurterRatesDto> latest(
            @RequestParam(required = false) String base,
            @RequestParam(required = false) String symbols) {

        if (base != null && !isValidCurrencyCode(base)) {
            return ResponseEntity.badRequest().build();
        }
        Set<String> syms = parseSymbols(symbols);
        if (syms == null) {
            return ResponseEntity.badRequest().build();
        }
        FrankfurterRatesDto dto = frankfurterProxyService.fetchLatest(base, syms);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/historical")
    public ResponseEntity<FrankfurterRatesDto> historical(
            @RequestParam String date,
            @RequestParam(required = false) String base,
            @RequestParam(required = false) String symbols) {

        if (!isValidIsoDate(date)) {
            return ResponseEntity.badRequest().build();
        }
        if (base != null && !isValidCurrencyCode(base)) {
            return ResponseEntity.badRequest().build();
        }
        Set<String> syms = parseSymbols(symbols);
        if (syms == null) {
            return ResponseEntity.badRequest().build();
        }
        FrankfurterRatesDto dto = frankfurterProxyService.fetchHistorical(date, base, syms);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/timeseries")
    public ResponseEntity<FrankfurterTimeseriesDto> timeseries(
            @RequestParam String start,
            @RequestParam(required = false) String end,
            @RequestParam(required = false) String base,
            @RequestParam(required = false) String symbols) {

        if (!isValidIsoDate(start)) {
            return ResponseEntity.badRequest().build();
        }
        if (StringUtils.hasText(end) && !isValidIsoDate(end)) {
            return ResponseEntity.badRequest().build();
        }
        if (StringUtils.hasText(end)) {
            try {
                if (LocalDate.parse(end).isBefore(LocalDate.parse(start))) {
                    return ResponseEntity.badRequest().build();
                }
            } catch (DateTimeParseException ex) {
                return ResponseEntity.badRequest().build();
            }
        }
        if (base != null && !isValidCurrencyCode(base)) {
            return ResponseEntity.badRequest().build();
        }
        Set<String> syms = parseSymbols(symbols);
        if (syms == null) {
            return ResponseEntity.badRequest().build();
        }
        FrankfurterTimeseriesDto dto = frankfurterProxyService.fetchTimeseries(start, end, base, syms);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    private static boolean isValidCurrencyCode(String code) {
        return StringUtils.hasText(code) && CURRENCY_CODE.matcher(code.trim()).matches();
    }

    private static boolean isValidIsoDate(String date) {
        if (!StringUtils.hasText(date) || !ISO_DATE.matcher(date).matches()) {
            return false;
        }
        try {
            LocalDate.parse(date);
            return true;
        } catch (DateTimeParseException ex) {
            return false;
        }
    }

    /**
     * Parse la chaîne {@code symbols} (ex. "USD,GBP,JPY").
     * Renvoie {@code null} si une devise est invalide, un set vide si la chaîne est vide/nulle.
     */
    private static Set<String> parseSymbols(String symbols) {
        if (!StringUtils.hasText(symbols)) {
            return Collections.emptySet();
        }
        String[] parts = symbols.split(",");
        if (parts.length > MAX_SYMBOLS) {
            return null;
        }
        Set<String> out = new LinkedHashSet<>();
        for (String p : parts) {
            if (!isValidCurrencyCode(p)) {
                return null;
            }
            out.add(p.trim().toUpperCase());
        }
        return out;
    }
}
