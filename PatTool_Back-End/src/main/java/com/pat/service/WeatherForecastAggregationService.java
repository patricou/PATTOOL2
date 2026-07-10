package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Aggregates multi-day point forecasts from OpenWeatherMap, Open-Meteo and Météo-France (via Open-Meteo seamless)
 * on a unified timeline (horizon + step in minutes).
 */
@Service
public class WeatherForecastAggregationService {

    private static final Logger log = LoggerFactory.getLogger(WeatherForecastAggregationService.class);

    private static final List<String> SOURCE_KEYS = List.of("openweathermap", "open-meteo", "meteofrance");
    private static final List<String> PARAM_KEYS = List.of("tempC", "humidityPct", "precipMm", "windSpeedMs", "pop");

    private final OpenWeatherService openWeatherService;
    private final OpenMeteoService openMeteoService;
    private final MeteoFranceForecastPreferenceService forecastPreferenceService;

    public WeatherForecastAggregationService(
            OpenWeatherService openWeatherService,
            OpenMeteoService openMeteoService,
            MeteoFranceForecastPreferenceService forecastPreferenceService) {
        this.openWeatherService = openWeatherService;
        this.openMeteoService = openMeteoService;
        this.forecastPreferenceService = forecastPreferenceService;
    }

    public Map<String, Object> getAggregatedForecast(double lat, double lon, String jwtSubject) {
        int horizonHours = forecastPreferenceService.resolveHorizonHours(jwtSubject);
        int stepMinutes = forecastPreferenceService.resolveStepMinutes(jwtSubject);
        return getAggregatedForecast(lat, lon, jwtSubject, horizonHours, stepMinutes);
    }

    public Map<String, Object> getAggregatedForecast(
            double lat, double lon, String jwtSubject, int horizonHours, int stepMinutes) {
        int horizon = MeteoFranceForecastPreferenceService.clampHorizon(horizonHours);
        int step = MeteoFranceForecastPreferenceService.clampStep(stepMinutes);
        long toleranceSec = (long) step * 60L / 2;
        List<Long> slots = ForecastHorizonFilter.slotEpochSeconds(horizon, step);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("lat", lat);
        result.put("lon", lon);
        result.put("parameters", PARAM_KEYS);
        result.put("forecastHorizonHours", horizon);
        result.put("forecastStepMinutes", step);
        result.put("slotCount", slots.size());

        Map<String, String> sourceErrors = new LinkedHashMap<>();
        List<String> sourcesAvailable = new ArrayList<>();
        Map<String, List<Map<String, Object>>> sourceItems = new LinkedHashMap<>();

        CompletableFuture<Map<String, Object>> owmFuture = CompletableFuture.supplyAsync(() ->
                openWeatherService.getForecastByCoordinates(lat, lon, null, horizon, step));
        CompletableFuture<Map<String, Object>> omFuture = CompletableFuture.supplyAsync(() ->
                openMeteoService.getForecastByCoordinates(lat, lon, jwtSubject, horizon, step));
        CompletableFuture<Map<String, Object>> mfFuture = CompletableFuture.supplyAsync(() ->
                openMeteoService.getMeteoFranceForecastByCoordinates(lat, lon, jwtSubject, horizon, step));
        CompletableFuture.allOf(owmFuture, omFuture, mfFuture).join();

        collectSource(sourceItems, sourcesAvailable, sourceErrors, "openweathermap", owmFuture.join());
        collectSource(sourceItems, sourcesAvailable, sourceErrors, "open-meteo", omFuture.join());
        collectSource(sourceItems, sourcesAvailable, sourceErrors, "meteofrance", mfFuture.join());

        List<Map<String, Object>> steps = buildAlignedSteps(slots, toleranceSec, sourceItems);
        result.put("steps", steps);
        result.put("sourcesAvailable", sourcesAvailable);
        if (!sourceErrors.isEmpty()) {
            result.put("sourceErrors", sourceErrors);
        }
        if (sourcesAvailable.isEmpty()) {
            result.put("error", "No forecast data available for the selected period and step");
        }
        return result;
    }

