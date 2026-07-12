package com.pat.controller.dto;

/**
 * Centrale / réacteur nucléaire dans le monde (GeoNuclearData).
 */
public class ElectricityNuclearPlantDto {

    private int id;
    private String name;
    private String country;
    private String countryCode;
    private String status;
    private String reactorType;
    private Integer capacityMw;
    private Double latitude;
    private Double longitude;
    private String operationalFrom;
    private String operationalTo;

    public int getId() {
        return id;
    }

    public void setId(int id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }

    public String getCountryCode() {
        return countryCode;
    }

    public void setCountryCode(String countryCode) {
        this.countryCode = countryCode;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getReactorType() {
        return reactorType;
    }

    public void setReactorType(String reactorType) {
        this.reactorType = reactorType;
    }

    public Integer getCapacityMw() {
        return capacityMw;
    }

    public void setCapacityMw(Integer capacityMw) {
        this.capacityMw = capacityMw;
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

    public String getOperationalFrom() {
        return operationalFrom;
    }

    public void setOperationalFrom(String operationalFrom) {
        this.operationalFrom = operationalFrom;
    }

    public String getOperationalTo() {
        return operationalTo;
    }

    public void setOperationalTo(String operationalTo) {
        this.operationalTo = operationalTo;
    }
}
