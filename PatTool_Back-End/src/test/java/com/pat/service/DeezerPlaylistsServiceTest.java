package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerPlaylistOrderRequest;
import com.pat.controller.dto.DeezerTrackDto;
import com.pat.controller.dto.DeezerUserPlaylistDto;
import com.pat.controller.dto.DeezerUserPlaylistsDto;
import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

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
class DeezerPlaylistsServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private DeezerPlaylistsService service;

    @BeforeEach
    void setUp() {
        service = new DeezerPlaylistsService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void findForSubjectReturnsEmptyWhenMissing() {
        when(userOwnerService.findParam("deezer.playlists.", "sub-1")).thenReturn(Optional.empty());
        assertTrue(service.findForSubject("sub-1").getPlaylists().isEmpty());
    }

    @Test
    void createPersistsNamedPlaylistUnderUsernameKey() {
        when(userOwnerService.findParam("deezer.playlists.", "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.writeKey("deezer.playlists.", "sub-1"))
                .thenReturn("deezer.playlists.patricou");

        DeezerUserPlaylistsDto saved = service.create("sub-1", "  Route  ", track(42, "California"));

        assertEquals(1, saved.getPlaylists().size());
        assertEquals("Route", saved.getPlaylists().get(0).getName());
        assertEquals(1, saved.getPlaylists().get(0).getTracks().size());
        assertEquals(42L, saved.getPlaylists().get(0).getTracks().get(0).id());
        assertTrue(DeezerPlaylistsService.validId(saved.getPlaylists().get(0).getId()));
        verify(appParameterService).setJson(eq("deezer.playlists.patricou"), anyString(), anyString());
        verify(userOwnerService).dropAliasKeys("deezer.playlists.", "sub-1");
    }

    @Test
    void createRejectsBlankName() {
        assertThrows(IllegalArgumentException.class, () -> service.create("sub-1", "   ", null));
    }

    @Test
    void renameAndRemoveTrackKeepThePlaylist() throws Exception {
        DeezerUserPlaylistDto playlist = stored("11111111-1111-1111-1111-111111111111", "Soir", track(7, "Night"));
        stubStored(playlist);

        DeezerUserPlaylistsDto renamed = service.rename("sub-1", playlist.getId(), "Soirée");
        assertEquals("Soirée", renamed.getPlaylists().get(0).getName());

        stubStored(renamed.getPlaylists().get(0));
        DeezerUserPlaylistsDto removed = service.removeTrack("sub-1", playlist.getId(), 7);
        assertTrue(removed.getPlaylists().get(0).getTracks().isEmpty());
        assertEquals("Soirée", removed.getPlaylists().get(0).getName());
    }

    @Test
    void addTrackAppendsAndSkipsDuplicates() throws Exception {
        DeezerUserPlaylistDto playlist = stored("22222222-2222-2222-2222-222222222222", "Mix", track(1, "One"));
        stubStored(playlist);

        DeezerUserPlaylistsDto saved = service.addTrack("sub-1", playlist.getId(), track(2, "Two"));
        assertEquals(List.of(1L, 2L), saved.getPlaylists().get(0).getTracks().stream().map(DeezerTrackDto::id).toList());

        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(
                new DeezerUserPlaylistsDto(List.of(saved.getPlaylists().get(0)))));
        when(userOwnerService.findParam("deezer.playlists.", "sub-1")).thenReturn(Optional.of(row));

        DeezerUserPlaylistsDto again = service.addTrack("sub-1", playlist.getId(), track(2, "Two"));
        assertEquals(2, again.getPlaylists().get(0).getTracks().size());
    }

    @Test
    void reorderMovesTheRequestedTrack() throws Exception {
        DeezerUserPlaylistDto playlist = stored(
                "33333333-3333-3333-3333-333333333333",
                "Mix",
                track(1, "One"),
                track(2, "Two"),
                track(3, "Three"));
        stubStored(playlist);
        DeezerPlaylistOrderRequest order = new DeezerPlaylistOrderRequest();
        order.setTrackIds(List.of(2L, 3L, 1L));

        DeezerUserPlaylistsDto saved = service.reorder("sub-1", playlist.getId(), order);

        assertEquals(List.of(2L, 3L, 1L), saved.getPlaylists().get(0).getTracks().stream().map(DeezerTrackDto::id).toList());
    }

    @Test
    void deleteRemovesOnlyTheNamedPlaylist() throws Exception {
        DeezerUserPlaylistDto keep = stored("44444444-4444-4444-4444-444444444444", "Keep", track(1, "One"));
        DeezerUserPlaylistDto drop = stored("55555555-5555-5555-5555-555555555555", "Drop", track(2, "Two"));
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new DeezerUserPlaylistsDto(List.of(keep, drop))));
        when(userOwnerService.findParam("deezer.playlists.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("deezer.playlists.", "sub-1")).thenReturn("deezer.playlists.patricou");

        DeezerUserPlaylistsDto saved = service.delete("sub-1", drop.getId());

        assertEquals(1, saved.getPlaylists().size());
        assertEquals("Keep", saved.getPlaylists().get(0).getName());
    }

    @Test
    void normalizeDropsNonDeezerMediaUrl() throws Exception {
        DeezerTrackDto raw = new DeezerTrackDto(
                11, "Rick", "Artist", 3, "Album", 4,
                "javascript:alert(1)",
                "https://evil.example/preview.mp3",
                30, false, "https://www.deezer.com/track/11");
        DeezerUserPlaylistDto playlist = stored("66666666-6666-6666-6666-666666666666", "Safe", raw);
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new DeezerUserPlaylistsDto(List.of(playlist))));
        when(userOwnerService.findParam("deezer.playlists.", "sub-1")).thenReturn(Optional.of(row));

        DeezerUserPlaylistsDto loaded = service.findForSubject("sub-1");

        DeezerTrackDto track = loaded.getPlaylists().get(0).getTracks().get(0);
        assertNull(track.coverUrl());
        assertNull(track.previewUrl());
        assertEquals("https://www.deezer.com/track/11", track.link());
    }

    private void stubStored(DeezerUserPlaylistDto playlist) throws Exception {
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new DeezerUserPlaylistsDto(List.of(playlist))));
        when(userOwnerService.findParam("deezer.playlists.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("deezer.playlists.", "sub-1")).thenReturn("deezer.playlists.patricou");
    }

    private static DeezerUserPlaylistDto stored(String id, String name, DeezerTrackDto... tracks) {
        DeezerUserPlaylistDto playlist = new DeezerUserPlaylistDto();
        playlist.setId(id);
        playlist.setName(name);
        playlist.setTracks(List.of(tracks));
        return playlist;
    }

    private static DeezerTrackDto track(long id, String title) {
        return new DeezerTrackDto(
                id,
                title,
                "Artist",
                3,
                "Album",
                4,
                "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg",
                "https://cdnt-preview.dzcdn.net/api/1/1/1.mp3",
                180,
                false,
                "https://www.deezer.com/track/" + id);
    }
}
