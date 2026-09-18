package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Per-user audio equalizer: current settings + one saved custom preset.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AudioEqualizerPreferenceDto {

    private AudioEqualizerSettingsDto settings;
    private AudioEqualizerSettingsDto userPreset;
    private Boolean persisted;

    public AudioEqualizerPreferenceDto() {
    }

    public AudioEqualizerPreferenceDto(
            AudioEqualizerSettingsDto settings, AudioEqualizerSettingsDto userPreset, Boolean persisted) {
        this.settings = settings;
        this.userPreset = userPreset;
        this.persisted = persisted;
    }

    public AudioEqualizerSettingsDto getSettings() {
        return settings;
    }

    public void setSettings(AudioEqualizerSettingsDto settings) {
        this.settings = settings;
    }

    public AudioEqualizerSettingsDto getUserPreset() {
        return userPreset;
    }

    public void setUserPreset(AudioEqualizerSettingsDto userPreset) {
        this.userPreset = userPreset;
    }

    public Boolean getPersisted() {
        return persisted;
    }

    public void setPersisted(Boolean persisted) {
        this.persisted = persisted;
    }
}
