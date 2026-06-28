package com.pat.controller.dto;

import java.util.List;

/**
 * Screen-space temperature grid: list of lat/lon points (proxied server-side).
 */
public record TemperatureLabelsRequestDto(List<Point> points, String source, Boolean refresh) {

    public TemperatureLabelsRequestDto(List<Point> points) {
        this(points, null, null);
    }

    public TemperatureLabelsRequestDto(List<Point> points, String source) {
        this(points, source, null);
    }

    public boolean refreshRequested() {
        return Boolean.TRUE.equals(refresh);
    }

    public record Point(double lat, double lon, String stationId) {
        public Point(double lat, double lon) {
            this(lat, lon, null);
        }
    }
}
