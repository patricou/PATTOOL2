package com.pat.controller.dto;

/**
 * One category share in an OpenRouteService {@code extras} summary
 * (surface, waytypes, steepness, …).
 */
public class OpenRouteExtraItemDto {

    private int value;
    private Double distanceMeters;
    private Double amountPercent;

    public int getValue() {
        return value;
    }

    public void setValue(int value) {
        this.value = value;
    }

    public Double getDistanceMeters() {
        return distanceMeters;
    }

    public void setDistanceMeters(Double distanceMeters) {
        this.distanceMeters = distanceMeters;
    }

    public Double getAmountPercent() {
        return amountPercent;
    }

    public void setAmountPercent(Double amountPercent) {
        this.amountPercent = amountPercent;
    }
}
