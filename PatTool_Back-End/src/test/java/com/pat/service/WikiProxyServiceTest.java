package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WikiProxyServiceTest {

    @Test
    void wikidataIdIsTakenFromAUrlOrBareId() {
        assertEquals("Q243", WikiProxyService.normalizeWikidataId("Q243"));
        assertEquals("Q243", WikiProxyService.normalizeWikidataId("https://www.wikidata.org/wiki/Q243"));
        assertEquals("", WikiProxyService.normalizeWikidataId("attraction"));
        assertEquals("", WikiProxyService.normalizeWikidataId(""));
    }

    @Test
    void commonsUrlKeepsTheFileAndDropsAnythingElse() {
        assertEquals(
                "https://commons.wikimedia.org/wiki/Special:FilePath/Eiffel_Tower.jpg?width=960",
                WikiProxyService.commonsThumbnailUrl("Eiffel Tower.jpg", 960)
        );
        assertEquals(
                "https://commons.wikimedia.org/wiki/File:Eiffel_Tower.jpg",
                WikiProxyService.commonsFilePageUrl("File:Eiffel Tower.jpg")
        );
        assertEquals("", WikiProxyService.commonsThumbnailUrl("../secret.jpg", 960));
        assertEquals("", WikiProxyService.commonsThumbnailUrl("https://evil.example/a.jpg", 960));
        assertEquals("", WikiProxyService.commonsThumbnailUrl("notes.pdf", 960));
    }

    @Test
    void nearbyNameMustShareThePlaceAndNotAStreet() {
        assertTrue(WikiProxyService.samePlace(
                "Statue de la vierge", "Statue de la Vierge (Argentan)", 12));
        assertTrue(WikiProxyService.samePlace("Lavoir", "Lavoir communal", 40));
        assertTrue(WikiProxyService.samePlace("Statue de la vierge", "Vierge", 30));
        assertFalse(WikiProxyService.samePlace("Statue de la vierge", "Chemin de la Vierge", 40));
        assertFalse(WikiProxyService.samePlace(
                "Erratic boulder of the Rhone glacier", "Sentier de l'Allondon", 20));
    }

    @Test
    void wikipediaTagKeepsLanguageAndTitle() {
        String[] tag = WikiProxyService.parseWikipediaTag("fr:Statue de la Vierge (Argentan)");
        assertEquals("fr", tag[0]);
        assertEquals("Statue de la Vierge (Argentan)", tag[1]);
        String[] url = WikiProxyService.parseWikipediaTag(
                "https://fr.wikipedia.org/wiki/Statue_de_la_Vierge_(Argentan)");
        assertEquals("fr", url[0]);
        assertEquals("Statue de la Vierge (Argentan)", url[1]);
    }

    @Test
    void articleTitleMustMatchThePlaceName() {
        assertTrue(WikiProxyService.titleMatches(
                "Erratic boulder of the Rhone glacier",
                "Erratic boulder of the Rhône glacier"
        ));
        assertTrue(WikiProxyService.titleMatches("Tour Eiffel", "Tour Eiffel"));
        assertFalse(WikiProxyService.titleMatches("Tour", "Tour Eiffel"));
        assertFalse(WikiProxyService.titleMatches("Rhone", "Sentier de l'Allondon"));
    }
}
