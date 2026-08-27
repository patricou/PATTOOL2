package com.pat.service.news;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RssFeedParserTest {

    private static final RssFeed FEED = new RssFeed(
            "test", "Test Feed", "https://example.com/rss.xml",
            "https://example.com/", "general", "fr", "fr", "test");

    @Test
    void parsesRss2Item() {
        String xml = """
                <?xml version="1.0"?>
                <rss version="2.0">
                  <channel>
                    <title>Example News</title>
                    <item>
                      <title>Hello &amp; welcome</title>
                      <link>https://example.com/hello</link>
                      <description>&lt;p&gt;First paragraph&lt;/p&gt;</description>
                      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
                      <enclosure url="https://example.com/pic.jpg" type="image/jpeg"/>
                    </item>
                  </channel>
                </rss>
                """;
        List<Map<String, Object>> articles = RssFeedParser.parse(xml.getBytes(StandardCharsets.UTF_8), FEED);
        assertEquals(1, articles.size());
        Map<String, Object> a = articles.get(0);
        assertEquals("Hello & welcome", a.get("title"));
        assertEquals("https://example.com/hello", a.get("url"));
        assertEquals("First paragraph", a.get("description"));
        assertEquals("https://example.com/pic.jpg", a.get("urlToImage"));
        @SuppressWarnings("unchecked")
        Map<String, Object> source = (Map<String, Object>) a.get("source");
        assertEquals("Example News", source.get("name"));
        assertTrue(String.valueOf(a.get("publishedAt")).startsWith("2024-01-01"));
    }

    @Test
    void parsesAtomEntry() {
        String xml = """
                <?xml version="1.0"?>
                <feed xmlns="http://www.w3.org/2005/Atom">
                  <title>Atom Feed</title>
                  <entry>
                    <title>Orbit news</title>
                    <link rel="alternate" href="https://example.com/orbit"/>
                    <updated>2024-06-02T08:30:00Z</updated>
                    <summary>A short summary</summary>
                  </entry>
                </feed>
                """;
        List<Map<String, Object>> articles = RssFeedParser.parse(xml.getBytes(StandardCharsets.UTF_8), FEED);
        assertEquals(1, articles.size());
        Map<String, Object> a = articles.get(0);
        assertEquals("Orbit news", a.get("title"));
        assertEquals("https://example.com/orbit", a.get("url"));
        assertEquals("A short summary", a.get("description"));
        assertFalse(String.valueOf(a.get("publishedAt")).isBlank());
    }

    @Test
    void catalogHasCourrierInternational() {
        assertTrue(RssFeedCatalog.defaults().stream()
                .anyMatch(f -> f.url().contains("courrierinternational.com")));
        assertTrue(RssFeedCatalog.defaults().size() >= 40);
    }
}
