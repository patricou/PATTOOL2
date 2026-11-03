package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerConcertDto;
import com.pat.controller.dto.DeezerConcertTrackDto;
import com.pat.controller.dto.DeezerTrackDto;
import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DeezerConcertServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private DeezerConcertService service;

    @BeforeEach
    void setUp() {
        service = new DeezerConcertService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void addKeepsTheNameTheUserTyped() {
        when(userOwnerService.findParam("deezer.concert.", "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.writeKey("deezer.concert.", "sub-1")).thenReturn("deezer.concert.patricou");

        DeezerConcertDto saved = service.add("sub-1", song(42, "California"), "  Rick  ", "dQw4w9WgXcQ");

        assertEquals(1, saved.getTracks().size());
        assertEquals("dQw4w9WgXcQ", saved.getTracks().get(0).getVideoId());
        assertEquals("Rick", saved.getTracks().get(0).getName());
        assertEquals(42L, saved.getTracks().get(0).getTrack().id());
        assertEquals("California", saved.getTracks().get(0).getTrack().title());
        assertTrue(saved.getTracks().get(0).getPlayId() >= DeezerConcertService.PLAY_ID_BASE);
        verify(appParameterService).setJson(eq("deezer.concert.patricou"), anyString(), anyString());
    }

    @Test
    void addKeepsTheTitleWhenNoYoutubeClipIsKnown() {
        when(userOwnerService.findParam("deezer.concert.", "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.writeKey("deezer.concert.", "sub-1")).thenReturn("deezer.concert.patricou");

        DeezerConcertDto saved = service.add("sub-1", song(7, "Night"), "Soir", null);

        assertEquals("Soir", saved.getTracks().get(0).getName());
        assertNull(saved.getTracks().get(0).getVideoId());
        assertEquals("Night", saved.getTracks().get(0).getTrack().title());
    }

    @Test
    void addAcceptsShortsAndMusicLinks() {
        assertEquals("abcdefghijk", DeezerConcertService.videoIdFrom("https://www.youtube.com/shorts/abcdefghijk"));
        assertEquals("abcdefghijk", DeezerConcertService.videoIdFrom("https://music.youtube.com/watch?v=abcdefghijk"));
        assertEquals("abcdefghijk", DeezerConcertService.videoIdFrom("abcdefghijk"));
        assertEquals(null, DeezerConcertService.videoIdFrom("https://evil.example/?v=abcdefghijk"));
        assertEquals(null, DeezerConcertService.videoIdFrom("not a link"));
    }

    @Test
    void renameAndDeleteKeepTheOtherClips() throws Exception {
        DeezerConcertTrackDto keep = stored("11111111-1111-1111-1111-111111111111", "One", 1);
        DeezerConcertTrackDto drop = stored("22222222-2222-2222-2222-222222222222", "Two", 2);
        stubStored(keep, drop);

        DeezerConcertDto renamed = service.rename("sub-1", drop.getId(), "Deux");
        assertEquals("Deux", renamed.getTracks().get(1).getName());
        assertEquals("One", renamed.getTracks().get(0).getName());

        stubStored(renamed.getTracks().get(0), renamed.getTracks().get(1));
        DeezerConcertDto removed = service.delete("sub-1", drop.getId());
        assertEquals(1, removed.getTracks().size());
        assertEquals("One", removed.getTracks().get(0).getName());
    }

    @Test
    void addRejectsAMissingNameOrTrack() {
        assertThrows(IllegalArgumentException.class, () -> service.add("sub-1", song(1, "One"), "  ", null));
        assertThrows(IllegalArgumentException.class, () -> service.add("sub-1", null, "Name", null));
    }

    @Test
    void addRejectsTheTrackAfterTheCap() throws Exception {
        List<DeezerConcertTrackDto> full = new ArrayList<>();
        for (int i = 0; i < DeezerConcertService.MAX_TRACKS; i++) {
            full.add(stored(String.format("aaaaaaaa-bbbb-cccc-dddd-%012d", i), "Song " + i, i + 1));
        }
        stubFind(full.toArray(DeezerConcertTrackDto[]::new));
        assertThrows(IllegalArgumentException.class,
                () -> service.add("sub-1", song(9000, "One more"), "One more", null));
    }

    private void stubStored(DeezerConcertTrackDto... tracks) throws Exception {
        stubFind(tracks);
        when(userOwnerService.writeKey("deezer.concert.", "sub-1")).thenReturn("deezer.concert.patricou");
    }

    private void stubFind(DeezerConcertTrackDto... tracks) throws Exception {
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new DeezerConcertDto(List.of(tracks))));
        when(userOwnerService.findParam("deezer.concert.", "sub-1")).thenReturn(Optional.of(row));
    }

    private static DeezerConcertTrackDto stored(String id, String name, long trackId) {
        DeezerConcertTrackDto track = new DeezerConcertTrackDto();
        track.setId(id);
        track.setPlayId(DeezerConcertService.PLAY_ID_BASE + Math.floorMod(id.hashCode(), 1000) + trackId);
        track.setName(name);
        track.setTrack(song(trackId, name));
        return track;
    }

    private static DeezerTrackDto song(long id, String title) {
        return new DeezerTrackDto(id, title, "Artist", 3L, "Album", 4L, null, null, 180, false, null, null, 0L);
    }
}
