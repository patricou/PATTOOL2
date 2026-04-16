package com.pat.service.news;

import java.util.Map;

/**
 * Abstraction for a news provider. A single implementation ({@link NewsApiService})
 * talks to newsapi.org today. Adding GNews / Mediastack later is just a matter of
 * creating another implementation and wiring it up.
 *
 * All methods return a {@code Map<String, Object>}. A successful response mirrors
 * the provider's native JSON payload; on failure the map contains an
 * {@code "error"} entry (mirroring {@code OpenWeatherService} conventions).
 */
public interface NewsProvider {

    /**
     * Top headlines, filtered by country, category and/or free text.
     *
     * @param country   ISO-3166-1 alpha-2, optional (e.g. "fr")
     * @param category  One of business, entertainment, general, health, science, sports, technology. Optional.
     * @param query     Free-text query, optional
     * @param pageSize  Page size (1..100), optional (default 20)
     * @param page      1-based page number, optional (default 1)
     */
    Map<String, Object> getTopHeadlines(String country, String category, String query, Integer pageSize, Integer page);

    /**
     * Full search across all articles indexed by the provider.
     *
     * @param query     Free-text query (required by NewsAPI /everything)
     * @param language  ISO-639-1 language code, optional
     * @param from      ISO-8601 date (YYYY-MM-DD), optional
     * @param to        ISO-8601 date (YYYY-MM-DD), optional
     * @param sortBy    publishedAt | relevancy | popularity, optional
     * @param pageSize  Page size (1..100), optional
     * @param page      1-based page number, optional
     */
    Map<String, Object> getEverything(String query, String language, String from, String to,
                                      String sortBy, Integer pageSize, Integer page);

    /**
     * Available news sources filtered by country / category / language (any may be null).
     */
    Map<String, Object> getSources(String country, String category, String language);

    /**
     * Light health-check returning a small map with status + masked key info.
     */
    Map<String, Object> getStatus();

    /**
     * Drop every cached NewsAPI response so the next call forcefully hits the
     * network. Does NOT reset the rolling-window request counter (which tracks
     * real quota consumption and must remain accurate across cache flushes).
     *
     * @return a small status map: {@code { cleared: N }}.
     */
    Map<String, Object> clearCache();
}
