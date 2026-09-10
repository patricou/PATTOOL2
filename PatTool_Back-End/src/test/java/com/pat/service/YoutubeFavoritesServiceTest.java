package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.YoutubeFavoritesDto;
import com.pat.controller.dto.YoutubeItemDto;
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
class YoutubeFavoritesServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private YoutubeFavoritesService service;

    @BeforeEach
    void setUp() {
        service = new YoutubeFavoritesService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void findForSubjectReturnsEmptyWhenMissing() {
        when(userOwnerService.findParam("youtube.favorites.", "sub-1")).thenReturn(Optional.empty());
        assertTrue(service.findForSubject("sub-1").getItems().isEmpty());
    }

    @Test
    void addFavoritePersistsSnapshotUnderUsernameKey() {
        when(userOwnerService.findParam("youtube.favorites.", "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.writeKey("youtube.favorites.", "sub-1"))
                .thenReturn("youtube.favorites.alice");

        YoutubeItemDto item = sample("dQw4w9WgXcQ", "video", "Never Gonna Give You Up");
        YoutubeFavoritesDto saved = service.addFavorite("sub-1", item);

        assertEquals(1, saved.getItems().size());
        assertEquals("dQw4w9WgXcQ", saved.getItems().get(0).id());
        assertEquals("video", saved.getItems().get(0).kind());
        verify(appParameterService).setJson(eq("youtube.favorites.alice"), anyString(), anyString());
        verify(userOwnerService).dropAliasKeys("youtube.favorites.", "sub-1");
    }

    @Test
    void addFavoriteRejectsBlankTitle() {
        YoutubeItemDto item = sample("abc123", "video", "  ");
        assertThrows(IllegalArgumentException.class, () -> service.addFavorite("sub-1", item));
    }

    @Test
    void sameIdDifferentKindAreDistinctFavorites() throws Exception {
        YoutubeItemDto video = sample("abc123XYZ01", "video", "Clip");
        YoutubeItemDto playlist = sample("abc123XYZ01", "playlist", "Mix");
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new YoutubeFavoritesDto(List.of(video))));
        when(userOwnerService.findParam("youtube.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("youtube.favorites.", "sub-1"))
                .thenReturn("youtube.favorites.alice");

        YoutubeFavoritesDto saved = service.addFavorite("sub-1", playlist);
        assertEquals(2, saved.getItems().size());
    }

    @Test
    void removeFavoriteUsesIdAndKind() throws Exception {
        YoutubeItemDto video = sample("abc123XYZ01", "video", "Clip");
        YoutubeItemDto playlist = sample("abc123XYZ01", "playlist", "Mix");
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new YoutubeFavoritesDto(List.of(video, playlist))));
        when(userOwnerService.findParam("youtube.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("youtube.favorites.", "sub-1"))
                .thenReturn("youtube.favorites.alice");

        YoutubeFavoritesDto saved = service.removeFavorite("sub-1", "abc123XYZ01", "video");
        assertEquals(1, saved.getItems().size());
        assertEquals("playlist", saved.getItems().get(0).kind());
    }

    @Test
    void normalizeDropsJavascriptThumbnail() {
        YoutubeItemDto item = new YoutubeItemDto(
                "dQw4w9WgXcQ",
                "video",
                "Rick",
                null,
                "Channel",
                "UCabc",
                null,
                "javascript:alert(1)",
                "PT3M",
                12L,
                "none");
        YoutubeItemDto n = YoutubeFavoritesService.normalizeItem(item);
        assertNull(n.thumbnailUrl());
        assertEquals("dQw4w9WgXcQ", n.id());
    }

    @Test
    void favoriteKeyCombinesKindAndId() {
        YoutubeItemDto item = YoutubeFavoritesService.normalizeItem(
                sample("UCchannelId01", "CHANNEL", "A channel"));
        assertEquals("channel|UCchannelId01", YoutubeFavoritesService.favoriteKey(item));
    }

    private static YoutubeItemDto sample(String id, String kind, String title) {
        return new YoutubeItemDto(
                id,
                kind,
                title,
                "desc",
                "Channel",
                "UCabcdef",
                "2024-01-01T00:00:00Z",
                "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
                "PT4M13S",
                100L,
                "none");
    }
}
