package com.pat.controller;

import com.pat.dto.PassiveProbeRequest;
import com.pat.dto.PassiveProbeResponse;
import com.pat.service.PassiveSiteProbeService;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * API REST « scan passif » sous authentification JWT. Délègue à {@link PassiveSiteProbeService} :
 * en-têtes de sécurité, HTTPS, certificat, {@code security.txt}, cookies analysés en surface ; si {@code includeActiveChecks},
 * ajoute OPTIONS (Allow), TRACE et récupération de {@code /robots.txt}. N’est pas un pentest : pas d’injection ni de crawl.
 */
@RestController
@RequestMapping("/api/security-scan")
public class SecurityPassiveProbeController {

    private final PassiveSiteProbeService passiveSiteProbeService;

    public SecurityPassiveProbeController(PassiveSiteProbeService passiveSiteProbeService) {
        this.passiveSiteProbeService = passiveSiteProbeService;
    }

    @PostMapping("/passive-probe")
    public PassiveProbeResponse passiveProbe(@RequestBody PassiveProbeRequest body) {
        if (body == null || !body.authorizationConfirmed()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "authorizationConfirmed must be true before probing.");
        }
        return passiveSiteProbeService.probe(
                body.targetUrl(), Boolean.TRUE.equals(body.includeActiveChecks()));
    }
}
