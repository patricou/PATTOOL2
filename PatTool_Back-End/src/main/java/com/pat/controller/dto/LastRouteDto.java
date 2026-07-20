package com.pat.controller.dto;

/**
 * Angular hash-route path persisted per user (e.g. {@code /tools/tv-watcher}).
 */
public class LastRouteDto {

    private String route;

    public LastRouteDto() {
    }

    public LastRouteDto(String route) {
        this.route = route;
    }

    public String getRoute() {
        return route;
    }

    public void setRoute(String route) {
        this.route = route;
    }
}
