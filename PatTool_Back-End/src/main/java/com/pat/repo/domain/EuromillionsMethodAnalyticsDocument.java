package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Instantané agrégé : cinq familles de métriques statistiques sur le périmètre assistant
 * (tirages dont la date est ≥ {@link #sinceInclusive}), persisté pour éviter de recalculer à chaque GET.
 */
@Document(collection = "euromillions_method_analytics")
public class EuromillionsMethodAnalyticsDocument {

    public static final String SINGLETON_ID = "singleton";

    @Id
    private String id = SINGLETON_ID;

    private Instant computedAt;
    private String sinceInclusive;
    private long drawCount;
    /** Identifiant méthode → métriques sérialisables (nombres, tableaux, sous-cartes). */
    private Map<String, Map<String, Object>> methods = new LinkedHashMap<>();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Instant getComputedAt() {
        return computedAt;
    }

    public void setComputedAt(Instant computedAt) {
        this.computedAt = computedAt;
    }

    public String getSinceInclusive() {
        return sinceInclusive;
    }

    public void setSinceInclusive(String sinceInclusive) {
        this.sinceInclusive = sinceInclusive;
    }

    public long getDrawCount() {
        return drawCount;
    }

    public void setDrawCount(long drawCount) {
        this.drawCount = drawCount;
    }

    public Map<String, Map<String, Object>> getMethods() {
        return methods;
    }

    public void setMethods(Map<String, Map<String, Object>> methods) {
        this.methods = methods != null ? methods : new LinkedHashMap<>();
    }
}
