package com.pat.util;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Leaflet {@code zoomSnap: 0} (smooth wheel zoom) can put a fractional zoom such as
 * {@code 11.638} in {@code /tile/{z}/{x}/{y}}. Slippy-map indexes are integers.
 */
public final class SlippyMapTileCoords {

    private SlippyMapTileCoords() {
    }

    public static int parse(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid tile coordinate");
        }
        String s = raw.trim();
        int dot = s.lastIndexOf('.');
        if (dot > 0) {
            String suffix = s.substring(dot + 1);
            if (!suffix.isEmpty() && suffix.chars().allMatch(Character::isLetter)) {
                s = s.substring(0, dot);
            }
        }
        try {
            double v = Double.parseDouble(s);
            if (!Double.isFinite(v) || v < 0d || v > Integer.MAX_VALUE) {
                throw new NumberFormatException(s);
            }
            return (int) Math.round(v);
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid tile coordinate");
        }
    }
}
