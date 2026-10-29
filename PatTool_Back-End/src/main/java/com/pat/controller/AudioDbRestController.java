package com.pat.controller;

import com.pat.controller.dto.AudioDbDossierDto;
import com.pat.service.AudioDbCatalogService;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.Map;

/**
 * TheAudioDB artist and album dossier (read-only).
 * {@code GET /api/external/audiodb/dossier?artist=Daft%20Punk&album=Discovery&lang=fr}
 */
@RestController
@RequestMapping("/api/external/audiodb")
public class AudioDbRestController {

    private final AudioDbCatalogService audioDbCatalogService;

    public AudioDbRestController(AudioDbCatalogService audioDbCatalogService) {
        this.audioDbCatalogService = audioDbCatalogService;
    }

    @GetMapping("/dossier")
    public ResponseEntity<?> dossier(
            @RequestParam("artist") String artist,
            @RequestParam(value = "album", required = false) String album,
            @RequestParam(value = "lang", required = false) String lang) {
        if (AudioDbCatalogService.cleanQuery(artist).isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Invalid artist"));
        }
        try {
            AudioDbDossierDto body = audioDbCatalogService.dossier(artist, album, lang);
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic())
                    .body(body);
        } catch (AudioDbCatalogService.UpstreamException e) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "TheAudioDB indisponible"));
        }
    }
}
