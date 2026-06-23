package com.pat.service;

import com.pat.controller.dto.TimezoneConvertResponseDto;
import com.pat.controller.dto.TimezoneInstantDto;
import com.pat.controller.dto.TimezoneZoneDto;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.stream.Collectors;

/**
 * Server-side IANA time-zone conversions (java.time).
 */
@Service
public class TimezoneService {

    private static final DateTimeFormatter LOCAL_INPUT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;
    private static final DateTimeFormatter DISPLAY = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final DateTimeFormatter ZONE_ABBR = DateTimeFormatter.ofPattern("z", Locale.ENGLISH);
    private static final int MAX_TARGET_ZONES = 20;

    public List<TimezoneZoneDto> listZones(Instant at) {
        Instant reference = at != null ? at : Instant.now();
        return ZoneId.getAvailableZoneIds().stream()
                .sorted()
                .map(id -> toZoneDto(id, reference))
                .collect(Collectors.toList());
    }

    /**
     * Reference instant for zone abbreviations: explicit UTC instant, or local date-time in a zone.
     */
    public Instant resolveReferenceInstant(String at, String localDateTime, String zoneId) {
        if (StringUtils.hasText(at)) {
            return Instant.parse(at.trim());
        }
        if (StringUtils.hasText(localDateTime) && StringUtils.hasText(zoneId)) {
            LocalDateTime parsed = LocalDateTime.parse(localDateTime.trim(), LOCAL_INPUT);
            return parsed.atZone(parseZone(zoneId)).toInstant();
        }
        return Instant.now();
    }

    public TimezoneInstantDto now(String zoneId) {
        ZoneId zone = parseZone(zoneId);
        ZonedDateTime now = ZonedDateTime.now(zone);
        return toInstantDto(now, null);
    }

    public TimezoneConvertResponseDto convert(String localDateTime, String fromZoneId, List<String> toZoneIds) {
        if (!StringUtils.hasText(localDateTime) || !StringUtils.hasText(fromZoneId) || toZoneIds == null || toZoneIds.isEmpty()) {
            return null;
        }

        LocalDateTime parsed;
        try {
            parsed = LocalDateTime.parse(localDateTime.trim(), LOCAL_INPUT);
        } catch (DateTimeParseException ex) {
            return null;
        }

        ZoneId fromZone = parseZone(fromZoneId);
        ZonedDateTime source;
        try {
            source = parsed.atZone(fromZone);
        } catch (DateTimeException ex) {
            return null;
        }

        Set<String> uniqueTargets = new LinkedHashSet<>();
        for (String target : toZoneIds) {
            if (StringUtils.hasText(target)) {
                uniqueTargets.add(target.trim());
            }
            if (uniqueTargets.size() >= MAX_TARGET_ZONES) {
                break;
            }
        }
        if (uniqueTargets.isEmpty()) {
            return null;
        }

        LocalDate sourceDate = source.toLocalDate();
        List<TimezoneInstantDto> outputs = new ArrayList<>();
        for (String targetId : uniqueTargets) {
            ZoneId targetZone = parseZone(targetId);
            ZonedDateTime target = source.withZoneSameInstant(targetZone);
            TimezoneInstantDto dto = toInstantDto(target, sourceDate);
            outputs.add(dto);
        }

        TimezoneConvertResponseDto response = new TimezoneConvertResponseDto();
        response.setInput(toInstantDto(source, null));
        response.setOutputs(outputs);
        response.setInstantUtc(source.toInstant().toString());
        return response;
    }

    private static ZoneId parseZone(String id) {
        if (!StringUtils.hasText(id)) {
            throw new DateTimeException("empty zone");
        }
        return ZoneId.of(id.trim());
    }

    private static TimezoneZoneDto toZoneDto(String id, Instant at) {
        ZoneId zone = ZoneId.of(id);
        ZonedDateTime zdt = ZonedDateTime.ofInstant(at, zone);
        ZoneOffset offset = zdt.getOffset();
        String offsetText = formatOffset(offset);
        String abbr = zoneAbbreviation(zdt);
        TimezoneZoneDto dto = new TimezoneZoneDto();
        dto.setId(id);
        dto.setAbbreviation(abbr);
        dto.setOffset(offsetText);
        dto.setOffsetSeconds(offset.getTotalSeconds());
        dto.setLabel(abbr + " — " + id + " (UTC" + offsetText + ")");
        return dto;
    }

