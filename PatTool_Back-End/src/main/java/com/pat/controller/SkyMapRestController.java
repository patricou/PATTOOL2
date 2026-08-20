package com.pat.controller;

import com.pat.controller.dto.SkyMapPreviewDto;
import com.pat.service.SkyMapProxyService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Proxy for Sky-Map.org (WikiSky) object search and DSS2 survey cutouts.
 * <p>
 * Endpoints:
 * <ul>
 *   <li>{@code GET /api/external/skymap/preview} — object metadata + same-origin cutout/window paths</li>
 *   <li>{@code GET /api/external/skymap/cutout} — JPEG survey image (RA in hours)</li>
 *   <li>{@code GET /api/external/skymap/skywindow} — Sky Window HTML with same-origin tile/label proxy</li>
 *   <li>{@code GET /api/external/skymap/upstream/{areas|imgcut|map}} — Sky-Map tile and label XHR</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/skymap")
public class SkyMapRestController {

    private final SkyMapProxyService skyMapProxyService;

    public SkyMapRestController(SkyMapProxyService skyMapProxyService) {
        this.skyMapProxyService = skyMapProxyService;
    }

    @GetMapping("/preview")
    public ResponseEntity<SkyMapPreviewDto> preview(
            @RequestParam(value = "q", required = false) String query,
            @RequestParam(required = false) Double ra,
            @RequestParam(required = false) Double de,
            @RequestParam(value = "raUnit", defaultValue = "hours") String raUnit,
            @RequestParam(required = false) Double angle,
            @RequestParam(defaultValue = "400") Integer w,
            @RequestParam(defaultValue = "400") Integer h,
            @RequestParam(defaultValue = "DSS2") String survey) {
        return ResponseEntity.ok(skyMapProxyService.preview(query, ra, de, raUnit, angle, w, h, survey));
    }

    @GetMapping("/cutout")
    public ResponseEntity<byte[]> cutout(
            @RequestParam double ra,
            @RequestParam double de,
            @RequestParam(required = false) Double angle,
            @RequestParam(defaultValue = "400") Integer w,
            @RequestParam(defaultValue = "400") Integer h,
            @RequestParam(defaultValue = "DSS2") String survey) {
        return skyMapProxyService.cutout(ra, de, angle, w, h, survey);
    }

    @GetMapping(value = "/skywindow", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> skyWindow(
            HttpServletRequest request,
            @RequestParam(required = false) String object,
            @RequestParam(required = false) Double ra,
            @RequestParam(required = false) Double de,
            @RequestParam(required = false) Integer zoom,
            @RequestParam(value = "img_source", defaultValue = "DSS2") String survey) {
        return skyMapProxyService.skyWindow(object, ra, de, zoom, survey, request);
    }

    @GetMapping("/upstream/{path}")
    public ResponseEntity<byte[]> upstream(
            @PathVariable String path,
            HttpServletRequest request) {
        return skyMapProxyService.upstream(path, request.getQueryString());
    }
}
