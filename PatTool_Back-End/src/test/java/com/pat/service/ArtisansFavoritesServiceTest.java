package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArtisanFavoriteDto;
import com.pat.controller.dto.ArtisansFavoritesDto;
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
class ArtisansFavoritesServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private ArtisansFavoritesService service;

    @BeforeEach
    void setUp() {
        service = new ArtisansFavoritesService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void findForSubjectReturnsEmptyWhenMissing() {
        when(userOwnerService.findParam("artisans.favorites.", "sub-1")).thenReturn(Optional.empty());
        assertTrue(service.findForSubject("sub-1").getItems().isEmpty());
    }

    @Test
    void addFavoritePersistsSnapshotUnderUsernameKey() {
        when(userOwnerService.findParam("artisans.favorites.", "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.writeKey("artisans.favorites.", "sub-1"))
                .thenReturn("artisans.favorites.alice");

        ArtisanFavoriteDto item = sample("12345678901234", "sirene", "Dupont Plomberie");
        ArtisansFavoritesDto saved = service.addFavorite("sub-1", item);

        assertEquals(1, saved.getItems().size());
        assertEquals("12345678901234", saved.getItems().get(0).getId());
        assertEquals("sirene", saved.getItems().get(0).getSource());
        verify(appParameterService).setJson(eq("artisans.favorites.alice"), anyString(), anyString());
        verify(userOwnerService).dropAliasKeys("artisans.favorites.", "sub-1");
    }

    @Test
    void addFavoriteRejectsBlankName() {
        ArtisanFavoriteDto item = sample("node/1", "osm", "  ");
        assertThrows(IllegalArgumentException.class, () -> service.addFavorite("sub-1", item));
    }

    @Test
    void sameIdDifferentSourceAreDistinctFavorites() throws Exception {
        ArtisanFavoriteDto sirene = sample("42", "sirene", "Atelier A");
        ArtisanFavoriteDto osm = sample("42", "osm", "Atelier A OSM");
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new ArtisansFavoritesDto(List.of(sirene))));
        when(userOwnerService.findParam("artisans.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("artisans.favorites.", "sub-1"))
                .thenReturn("artisans.favorites.alice");

        ArtisansFavoritesDto saved = service.addFavorite("sub-1", osm);
        assertEquals(2, saved.getItems().size());
    }

    @Test
    void removeFavoriteUsesIdAndSource() throws Exception {
        ArtisanFavoriteDto sirene = sample("42", "sirene", "Atelier A");
        ArtisanFavoriteDto osm = sample("42", "osm", "Atelier A OSM");
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new ArtisansFavoritesDto(List.of(sirene, osm))));
        when(userOwnerService.findParam("artisans.favorites.", "sub-1")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("artisans.favorites.", "sub-1"))
                .thenReturn("artisans.favorites.alice");

        ArtisansFavoritesDto saved = service.removeFavorite("sub-1", "42", "sirene");
        assertEquals(1, saved.getItems().size());
        assertEquals("osm", saved.getItems().get(0).getSource());
    }

    @Test
    void normalizeDropsJavascriptWebsite() {
        ArtisanFavoriteDto item = sample("1", "sirene", "Atelier");
        item.setWebsite("javascript:alert(1)");
        item.setUrl("https://annuaire-entreprises.data.gouv.fr/etablissement/1");
        ArtisanFavoriteDto n = ArtisansFavoritesService.normalizeItem(item);
        assertNull(n.getWebsite());
        assertEquals("https://annuaire-entreprises.data.gouv.fr/etablissement/1", n.getUrl());
    }

    @Test
    void favoriteKeyCombinesSourceAndId() {
        ArtisanFavoriteDto item = sample("node/9", "OSM", "Pro");
        ArtisanFavoriteDto n = ArtisansFavoritesService.normalizeItem(item);
        assertEquals("osm:node/9", ArtisansFavoritesService.favoriteKey(n));
    }

    private static ArtisanFavoriteDto sample(String id, String source, String name) {
        ArtisanFavoriteDto item = new ArtisanFavoriteDto();
        item.setId(id);
        item.setSource(source);
        item.setName(name);
        item.setCity("Lyon");
        item.setLat(45.75);
        item.setLon(4.85);
        return item;
    }
}
