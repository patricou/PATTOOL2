package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AudioEqualizerPreferenceDto;
import com.pat.controller.dto.AudioEqualizerSettingsDto;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Per-user audio equalizer, stored in {@code appParameters}
 * under key {@code audio.equalizer.<JWT sub>}.
 */
@Service
public class AudioEqualizerPreferenceService {

    private static final Logger log = LoggerFactory.getLogger(AudioEqualizerPreferenceService.class);

    static final String PARAM_KEY_PREFIX = "audio.equalizer.";
    private static final int BAND_COUNT = 10;
    private static final int MAX_PRESET_LEN = 40;

    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final UserOwnerService userOwnerService;

    public AudioEqualizerPreferenceService(
            AppParameterService appParameterService, ObjectMapper objectMapper, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.userOwnerService = userOwnerService;
    }

    public AudioEqualizerPreferenceDto findForSubject(String jwtSubject) {
        Optional<AppParameter> row = userOwnerService.findParam(PARAM_KEY_PREFIX, jwtSubject);
        if (row.isEmpty()) {
            return empty(false);
        }
        String raw = row.get().getParamValue();
        if (!StringUtils.hasText(raw)) {
            return empty(false);
        }
        try {
            AudioEqualizerPreferenceDto dto = objectMapper.readValue(raw, AudioEqualizerPreferenceDto.class);
            AudioEqualizerPreferenceDto normalized = normalize(dto);
            normalized.setPersisted(true);
            return normalized;
        } catch (JsonProcessingException e) {
            log.debug("audio.equalizer unreadable JSON: {}", e.getMessage());
            return empty(false);
        }
    }

    public AudioEqualizerPreferenceDto saveForSubject(String jwtSubject, AudioEqualizerPreferenceDto dto) {
        AudioEqualizerPreferenceDto normalized = normalize(dto);
        String key = userOwnerService.writeKey(PARAM_KEY_PREFIX, jwtSubject);
        try {
            AudioEqualizerPreferenceDto toStore = new AudioEqualizerPreferenceDto(
                    normalized.getSettings(), normalized.getUserPreset(), null);
            String json = objectMapper.writeValueAsString(toStore);
            appParameterService.setJson(
                    key,
                    json,
                    "Audio equalizer: per-user settings and one custom preset (JSON).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization audio equalizer preferences", e);
        }
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwtSubject);
        normalized.setPersisted(true);
        return normalized;
    }

    private static AudioEqualizerPreferenceDto empty(boolean persisted) {
        return new AudioEqualizerPreferenceDto(null, null, persisted);
    }

    private static AudioEqualizerPreferenceDto normalize(AudioEqualizerPreferenceDto dto) {
        if (dto == null) {
            return empty(false);
        }
        return new AudioEqualizerPreferenceDto(
                normalizeSettings(dto.getSettings()),
                normalizeSettings(dto.getUserPreset()),
                dto.getPersisted());
    }

    private static AudioEqualizerSettingsDto normalizeSettings(AudioEqualizerSettingsDto src) {
        if (src == null) {
            return null;
        }
        AudioEqualizerSettingsDto out = new AudioEqualizerSettingsDto();
        out.setEnabled(src.getEnabled() == null || src.getEnabled());
        out.setBypass(Boolean.TRUE.equals(src.getBypass()));
        out.setPreamp(clamp(src.getPreamp(), -12, 12, 0));
        out.setBass(clamp(src.getBass(), -12, 12, 0));
        out.setMid(clamp(src.getMid(), -12, 12, 0));
        out.setTreble(clamp(src.getTreble(), -12, 12, 0));
        out.setPresence(clamp(src.getPresence(), -12, 12, 0));
        out.setLoudness(clamp(src.getLoudness(), 0, 12, 0));
        out.setBands(normalizeBands(src.getBands()));
        out.setVolume(clamp(src.getVolume(), 0, 1.5, 1));
        out.setBalance(clamp(src.getBalance(), -1, 1, 0));
        out.setStereoWidth(clamp(src.getStereoWidth(), 0, 2, 1));
        out.setCompressor(Boolean.TRUE.equals(src.getCompressor()));
        out.setCompressorThreshold(clamp(src.getCompressorThreshold(), -60, 0, -18));
        out.setCompressorRatio(clamp(src.getCompressorRatio(), 1, 20, 4));
        out.setCompressorAttack(clamp(src.getCompressorAttack(), 0.001, 0.2, 0.012));
        out.setCompressorRelease(clamp(src.getCompressorRelease(), 0.02, 1, 0.18));
        out.setLimiter(src.getLimiter() == null || src.getLimiter());
        out.setReverb(clamp(src.getReverb(), 0, 1, 0));
        out.setEcho(clamp(src.getEcho(), 0, 1, 0));
        out.setEchoTime(clamp(src.getEchoTime(), 0.08, 0.7, 0.28));
        out.setChorus(clamp(src.getChorus(), 0, 1, 0));
        out.setDrive(clamp(src.getDrive(), 0, 1, 0));
        out.setHighpass(clamp(src.getHighpass(), 20, 400, 20));
        out.setLowpass(clamp(src.getLowpass(), 1500, 20000, 20000));
        out.setPreset(trimTo(src.getPreset(), MAX_PRESET_LEN));
        if (!StringUtils.hasText(out.getPreset())) {
            out.setPreset("flat");
        }
        return out;
    }

    private static List<Double> normalizeBands(List<Double> bands) {
        List<Double> next = new ArrayList<>(BAND_COUNT);
        for (int i = 0; i < BAND_COUNT; i++) {
            Double value = bands != null && i < bands.size() ? bands.get(i) : null;
            next.add(clamp(value, -12, 12, 0));
        }
        return next;
    }

    private static double clamp(Double value, double min, double max, double fallback) {
        double n = value == null || value.isNaN() || value.isInfinite() ? fallback : value;
        return Math.max(min, Math.min(max, n));
    }

    private static String trimTo(String value, int max) {
        if (value == null) {
            return "";
        }
        String t = value.trim();
        if (t.isEmpty()) {
            return "";
        }
        return t.length() > max ? t.substring(0, max) : t;
    }
}
