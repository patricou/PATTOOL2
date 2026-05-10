package com.pat.controller;

import com.pat.controller.dto.LotoDrawDateUpdateDto;
import com.pat.controller.dto.LotoDrawDto;
import com.pat.controller.dto.LotoSyncRequestDto;
import com.pat.controller.dto.LotoSyncResultDto;
import com.pat.service.LotoLesBonsNumerosSyncService;
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
@RequestMapping("/api/loto")
public class LotoRestController {

    private final LotoLesBonsNumerosSyncService lotoLesBonsNumerosSyncService;

    public LotoRestController(LotoLesBonsNumerosSyncService lotoLesBonsNumerosSyncService) {
        this.lotoLesBonsNumerosSyncService = lotoLesBonsNumerosSyncService;
    }

    @GetMapping("/draws")
    public List<LotoDrawDto> listDraws() {
        return lotoLesBonsNumerosSyncService.listDrawsOrderedByDateDesc();
    }

    /**
     * Importe les pages mensuelles sur une plage (mois inclusifs, {@code yyyy-MM}), puis fusionne en base.
     * Peut prendre du temps si la plage couvre beaucoup de mois.
     */
    @PostMapping("/sync")
    public LotoSyncResultDto syncArchive(@RequestBody(required = false) LotoSyncRequestDto body) {
        if (body == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "JSON body with startYearMonth and endYearMonth (yyyy-MM) required");
        }
        try {
            return lotoLesBonsNumerosSyncService.syncYearMonthRange(body.getStartYearMonth(), body.getEndYearMonth());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }

    /**
     * Met à jour la {@link com.pat.repo.domain.LotoDraw#setDrawDate date de tirage} d’un document (clé Mongo = URL détail).
     */
    @PatchMapping("/draws")
    public LotoDrawDto patchDrawDate(@RequestBody(required = false) LotoDrawDateUpdateDto body) {
        if (body == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "JSON body with id and drawDate required");
        }
        try {
            return lotoLesBonsNumerosSyncService.updateDrawDate(body.getId(), body.getDrawDate());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }
}
