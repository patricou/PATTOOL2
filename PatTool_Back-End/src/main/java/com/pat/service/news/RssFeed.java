package com.pat.service.news;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One curated (or user-added) RSS/Atom feed. {@code id} is stable for
 * defaults shipped in {@link RssFeedCatalog}; custom feeds use a hash of
 * the URL so they can be persisted in the browser without colliding.
 */
public record RssFeed(
        String id,
        String name,
        String url,
        String website,
        String category,
        String language,
        String country,
        String description
) {
    public Map<String, Object> toSourceMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("name", name);
        m.put("url", website != null && !website.isBlank() ? website : url);
        m.put("feedUrl", url);
        m.put("description", description);
        m.put("category", category);
        m.put("language", language);
        m.put("country", country);
        return m;
    }
}
