package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AudioDbAlbumDto;
import com.pat.controller.dto.AudioDbArtistDto;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AudioDbCatalogServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void prefersFrenchBiographyAndDropsForeignImages() throws Exception {
        String json = """
                {"idArtist":"111","strArtist":"Daft Punk","intFormedYear":"1993","intMembers":"2",
                 "strGenre":"Electronic","strStyle":"House","strMood":"Energetic",
                 "strCountry":"France","strWebsite":"www.daftpunk.com",
                 "strBiographyFR":"Duo français.<br>Formé à Paris.",
                 "strBiographyEN":"<b>French</b> duo.",
                 "strArtistThumb":"https://evil.example/a.jpg"}
                """;
        AudioDbArtistDto artist = AudioDbCatalogService.mapArtist(mapper.readTree(json), "fr");
        assertEquals("Daft Punk", artist.name());
        assertEquals("Duo français.\nFormé à Paris.", artist.biography());
        assertEquals("1993", artist.formedYear());
        assertEquals(2, artist.members());
        assertEquals("https://www.daftpunk.com", artist.website());
        assertEquals("", artist.thumbUrl());
    }

    @Test
    void albumFallsBackToEnglishAndKeepsAudioDbArt() throws Exception {
        String json = """
                {"strAlbum":"Discovery","strArtist":"Daft Punk","intYearReleased":"2001",
                 "strGenre":"Electronic","strLabel":"Virgin",
                 "strDescriptionFR":null,
                 "strDescriptionEN":"Second studio album.",
                 "strAlbumThumb":"http://www.theaudiodb.com/images/media/album/thumb/x.jpg"}
                """;
        AudioDbAlbumDto album = AudioDbCatalogService.mapAlbum(mapper.readTree(json), "fr");
        assertEquals("Discovery", album.title());
        assertEquals("Second studio album.", album.description());
        assertEquals("2001", album.year());
        assertEquals("Virgin", album.label());
        assertTrue(album.thumbUrl().startsWith("https://www.theaudiodb.com/"));
    }

    @Test
    void missingNameIsNotADossier() throws Exception {
        assertNull(AudioDbCatalogService.mapArtist(mapper.readTree("{\"strArtist\":\"\"}"), "en"));
        assertNull(AudioDbCatalogService.mapAlbum(mapper.readTree("{\"strAlbum\":\"null\"}"), "en"));
        assertEquals("", AudioDbCatalogService.cleanQuery("  \n "));
    }
}
