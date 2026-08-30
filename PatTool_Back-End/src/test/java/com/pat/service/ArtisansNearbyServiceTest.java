package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ArtisansNearbyServiceTest {

    @Test
    void haversineParisToZeroIsAboutZero() {
        assertEquals(0.0, ArtisansNearbyService.haversineKm(48.8566, 2.3522, 48.8566, 2.3522), 1e-6);
    }

    @Test
    void naf4711BIsSupermarket() {
        assertEquals("supermarket", ArtisansNearbyService.tradeForNaf("47.11B"));
        assertEquals("shop", ArtisansNearbyService.tradeForNaf("47.19A"));
        assertEquals("restaurant", ArtisansNearbyService.tradeForNaf("56.10A"));
    }

    @Test
    void naf4322AIsPlumbing() {
        assertEquals("Plomberie / eau et gaz", ArtisansNearbyService.labelForNaf("43.22A"));
        assertEquals("plumber", ArtisansNearbyService.tradeForNaf("43.22A"));
    }

    @Test
    void nafPrefixFallsBackToBuildingTrade() {
        assertEquals("Travaux de bâtiment", ArtisansNearbyService.labelForNaf("43.50Z"));
    }

    @Test
    void websiteWithoutSchemeGetsHttps() {
        assertEquals("https://atelier-dupont.fr", ArtisansNearbyService.normalizeWebsite("atelier-dupont.fr"));
        assertEquals("https://www.example.com/contact", ArtisansNearbyService.normalizeWebsite("https://www.example.com/contact"));
        assertEquals("", ArtisansNearbyService.normalizeWebsite("javascript:alert(1)"));
        assertEquals("", ArtisansNearbyService.normalizeWebsite("https://www.facebook.com/atelier-dupont"));
        assertEquals("", ArtisansNearbyService.normalizeWebsite("https://www.pagesjaunes.fr/pros/123"));
    }

    @Test
    void wikidataIdIsNormalized() {
        assertEquals("Q123", ArtisansNearbyService.normalizeWikidataId("https://www.wikidata.org/wiki/Q123"));
        assertEquals("Q99", ArtisansNearbyService.normalizeWikidataId("q99"));
        assertEquals("", ArtisansNearbyService.normalizeWikidataId("not-an-id"));
    }

    @Test
    void haversineOneDegreeLatitudeIsAbout111Km() {
        double km = ArtisansNearbyService.haversineKm(48.0, 2.0, 49.0, 2.0);
        assertTrue(km > 110 && km < 112, "expected ~111 km, got " + km);
    }
}
