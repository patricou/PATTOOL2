package com.pat.service;

import com.pat.controller.dto.NagerPublicHolidayDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Traduit le libellé anglais des jours fériés Nager ({@code name}) vers la langue de l’interface PatTool,
 * via l’API publique MyMemory (cache en mémoire). Désactivable en configuration.
 */
@Service
public class HolidayUiTranslationService {

    private static final Logger log = LoggerFactory.getLogger(HolidayUiTranslationService.class);

    private final RestTemplate restTemplate;

    @Value("${app.holiday-ui-translate.enabled:true}")
    private boolean enabled;

    @Value("${app.holiday-ui-translate.cache-ttl-hours:168}")
    private long cacheTtlHours;

    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();

    public HolidayUiTranslationService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public boolean isEnabled() {
        return enabled;
    }

    /**
     * Code cible pour la paire {@code en|…} (MyMemory), ou {@code null} si pas de traduction.
     */
    public String mapPatUiLangToTarget(String rawPatUiLang) {
        if (!StringUtils.hasText(rawPatUiLang)) {
            return null;
        }
        String s = rawPatUiLang.trim().toLowerCase(Locale.ROOT);
        if (s.equals("en") || s.startsWith("en-")) {
            return "en";
        }
        if ("cn".equals(s) || s.startsWith("zh")) {
            return "zh-CN";
        }
        if ("jp".equals(s) || s.startsWith("ja")) {
            return "ja";
        }
        if ("in".equals(s) || s.startsWith("hi")) {
            return "hi";
        }
        if (s.startsWith("he") || "iw".equals(s)) {
            return "he";
        }
        if (s.length() >= 2) {
            return s.substring(0, 2);
        }
        return null;
    }

    /**
     * Renseigne {@link NagerPublicHolidayDto#setTranslatedName(String)} à partir du champ anglais {@code name}.
     */
    public void applyTranslations(List<NagerPublicHolidayDto> holidays, String rawPatUiLang) {
        if (!enabled || holidays == null || holidays.isEmpty()) {
            return;
        }
        String target = mapPatUiLangToTarget(rawPatUiLang);
        if (target == null || "en".equalsIgnoreCase(target)) {
            return;
        }
        for (NagerPublicHolidayDto h : holidays) {
            String en = h.getName();
            if (!StringUtils.hasText(en)) {
                continue;
            }
            String translated = translateEnglishTo(en.trim(), target);
            if (StringUtils.hasText(translated)) {
                h.setTranslatedName(translated);
            }
        }
    }

    private String translateEnglishTo(String englishText, String myMemoryTarget) {
        String cacheKey = myMemoryTarget + "\u0000" + englishText;
        long ttlMillis = Math.max(1, cacheTtlHours) * 60 * 60 * 1000;
        CacheEntry hit = cache.get(cacheKey);
        if (hit != null && !hit.isExpired(ttlMillis)) {
            return hit.value;
        }

        try {
            URI uri = UriComponentsBuilder
                    .fromHttpUrl("https://api.mymemory.translated.net/get")
                    .queryParam("q", englishText)
                    .queryParam("langpair", "en|" + myMemoryTarget)
                    .encode()
                    .build()
                    .toUri();

            @SuppressWarnings("unchecked")
            Map<String, Object> body = restTemplate.getForObject(uri, Map.class);
            if (body == null) {
                return null;
            }
            Object responseStatus = body.get("responseStatus");
            int code = 200;
            if (responseStatus instanceof Number) {
                code = ((Number) responseStatus).intValue();
            } else if (responseStatus instanceof String) {
                try {
                    code = Integer.parseInt(((String) responseStatus).trim());
                } catch (NumberFormatException ignored) {
                    code = 200;
                }
            }
            if (code != 200) {
                log.debug("MyMemory non-200 for holiday name: status={} body={}", responseStatus, body);
                return null;
            }
            Object rdObj = body.get("responseData");
            if (!(rdObj instanceof Map)) {
                return null;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> rd = (Map<String, Object>) rdObj;
            Object tt = rd.get("translatedText");
            if (!(tt instanceof String)) {
                return null;
            }
            String translated = ((String) tt).trim();
            if (translated.isEmpty() || translated.equalsIgnoreCase(englishText)) {
                return null;
            }
            cache.put(cacheKey, new CacheEntry(translated));
            return translated;
        } catch (Exception e) {
            log.debug("Holiday name translation failed (en -> {}): {}", myMemoryTarget, e.toString());
            return null;
        }
    }

    private static final class CacheEntry {
        final String value;
        final long timestamp;

        CacheEntry(String value) {
            this.value = value;
            this.timestamp = System.currentTimeMillis();
        }

        boolean isExpired(long ttlMillis) {
            return (System.currentTimeMillis() - timestamp) > ttlMillis;
        }
    }
}
