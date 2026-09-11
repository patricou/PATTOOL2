package com.pat.service;

import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ArtisansOpeningHoursTest {

    private static final ZoneId PARIS = ZoneId.of("Europe/Paris");

    @Test
    void emptyIsNotClosed() {
        assertFalse(ArtisansOpeningHours.isClosedNow(null));
        assertFalse(ArtisansOpeningHours.isClosedNow(""));
    }

    @Test
    void permanentlyClosed() {
        assertTrue(ArtisansOpeningHours.isClosedNow("closed"));
        assertTrue(ArtisansOpeningHours.isClosedNow("off"));
    }

    @Test
    void alwaysOpen() {
        assertFalse(ArtisansOpeningHours.isClosedNow("24/7", at(2026, 9, 11, 3, 0)));
    }

    @Test
    void weekdayHours() {
        ZonedDateTime fridayNoon = at(2026, 9, 11, 12, 0); // Friday
        ZonedDateTime fridayNight = at(2026, 9, 11, 21, 0);
        ZonedDateTime sundayNoon = at(2026, 9, 13, 12, 0);
        String spec = "Mo-Fr 09:00-18:00";
        assertFalse(ArtisansOpeningHours.isClosedNow(spec, fridayNoon));
        assertTrue(ArtisansOpeningHours.isClosedNow(spec, fridayNight));
        assertTrue(ArtisansOpeningHours.isClosedNow(spec, sundayNoon));
    }

    @Test
    void overnight() {
        String spec = "Mo-Su 18:00-02:00";
        assertFalse(ArtisansOpeningHours.isClosedNow(spec, at(2026, 9, 11, 20, 0)));
        assertFalse(ArtisansOpeningHours.isClosedNow(spec, at(2026, 9, 12, 1, 0)));
        assertTrue(ArtisansOpeningHours.isClosedNow(spec, at(2026, 9, 11, 12, 0)));
    }

    private static ZonedDateTime at(int y, int m, int d, int h, int min) {
        return ZonedDateTime.of(LocalDateTime.of(y, m, d, h, min), PARIS);
    }
}
