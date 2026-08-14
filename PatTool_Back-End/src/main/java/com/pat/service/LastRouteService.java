package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Locale;
import java.util.Set;

/**
 * Per-user last visited Angular route, stored in {@code appParameters}
 * under key {@code app.last-route.&lt;Member.userName&gt;} (surnom in DB).
 * <p>
 * Legacy rows keyed by Keycloak JWT {@code sub} are still read once and
 * migrated to the surnom key on the next save/find.
 */
@Service
public class LastRouteService {

    static final String PARAM_KEY_PREFIX = "app.last-route.";
    private static final int MAX_ROUTE_LEN = 500;
    private static final Set<String> BLOCKED_PREFIXES = Set.of(
            "/tools/tv-popout",
            "/acces-refuse-evenement",
            "/profile"
    );

    private final AppParameterService appParameterService;
    private final UserOwnerService userOwnerService;

    public LastRouteService(AppParameterService appParameterService, UserOwnerService userOwnerService) {
        this.appParameterService = appParameterService;
        this.userOwnerService = userOwnerService;
    }

    /**
     * Resolve storage owner = Member surnom ({@code userName}), never Keycloak {@code sub}.
     * Falls back to JWT {@code preferred_username} when the member row is not yet in Mongo.
     */
    public String resolveOwnerUsername(Jwt jwt) {
        return userOwnerService.username(jwt);
    }

    public String findForUser(Jwt jwt) {
        return userOwnerService.findParam(PARAM_KEY_PREFIX, jwt != null ? jwt.getSubject() : null)
                .map(AppParameter::getParamValue)
                .map(LastRouteService::normalizeRoute)
                .orElse(null);
    }

    public String saveForUser(Jwt jwt, String route) {
        String username = resolveOwnerUsername(jwt);
        if (username == null) {
            throw new IllegalArgumentException("username required");
        }
        String normalized = normalizeRoute(route);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid route");
        }
        String key = PARAM_KEY_PREFIX + username;
        appParameterService.setString(
                key,
                normalized,
                "Last visited PatTool page (Angular hash route) per user (surnom).");
        userOwnerService.dropAliasKeys(PARAM_KEY_PREFIX, jwt != null ? jwt.getSubject() : username);
        return normalized;
    }

    static String normalizeRoute(String raw) {
        if (!StringUtils.hasText(raw)) {
            return null;
        }
        String route = raw.trim();
        if (route.startsWith("#")) {
            route = route.substring(1);
        }
        if (!route.startsWith("/")) {
            route = "/" + route;
        }
        if (route.length() > MAX_ROUTE_LEN) {
            route = route.substring(0, MAX_ROUTE_LEN);
        }
        String lower = route.toLowerCase(Locale.ROOT);
        if (lower.contains("://") || lower.contains("..") || lower.contains("//")) {
            return null;
        }
        for (String blocked : BLOCKED_PREFIXES) {
            if (lower.equals(blocked) || lower.startsWith(blocked + "/") || lower.startsWith(blocked + "?")) {
                return null;
            }
        }
        // Keep only a relative path + optional query (no fragment)
        int hash = route.indexOf('#');
        if (hash >= 0) {
            route = route.substring(0, hash);
        }
        if (!StringUtils.hasText(route) || "/".equals(route)) {
            return null;
        }
        return route;
    }
}
