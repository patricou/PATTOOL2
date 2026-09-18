package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.List;

/**
 * Live or saved equalizer snapshot (JSON in {@code appParameters}).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AudioEqualizerSettingsDto {

    private Boolean enabled;
    private Boolean bypass;
    private Double preamp;
    private Double bass;
    private Double mid;
    private Double treble;
    private Double presence;
    private Double loudness;
    private List<Double> bands;
    private Double volume;
    private Double balance;
    private Double stereoWidth;
    private Boolean compressor;
    private Double compressorThreshold;
    private Double compressorRatio;
    private Double compressorAttack;
    private Double compressorRelease;
    private Boolean limiter;
    private Double reverb;
    private Double echo;
    private Double echoTime;
    private Double chorus;
    private Double drive;
    private Double highpass;
    private Double lowpass;
    private String preset;

    public AudioEqualizerSettingsDto() {
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }

    public Boolean getBypass() {
        return bypass;
    }

    public void setBypass(Boolean bypass) {
        this.bypass = bypass;
    }

    public Double getPreamp() {
        return preamp;
    }

    public void setPreamp(Double preamp) {
        this.preamp = preamp;
    }

    public Double getBass() {
        return bass;
    }

    public void setBass(Double bass) {
        this.bass = bass;
    }

    public Double getMid() {
        return mid;
    }

    public void setMid(Double mid) {
        this.mid = mid;
    }

    public Double getTreble() {
        return treble;
    }

    public void setTreble(Double treble) {
        this.treble = treble;
    }

    public Double getPresence() {
        return presence;
    }

    public void setPresence(Double presence) {
        this.presence = presence;
    }

    public Double getLoudness() {
        return loudness;
    }

    public void setLoudness(Double loudness) {
        this.loudness = loudness;
    }

    public List<Double> getBands() {
        return bands;
    }

    public void setBands(List<Double> bands) {
        this.bands = bands == null ? null : new ArrayList<>(bands);
    }

    public Double getVolume() {
        return volume;
    }

    public void setVolume(Double volume) {
        this.volume = volume;
    }

    public Double getBalance() {
        return balance;
    }

    public void setBalance(Double balance) {
        this.balance = balance;
    }

    public Double getStereoWidth() {
        return stereoWidth;
    }

    public void setStereoWidth(Double stereoWidth) {
        this.stereoWidth = stereoWidth;
    }

    public Boolean getCompressor() {
        return compressor;
    }

    public void setCompressor(Boolean compressor) {
        this.compressor = compressor;
    }

    public Double getCompressorThreshold() {
        return compressorThreshold;
    }

    public void setCompressorThreshold(Double compressorThreshold) {
        this.compressorThreshold = compressorThreshold;
    }

    public Double getCompressorRatio() {
        return compressorRatio;
    }

    public void setCompressorRatio(Double compressorRatio) {
        this.compressorRatio = compressorRatio;
    }

    public Double getCompressorAttack() {
        return compressorAttack;
    }

    public void setCompressorAttack(Double compressorAttack) {
        this.compressorAttack = compressorAttack;
    }

    public Double getCompressorRelease() {
        return compressorRelease;
    }

    public void setCompressorRelease(Double compressorRelease) {
        this.compressorRelease = compressorRelease;
    }

    public Boolean getLimiter() {
        return limiter;
    }

    public void setLimiter(Boolean limiter) {
        this.limiter = limiter;
    }

    public Double getReverb() {
        return reverb;
    }

    public void setReverb(Double reverb) {
        this.reverb = reverb;
    }

    public Double getEcho() {
        return echo;
    }

    public void setEcho(Double echo) {
        this.echo = echo;
    }

    public Double getEchoTime() {
        return echoTime;
    }

    public void setEchoTime(Double echoTime) {
        this.echoTime = echoTime;
    }

    public Double getChorus() {
        return chorus;
    }

    public void setChorus(Double chorus) {
        this.chorus = chorus;
    }

    public Double getDrive() {
        return drive;
    }

    public void setDrive(Double drive) {
        this.drive = drive;
    }

    public Double getHighpass() {
        return highpass;
    }

    public void setHighpass(Double highpass) {
        this.highpass = highpass;
    }

    public Double getLowpass() {
        return lowpass;
    }

    public void setLowpass(Double lowpass) {
        this.lowpass = lowpass;
    }

    public String getPreset() {
        return preset;
    }

    public void setPreset(String preset) {
        this.preset = preset;
    }
}
