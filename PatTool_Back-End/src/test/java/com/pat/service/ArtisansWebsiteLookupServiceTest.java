package com.pat.service;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ArtisansWebsiteLookupServiceTest {

    @Test
    void searchQueryDropsLegalFormAndAddsOfficialHint() {
        String query = ArtisansWebsiteLookupService.searchQuery(
                "SARL Poilâne", "Paris", "75006", "Boulangerie");
        assertTrue(query.contains("Poilâne"));
        assertTrue(query.contains("Paris"));
        assertTrue(query.contains("75006"));
        assertTrue(query.contains("site officiel"));
        assertFalse(query.toLowerCase().contains("sarl"));
    }

    @Test
    void extractDuckDuckGoUrlsKeepsFirstOfficialHost() {
        String html = """
                <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.poilane.com%2F&amp;rut=abc">Poilâne</a>
                <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.poilane.com%2Fen%2F&amp;rut=def">www.poilane.com/en/</a>
                <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.pagesjaunes.fr%2Fpros%2F123&amp;rut=ghi">Pages Jaunes</a>
                <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.laposte.fr%2Fprofessionnel&amp;rut=jkl">La Poste</a>
                """;
        List<String> urls = ArtisansWebsiteLookupService.extractDuckDuckGoUrls(html);
        assertEquals(List.of("https://www.poilane.com/"), urls);
    }

    @Test
    void pickOfficialWebsitePrefersNameMatchingDomain() {
        String picked = ArtisansWebsiteLookupService.pickOfficialWebsite(
                "Boulangerie Poilâne",
                "Paris",
                List.of(
                        "https://www.tripadvisor.fr/poilane",
                        "https://www.poilane.com/",
                        "https://uneboulangerie.fr/75/paris/poilane"
                ));
        assertEquals("https://www.poilane.com/", picked);
    }

    @Test
    void pickOfficialWebsiteRejectsDirectoriesOnly() {
        String picked = ArtisansWebsiteLookupService.pickOfficialWebsite(
                "Atelier Dupont",
                "Lyon",
                List.of(
                        "https://www.pagesjaunes.fr/pros/1",
                        "https://www.laposte.fr/professionnel",
                        "https://www.societe.com/societe/atelier-dupont"
                ));
        assertEquals("", picked);
    }

    @Test
    void domainLooksLikeAccentedName() {
        assertTrue(ArtisansWebsiteLookupService.domainLooksLikeName("www.poilane.com", "Boulangerie Poilâne"));
        assertFalse(ArtisansWebsiteLookupService.domainLooksLikeName("www.pagesjaunes.fr", "Boulangerie Poilâne"));
    }
}
