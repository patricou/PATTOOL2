package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class MaptoolkitProxyServiceTest {

    @Test
    void allowsTheFourStyleHosts() {
        assertEquals(
                "https://styles.maptoolkit.org/hiking.json",
                MaptoolkitProxyService.allowedUri("https://styles.maptoolkit.org/hiking.json").toString());
        assertNotNull(MaptoolkitProxyService.allowedUri(
                "https://tiles.maptoolkit.org/v01072026/vector/12/2147/1456.pbf"));
        assertNotNull(MaptoolkitProxyService.allowedUri(
                "https://fonts.maptoolkit.org/Open%20Sans%20Regular/0-255.pbf"));
        assertEquals(
                "/sprite@2x.png",
                MaptoolkitProxyService.allowedUri("https://icons.maptoolkit.org/sprite@2x.png").getPath());
        assertNotNull(MaptoolkitProxyService.allowedUri("https://tiles.mapterhorn.com/12/2147/1456.webp"));
    }

    @Test
    void rejectsAnythingElse() {
        assertNull(MaptoolkitProxyService.allowedUri(null));
        assertNull(MaptoolkitProxyService.allowedUri(""));
        assertNull(MaptoolkitProxyService.allowedUri("http://styles.maptoolkit.org/hiking.json"));
        assertNull(MaptoolkitProxyService.allowedUri("https://user:pass@styles.maptoolkit.org/hiking.json"));
        assertNull(MaptoolkitProxyService.allowedUri("https://styles.maptoolkit.org:444/hiking.json"));
        assertNull(MaptoolkitProxyService.allowedUri("https://styles.maptoolkit.org.evil.com/hiking.json"));
        assertNull(MaptoolkitProxyService.allowedUri("https://evil.com/styles.maptoolkit.org/hiking.json"));
        assertNull(MaptoolkitProxyService.allowedUri("https://static.maptoolkit.net/webfonts/webfonts.css"));
        assertNull(MaptoolkitProxyService.allowedUri("https://styles.maptoolkit.org/../secret"));
        assertNull(MaptoolkitProxyService.allowedUri("https://styles.maptoolkit.org/%2e%2e/secret"));
        assertNull(MaptoolkitProxyService.allowedUri("file:///etc/passwd"));
        assertNull(MaptoolkitProxyService.allowedUri("https://styles.maptoolkit.org/hiking.json?next=https://evil.com"));
    }
}
