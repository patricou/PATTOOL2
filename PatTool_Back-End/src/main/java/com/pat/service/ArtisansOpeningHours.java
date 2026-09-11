package com.pat.service;

import org.springframework.util.StringUtils;

import java.time.DayOfWeek;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lightweight OSM {@code opening_hours} evaluator for "closed right now".
 * Unknown or unparsed specs are treated as not closed.
 */
public final class ArtisansOpeningHours {

    private static final ZoneId PARIS = ZoneId.of("Europe/Paris");
    private static final Pattern TIME_RANGE = Pattern.compile("(\\d{1,2}):(\\d{2})\\s*-\\s*(\\d{1,2}):(\\d{2})");
    private static final Pattern DAY_RANGE = Pattern.compile("(mo|tu|we|th|fr|sa|su)\\s*-\\s*(mo|tu|we|th|fr|sa|su)");
    private static final Pattern DAY_ONE = Pattern.compile("\\b(mo|tu|we|th|fr|sa|su)\\b");
    private static final String[] DAYS = {"mo", "tu", "we", "th", "fr", "sa", "su"};
    private static final int ALL_DAYS = 0b1111111;

    private ArtisansOpeningHours() {
    }

    public static boolean isClosedNow(String spec) {
        return isClosedNow(spec, ZonedDateTime.now(PARIS));
    }

    public static boolean isClosedNow(String spec, ZonedDateTime when) {
        if (!StringUtils.hasText(spec)) {
            return false;
        }
        String folded = spec.trim().toLowerCase(Locale.ROOT)
                .replace('\u2013', '-')
                .replace('\u2014', '-');
        if ("closed".equals(folded) || "off".equals(folded) || folded.contains("permanently closed")) {
            return true;
        }
        if (folded.contains("24/7")) {
            return false;
        }
        Boolean closed = evaluate(folded, when);
        return closed != null && closed;
    }

    private static Boolean evaluate(String spec, ZonedDateTime when) {
        String[] rules = spec.split(";");
        int today = when.getDayOfWeek().getValue() % 7; // ISO 7=Sun → 0 to align with DAYS[0]=mo ... wait
        // DAYS: mo=0 ... su=6. ISO: Mon=1 ... Sun=7
        int todayIdx = when.getDayOfWeek() == DayOfWeek.SUNDAY ? 6 : when.getDayOfWeek().getValue() - 1;
        LocalTime clock = when.toLocalTime();
        boolean parsed = false;
        boolean open = false;
        boolean todayRule = false;
        for (String raw : rules) {
            String rule = raw.trim();
            if (rule.isEmpty() || rule.startsWith("ph") || rule.startsWith("sh")) {
                continue;
            }
            parsed = true;
            int days = parseDays(rule);
            if ((days & (1 << todayIdx)) == 0) {
                continue;
            }
            todayRule = true;
            if (rule.contains("off") || rule.matches(".*\\bclosed\\b.*") && !TIME_RANGE.matcher(rule).find()) {
                open = false;
                continue;
            }
            Matcher times = TIME_RANGE.matcher(rule);
            boolean hasTime = false;
            boolean inRange = false;
            while (times.find()) {
                hasTime = true;
                LocalTime start = time(times.group(1), times.group(2));
                LocalTime end = time(times.group(3), times.group(4));
                if (start == null || end == null) {
                    continue;
                }
                if (inTimeRange(clock, start, end)) {
                    inRange = true;
                    break;
                }
            }
            if (hasTime) {
                open = inRange;
            }
        }
        if (!parsed) {
            return null;
        }
        if (!todayRule) {
            return true;
        }
        return !open;
    }

    private static int parseDays(String rule) {
        int mask = 0;
        Matcher ranges = DAY_RANGE.matcher(rule);
        while (ranges.find()) {
            int from = dayIndex(ranges.group(1));
            int to = dayIndex(ranges.group(2));
            if (from < 0 || to < 0) {
                continue;
            }
            int d = from;
            while (true) {
                mask |= 1 << d;
                if (d == to) {
                    break;
                }
                d = (d + 1) % 7;
            }
        }
        Matcher ones = DAY_ONE.matcher(rule);
        while (ones.find()) {
            int idx = dayIndex(ones.group(1));
            if (idx >= 0) {
                mask |= 1 << idx;
            }
        }
        return mask == 0 ? ALL_DAYS : mask;
    }

    private static int dayIndex(String token) {
        for (int i = 0; i < DAYS.length; i++) {
            if (DAYS[i].equals(token)) {
                return i;
            }
        }
        return -1;
    }

    private static LocalTime time(String hour, String minute) {
        try {
            int h = Integer.parseInt(hour);
            int m = Integer.parseInt(minute);
            if (h == 24 && m == 0) {
                return LocalTime.MIDNIGHT;
            }
            return LocalTime.of(h, m);
        } catch (Exception ex) {
            return null;
        }
    }

    private static boolean inTimeRange(LocalTime clock, LocalTime start, LocalTime end) {
        if (end.equals(LocalTime.MIDNIGHT) && start.equals(LocalTime.MIDNIGHT)) {
            return true;
        }
        if (!end.isAfter(start)) {
            return !clock.isBefore(start) || clock.isBefore(end);
        }
        return !clock.isBefore(start) && clock.isBefore(end);
    }
}
