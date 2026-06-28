package com.pat.controller.dto;

import java.util.List;

/**
 * Screen-space temperature grid: list of lat/lon points (proxied server-side).
 */
public record TemperatureLabelsRequestDto(List<Point> points) {

    public record Point(double lat, double lon) {}
}
