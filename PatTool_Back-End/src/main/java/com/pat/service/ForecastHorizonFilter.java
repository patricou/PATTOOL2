package com.pat.service;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Filters OpenWeatherMap-like forecast {@code list} entries to a horizon (hours) and step (minutes).
 */
public final class ForecastHorizonFilter {

    /** Daily forecast slots use local civil time (same zone as MF climatology). */
    private static final ZoneId DAILY_SLOT_ZONE = ZoneId.of("Europe/Paris");
    /** Preferred hour for daily forecast samples (14:00 local). */
    private static final int DAILY_SLOT_HOUR = 14;

    private ForecastHorizonFilter() {
    }

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> filterList(
            List<Map<String, Object>> list, int horizonHours, int stepMinutes) {
        if (list == null || list.isEmpty()) {
            return List.of();
        }
        List<Long> slots = slotEpochSeconds(horizonHours, stepMinutes);
        if (slots.isEmpty()) {
            return List.of();
        }
        int step = MeteoFranceForecastPreferenceService.clampStep(stepMinutes);
        long tolerance = (long) step * 60L / 2;

        List<Map<String, Object>> sorted = new ArrayList<>(list);
        sorted.sort(Comparator.comparingLong(ForecastHorizonFilter::epochSeconds));

        List<Map<String, Object>> result = new ArrayList<>();
        for (long slot : slots) {
            Map<String, Object> nearest = nearestItem(sorted, slot, tolerance);
            if (nearest != null) {
                result.add(nearest);
            }
        }
        return dedupeByDt(result);
    }

    /** Epoch seconds for each forecast slot in the selected horizon and step (minutes). */
    public static List<Long> slotEpochSeconds(int horizonHours, int stepMinutes) {
        int horizon = MeteoFranceForecastPreferenceService.clampHorizon(horizonHours);
        int step = MeteoFranceForecastPreferenceService.clampStep(stepMinutes);
        if (step >= 1440) {
            return dailySlotEpochSeconds(horizon, DAILY_SLOT_ZONE, DAILY_SLOT_HOUR);
        }
        if (step >= 60 && 1440 % step == 0) {
            return localStepSlotEpochSeconds(horizon, DAILY_SLOT_ZONE, step);
        }
        long now = System.currentTimeMillis() / 1000L;
        long horizonEnd = now + (long) horizon * 3600L;
        long stepSec = (long) step * 60L;
        List<Long> slots = new ArrayList<>();
        long slotStart = stepSec > 0 ? ((now / stepSec) + 1) * stepSec : now;
        for (long slot = slotStart; slot <= horizonEnd; slot += stepSec) {
            slots.add(slot);
        }
        return slots;
    }

    /**
     * One slot per calendar day at {@code anchorHour}:00 in {@code zone}, from the next occurrence
     * through the forecast horizon (avoids UTC-midnight slots that display as 01:00/02:00 in France).
     */
    static List<Long> dailySlotEpochSeconds(int horizonHours, ZoneId zone, int anchorHour) {
        long now = System.currentTimeMillis() / 1000L;
        long horizonEnd = now + (long) MeteoFranceForecastPreferenceService.clampHorizon(horizonHours) * 3600L;
        ZonedDateTime nowZdt = Instant.ofEpochSecond(now).atZone(zone);
        ZonedDateTime slot = nowZdt.toLocalDate().atTime(anchorHour, 0).atZone(zone);
        if (!slot.isAfter(nowZdt)) {
            slot = slot.plusDays(1);
        }
        List<Long> slots = new ArrayList<>();
        while (slot.toEpochSecond() <= horizonEnd) {
            slots.add(slot.toEpochSecond());
            slot = slot.plusDays(1);
        }
        return slots;
    }

    /**
     * Slots every {@code stepMinutes} on local civil-time boundaries (00:00, 02:00, … for a 2 h step).
     */
    static List<Long> localStepSlotEpochSeconds(int horizonHours, ZoneId zone, int stepMinutes) {
        long now = System.currentTimeMillis() / 1000L;
        long horizonEnd = now + (long) MeteoFranceForecastPreferenceService.clampHorizon(horizonHours) * 3600L;
        long stepSec = (long) MeteoFranceForecastPreferenceService.clampStep(stepMinutes) * 60L;
        if (stepSec <= 0) {
            return List.of();
        }
        ZonedDateTime nowZdt = Instant.ofEpochSecond(now).atZone(zone);
        ZonedDateTime dayStart = nowZdt.toLocalDate().atStartOfDay(zone);
        long secondsSinceMidnight = nowZdt.toEpochSecond() - dayStart.toEpochSecond();
        long stepIndex = secondsSinceMidnight / stepSec;
        ZonedDateTime slot = dayStart.plusSeconds((stepIndex + 1) * stepSec);
        if (!slot.isAfter(nowZdt)) {
            slot = slot.plusSeconds(stepSec);
        }
        List<Long> slots = new ArrayList<>();
        while (slot.toEpochSecond() <= horizonEnd) {
            slots.add(slot.toEpochSecond());
            slot = slot.plusSeconds(stepSec);
        }
        return slots;
    }

    static Map<String, Object> nearestItemForSlot(
            List<Map<String, Object>> sorted, long target, long tolerance) {
        return nearestItem(sorted, target, tolerance);
    }

    private static Map<String, Object> nearestItem(List<Map<String, Object>> sorted, long target, long tolerance) {
        Map<String, Object> best = null;
        long bestDelta = Long.MAX_VALUE;
        for (Map<String, Object> item : sorted) {
            long dt = epochSeconds(item);
            if (dt <= 0) {
                continue;
            }
            long delta = Math.abs(dt - target);
            if (delta <= tolerance && delta < bestDelta) {
                bestDelta = delta;
                best = item;
            }
        }
        return best;
    }

    private static List<Map<String, Object>> dedupeByDt(List<Map<String, Object>> items) {
        Map<Long, Map<String, Object>> unique = new LinkedHashMap<>();
        for (Map<String, Object> item : items) {
            long dt = epochSeconds(item);
            if (dt > 0) {
                unique.putIfAbsent(dt, item);
            }
        }
        return new ArrayList<>(unique.values());
    }

    static long epochSeconds(Map<String, Object> item) {
        Object dt = item.get("dt");
        if (dt instanceof Number number) {
            return number.longValue();
        }
        return 0;
    }
}
