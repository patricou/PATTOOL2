package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
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
    void coordinateLabelIsNotAPlaceName() throws Exception {
        assertTrue(WikiProxyService.isCoordinateLabel("46.27094, 5.93987"));
        assertFalse(WikiProxyService.isCoordinateLabel("Crêt de la Neige"));
        ObjectMapper mapper = new ObjectMapper();
        JsonNode raw = mapper.readTree("""
                {"elements":[
                  {"type":"node","lat":46.2714,"lon":5.9412,"tags":{"name":"Belvédère","wikidata":"Q1"}},
                  {"type":"node","lat":46.270925,"lon":5.939626,"tags":{"name":"Crêt de la Neige","wikidata":"Q1142554"}},
                  {"type":"way","tags":{"name":"Lélex","wikidata":"Q24643","boundary":"administrative"},"center":{"lat":46.27093,"lon":5.93987}}
                ]}
                """);
        WikiProxyService.NearbyPlace place = WikiProxyService.closestNamedPlace(raw, 46.2709367, 5.9398659, 75);
        assertEquals("Crêt de la Neige", place.name());
        assertEquals("Q1142554", place.wikidata());
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
    void camptocampKeepsASizedFileAndDropsAnythingElse() {
        assertEquals(
                "https://media.camptocamp.org/c2corg-active/1755253183_2074136837BI.jpg",
                WikiProxyService.camptocampImageUrl("1755253183_2074136837.jpg")
        );
        assertEquals("", WikiProxyService.camptocampImageUrl("../secret.jpg"));
        assertEquals("", WikiProxyService.camptocampImageUrl("https://evil.example/a.jpg"));
    }

    @Test
    void camptocampBoxIsWebMercatorAroundThePlace() {
        double[] summit = WikiProxyService.mercatorToLatLng(660074.8205917277, 5821609.609640827);
        assertEquals(46.256875, summit[0], 0.00002);
        assertEquals(5.929553, summit[1], 0.00002);
        String box = WikiProxyService.webMercatorBbox(summit[0], summit[1], 75);
        String[] edges = box.split(",");
        assertEquals(4, edges.length);
        double west = Double.parseDouble(edges[0]);
        double south = Double.parseDouble(edges[1]);
        double east = Double.parseDouble(edges[2]);
        double north = Double.parseDouble(edges[3]);
        assertTrue(west < 660074.82 && east > 660074.82);
        assertTrue(south < 5821609.61 && north > 5821609.61);
        assertTrue(east - west < 400);
        assertTrue(north - south < 400);
    }

    @Test
    void inaturalistUsesTheLargeRenditionOnItsOwnHosts() {
        assertEquals(
                "https://inaturalist-open-data.s3.amazonaws.com/photos/276164011/large.jpeg",
                WikiProxyService.inaturalistImageUrl(
                        "https://inaturalist-open-data.s3.amazonaws.com/photos/276164011/square.jpeg")
        );
        assertEquals(
                "https://static.inaturalist.org/photos/12/large.jpg",
                WikiProxyService.inaturalistImageUrl("https://static.inaturalist.org/photos/12/medium.jpg")
        );
        assertEquals("", WikiProxyService.inaturalistImageUrl("https://evil.example/photos/12/square.jpg"));
        assertEquals("", WikiProxyService.inaturalistImageUrl("https://static.inaturalist.org/photos/12/original.jpg"));
    }

    @Test
    void kartaviewBuildsTheCdnUrlFromTheStoragePath() {
        assertEquals(
                "https://cdn.kartaview.org/pr:sharp/aHR0cHM6Ly9zdG9yYWdlMTMub3BlbnN0cmVldGNhbS5vcmcvZmlsZXMvcGhvdG8vMjAyMC85LzE0L2x0aC8zMDE5NDc0XzAxYThlXzVmNWY4ZmEyYmE3Y2YuanBn",
                WikiProxyService.kartaviewImageUrl(
                        "storage13/files/photo/2020/9/14/lth/3019474_01a8e_5f5f8fa2ba7cf.jpg")
        );
        assertEquals("", WikiProxyService.kartaviewImageUrl("https://evil.example/a.jpg"));
        assertEquals("", WikiProxyService.kartaviewImageUrl("storage13/files/photo/../secret.jpg"));
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