    /**
     * Fetches OWM, Open-Meteo and MF forecasts in parallel and invokes {@code onSource}
     * as soon as each upstream response is available (for SSE progressive delivery).
     */
    public void streamForecastSources(
            double lat,
            double lon,
            String jwtSubject,
            int horizonHours,
            int stepMinutes,
            Consumer<Map<String, Object>> onSource,
            Runnable onComplete) {
        int horizon = MeteoFranceForecastPreferenceService.clampHorizon(horizonHours);
        int step = MeteoFranceForecastPreferenceService.clampStep(stepMinutes);
        AtomicInteger pending = new AtomicInteger(SOURCE_KEYS.size());

        Runnable finishOne = () -> {
            if (pending.decrementAndGet() == 0 && onComplete != null) {
                onComplete.run();
            }
        };

        CompletableFuture
                .supplyAsync(() -> openWeatherService.getForecastByCoordinates(lat, lon, null, horizon, step))
                .whenComplete((payload, error) -> {
                    if (onSource != null) {
                        onSource.accept(wrapStreamSourcePayload("openweathermap", payload, error));
                    }
                    finishOne.run();
                });
        CompletableFuture
                .supplyAsync(() -> openMeteoService.getForecastByCoordinates(lat, lon, jwtSubject, horizon, step))
                .whenComplete((payload, error) -> {
                    if (onSource != null) {
                        onSource.accept(wrapStreamSourcePayload("open-meteo", payload, error));
                    }
                    finishOne.run();
                });
        CompletableFuture
                .supplyAsync(() -> openMeteoService.getMeteoFranceForecastByCoordinates(lat, lon, jwtSubject, horizon, step))
                .whenComplete((payload, error) -> {
                    if (onSource != null) {
                        onSource.accept(wrapStreamSourcePayload("meteofrance", payload, error));
                    }
                    finishOne.run();
                });
    }

