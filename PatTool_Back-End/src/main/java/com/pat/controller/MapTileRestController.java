package com.pat.controller;

import com.pat.service.MapTileProxyService;
import com.pat.util.SlippyMapTileCoords;
import org.springframework.http.MediaType;
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

    public MapTileRestController(MapTileProxyService mapTileProxyService) {
        this.mapTileProxyService = mapTileProxyService;
    }

    @GetMapping(value = "/tile/{z}/{x}/{y}", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> getTile(
            @PathVariable("z") String z,
            @PathVariable("x") String x,
            @PathVariable("y") String y,
            @RequestParam(value = "style", defaultValue = "voyager") String style) {
        return mapTileProxyService.getTile(
                style,
                SlippyMapTileCoords.parse(z),
                SlippyMapTileCoords.parse(x),
                SlippyMapTileCoords.parse(y));
    }
}
