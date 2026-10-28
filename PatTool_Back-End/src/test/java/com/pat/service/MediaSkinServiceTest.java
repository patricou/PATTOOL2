package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Date;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class MediaSkinServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;

    private MediaSkinService service;

    @BeforeEach
    void setUp() {
        service = new MediaSkinService(appParameterService, userOwnerService);
    }

    @Test
    void findForSubjectReturnsNullWhenMissing() {
        when(userOwnerService.findParam(anyString(), eq("sub-1"))).thenReturn(Optional.empty());

        assertNull(service.findForSubject("sub-1"));

        verify(userOwnerService, never()).writeKey(anyString(), anyString());
    }

    @Test
    void findForSubjectReturnsSharedSkin() {
        when(userOwnerService.findParam(MediaSkinService.PARAM_KEY_PREFIX, "sub-1"))
                .thenReturn(Optional.of(param(" SpaceAge ", 5_000L)));

        assertEquals("spaceage", service.findForSubject("sub-1"));

        verify(userOwnerService, never()).findParam("tv.skin.", "sub-1");
        verify(userOwnerService, never()).writeKey(anyString(), anyString());
        verify(userOwnerService).deleteParams("tv.skin.", "sub-1");
        verify(userOwnerService).deleteParams("radio.skin.", "sub-1");
        verify(userOwnerService).deleteParams("deezer.skin.", "sub-1");
    }

    @Test
    void findForSubjectPromotesNewestLegacySkin() {
        when(userOwnerService.findParam(MediaSkinService.PARAM_KEY_PREFIX, "sub-1")).thenReturn(Optional.empty());
        when(userOwnerService.findParam("tv.skin.", "sub-1")).thenReturn(Optional.of(param("noir", 1_000L)));
        when(userOwnerService.findParam("radio.skin.", "sub-1")).thenReturn(Optional.of(param("aurora", 3_000L)));
        when(userOwnerService.findParam("deezer.skin.", "sub-1")).thenReturn(Optional.of(param("sleeve", 9_000L)));
        when(userOwnerService.writeKey(anyString(), eq("sub-1")))
                .thenAnswer(invocation -> invocation.getArgument(0) + "patricou");

        assertEquals("aurora", service.findForSubject("sub-1"));

        verify(appParameterService).setString(eq("media.skin.patricou"), eq("aurora"), anyString());
        verify(appParameterService, never()).setString(eq("tv.skin.patricou"), anyString(), anyString());
        verify(userOwnerService).dropAliasKeys(MediaSkinService.PARAM_KEY_PREFIX, "sub-1");
        verify(userOwnerService).deleteParams("tv.skin.", "sub-1");
        verify(userOwnerService).deleteParams("radio.skin.", "sub-1");
        verify(userOwnerService).deleteParams("deezer.skin.", "sub-1");
    }

    @Test
    void saveForSubjectPersistsNormalizedSkinOnEveryPage() {
        when(userOwnerService.writeKey(anyString(), eq("sub-1")))
                .thenAnswer(invocation -> invocation.getArgument(0) + "patricou");

        assertEquals("spaceage", service.saveForSubject("sub-1", " SpaceAge "));

        verify(appParameterService).setString(eq("media.skin.patricou"), eq("spaceage"), anyString());
        verify(appParameterService, never()).setString(eq("radio.skin.patricou"), anyString(), anyString());
        verify(userOwnerService).deleteParams("tv.skin.", "sub-1");
        verify(userOwnerService).deleteParams("radio.skin.", "sub-1");
        verify(userOwnerService).deleteParams("deezer.skin.", "sub-1");
    }

    @Test
    void saveForSubjectRejectsUnknownSkin() {
        assertThrows(IllegalArgumentException.class, () -> service.saveForSubject("sub-1", "nope"));
        verify(userOwnerService, never()).writeKey(anyString(), anyString());
    }

    private static AppParameter param(String value, long modified) {
        AppParameter row = new AppParameter();
        row.setParamValue(value);
        row.setDateModification(new Date(modified));
        return row;
    }
}
