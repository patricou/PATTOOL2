package com.pat.service;

import com.pat.controller.dto.MeteoFranceMapLayerPreferenceDto;
import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;

/**
 * Map-layer display settings shared by all users: radar / clouds / temperature switches
 * and cloud opacity / intensity, stored in MongoDB {@code appParameters}.
 */
@Service
public class MeteoFranceMapLayerPreferenceService {

    static final String GLOBAL_SHOW_RADAR_KEY = "meteofrance.map.show-radar";
    static final String GLOBAL_SHOW_CLOUD_KEY = "meteofrance.map.show-cloud-layer";
    static final String GLOBAL_SHOW_TEMPERATURE_KEY = "meteofrance.map.show-temperature-map";
    static final String GLOBAL_CLOUD_OPACITY_KEY = "meteofrance.map.cloud-opacity";
    static final String GLOBAL_CLOUD_INTENSITY_KEY = "meteofrance.map.cloud-intensity";

    private static final boolean DEFAULT_SHOW_RADAR = true;
    private static final boolean DEFAULT_SHOW_CLOUD = true;
    private static final boolean DEFAULT_SHOW_TEMPERATURE = true;
    private static final double DEFAULT_CLOUD_OPACITY = 0.75;
    private static final double DEFAULT_CLOUD_INTENSITY = 3.0;
    private static final double MIN_CLOUD_OPACITY = 0.1;
    private static final double MAX_CLOUD_OPACITY = 1.0;
    private static final double MIN_CLOUD_INTENSITY = 0.5;
    private static final double MAX_CLOUD_INTENSITY = 8.0;

    private final AppParameterService appParameterService;

    public MeteoFranceMapLayerPreferenceService(AppParameterService appParameterService) {
        this.appParameterService = appParameterService;
    }

    public MeteoFranceMapLayerPreferenceDto readGlobal() {
        return new MeteoFranceMapLayerPreferenceDto(
                appParameterService.getBooleanSafe(GLOBAL_SHOW_RADAR_KEY, DEFAULT_SHOW_RADAR),
                appParameterService.getBooleanSafe(GLOBAL_SHOW_CLOUD_KEY, DEFAULT_SHOW_CLOUD),
                appParameterService.getBooleanSafe(GLOBAL_SHOW_TEMPERATURE_KEY, DEFAULT_SHOW_TEMPERATURE),
                resolveCloudOpacity(),
                resolveCloudIntensity(),
                isPersistedInMongo()
        );
    }

    public MeteoFranceMapLayerPreferenceDto saveGlobal(MeteoFranceMapLayerPreferenceDto patch) {
        if (patch == null) {
            throw new IllegalArgumentException("patch required");
        }
        MeteoFranceMapLayerPreferenceDto current = readGlobal();
        boolean showRadar = patch.showRadar() != null ? patch.showRadar() : current.showRadar();
        boolean showCloud = patch.showCloudLayer() != null ? patch.showCloudLayer() : current.showCloudLayer();
        boolean showTemp = patch.showTemperatureMap() != null
                ? patch.showTemperatureMap()
                : current.showTemperatureMap();
        double cloudOpacity = patch.cloudOpacity() != null
                ? clampOpacity(patch.cloudOpacity())
                : current.cloudOpacity();
        double cloudIntensity = patch.cloudIntensity() != null
                ? clampIntensity(patch.cloudIntensity())
                : current.cloudIntensity();

        appParameterService.setBoolean(
                GLOBAL_SHOW_RADAR_KEY,
                showRadar,
                "Météo France: show radar layer switch, shared by all users.");
        appParameterService.setBoolean(
                GLOBAL_SHOW_CLOUD_KEY,
                showCloud,
                "Météo France: show cloud layer switch, shared by all users.");
        appParameterService.setBoolean(
                GLOBAL_SHOW_TEMPERATURE_KEY,
                showTemp,
                "Météo France: show temperature map switch, shared by all users.");
        appParameterService.setString(
                GLOBAL_CLOUD_OPACITY_KEY,
                formatDouble(cloudOpacity),
                "Météo France: cloud layer opacity (0.1–1), shared by all users.");
        appParameterService.setString(
                GLOBAL_CLOUD_INTENSITY_KEY,
                formatDouble(cloudIntensity),
                "Météo France: cloud layer intensity (0.5–8), shared by all users.");

        return new MeteoFranceMapLayerPreferenceDto(
                showRadar, showCloud, showTemp, cloudOpacity, cloudIntensity, true);
    }

    private double resolveCloudOpacity() {
        return parseDouble(
                appParameterService.find(GLOBAL_CLOUD_OPACITY_KEY).map(AppParameter::getParamValue).orElse(null),
                DEFAULT_CLOUD_OPACITY,
                MIN_CLOUD_OPACITY,
                MAX_CLOUD_OPACITY);
    }

    private double resolveCloudIntensity() {
        return parseDouble(
                appParameterService.find(GLOBAL_CLOUD_INTENSITY_KEY).map(AppParameter::getParamValue).orElse(null),
                DEFAULT_CLOUD_INTENSITY,
                MIN_CLOUD_INTENSITY,
                MAX_CLOUD_INTENSITY);
    }

    private boolean isPersistedInMongo() {
        return appParameterService.find(GLOBAL_SHOW_RADAR_KEY).isPresent()
                || appParameterService.find(GLOBAL_SHOW_CLOUD_KEY).isPresent()
                || appParameterService.find(GLOBAL_SHOW_TEMPERATURE_KEY).isPresent()
                || appParameterService.find(GLOBAL_CLOUD_OPACITY_KEY).isPresent()
                || appParameterService.find(GLOBAL_CLOUD_INTENSITY_KEY).isPresent();
    }

    private static double parseDouble(String raw, double fallback, double min, double max) {
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            return clamp(Double.parseDouble(raw.trim()), min, max);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static double clampOpacity(double value) {
        return clamp(value, MIN_CLOUD_OPACITY, MAX_CLOUD_OPACITY);
    }

    private static double clampIntensity(double value) {
        return clamp(value, MIN_CLOUD_INTENSITY, MAX_CLOUD_INTENSITY);
    }

    private static double clamp(double value, double min, double max) {
        if (value < min) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    private static String formatDouble(double value) {
        return Double.toString(Math.round(value * 100.0) / 100.0);
    }
}
