package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
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
        assertTrue(WikiProxyService.samePlace(
                "Route Sylvo-Pastorale du col du Sac", "Col du Sac", 200));
    }

    @Test
    void coreNameDropsTheRoadAndKeepsThePlace() {
        assertEquals("col du Sac", WikiProxyService.corePlaceName("Route Sylvo-Pastorale du col du Sac"));
        assertEquals("Tour Eiffel", WikiProxyService.corePlaceName("Tour Eiffel"));
        assertEquals("Vierge", WikiProxyService.corePlaceName("Statue de la Vierge"));
    }

    @Test
    void panoramaxSphereIsShownAsATurningPhoto() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        assertTrue(WikiProxyService.panoramaxPano(mapper.readTree(
                "{\"properties\":{\"pers:interior_orientation\":{\"sensor_array_dimensions\":[3168,1584]}}}")));
        assertTrue(WikiProxyService.panoramaxPano(mapper.readTree(
                "{\"properties\":{\"pers:interior_orientation\":{\"field_of_view\":360}}}")));
        assertTrue(WikiProxyService.equirectFrame(3168, 1584));
        assertFalse(WikiProxyService.panoramaxPano(mapper.readTree(
                "{\"properties\":{\"pers:interior_orientation\":{\"sensor_array_dimensions\":[4000,3000]}}}")));
        assertFalse(WikiProxyService.equirectFrame(4000, 3000));
    }

    @Test
    void commonsKeepsAPhotographAndDropsAMap() {
        assertTrue(WikiProxyService.scenicCommonsFile(
                "File:Scenic view form the Crêt de la Goutte - panoramio (7).jpg"));
        assertFalse(WikiProxyService.scenicCommonsFile("File:Locator map of Ain.svg"));
        assertFalse(WikiProxyService.scenicCommonsFile("File:Blason ville.png"));
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
