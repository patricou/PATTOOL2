package com.pat.controller;

import com.pat.controller.dto.ElectricityCountryNuclearDto;
import com.pat.controller.dto.ElectricityFrPlantDto;
import com.pat.controller.dto.ElectricityGenerationPointDto;
import com.pat.controller.dto.ElectricityNuclearPlantDto;
import com.pat.controller.dto.ElectricityOverviewDto;
import com.pat.controller.dto.ElectricityUnavailabilityDto;
import com.pat.service.ElectricityProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Proxy open data pour la page Électricité PatTool.
 * <ul>
 *   <li>{@code GET /api/external/electricity/overview} — tableau de bord agrégé</li>
 *   <li>{@code GET /api/external/electricity/fr/generation?hours=24}</li>
 *   <li>{@code GET /api/external/electricity/fr/plants}</li>
 *   <li>{@code GET /api/external/electricity/fr/unavailabilities?active=true}</li>
 *   <li>{@code GET /api/external/electricity/world/nuclear-plants}</li>
 *   <li>{@code GET /api/external/electricity/eu/nuclear} — ENTSO-E (clé optionnelle)</li>
 *   <li>{@code GET /api/external/electricity/us/nuclear} — EIA (clé optionnelle)</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/electricity")
public class ElectricityRestController {

    @Autowired
    private ElectricityProxyService electricityProxyService;

    @GetMapping("/overview")
    public ResponseEntity<ElectricityOverviewDto> overview() {
        return ResponseEntity.ok(electricityProxyService.fetchOverview());
    }

    @GetMapping("/fr/generation")
    public ResponseEntity<List<ElectricityGenerationPointDto>> frGeneration(
            @RequestParam(defaultValue = "24") int hours) {
        List<ElectricityGenerationPointDto> data = electricityProxyService.fetchFrGeneration(hours);
        if (data.isEmpty()) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(data);
    }

    @GetMapping("/fr/plants")
    public ResponseEntity<List<ElectricityFrPlantDto>> frPlants() {
        List<ElectricityFrPlantDto> data = electricityProxyService.fetchFrPlants();
        if (data.isEmpty()) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(data);
    }

    @GetMapping("/fr/unavailabilities")
    public ResponseEntity<List<ElectricityUnavailabilityDto>> frUnavailabilities(
            @RequestParam(defaultValue = "true") boolean active) {
        return ResponseEntity.ok(electricityProxyService.fetchFrUnavailabilities(active));
    }

    @GetMapping("/world/nuclear-plants")
    public ResponseEntity<List<ElectricityNuclearPlantDto>> worldNuclearPlants() {
        List<ElectricityNuclearPlantDto> data = electricityProxyService.fetchWorldNuclearPlants();
        if (data.isEmpty()) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(data);
    }

    @GetMapping("/eu/nuclear")
    public ResponseEntity<List<ElectricityCountryNuclearDto>> euNuclear() {
        if (!electricityProxyService.isEntsoeConfigured()) {
            return ResponseEntity.ok(List.of());
        }
        return ResponseEntity.ok(electricityProxyService.fetchEuNuclear());
    }

    @GetMapping("/us/nuclear")
    public ResponseEntity<ElectricityCountryNuclearDto> usNuclear() {
        if (!electricityProxyService.isEiaConfigured()) {
            return ResponseEntity.noContent().build();
        }
        ElectricityCountryNuclearDto dto = electricityProxyService.fetchUsNuclear();
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }
}
