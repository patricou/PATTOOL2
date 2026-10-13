package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.MailController;
import com.pat.controller.dto.ClockAlarmDto;
import com.pat.controller.dto.ClockPreferencesDto;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.AppParameter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ClockPreferenceServiceTest {

    @Mock
    private AppParameterService appParameterService;
    @Mock
    private UserOwnerService userOwnerService;
    @Mock
    private MembersRepository membersRepository;
    @Mock
    private MailController mailController;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private ClockPreferenceService service;

    @BeforeEach
    void setUp() {
        service = new ClockPreferenceService(
                appParameterService, objectMapper, userOwnerService, membersRepository, mailController);
    }

    @Test
    void lookStaysNeutralWhenMissingAndClampsWhenOutOfRange() throws Exception {
        AppParameter row = new AppParameter(
                "clock.preferences.alice",
                "{\"faceId\":\"cobalt\",\"timeZone\":\"\",\"alarms\":[]}",
                AppParameter.TYPE_JSON,
                "test");
        when(userOwnerService.findParam("clock.preferences.", "sub")).thenReturn(Optional.of(row));
        ClockPreferencesDto found = service.findForSubject("sub");
        assertEquals("cobalt", found.getFaceId());
        assertEquals(100, found.getContrast());
        assertEquals(100, found.getReflection());

        when(userOwnerService.writeKey("clock.preferences.", "sub")).thenReturn("clock.preferences.alice");
        ClockPreferencesDto body = new ClockPreferencesDto();
        body.setFaceId("ruby");
        body.setContrast(900);
        body.setBrightness(10);
        body.setReflection(0);
        body.setBrilliance(150);
        ClockPreferencesDto saved = service.saveForSubject("sub", body, null);
        assertEquals("ruby", saved.getFaceId());
        assertEquals(170, saved.getContrast());
        assertEquals(50, saved.getBrightness());
        assertEquals(0, saved.getReflection());
        assertEquals(100, saved.getIntensity());
        assertEquals(150, saved.getBrilliance());
    }

    @Test
    void normalizeFaceAndZone() {
        assertEquals("classic", ClockPreferenceService.normalizeFace("nope"));
        assertEquals("lcd-green", ClockPreferenceService.normalizeFace("LCD-GREEN"));
        assertEquals("", ClockPreferenceService.normalizeZone("Not/AZone"));
        assertEquals("Europe/Paris", ClockPreferenceService.normalizeZone(" Europe/Paris "));
        assertEquals("", ClockPreferenceService.normalizeZone(""));
    }

    @Test
    void isDueOnlyInsideTheMinuteWindow() {
        ZonedDateTime at = ZonedDateTime.of(2026, 10, 12, 7, 30, 20, 0, ZoneId.of("Europe/Paris"));
        assertTrue(ClockPreferenceService.isDue(at, 7, 30, ""));
        assertFalse(ClockPreferenceService.isDue(at, 7, 30, "2026-10-12"));
        assertFalse(ClockPreferenceService.isDue(at, 7, 31, ""));
        ZonedDateTime late = at.withSecond(0).plusSeconds(90);
        assertFalse(ClockPreferenceService.isDue(late, 7, 30, ""));
    }

    @Test
    void saveKeepsServerLastFiredDate() throws Exception {
        ClockAlarmDto stored = alarm("a1", 7, 30, "email");
        stored.setLastFiredDate("2026-10-12");
        ClockPreferencesDto previous = new ClockPreferencesDto();
        previous.setFaceId("noir");
        previous.setTimeZone("Europe/Paris");
        previous.setAlarms(List.of(stored));
        AppParameter row = new AppParameter(
                "clock.preferences.alice",
                objectMapper.writeValueAsString(previous),
                AppParameter.TYPE_JSON,
                "test");
        when(userOwnerService.findParam("clock.preferences.", "sub")).thenReturn(Optional.of(row));
        when(userOwnerService.writeKey("clock.preferences.", "sub")).thenReturn("clock.preferences.alice");

        ClockAlarmDto incoming = alarm("a1", 7, 30, "email");
        incoming.setLastFiredDate("");
        ClockPreferencesDto body = new ClockPreferencesDto();
        body.setFaceId("gold");
        body.setTimeZone("Europe/Paris");
        body.setNotifyEmail("evil@example.com");
        body.setAlarms(List.of(incoming));

        ClockPreferencesDto saved = service.saveForSubject("sub", body, "user@example.com");

        assertEquals("gold", saved.getFaceId());
        assertEquals("user@example.com", saved.getNotifyEmail());
        assertEquals("2026-10-12", saved.getAlarms().get(0).getLastFiredDate());
        verify(userOwnerService).dropAliasKeys("clock.preferences.", "sub");
    }

    @Test
    void emailAlarmSendsOnceInsideWindow() throws Exception {
        ClockAlarmDto alarm = alarm("a1", 7, 30, "email");
        alarm.setLabel("Réveil");
        ClockPreferencesDto prefs = new ClockPreferencesDto();
        prefs.setFaceId("classic");
        prefs.setTimeZone("Europe/Paris");
        prefs.setNotifyEmail("user@example.com");
        prefs.setAlarms(List.of(alarm));
        AppParameter row = new AppParameter(
                "clock.preferences.alice",
                objectMapper.writeValueAsString(prefs),
                AppParameter.TYPE_JSON,
                "test");
        ZonedDateTime now = ZonedDateTime.of(2026, 10, 12, 5, 30, 15, 0, ZoneId.of("UTC"));

        int sent = service.fireOne(row, now, new HashSet<>());

        assertEquals(1, sent);
        verify(mailController).sendMailToRecipient(eq("user@example.com"), anyString(), anyString(), eq(true));
        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(appParameterService).setJson(eq("clock.preferences.alice"), json.capture(), anyString());
        assertTrue(json.getValue().contains("2026-10-12"));

        AppParameter updated = new AppParameter(
                row.getParamKey(), json.getValue(), AppParameter.TYPE_JSON, "test");
        int again = service.fireOne(updated, now, new HashSet<>());
        assertEquals(0, again);
        verify(mailController).sendMailToRecipient(anyString(), anyString(), anyString(), eq(true));
    }

    @Test
    void blankTimeZoneDoesNotSend() throws Exception {
        ClockAlarmDto alarm = alarm("a1", 7, 30, "email");
        ClockPreferencesDto prefs = new ClockPreferencesDto();
        prefs.setTimeZone("");
        prefs.setNotifyEmail("user@example.com");
        prefs.setAlarms(List.of(alarm));
        AppParameter row = new AppParameter(
                "clock.preferences.alice",
                objectMapper.writeValueAsString(prefs),
                AppParameter.TYPE_JSON,
                "test");
        ZonedDateTime now = ZonedDateTime.of(2026, 10, 12, 7, 30, 10, 0, ZoneId.of("Europe/Paris"));

        assertEquals(0, service.fireOne(row, now, new HashSet<>()));
        verify(mailController, never()).sendMailToRecipient(anyString(), anyString(), anyString(), eq(true));
    }

    private static ClockAlarmDto alarm(String id, int hour, int minute, String channel) {
        ClockAlarmDto alarm = new ClockAlarmDto();
        alarm.setId(id);
        alarm.setHour(hour);
        alarm.setMinute(minute);
        alarm.setChannel(channel);
        alarm.setEnabled(true);
        return alarm;
    }
}
