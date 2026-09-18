package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AudioEqualizerPreferenceDto;
import com.pat.controller.dto.AudioEqualizerSettingsDto;
import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AudioEqualizerPreferenceServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private AudioEqualizerPreferenceService service;

    @BeforeEach
    void setUp() {
        service = new AudioEqualizerPreferenceService(appParameterService, objectMapper, userOwnerService);
    }

    @Test
    void findForSubjectReturnsEmptyWhenMissing() {
        when(userOwnerService.findParam("audio.equalizer.", "sub-1")).thenReturn(Optional.empty());
        AudioEqualizerPreferenceDto dto = service.findForSubject("sub-1");
        assertNull(dto.getSettings());
        assertNull(dto.getUserPreset());
    }

    @Test
    void saveForSubjectPersistsNormalizedSnapshot() {
        when(userOwnerService.writeKey("audio.equalizer.", "sub-1"))
                .thenReturn("audio.equalizer.alice");

        AudioEqualizerSettingsDto settings = new AudioEqualizerSettingsDto();
        settings.setBass(8d);
        settings.setEcho(2d);
        settings.setBands(List.of(1d, 2d));
        settings.setPreset("mine");
        AudioEqualizerPreferenceDto saved = service.saveForSubject(
                "sub-1", new AudioEqualizerPreferenceDto(settings, settings, null));

        assertNotNull(saved.getSettings());
        assertEquals(8d, saved.getSettings().getBass());
        assertEquals(1d, saved.getSettings().getEcho());
        assertEquals(10, saved.getSettings().getBands().size());
        assertEquals("mine", saved.getSettings().getPreset());
        assertTrue(Boolean.TRUE.equals(saved.getPersisted()));
        verify(appParameterService).setJson(eq("audio.equalizer.alice"), anyString(), anyString());
        verify(userOwnerService).dropAliasKeys("audio.equalizer.", "sub-1");
    }

    @Test
    void findForSubjectReadsStoredJson() throws Exception {
        AudioEqualizerSettingsDto mine = new AudioEqualizerSettingsDto();
        mine.setPreset("mine");
        mine.setBass(4d);
        AppParameter row = new AppParameter();
        row.setParamValue(objectMapper.writeValueAsString(new AudioEqualizerPreferenceDto(null, mine, null)));
        when(userOwnerService.findParam("audio.equalizer.", "sub-1")).thenReturn(Optional.of(row));

        AudioEqualizerPreferenceDto dto = service.findForSubject("sub-1");
        assertNull(dto.getSettings());
        assertNotNull(dto.getUserPreset());
        assertEquals("mine", dto.getUserPreset().getPreset());
        assertEquals(4d, dto.getUserPreset().getBass());
        assertTrue(Boolean.TRUE.equals(dto.getPersisted()));
    }
}