    private static Map<String, Object> wrapStreamSourcePayload(
            String sourceKey, Map<String, Object> payload, Throwable error) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("source", sourceKey);
        if (error != null) {
            event.put("error", error.getMessage() != null ? error.getMessage() : "request failed");
            return event;
        }
        if (payload == null) {
            event.put("error", "empty response");
            return event;
        }
        if (payload.containsKey("error")) {
            event.put("error", String.valueOf(payload.get("error")));
            return event;
        }
        Object listObj = payload.get("list");
        if (!(listObj instanceof List<?> list) || list.isEmpty()) {
            event.put("error", "no forecast steps");
            return event;
        }
        event.put("list", list);
        return event;
    }

    private List<Map<String, Object>> buildAlignedSteps(
            List<Long> slots,
            long toleranceSec,
            Map<String, List<Map<String, Object>>> sourceItems) {
        List<Map<String, Object>> steps = new ArrayList<>();
        for (long slot : slots) {
            Map<String, Map<String, Object>> bySource = new LinkedHashMap<>();
            Map<String, Object> step = new LinkedHashMap<>();
            step.put("dt", slot);
            for (String sourceKey : SOURCE_KEYS) {
                Map<String, Object> values = nearestNormalized(sourceItems.get(sourceKey), slot, toleranceSec);
                if (values != null && !values.isEmpty()) {
                    bySource.put(sourceKey, values);
                    step.put(sourceKey, values);
                }
            }
            step.put("aggregate", buildAggregate(bySource));
            steps.add(step);
        }
        return steps;
    }

    @SuppressWarnings("unchecked")
    private void collectSource(
            Map<String, List<Map<String, Object>>> sourceItems,
            List<String> sourcesAvailable,
            Map<String, String> sourceErrors,
            String sourceKey,
            Map<String, Object> payload) {
        if (payload == null) {
            sourceErrors.put(sourceKey, "empty response");
            return;
        }
        if (payload.containsKey("error")) {
            sourceErrors.put(sourceKey, String.valueOf(payload.get("error")));
            return;
        }
        Object listObj = payload.get("list");
        if (!(listObj instanceof List<?> list) || list.isEmpty()) {
            sourceErrors.put(sourceKey, "no forecast steps");
            return;
        }
        List<Map<String, Object>> normalized = new ArrayList<>();
        for (Object itemObj : list) {
            if (!(itemObj instanceof Map<?, ?> item)) {
                continue;
            }
            Map<String, Object> values = normalizeListItem(item);
            if (values.isEmpty()) {
                continue;
            }
            Object dtObj = item.get("dt");
            if (!(dtObj instanceof Number dtNum)) {
                continue;
            }
            Map<String, Object> entry = new LinkedHashMap<>(values);
            entry.put("dt", dtNum.longValue());
            normalized.add(entry);
        }
        normalized.sort(Comparator.comparingLong(ForecastHorizonFilter::epochSeconds));
        if (normalized.isEmpty()) {
            sourceErrors.put(sourceKey, "no usable forecast steps");
            return;
        }
        sourceItems.put(sourceKey, normalized);
        sourcesAvailable.add(sourceKey);
    }

    private static Map<String, Object> nearestNormalized(
            List<Map<String, Object>> items, long slot, long toleranceSec) {
        if (items == null || items.isEmpty()) {
            return null;
        }
        Map<String, Object> nearest = ForecastHorizonFilter.nearestItemForSlot(items, slot, toleranceSec);
        if (nearest == null) {
            return null;
        }
        Map<String, Object> values = new LinkedHashMap<>();
        for (String param : PARAM_KEYS) {
            Object raw = nearest.get(param);
            if (raw != null) {
                values.put(param, raw);
            }
        }
        Object desc = nearest.get("description");
        if (desc != null) {
            values.put("description", desc);
        }
        return values;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> normalizeListItem(Map<?, ?> item) {
        Map<String, Object> values = new LinkedHashMap<>();
        Object mainObj = item.get("main");
        if (mainObj instanceof Map<?, ?> main) {
            putNumber(values, "tempC", main.get("temp"));
            putNumber(values, "humidityPct", main.get("humidity"));
        }
        Object windObj = item.get("wind");
        if (windObj instanceof Map<?, ?> wind) {
            putNumber(values, "windSpeedMs", wind.get("speed"));
        }
        Object rainObj = item.get("rain");
        if (rainObj instanceof Map<?, ?> rain) {
            Object mm = rain.get("1h");
            if (mm == null) {
                mm = rain.get("3h");
            }
            putNumber(values, "precipMm", mm);
        }
        Object snowObj = item.get("snow");
        if (snowObj instanceof Map<?, ?> snow) {
            Object mm = snow.get("1h");
            if (mm == null) {
                mm = snow.get("3h");
            }
            if (!values.containsKey("precipMm")) {
                putNumber(values, "precipMm", mm);
            }
        }
        putNumber(values, "pop", item.get("pop"));
        Object weatherObj = item.get("weather");
        if (weatherObj instanceof List<?> weatherList && !weatherList.isEmpty()
                && weatherList.get(0) instanceof Map<?, ?> weather) {
            Object desc = weather.get("description");
            if (desc != null && !String.valueOf(desc).isBlank()) {
                values.put("description", String.valueOf(desc));
            }
        }
        return values;
    }

    private static Map<String, Object> buildAggregate(Map<String, Map<String, Object>> bySource) {
        Map<String, Object> aggregate = new LinkedHashMap<>();
        for (String param : PARAM_KEYS) {
            List<Double> nums = new ArrayList<>();
            for (String source : SOURCE_KEYS) {
                Map<String, Object> values = bySource.get(source);
                if (values == null) {
                    continue;
                }
                Object raw = values.get(param);
                if (raw instanceof Number number) {
                    nums.add(number.doubleValue());
                }
            }
            if (nums.isEmpty()) {
                continue;
            }
            double min = nums.stream().mapToDouble(Double::doubleValue).min().orElse(0);
            double max = nums.stream().mapToDouble(Double::doubleValue).max().orElse(0);
            double mean = nums.stream().mapToDouble(Double::doubleValue).average().orElse(0);
            Map<String, Object> stats = new LinkedHashMap<>();
            if ("pop".equals(param)) {
                stats.put("min", round(min * 100.0) / 100.0);
                stats.put("max", round(max * 100.0) / 100.0);
                stats.put("mean", round(mean * 100.0) / 100.0);
            } else if ("humidityPct".equals(param)) {
                stats.put("min", Math.round(min));
                stats.put("max", Math.round(max));
                stats.put("mean", Math.round(mean));
            } else {
                stats.put("min", round(min * 10.0) / 10.0);
                stats.put("max", round(max * 10.0) / 10.0);
                stats.put("mean", round(mean * 10.0) / 10.0);
            }
            stats.put("count", nums.size());
            aggregate.put(param, stats);
        }
        return aggregate;
    }

    private static void putNumber(Map<String, Object> target, String key, Object raw) {
        if (!(raw instanceof Number number)) {
            return;
        }
        double value = number.doubleValue();
        if ("humidityPct".equals(key)) {
            target.put(key, Math.round(value));
        } else if ("pop".equals(key)) {
            target.put(key, round(Math.min(1.0, Math.max(0.0, value)) * 100.0) / 100.0);
        } else {
            target.put(key, round(value * 10.0) / 10.0);
        }
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }
}
