package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.DeezerFavoriteItemDto;
import com.pat.controller.dto.DeezerFavoritesDto;
import com.pat.controller.dto.DeezerTrackDto;
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
class DeezerFavoritesServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private DeezerFavoritesService service;

    @BeforeEach
    void setUp() {
        service = new DeezerFavoritesService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void findForSubjectReturnsEmptyWhenMissing() {
        when(userOwnerService.findParam("deezer.favorites.", "sub-1")).thenReturn(Optional.empty());
        assertTrue(service.findForSubject("sub-1").getItems().isEmpty());
    }

    @Test
    void addFavoritePersistsSnapshotUnderUsernameKey() {
        when(userOwnerService.findParam("deezer.favorites.", "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.writeKey("deezer.favorites.", "sub-1"))
                .thenReturn("deezer.favorites.patricou");

        DeezerFavoritesDto saved = service.addFavorite("sub-1", trackItem(42, "California"));

        assertEquals(1, saved.getItems().size());
        assertEquals("track", saved.getItems().get(0).getKind());
        assertEquals(42L, saved.getItems().get(0).getTrack().id());
        assertEquals("California", saved.getItems().get(0).getTrack().title());
        verify(appParameterService).setJson(eq("deezer.favorites.patricou"), anyString(), anyString());
        verify(userOwnerService).dropAliasKeys("deezer.favorites.", "sub-1");
    }

    @Test
    void addFavoritePrependsNewest() throws Exception {
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(
                new DeezerFavoritesDto(List.of(trackItem(1, "Older")))));
        when(userOwnerService.findParam("deezer.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("deezer.favorites.", "sub-1"))
                .thenReturn("deezer.favorites.patricou");

        DeezerFavoritesDto saved = service.addFavorite("sub-1", trackItem(2, "Newer"));

        assertEquals(2, saved.getItems().size());
        assertEquals(2L, saved.getItems().get(0).getTrack().id());
        assertEquals(1L, saved.getItems().get(1).getTrack().id());
    }

    @Test
    void addFavoriteRejectsBlankTitle() {
        DeezerFavoriteItemDto item = trackItem(7, "  ");
        assertThrows(IllegalArgumentException.class, () -> service.addFavorite("sub-1", item));
    }

    @Test
    void sameIdDifferentKindAreDistinctFavorites() throws Exception {
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(
                new DeezerFavoritesDto(List.of(trackItem(9, "Clip")))));
        when(userOwnerService.findParam("deezer.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("deezer.favorites.", "sub-1"))
                .thenReturn("deezer.favorites.patricou");

        DeezerFavoritesDto saved = service.addFavorite("sub-1", albumItem(9, "Album"));
        assertEquals(2, saved.getItems().size());
    }

    @Test
    void removeFavoriteUsesIdAndKind() throws Exception {
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(
                new DeezerFavoritesDto(List.of(trackItem(9, "Clip"), albumItem(9, "Album")))));
        when(userOwnerService.findParam("deezer.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("deezer.favorites.", "sub-1"))
                .thenReturn("deezer.favorites.patricou");

        DeezerFavoritesDto saved = service.removeFavorite("sub-1", 9, "track");
        assertEquals(1, saved.getItems().size());
        assertEquals("album", saved.getItems().get(0).getKind());
    }

    @Test
    void normalizeDropsNonDeezerMediaUrl() {
        DeezerTrackDto raw = new DeezerTrackDto(
                11,
                "Rick",
                "Artist",
                3,
                "Album",
                4,
                "javascript:alert(1)",
                "https://evil.example/preview.mp3",
                30,
                false,
                "https://www.deezer.com/track/11");
        DeezerFavoriteItemDto item = new DeezerFavoriteItemDto();
        item.setKind("TRACK");
        item.setTrack(raw);

        DeezerFavoriteItemDto n = DeezerFavoritesService.normalizeItem(item);
        assertEquals("track", n.getKind());
        assertNull(n.getTrack().coverUrl());
        assertNull(n.getTrack().previewUrl());
        assertEquals("https://www.deezer.com/track/11", n.getTrack().link());
        assertEquals("track|11", DeezerFavoritesService.favoriteKey(n));
    }

    private static DeezerFavoriteItemDto trackItem(long id, String title) {
        DeezerFavoriteItemDto item = new DeezerFavoriteItemDto();
        item.setKind("track");
        item.setTrack(new DeezerTrackDto(
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
                "https://www.deezer.com/track/" + id));
        return item;
    }

    private static DeezerFavoriteItemDto albumItem(long id, String title) {
        DeezerFavoriteItemDto item = new DeezerFavoriteItemDto();
        item.setKind("album");
        item.setAlbum(new com.pat.controller.dto.DeezerAlbumDto(
                id,
                title,
                "Artist",
                3,
                "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg",
                "2020-01-01",
                12,
                "album",
                "https://www.deezer.com/album/" + id));
        return item;
    }
}