    private static TimezoneInstantDto toInstantDto(ZonedDateTime zdt, LocalDate referenceDate) {
        ZoneOffset offset = zdt.getOffset();
        TimezoneInstantDto dto = new TimezoneInstantDto();
        dto.setDateTime(zdt.format(DISPLAY));
        dto.setZone(zdt.getZone().getId());
        dto.setAbbreviation(zoneAbbreviation(zdt));
        dto.setIso(zdt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME));
        dto.setOffset(formatOffset(offset));
        if (referenceDate != null) {
            dto.setDayDifference((int) ChronoUnit.DAYS.between(referenceDate, zdt.toLocalDate()));
        }
        return dto;
    }

    private static String formatOffset(ZoneOffset offset) {
        String text = offset.getId();
        if ("Z".equals(text)) {
            return "+00:00";
        }
        return text;
    }

    private static String zoneAbbreviation(ZonedDateTime zdt) {
        String legacy = legacyShortAbbreviation(zdt);
        if (isLetterAbbreviation(legacy)) {
            return legacy.toUpperCase(Locale.ENGLISH);
        }
        String formatted = zdt.format(ZONE_ABBR);
        if (isLetterAbbreviation(formatted)) {
            return formatted.toUpperCase(Locale.ENGLISH);
        }
        String inferred = inferCommonAbbreviation(zdt);
        if (isLetterAbbreviation(inferred)) {
            return inferred.toUpperCase(Locale.ENGLISH);
        }
        return formatOffset(zdt.getOffset());
    }

    private static String legacyShortAbbreviation(ZonedDateTime zdt) {
        ZoneId zoneId = zdt.getZone();
        TimeZone tz = TimeZone.getTimeZone(zoneId.getId());
        boolean inDst = zoneId.getRules().isDaylightSavings(zdt.toInstant());
        return tz.getDisplayName(inDst, TimeZone.SHORT, Locale.ENGLISH);
    }

    /**
     * Fallback when JDK returns {@code GMT+02:00} instead of {@code CEST}.
     * Uses offset + region so searches like CEST / EST / IST still work.
     */
    private static String inferCommonAbbreviation(ZonedDateTime zdt) {
        String id = zdt.getZone().getId();
        int sec = zdt.getOffset().getTotalSeconds();

        if ("UTC".equals(id) || id.startsWith("Etc/UTC") || "Etc/GMT".equals(id)) {
            return "UTC";
        }
        if ("Asia/Kolkata".equals(id) || "Asia/Calcutta".equals(id)) {
            return "IST";
        }
        if ("Asia/Tokyo".equals(id)) {
            return "JST";
        }
        if ("Australia/Sydney".equals(id) || "Australia/Melbourne".equals(id)) {
            if (sec == 36_000) {
                return "AEST";
            }
            if (sec == 39_600) {
                return "AEDT";
            }
        }
        if ("Europe/London".equals(id)) {
            if (sec == 0) {
                return "GMT";
            }
            if (sec == 3_600) {
                return "BST";
            }
        }
        if (id.startsWith("Europe/")) {
            if (sec == 3_600) {
                return "CET";
            }
            if (sec == 7_200) {
                return "CEST";
            }
        }
        if (id.startsWith("America/New_York") || id.startsWith("America/Toronto")
                || id.startsWith("America/Detroit") || id.startsWith("America/Montreal")) {
            if (sec == -18_000) {
                return "EST";
            }
            if (sec == -14_400) {
                return "EDT";
            }
        }
        if (id.startsWith("America/Chicago") || id.startsWith("America/Mexico_City")) {
            if (sec == -21_600) {
                return "CST";
            }
            if (sec == -18_000) {
                return "CDT";
            }
        }
        if (id.startsWith("America/Los_Angeles") || id.startsWith("America/Vancouver")) {
            if (sec == -28_800) {
                return "PST";
            }
            if (sec == -25_200) {
                return "PDT";
            }
        }
        return null;
    }

    private static boolean isLetterAbbreviation(String value) {
        if (!StringUtils.hasText(value)) {
            return false;
        }
        String trimmed = value.trim();
        if (trimmed.startsWith("GMT") || trimmed.startsWith("UTC")) {
            return false;
        }
        if (trimmed.charAt(0) == '+' || trimmed.charAt(0) == '-') {
            return false;
        }
        return trimmed.matches("^[A-Za-z]{2,5}$");
    }
}
