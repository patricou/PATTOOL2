package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerAlbumDto;
import com.pat.controller.dto.DeezerTrackDto;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DeezerCatalogServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void mapsTrackCoverPreviewAndLink() throws Exception {
        String json = """
                {"id":3135556,"title":"Get Lucky","duration":248,"explicit_lyrics":false,
                 "preview":"https://cdnt-preview.dzcdn.net/api/1/1/0/0/0/0/0/0/0/0/0/0/0/0/0/0.mp3",
                 "link":"https://www.deezer.com/track/3135556",
                 "artist":{"id":27,"name":"Daft Punk"},
                 "album":{"id":6575789,"title":"Random Access Memories",
                          "cover_xl":"https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg"}}
                """;
        DeezerTrackDto track = DeezerCatalogService.mapTrack(mapper.readTree(json), null);
        assertEquals("Get Lucky", track.title());
        assertEquals("Daft Punk", track.artistName());
        assertEquals(27L, track.artistId());
        assertEquals("Random Access Memories", track.albumTitle());
        assertTrue(track.coverUrl().contains("dzcdn.net"));
        assertTrue(track.previewUrl().startsWith("https://cdnt-preview.dzcdn.net/"));
        assertTrue(track.link().contains("deezer.com/track/"));
        assertFalse(track.explicit());
        assertEquals(248, track.durationSec());
    }

    @Test
    void dropsMediaAndLinksOutsideDeezer() throws Exception {
        String json = """
                {"id":1,"title":"X","duration":10,
                 "preview":"https://evil.example/a.mp3",
                 "link":"https://evil.example/track",
                 "artist":{"id":2,"name":"Y"},
                 "album":{"id":3,"title":"Z","cover_xl":"https://evil.example/a.jpg"}}
                """;
        DeezerTrackDto track = DeezerCatalogService.mapTrack(mapper.readTree(json), null);
        assertEquals("", track.previewUrl());
        assertEquals("", track.coverUrl());
        assertEquals("", track.link());
    }

    @Test
    void albumFallbackFillsMissingTrackFields() throws Exception {
        String json = """
                {"id":9,"title":"Within","duration":228,"preview":"",
                 "artist":{"id":0,"name":""},"album":{"id":0,"title":""}}
                """;
        DeezerAlbumDto album = new DeezerAlbumDto(
                6575789L, "Random Access Memories", "Daft Punk", 27L,
                "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg",
                "2013-05-17", 13, "album", "https://www.deezer.com/album/6575789");
        DeezerTrackDto track = DeezerCatalogService.mapTrack(mapper.readTree(json), album);
        assertEquals("Daft Punk", track.artistName());
        assertEquals("Random Access Memories", track.albumTitle());
        assertEquals(6575789L, track.albumId());
        assertTrue(track.coverUrl().contains("dzcdn.net"));
    }

    @Test
    void searchTypeFallsBackToTrack() {
        assertEquals("track", DeezerCatalogService.normalizeType(null));
        assertEquals("track", DeezerCatalogService.normalizeType("nope"));
        assertEquals("album", DeezerCatalogService.normalizeType("ALBUM"));
    }
}
