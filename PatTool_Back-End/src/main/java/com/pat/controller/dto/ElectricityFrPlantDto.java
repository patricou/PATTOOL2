package com.pat.controller.dto;

/**
 * Tranche nucléaire EDF (France métropolitaine).
 */
public class ElectricityFrPlantDto {

    private String centrale;
    private String tranche;
    private Integer puissanceInstalleeMw;
    private Double latitude;
    private Double longitude;
    private String region;
    private String sousFiliere;
    private String dateMiseEnService;
    private String commune;

    public String getCentrale() {
        return centrale;
    }

    public void setCentrale(String centrale) {
        this.centrale = centrale;
    }

    public String getTranche() {
        return tranche;
    }

    public void setTranche(String tranche) {
        this.tranche = tranche;
    }

    public Integer getPuissanceInstalleeMw() {
        return puissanceInstalleeMw;
    }

    public void setPuissanceInstalleeMw(Integer puissanceInstalleeMw) {
        this.puissanceInstalleeMw = puissanceInstalleeMw;
    }

    public Double getLatitude() {
        return latitude;
    }

    public void setLatitude(Double latitude) {
        this.latitude = latitude;
    }

    public Double getLongitude() {
        return longitude;
    }

    public void setLongitude(Double longitude) {
        this.longitude = longitude;
    }

    public String getRegion() {
        return region;
    }

    public void setRegion(String region) {
        this.region = region;
    }

    public String getSousFiliere() {
        return sousFiliere;
    }

    public void setSousFiliere(String sousFiliere) {
        this.sousFiliere = sousFiliere;
    }

    public String getDateMiseEnService() {
        return dateMiseEnService;
    }

    public void setDateMiseEnService(String dateMiseEnService) {
        this.dateMiseEnService = dateMiseEnService;
    }

    public String getCommune() {
        return commune;
    }

    public void setCommune(String commune) {
        this.commune = commune;
    }
}
