package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.MailController;
import com.pat.controller.dto.ClockAlarmDto;
import com.pat.controller.dto.ClockPreferencesDto;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.AppParameter;
import com.pat.repo.domain.Member;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.DateTimeException;
import java.time.Duration;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Per-user clock preferences in {@code appParameters}
 * under {@code clock.preferences.<username>}.
 * Email alarms are sent by a scheduler even when the page is closed.
 * An empty time zone means "use the browser zone" and is not fired server-side.
 */
@Service
public class ClockPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(ClockPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "clock.preferences.";
    static final String DEFAULT_FACE = "classic";
    static final String DESCRIPTION = "Clock: per-user face, time zone and alarms (JSON).";

    private static final Set<String> FACES = Set.of(
            "classic", "roman", "noir", "gold", "sport", "minimal",
            "aurora", "skeleton", "deco", "constellation", "regulator", "bauhaus", "guilloche",
            "marine", "rail", "metro", "obsidian", "sakura", "desert", "abyss", "arcade",
            "cathedral", "radar", "marble", "ink", "circuit", "lunar", "flame", "prism",
            "aviator", "forest", "chess", "orbit",
            "ripple", "gears", "compass", "vinyl", "eclipse", "ecg", "fan", "labyrinth",
            "burst-silver", "burst-green", "burst-blue", "burst-sand", "burst-ink",
            "chrono-green", "chrono-silver", "gousset",
            "diver-blue", "chrono-gold", "field-cream", "chrono-slate", "chrono-blue",
            "dress-navy", "chrono-black", "lcd-led", "lcd-module", "lcd-dive",
            "lcd-resin", "lcd-round",
            "board-green", "board-amber", "board-blue", "board-light",
            "smart-oled", "smart-sport", "smart-sand", "smart-night", "ultra-orange",
            "hybrid-green", "hybrid-amber", "hybrid-blue",
            "hybrid-night", "hybrid-chrono", "hybrid-radar", "hybrid-sakura", "hybrid-orbit", "hybrid-deco",
            "lcd-green", "lcd-amber", "lcd-blue", "lcd-light", "lcd-red", "lcd-white", "lcd-pink",
            "lcd-sharp", "lcd-sharp-black",
            "sharp-silver", "sharp-gold", "sharp-black", "hybrid-sharp",
            "quartz", "quartz-date", "quartz-black", "quartz-gold", "quartz-field",
            "quartz-serif", "quartz-mono", "quartz-script", "quartz-narrow", "quartz-gothic", "quartz-heavy",
            "cobalt", "ruby", "emerald", "copper", "indigo", "olive", "wine", "petrol", "plum", "lava",
            "pine", "graphite", "brass", "saffron", "navy-ink", "moss", "rust", "lagoon", "onyx", "garnet",
            "nixie");

    private static final DateTimeFormatter HM = DateTimeFormatter.ofPattern("HH:mm");

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;
    private final MembersRepository membersRepository;
    private final MailController mailController;
    private final AtomicBoolean firing = new AtomicBoolean(false);

    public ClockPreferenceService(
            AppParameterService appParameterService,
            ObjectMapper objectMapper,
            UserOwnerService userOwnerService,
            MembersRepository membersRepository,
            MailController mailController) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
        this.membersRepository = membersRepository;
        this.mailController = mailController;
    }

    public ClockPreferencesDto findForSubject(String jwtSubject) {
        AppParameter row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject).orElse(null);
        if (row == null || !StringUtils.hasText(row.getParamValue())) {
            return defaults();
        }
        return parse(row.getParamValue());
    }

    public ClockPreferencesDto saveForSubject(String jwtSubject, ClockPreferencesDto body, String jwtEmail) {
        ClockPreferencesDto previous = findForSubject(jwtSubject);
        ClockPreferencesDto saved = new ClockPreferencesDto();
        saved.setFaceId(normalizeFace(body == null ? null : body.getFaceId()));
        saved.setTimeZone(normalizeZone(body == null ? null : body.getTimeZone()));
        saved.setAlarms(normalizeAlarms(
                body == null ? null : body.getAlarms(),
                previous.getAlarms()));
        applyLook(saved, body);
        saved.setNotifyEmail(resolveEmail(jwtSubject, firstEmail(jwtEmail, previous.getNotifyEmail())));
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            appParameterService.setJson(key, objectMapper.writeValueAsString(saved), DESCRIPTION);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization clock preferences", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        return saved;
    }

    /** Sends due email alarms. Ring alarms stay in the browser. */
    @Scheduled(fixedDelay = 20_000L, initialDelay = 45_000L)
    public void fireDueEmailAlarms() {
        if (!firing.compareAndSet(false, true)) {
            return;
        }
        try {
            ZonedDateTime now = ZonedDateTime.now(ZoneId.of("UTC"));
            Set<String> sent = new HashSet<>();
            for (AppParameter row : appParameterService.findByParamKeyStartingWith(PARAM_KEY_PREFIX)) {
                try {
                    fireOne(row, now, sent);
                } catch (RuntimeException e) {
                    log.warn("Clock email alarm skipped for {}: {}", row.getParamKey(), e.getMessage());
                }
            }
        } finally {
            firing.set(false);
        }
    }

    /**
     * @return number of messages handed to the mailer for this row
     */
    int fireOne(AppParameter row, ZonedDateTime now, Set<String> sentKeys) {
        if (row == null || !StringUtils.hasText(row.getParamKey())
                || !row.getParamKey().startsWith(PARAM_KEY_PREFIX)
                || !StringUtils.hasText(row.getParamValue())) {
            return 0;
        }
        ClockPreferencesDto prefs = parse(row.getParamValue());
        String zoneId = normalizeZone(prefs.getTimeZone());
        if (zoneId.isEmpty() || prefs.getAlarms() == null || prefs.getAlarms().isEmpty()) {
            return 0;
        }
        ZonedDateTime local = now.withZoneSameInstant(ZoneId.of(zoneId));
        String today = local.toLocalDate().toString();
        String suffix = row.getParamKey().substring(PARAM_KEY_PREFIX.length());
        String email = resolveEmail(suffix, prefs.getNotifyEmail());
        boolean changed = false;
        int sent = 0;
        for (ClockAlarmDto alarm : prefs.getAlarms()) {
            if (alarm == null || !alarm.isEnabled() || !"email".equals(alarm.getChannel())) {
                continue;
            }
            if (!isDue(local, alarm.getHour(), alarm.getMinute(), alarm.getLastFiredDate())) {
                continue;
            }
            alarm.setLastFiredDate(today);
            changed = true;
            if (!looksLikeEmail(email)) {
                log.warn("Clock email alarm {} has no recipient ({})", alarm.getId(), suffix);
                continue;
            }
            String dedupe = email.toLowerCase(Locale.ROOT) + "|" + alarm.getId() + "|" + today;
            if (sentKeys.add(dedupe)) {
                sendAlarmMail(email, alarm, local);
                sent++;
            }
        }
        if (changed) {
            prefs.setNotifyEmail(email);
            writeRow(row.getParamKey(), prefs);
        }
        return sent;
    }

    /**
     * True when {@code now} is within 90 seconds after today's alarm instant
     * and the alarm has not already fired on that local date.
     */
    public static boolean isDue(ZonedDateTime now, int hour, int minute, String lastFiredDate) {
        if (now == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return false;
        }
        ZonedDateTime alarmAt = now.withHour(hour).withMinute(minute).withSecond(0).withNano(0);
        if (alarmAt.isAfter(now)) {
            return false;
        }
        long late = Duration.between(alarmAt, now).getSeconds();
        if (late < 0 || late >= 90) {
            return false;
        }
        String today = now.toLocalDate().toString();
        return !today.equals(normalizeDate(lastFiredDate));
    }

    static String normalizeFace(String faceId) {
        if (faceId == null) {
            return DEFAULT_FACE;
        }
        String id = faceId.trim().toLowerCase(Locale.ROOT);
        return FACES.contains(id) ? id : DEFAULT_FACE;
    }

    static String normalizeZone(String zone) {
        if (!StringUtils.hasText(zone)) {
            return "";
        }
        String z = zone.trim();
        if (z.length() > 80) {
            return "";
        }
        try {
            ZoneId.of(z);
            return z;
        } catch (DateTimeException e) {
            return "";
        }
    }

    private void sendAlarmMail(String email, ClockAlarmDto alarm, ZonedDateTime local) {
        String hm = local.format(HM);
        String label = alarm.getLabel() == null ? "" : alarm.getLabel().trim();
        String subject = label.isEmpty()
                ? "PatTool — Alarme " + hm
                : "PatTool — Alarme " + hm + " — " + label;
        String safeLabel = esc(label.isEmpty() ? "Alarme" : label);
        String zone = esc(local.getZone().getId());
        String html = "<p>Votre alarme <strong>" + safeLabel + "</strong> ("
                + esc(hm) + ", " + zone + ") s'est déclenchée.</p>"
                + "<p>PatTool — Horloge</p>";
        mailController.sendMailToRecipient(email, subject, html, true);
    }

    private void writeRow(String key, ClockPreferencesDto prefs) {
        try {
            appParameterService.setJson(key, objectMapper.writeValueAsString(prefs), DESCRIPTION);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization clock preferences", e);
        }
    }

    private ClockPreferencesDto parse(String raw) {
        try {
            ClockPreferencesDto dto = objectMapper.readValue(raw, ClockPreferencesDto.class);
            if (dto == null) {
                return defaults();
            }
            ClockPreferencesDto out = new ClockPreferencesDto();
            out.setFaceId(normalizeFace(dto.getFaceId()));
            out.setTimeZone(normalizeZone(dto.getTimeZone()));
            out.setNotifyEmail(looksLikeEmail(dto.getNotifyEmail()) ? dto.getNotifyEmail().trim() : "");
            out.setAlarms(normalizeAlarms(dto.getAlarms(), List.of()));
            applyLook(out, dto);
            return out;
        } catch (JsonProcessingException e) {
            log.debug("clock.preferences unreadable JSON: {}", e.getMessage());
            return defaults();
        }
    }

    private static ClockPreferencesDto defaults() {
        ClockPreferencesDto dto = new ClockPreferencesDto();
        applyLook(dto, null);
        return dto;
    }

    static List<ClockAlarmDto> normalizeAlarms(List<ClockAlarmDto> incoming, List<ClockAlarmDto> previous) {
        Map<String, String> prevFired = new LinkedHashMap<>();
        if (previous != null) {
            for (ClockAlarmDto prev : previous) {
                if (prev != null && StringUtils.hasText(prev.getId())) {
                    prevFired.put(prev.getId().trim(), normalizeDate(prev.getLastFiredDate()));
                }
            }
        }
        List<ClockAlarmDto> out = new ArrayList<>();
        if (incoming == null) {
            return out;
        }
        Set<String> seen = new HashSet<>();
        for (ClockAlarmDto raw : incoming) {
            if (raw == null || out.size() >= 24) {
                continue;
            }
            String id = raw.getId() == null ? "" : raw.getId().trim();
            if (!id.matches("[A-Za-z0-9_\\-]{1,40}")) {
                id = UUID.randomUUID().toString();
            }
            if (!seen.add(id)) {
                continue;
            }
            ClockAlarmDto alarm = new ClockAlarmDto();
            alarm.setId(id);
            alarm.setHour(clamp(raw.getHour(), 0, 23));
            alarm.setMinute(clamp(raw.getMinute(), 0, 59));
            String label = raw.getLabel() == null ? "" : raw.getLabel().trim();
            if (label.length() > 80) {
                label = label.substring(0, 80);
            }
            alarm.setLabel(label);
            String channel = raw.getChannel() == null ? "" : raw.getChannel().trim().toLowerCase(Locale.ROOT);
            alarm.setChannel("email".equals(channel) ? "email" : "ring");
            alarm.setEnabled(raw.isEnabled());
            String fired = normalizeDate(raw.getLastFiredDate());
            String older = prevFired.getOrDefault(id, "");
            if (older.compareTo(fired) > 0) {
                fired = older;
            }
            alarm.setLastFiredDate(fired);
            out.add(alarm);
        }
        return out;
    }

    private String resolveEmail(String ownerHint, String candidate) {
        if (looksLikeEmail(candidate)) {
            return candidate.trim();
        }
        if (!StringUtils.hasText(ownerHint)) {
            return "";
        }
        String key = ownerHint.trim();
        Member member = membersRepository.findByUserName(key);
        if (member == null) {
            member = membersRepository.findByKeycloakId(key);
        }
        if (member == null || !looksLikeEmail(member.getAddressEmail())) {
            return "";
        }
        return member.getAddressEmail().trim();
    }

    private static String firstEmail(String primary, String fallback) {
        if (looksLikeEmail(primary)) {
            return primary.trim();
        }
        return looksLikeEmail(fallback) ? fallback.trim() : "";
    }

    static boolean looksLikeEmail(String value) {
        if (!StringUtils.hasText(value)) {
            return false;
        }
        String v = value.trim();
        int at = v.indexOf('@');
        return at > 0 && at < v.length() - 1 && v.length() <= 200
                && v.indexOf(' ') < 0 && v.indexOf('@', at + 1) < 0;
    }

    static String normalizeDate(String value) {
        if (!StringUtils.hasText(value)) {
            return "";
        }
        String v = value.trim();
        return v.matches("\\d{4}-\\d{2}-\\d{2}") ? v : "";
    }

    private static void applyLook(ClockPreferencesDto target, ClockPreferencesDto source) {
        target.setContrast(normalizeLook(source == null ? null : source.getContrast(), 50, 170));
        target.setBrightness(normalizeLook(source == null ? null : source.getBrightness(), 50, 170));
        target.setReflection(normalizeLook(source == null ? null : source.getReflection(), 0, 200));
        target.setIntensity(normalizeLook(source == null ? null : source.getIntensity(), 0, 200));
        target.setBrilliance(normalizeLook(source == null ? null : source.getBrilliance(), 0, 200));
    }

    /** Missing value stays at the neutral design (100). */
    static int normalizeLook(Integer value, int min, int max) {
        if (value == null) {
            return 100;
        }
        return clamp(value, min, max);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static String esc(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
