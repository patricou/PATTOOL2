package com.pat.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.pat.service.MapPlacesService;
import com.pat.service.MapTileProxyService;
import com.pat.service.MaptoolkitProxyService;
import com.pat.util.SlippyMapTileCoords;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Same-origin raster tile proxy for GPS 3D navigation (Three.js textures).
 */
@RestController
@RequestMapping("/api/external/map")
public class MapTileRestController {

    private final MapTileProxyService mapTileProxyService;
    private final MapPlacesService mapPlacesService;
    private final MaptoolkitProxyService maptoolkitProxyService;

    public MapTileRestController(
            MapTileProxyService mapTileProxyService,
            MapPlacesService mapPlacesService,
            MaptoolkitProxyService maptoolkitProxyService) {
        this.mapTileProxyService = mapTileProxyService;
        this.mapPlacesService = mapPlacesService;
        this.maptoolkitProxyService = maptoolkitProxyService;
    }

    @GetMapping(value = "/tile/{z}/{x}/{y}")
    public ResponseEntity<byte[]> getTile(
            @PathVariable("z") String z,
            @PathVariable("x") String x,
            @PathVariable("y") String y,
            @RequestParam(value = "style", defaultValue = "voyager") String style,
            @RequestParam(value = "part", defaultValue = "0") int part) {
        return mapTileProxyService.getTile(
                style,
                part,
                SlippyMapTileCoords.parse(z),
                SlippyMapTileCoords.parse(x),
                SlippyMapTileCoords.parse(y));
    }

    /**
     * Maptoolkit style, tiles, glyphs and sprites.
     * MapLibre calls this without the Angular token, and only after a direct request was refused.
     */
    @GetMapping("/maptoolkit")
    public ResponseEntity<byte[]> maptoolkit(@RequestParam("url") String url) {
        return maptoolkitProxyService.fetch(url);
    }

    /** Monuments, sights and airfields inside the visible map. */
    @GetMapping("/places")
    public JsonNode places(
            @RequestParam("south") double south,
            @RequestParam("west") double west,
            @RequestParam("north") double north,
            @RequestParam("east") double east) {
        return mapPlacesService.places(south, west, north, east);
    }
}
