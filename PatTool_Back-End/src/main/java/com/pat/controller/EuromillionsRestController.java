package com.pat.controller;

import com.pat.controller.dto.EuromillionsClientSettingsDto;
import com.pat.controller.dto.EuromillionsClientSettingsPatchDto;
import com.pat.controller.dto.EuromillionsDrawDateUpdateDto;
import com.pat.controller.dto.EuromillionsDrawDto;
import com.pat.controller.dto.EuromillionsSyncResultDto;
import com.pat.service.EuromillionsAiSettingsService;
import com.pat.service.EuromillionsCsvImportService;
import com.pat.service.EuromillionsFdjArchiveService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@RestController
@RequestMapping("/api/euromillions")
public class EuromillionsRestController {

    private final EuromillionsCsvImportService csvImportService;
    private final EuromillionsFdjArchiveService fdjArchiveService;
    private final EuromillionsAiSettingsService aiSettingsService;

    public EuromillionsRestController(
            EuromillionsCsvImportService csvImportService,
            EuromillionsFdjArchiveService fdjArchiveService,
            EuromillionsAiSettingsService aiSettingsService) {
        this.csvImportService = csvImportService;
        this.fdjArchiveService = fdjArchiveService;
        this.aiSettingsService = aiSettingsService;
    }

    /**
     * Paramètres exposés au front (assistant {@code pat-eurom-ai-v2}). La valeur effective préfère
     * Mongo ({@code appParameters}, clé {@code euromillions.ai.min-draw-date}) lorsqu’elle existe.
     */
    @GetMapping("/client-settings")
    public EuromillionsClientSettingsDto clientSettings() {
        EuromillionsAiSettingsService.EffectiveMinDrawDate e = aiSettingsService.effectiveMinDrawDate();
        return new EuromillionsClientSettingsDto(e.minDrawDateIso(), e.storedInMongo());
    }

    /**
     * Admin : borne basse inclusive (ISO yyyy-MM-dd) persistée en Mongo sous la même clé que dans
     * {@code application.properties} ; prend le pas sur les properties après redémarrage.
     */
    @PatchMapping("/client-settings")
    public EuromillionsClientSettingsDto patchClientSettings(
            @RequestBody(required = false) EuromillionsClientSettingsPatchDto body) {
        if (body == null || body.getMinDrawDateIso() == null || body.getMinDrawDateIso().isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "JSON body with minDrawDateIso (yyyy-MM-dd) required");
        }
        final String iso;
        try {
            iso = aiSettingsService.persistMinDrawDateIso(body.getMinDrawDateIso());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        return new EuromillionsClientSettingsDto(iso, true);
    }

    @GetMapping("/draws")
    public List<EuromillionsDrawDto> listDraws() {
        return csvImportService.listDrawsOrderedByDateDesc();
    }

    /** Lit tous les {@code *.csv} du dossier configuré puis fusion MongoDB. */
    @PostMapping("/sync")
    public EuromillionsSyncResultDto syncFromCsvDirectory() {
        try {
            return csvImportService.importFromConfiguredDirectory();
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    @PostMapping("/fdj-archive/import")
    public EuromillionsSyncResultDto fetchFdjArchiveExtractAndImport() {
        try {
            return fdjArchiveService.fetchArchiveExtractAndImport();
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (RestClientException e) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_GATEWAY, "Téléchargement FDJ impossible : " + e.getMessage());
        }
    }

    /** Met à jour la date de tirage (admin). Corps : {@code id} = code tirage FDJ. */
    @PatchMapping("/draws")
    public EuromillionsDrawDto patchDrawDate(@RequestBody(required = false) EuromillionsDrawDateUpdateDto body) {
        if (body == null) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "JSON body with id (code tirage) and drawDate required");
        }
        try {
            return csvImportService.updateDrawDate(body.getId(), body.getDrawDate());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }
}
