package com.pat.controller;

import com.pat.controller.dto.LastRouteDto;
import com.pat.controller.dto.UserAppParameterDto;
import com.pat.repo.domain.AppParameter;
import com.pat.service.AppParameterService;
import com.pat.service.LastRouteService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Per-user last visited page and inventory of stored app parameters.
 * <p>
 * {@code GET/PUT /api/external/app/last-route}<br>
 * {@code GET /api/external/app/user-parameters}
 */
@RestController
@RequestMapping("/api/external/app")
public class AppLastRouteRestController {

    private static final Logger log = LoggerFactory.getLogger(AppLastRouteRestController.class);

    private final LastRouteService lastRouteService;
    private final AppParameterService appParameterService;

    public AppLastRouteRestController(LastRouteService lastRouteService, AppParameterService appParameterService) {
        this.lastRouteService = lastRouteService;
        this.appParameterService = appParameterService;
    }

    @GetMapping("/last-route")
    public ResponseEntity<LastRouteDto> getLastRoute() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String route = lastRouteService.findForSubject(sub);
        if (route == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(new LastRouteDto(route));
    }

    @PutMapping("/last-route")
    public ResponseEntity<?> putLastRoute(@RequestBody LastRouteDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            String route = lastRouteService.saveForSubject(sub, body != null ? body.getRoute() : null);
            return ResponseEntity.ok(new LastRouteDto(route));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * All {@code appParameters} rows keyed with the current user's JWT {@code sub}
     * and/or {@code preferred_username} (legacy rows may use either).
     * <p>
     * Optional {@code owner=sub|username|&lt;exactKey&gt;} filters to one owner suffix.
     */
    @GetMapping("/user-parameters")
    public ResponseEntity<List<UserAppParameterDto>> listUserParameters(
            @RequestParam(value = "owner", required = false) String ownerFilter) {
        Jwt jwt = currentJwt();
        if (jwt == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String sub = trimToNull(jwt.getSubject());
        String username = trimToNull(jwt.getClaimAsString("preferred_username"));

        LinkedHashSet<String> owners = new LinkedHashSet<>();
        if (sub != null) {
            owners.add(sub);
        }
        if (username != null) {
            owners.add(username);
        }
        if (owners.isEmpty()) {
            return ResponseEntity.ok(List.of());
        }

        Set<String> selected = owners;
        if (StringUtils.hasText(ownerFilter)) {
            String filter = ownerFilter.trim();
            if ("sub".equalsIgnoreCase(filter) || "keycloak".equalsIgnoreCase(filter)) {
                if (sub == null) {
                    return ResponseEntity.ok(List.of());
                }
                selected = Set.of(sub);
            } else if ("username".equalsIgnoreCase(filter) || "user".equalsIgnoreCase(filter)) {
                if (username == null) {
                    return ResponseEntity.ok(List.of());
                }
                selected = Set.of(username);
            } else if (owners.contains(filter)) {
                selected = Set.of(filter);
            } else {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
            }
        }

        List<UserAppParameterDto> out = new ArrayList<>();
        log.info("user-parameters: sub='{}' username='{}' filter='{}' owners={}",
                sub, username, ownerFilter, selected);
        for (String owner : selected) {
            String suffix = "." + owner;
            List<AppParameter> rows = appParameterService.findByOwnerSuffix(owner);
            log.info("user-parameters: owner='{}' → {} document(s)", owner, rows.size());
            for (AppParameter row : rows) {
                String key = row.getParamKey();
                String feature = key != null && key.endsWith(suffix)
                        ? key.substring(0, key.length() - suffix.length())
                        : key;
                out.add(new UserAppParameterDto(
                        key,
                        feature,
                        row.getParamValue(),
                        row.getValueType(),
                        row.getDescription(),
                        row.getDateModification(),
                        owner));
            }
        }
        out.sort((a, b) -> {
            String ka = a.getFeatureKey() != null ? a.getFeatureKey() : a.getParamKey();
            String kb = b.getFeatureKey() != null ? b.getFeatureKey() : b.getParamKey();
            int c = String.CASE_INSENSITIVE_ORDER.compare(
                    ka != null ? ka : "",
                    kb != null ? kb : "");
            if (c != 0) {
                return c;
            }
            return String.CASE_INSENSITIVE_ORDER.compare(
                    a.getOwnerKey() != null ? a.getOwnerKey() : "",
                    b.getOwnerKey() != null ? b.getOwnerKey() : "");
        });
        return ResponseEntity.ok(out);
    }

    private static Jwt currentJwt() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt;
    }

    private static String currentJwtSubject() {
        Jwt jwt = currentJwt();
        return jwt != null ? trimToNull(jwt.getSubject()) : null;
    }

    private static String trimToNull(String value) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        return value.trim();
    }
}
