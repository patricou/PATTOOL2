package com.pat.service;

import com.pat.repo.domain.AppParameter;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Per-user last visited Angular route, stored in {@code appParameters}
 * under key {@code app.last-route.<JWT sub>}.
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

    public LastRouteService(AppParameterService appParameterService) {
        this.appParameterService = appParameterService;
    }

    public String findForSubject(String jwtSubject) {
        if (!StringUtils.hasText(jwtSubject)) {
            return null;
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        Optional<AppParameter> row = appParameterService.find(key);
        if (row.isEmpty()) {
            return null;
        }
        return normalizeRoute(row.get().getParamValue());
    }

    public String saveForSubject(String jwtSubject, String route) {
        if (!StringUtils.hasText(jwtSubject)) {
            throw new IllegalArgumentException("jwtSubject required");
        }
        String normalized = normalizeRoute(route);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid route");
        }
        String key = PARAM_KEY_PREFIX + jwtSubject;
        appParameterService.setString(
                key,
                normalized,
                "Last visited PatTool page (Angular hash route) per user.");
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
