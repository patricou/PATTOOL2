package com.pat.controller;

import com.pat.controller.dto.EuromillionsDrawDateUpdateDto;
import com.pat.controller.dto.EuromillionsDrawDto;
import com.pat.controller.dto.EuromillionsSyncResultDto;
import com.pat.service.EuromillionsCsvImportService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@RestController
@RequestMapping("/api/euromillions")
public class EuromillionsRestController {

    private final EuromillionsCsvImportService csvImportService;

    public EuromillionsRestController(EuromillionsCsvImportService csvImportService) {
        this.csvImportService = csvImportService;
    }

    @GetMapping("/draws")
    public List<EuromillionsDrawDto> listDraws() {
        return csvImportService.listDrawsOrderedByDateDesc();
    }

    /**
     * Lit tous les fichiers {@code *.csv} du répertoire configuré ({@code euromillions.import.directory})
     * et fusionne en MongoDB (clé = code tirage FDJ).
     */
    @PostMapping("/sync")
    public EuromillionsSyncResultDto syncFromCsvDirectory() {
        try {
            return csvImportService.importFromConfiguredDirectory();
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    /**
     * Met à jour la date de tirage (admin). Corps : {@code id} = code tirage FDJ (clé Mongo).
     */
    @PatchMapping("/draws")
    public EuromillionsDrawDto patchDrawDate(@RequestBody(required = false) EuromillionsDrawDateUpdateDto body) {
        if (body == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "JSON body with id (code tirage) and drawDate required");
        }
        try {
            return csvImportService.updateDrawDate(body.getId(), body.getDrawDate());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }
}
