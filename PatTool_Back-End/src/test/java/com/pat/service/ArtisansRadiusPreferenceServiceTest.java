package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.ArtisansPreferencesDto;
import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ArtisansRadiusPreferenceServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private ArtisansRadiusPreferenceService service;

    @BeforeEach
    void setUp() {
        service = new ArtisansRadiusPreferenceService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void findForSubjectDefaultsToTenWhenMissing() {
        when(userOwnerService.findParam("artisans.preferences.", "sub-1")).thenReturn(Optional.empty());
        ArtisansPreferencesDto dto = service.findForSubject("sub-1");
        assertEquals(10, dto.getRadiusKm());
        assertEquals(500, dto.getPerPage());
        assertFalse(dto.isMapListOnly());
    }

    @Test
    void findForSubjectReadsStoredRadius() {
        AppParameter row = new AppParameter();
        row.setParamValue("{\"radiusKm\":25}");
        when(userOwnerService.findParam("artisans.preferences.", "sub-1")).thenReturn(Optional.of(row));
        ArtisansPreferencesDto dto = service.findForSubject("sub-1");
        assertEquals(25, dto.getRadiusKm());
        assertEquals(500, dto.getPerPage());
        assertFalse(dto.isMapListOnly());
    }

    @Test
    void findForSubjectReadsPageSizeAndMapFlag() {
        AppParameter row = new AppParameter();
        row.setParamValue("{\"radiusKm\":12,\"perPage\":50,\"mapListOnly\":true}");
        when(userOwnerService.findParam("artisans.preferences.", "sub-1")).thenReturn(Optional.of(row));
        ArtisansPreferencesDto dto = service.findForSubject("sub-1");
        assertEquals(12, dto.getRadiusKm());
        assertEquals(50, dto.getPerPage());
        assertTrue(dto.isMapListOnly());
    }

    @Test
    void saveClampsAndPersistsUnderUsernameKey() throws Exception {
        when(userOwnerService.writeKey("artisans.preferences.", "sub-1"))
                .thenReturn("artisans.preferences.alice");

        ArtisansPreferencesDto incoming = new ArtisansPreferencesDto(80, 40, true);
        ArtisansPreferencesDto saved = service.saveForSubject("sub-1", incoming);

        assertEquals(50, saved.getRadiusKm());
        assertEquals(50, saved.getPerPage());
        assertTrue(saved.isMapListOnly());
        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(appParameterService).setJson(
                eq("artisans.preferences.alice"),
                json.capture(),
                anyString());
        JsonNode node = objectMapper.readTree(json.getValue());
        assertEquals(50, node.path("radiusKm").asInt());
        assertEquals(50, node.path("perPage").asInt());
        assertTrue(node.path("mapListOnly").asBoolean());
        verify(userOwnerService).dropAliasKeys("artisans.preferences.", "sub-1");
    }
}
