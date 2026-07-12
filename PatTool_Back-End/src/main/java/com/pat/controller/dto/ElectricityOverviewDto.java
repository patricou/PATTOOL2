package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Vue d'ensemble pour la page Électricité PatTool.
 */
public class ElectricityOverviewDto {

    private String updatedAt;
    private ElectricityGenerationPointDto frLatest;
    private List<ElectricityGenerationPointDto> frHistory = new ArrayList<>();
    private int frPlantCount;
    private int frInstalledNuclearMw;
    private int frActiveUnavailabilityCount;
    private List<ElectricityCountryNuclearDto> euNuclear = new ArrayList<>();
    private ElectricityCountryNuclearDto usNuclear;
    private boolean entsoeConfigured;
    private boolean eiaConfigured;
    private int worldNuclearPlantCount;
    private int worldOperationalCount;

    public String getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(String updatedAt) {
        this.updatedAt = updatedAt;
    }

    public ElectricityGenerationPointDto getFrLatest() {
        return frLatest;
    }

    public void setFrLatest(ElectricityGenerationPointDto frLatest) {
        this.frLatest = frLatest;
    }

    public List<ElectricityGenerationPointDto> getFrHistory() {
        return frHistory;
    }

    public void setFrHistory(List<ElectricityGenerationPointDto> frHistory) {
        this.frHistory = frHistory != null ? frHistory : new ArrayList<>();
    }

    public int getFrPlantCount() {
        return frPlantCount;
    }

    public void setFrPlantCount(int frPlantCount) {
        this.frPlantCount = frPlantCount;
    }

    public int getFrInstalledNuclearMw() {
        return frInstalledNuclearMw;
    }

    public void setFrInstalledNuclearMw(int frInstalledNuclearMw) {
        this.frInstalledNuclearMw = frInstalledNuclearMw;
    }

    public int getFrActiveUnavailabilityCount() {
        return frActiveUnavailabilityCount;
    }

    public void setFrActiveUnavailabilityCount(int frActiveUnavailabilityCount) {
        this.frActiveUnavailabilityCount = frActiveUnavailabilityCount;
    }

    public List<ElectricityCountryNuclearDto> getEuNuclear() {
        return euNuclear;
    }

    public void setEuNuclear(List<ElectricityCountryNuclearDto> euNuclear) {
        this.euNuclear = euNuclear != null ? euNuclear : new ArrayList<>();
    }

    public ElectricityCountryNuclearDto getUsNuclear() {
        return usNuclear;
    }

    public void setUsNuclear(ElectricityCountryNuclearDto usNuclear) {
        this.usNuclear = usNuclear;
    }

    public boolean isEntsoeConfigured() {
        return entsoeConfigured;
    }

    public void setEntsoeConfigured(boolean entsoeConfigured) {
        this.entsoeConfigured = entsoeConfigured;
    }

    public boolean isEiaConfigured() {
        return eiaConfigured;
    }

    public void setEiaConfigured(boolean eiaConfigured) {
        this.eiaConfigured = eiaConfigured;
    }

    public int getWorldNuclearPlantCount() {
        return worldNuclearPlantCount;
    }

    public void setWorldNuclearPlantCount(int worldNuclearPlantCount) {
        this.worldNuclearPlantCount = worldNuclearPlantCount;
    }

    public int getWorldOperationalCount() {
        return worldOperationalCount;
    }

    public void setWorldOperationalCount(int worldOperationalCount) {
        this.worldOperationalCount = worldOperationalCount;
    }
}
