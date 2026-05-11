package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Optional;

/**
 * Borne inclusive des tirages EuroMillions pour le JSON assistant : préfère la valeur stockée Mongo
 * ({@link AppParameter}, clé identique au nom de propriété Spring) si elle existe et est une date ISO
 * valide ; sinon utilise {@code euromillions.ai.min-draw-date} dans les properties.
 */
@Service
public class EuromillionsAiSettingsService {

    private static final Logger log = LoggerFactory.getLogger(EuromillionsAiSettingsService.class);

    /** Même chaîne que la clé dans {@code application.properties} pour cohérence et imports manuels. */
    public static final String PARAM_KEY_EUROM_AI_MIN_DRAW_DATE = "euromillions.ai.min-draw-date";

    private static final String EUROM_AI_MIN_DRAW_DATE_DEFAULT = "2020-01-01";

    private static final String PARAM_DESCRIPTION =
            "Inclusive lower bound (ISO yyyy-MM-dd) for draws included in assistant JSON pat-eurom-ai-v2 (sinceInclusive); overrides application.properties.";

    private final AppParameterService appParameterService;
    private final String propertyFallbackRaw;

    public EuromillionsAiSettingsService(
            AppParameterService appParameterService,
            @Value("${euromillions.ai.min-draw-date:2020-01-01}") String euromillionsAiMinDrawDateRaw) {
        this.appParameterService = appParameterService;
        this.propertyFallbackRaw = euromillionsAiMinDrawDateRaw == null ? "" : euromillionsAiMinDrawDateRaw.trim();
    }

    /** Date effective et indicateur si elle provient d’un {@link AppParameter} valide dans MongoDB. */
    public EffectiveMinDrawDate effectiveMinDrawDate() {
        Optional<String> dbRaw =
                appParameterService.find(PARAM_KEY_EUROM_AI_MIN_DRAW_DATE).map(AppParameter::getParamValue);
        if (dbRaw.isPresent()) {
            String trimmed = dbRaw.get().trim();
            if (!trimmed.isEmpty()) {
                try {
                    String iso = LocalDate.parse(trimmed).toString();
                    return new EffectiveMinDrawDate(iso, true);
                } catch (DateTimeParseException e) {
                    log.warn("Mongo appParameters '{}' has invalid ISO date '{}', falling back to properties", PARAM_KEY_EUROM_AI_MIN_DRAW_DATE, trimmed);
                }
            }
        }
        return new EffectiveMinDrawDate(normalizeEuromAiMinDrawDateIso(propertyFallbackRaw), false);
    }

    /**
     * Enregistre la borne inclusive en Mongo ({@link #PARAM_KEY_EUROM_AI_MIN_DRAW_DATE}).
     *
     * @throws IllegalArgumentException si la valeur n’est pas une date ISO yyyy-MM-dd
     */
    public String persistMinDrawDateIso(String raw) throws IllegalArgumentException {
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("minDrawDateIso required (yyyy-MM-dd)");
        }
        String iso;
        try {
            iso = LocalDate.parse(raw.trim()).toString();
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("Date invalide (attendu yyyy-MM-dd)");
        }
        appParameterService.setString(PARAM_KEY_EUROM_AI_MIN_DRAW_DATE, iso, PARAM_DESCRIPTION);
        return iso;
    }

    public static String normalizeEuromAiMinDrawDateIso(String raw) {
        if (raw == null || raw.isBlank()) {
            return EUROM_AI_MIN_DRAW_DATE_DEFAULT;
        }
        try {
            return LocalDate.parse(raw.trim()).toString();
        } catch (DateTimeParseException e) {
            return EUROM_AI_MIN_DRAW_DATE_DEFAULT;
        }
    }

    public record EffectiveMinDrawDate(String minDrawDateIso, boolean storedInMongo) {}
}
