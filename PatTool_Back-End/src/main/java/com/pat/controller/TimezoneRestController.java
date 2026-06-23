package com.pat.controller;

import com.pat.controller.dto.TimezoneConvertResponseDto;
import com.pat.controller.dto.TimezoneInstantDto;
import com.pat.controller.dto.TimezoneZoneDto;
import com.pat.service.TimezoneService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * IANA time-zone utilities for the PatTool "Fuseaux horaires" page.
 * <p>
 * Endpoints :
 * <ul>
 *   <li>{@code GET /api/external/timezone/zones} — all IANA zones with current offset</li>
 *   <li>{@code GET /api/external/timezone/now?zone=Europe/Paris} — current time in a zone</li>
 *   <li>{@code GET /api/external/timezone/convert?dateTime=2026-06-23T14:30&from=Europe/Paris&to=America/New_York[,UTC]}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/timezone")
public class TimezoneRestController {

    @Autowired
    private TimezoneService timezoneService;

    @GetMapping("/zones")
    public ResponseEntity<Map<String, List<TimezoneZoneDto>>> zones(
            @RequestParam(required = false) String at,
            @RequestParam(required = false) String dateTime,
            @RequestParam(required = false) String zone) {

        try {
            return ResponseEntity.ok(Collections.singletonMap(
                    "zones",
                    timezoneService.listZones(timezoneService.resolveReferenceInstant(at, dateTime, zone))));
        } catch (Exception ex) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/now")
    public ResponseEntity<TimezoneInstantDto> now(@RequestParam String zone) {
        if (!StringUtils.hasText(zone)) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(timezoneService.now(zone));
        } catch (Exception ex) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/convert")
    public ResponseEntity<TimezoneConvertResponseDto> convert(
            @RequestParam String dateTime,
            @RequestParam String from,
            @RequestParam String to) {

        if (!StringUtils.hasText(dateTime) || !StringUtils.hasText(from) || !StringUtils.hasText(to)) {
            return ResponseEntity.badRequest().build();
        }

        List<String> targets = Arrays.asList(to.split(","));
        try {
            TimezoneConvertResponseDto result = timezoneService.convert(dateTime, from, targets);
            if (result == null) {
                return ResponseEntity.badRequest().build();
            }
            return ResponseEntity.ok(result);
        } catch (Exception ex) {
            return ResponseEntity.badRequest().build();
        }
    }
}
