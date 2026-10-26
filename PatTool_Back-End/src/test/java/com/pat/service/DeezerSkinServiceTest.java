package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DeezerSkinServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private DeezerSkinService service;

    @BeforeEach
    void setUp() {
        service = new DeezerSkinService(appParameterService, userOwnerService);
    }

    @Test
    void findForSubjectReturnsNullWhenMissing() {
        when(userOwnerService.findParam("deezer.skin.", "sub-1")).thenReturn(Optional.empty());
        assertNull(service.findForSubject("sub-1"));
    }

    @Test
    void findForSubjectIgnoresUnknownStoredValue() {
        AppParameter row = new AppParameter();
        row.setParamValue("sleeve");
        when(userOwnerService.findParam("deezer.skin.", "sub-1")).thenReturn(Optional.of(row));
        assertNull(service.findForSubject("sub-1"));
    }

    @Test
    void saveForSubjectPersistsNormalizedSkin() {
        when(userOwnerService.writeKey("deezer.skin.", "sub-1")).thenReturn("deezer.skin.patricou");

        assertEquals("spaceage", service.saveForSubject("sub-1", " SpaceAge "));

        verify(appParameterService).setString(eq("deezer.skin.patricou"), eq("spaceage"), anyString());
        verify(userOwnerService).dropAliasKeys("deezer.skin.", "sub-1");
    }

    @Test
    void saveForSubjectRejectsUnknownSkin() {
        assertThrows(IllegalArgumentException.class, () -> service.saveForSubject("sub-1", "nope"));
    }
}
