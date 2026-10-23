package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RadioNowPlayingServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void mapsRadioFranceSlugsToLivemetaIds() {
        assertEquals(1, RadioNowPlayingService.radioFranceStationId(
                "https://stream.radiofrance.fr/franceinter/franceinter.m3u8", null, null));
        assertEquals(7, RadioNowPlayingService.radioFranceStationId(
                "https://icecast.radiofrance.fr/fip-hifi.aac", "FIP", null));
        assertEquals(64, RadioNowPlayingService.radioFranceStationId(
                "https://icecast.radiofrance.fr/fip-rock-midfi.mp3", "FIP", null));
        assertEquals(69, RadioNowPlayingService.radioFranceStationId(
                "https://icecast.radiofrance.fr/fip-monde-hifi.aac", null, null));
        assertEquals(6, RadioNowPlayingService.radioFranceStationId(
                "https://example.com/stream", "Mouv'", null));
        assertEquals(4, RadioNowPlayingService.radioFranceStationId(
                "https://cdn.example/live", null, "https://www.radiofrance.fr/francemusique"));
        assertNull(RadioNowPlayingService.radioFranceStationId(
                "https://ice.example/radio.mp3", "Nova", "https://www.nova.fr"));
    }

    @Test
    void parsesIcyStreamTitle() {
        RadioNowPlayingService.Track track = RadioNowPlayingService.trackFromIcy(
                "StreamTitle='Daft Punk - Get Lucky - Random Access Memories';StreamUrl='';",
                "FIP");
        assertEquals("Daft Punk", track.artist);
        assertEquals("Get Lucky", track.title);
        assertEquals("Daft Punk — Get Lucky", track.label());
        assertFalse(RadioNowPlayingService.trackFromIcy("StreamTitle='FIP';", "FIP").hasTitle());
        assertFalse(RadioNowPlayingService.trackFromIcy("StreamTitle='advert';", "Nova").hasTitle());
    }

    @Test
    void picksTheSongOnAirAndIgnoresTalk() throws Exception {
        var root = mapper.readTree("""
                {
                  "steps": {
                    "show": {"title": "Le journal", "embedType": "expression", "start": 100, "end": 400, "depth": 1},
                    "song": {"title": "Talagh", "embedType": "song", "start": 200, "end": 260, "depth": 3,
                             "highlightedArtists": ["Googoosh"]}
                  }
                }
                """);
        var song = RadioNowPlayingService.pickSong(root, 220);
        assertEquals("Talagh", song.path("title").asText());
        assertNull(RadioNowPlayingService.pickSong(root, 300));
    }

    @Test
    void acceptsArtistPhotosAndSkipsLogos() {
        assertTrue(RadioNowPlayingService.wikiPhotoAllowed("File:Googoosh performing.jpg"));
        assertFalse(RadioNowPlayingService.wikiPhotoAllowed("File:FIP logo.svg"));
        assertFalse(RadioNowPlayingService.wikiPhotoAllowed("File:Flag of France.png"));
    }
}
