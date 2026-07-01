package com.pat.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Filters OpenWeatherMap-like forecast {@code list} entries to a horizon (hours) and step (minutes).
 */
public final class ForecastHorizonFilter {

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
