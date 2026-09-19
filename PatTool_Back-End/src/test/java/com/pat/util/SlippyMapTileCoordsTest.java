package com.pat.util;

import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SlippyMapTileCoordsTest {

    @Test
    void integerZoom() {
        assertEquals(12, SlippyMapTileCoords.parse("12"));
    }

    @Test
    void fractionalZoomFromSmoothLeaflet() {
        assertEquals(12, SlippyMapTileCoords.parse("11.638"));
    }

    @Test
    void pngExtension() {
        assertEquals(14, SlippyMapTileCoords.parse("14.png"));
    }

    @Test
    void rejectsGarbage() {
        assertThrows(ResponseStatusException.class, () -> SlippyMapTileCoords.parse("abc"));
    }
}
