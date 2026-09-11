package com.pat.controller.dto;

/**
 * Per-user artisans search preferences (radius, page size, map scope).
 */
public class ArtisansPreferencesDto {

    private int radiusKm = 10;
    private int perPage = 500;
    private boolean mapListOnly = false;

    public ArtisansPreferencesDto() {
    }

    public ArtisansPreferencesDto(double radiusKm) {
        this.radiusKm = (int) Math.round(radiusKm);
    }

    public ArtisansPreferencesDto(double radiusKm, int perPage, boolean mapListOnly) {
        this.radiusKm = (int) Math.round(radiusKm);
        this.perPage = perPage;
        this.mapListOnly = mapListOnly;
    }

    public int getRadiusKm() {
        return radiusKm;
    }

    public void setRadiusKm(double radiusKm) {
        this.radiusKm = (int) Math.round(radiusKm);
    }

    public int getPerPage() {
        return perPage;
    }

    public void setPerPage(int perPage) {
        this.perPage = perPage;
    }

    public boolean isMapListOnly() {
        return mapListOnly;
    }

    public void setMapListOnly(boolean mapListOnly) {
        this.mapListOnly = mapListOnly;
    }
}
