package com.pat.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.convert.converter.Converter;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;
import org.springframework.core.Ordered;
import org.springframework.boot.web.servlet.FilterRegistrationBean;

import java.util.*;
import java.util.stream.Collectors;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Value("${keycloak.auth-server-url}")
    private String keycloakAuthServerUrl;

    @Value("${keycloak.realm}")
    private String keycloakRealm;

    @Value("${app.cors.allowed-origins:http://localhost:4200,http://127.0.0.1:4200,http://localhost:8000,http://127.0.0.1:8000}")
    private String allowedOrigins;

    @Value("${keycloak.client-id:tutorial-frontend}")
    private String keycloakClientId;

    @Bean
    public JwtDecoder jwtDecoder() {
        String jwkSetUri = keycloakAuthServerUrl + "/realms/" + keycloakRealm + "/protocol/openid-connect/certs";
        return NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build();
    }

    /**
     * JWT Authentication Converter to extract roles from Keycloak JWT tokens
     * Extracts roles from both realm_access.roles and resource_access.{clientId}.roles
     */
    @Bean
    public JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(new KeycloakJwtGrantedAuthoritiesConverter());
        return converter;
    }

    /**
     * Custom converter to extract roles from Keycloak JWT tokens
     */
    private class KeycloakJwtGrantedAuthoritiesConverter implements Converter<Jwt, Collection<GrantedAuthority>> {
        @Override
        public Collection<GrantedAuthority> convert(Jwt jwt) {
            Collection<GrantedAuthority> authorities = new ArrayList<>();

            // Extract realm-level roles from realm_access.roles
            Map<String, Object> realmAccess = jwt.getClaimAsMap("realm_access");
            if (realmAccess != null) {
                @SuppressWarnings("unchecked")
                List<String> realmRoles = (List<String>) realmAccess.get("roles");
                if (realmRoles != null) {
                    authorities.addAll(realmRoles.stream()
                            .map(role -> new SimpleGrantedAuthority("ROLE_" + role))
                            .collect(Collectors.toList()));
                }
            }

            // Extract client-level roles from resource_access.{clientId}.roles
            Map<String, Object> resourceAccess = jwt.getClaimAsMap("resource_access");
            if (resourceAccess != null) {
                @SuppressWarnings("unchecked")
                Map<String, Object> clientAccess = (Map<String, Object>) resourceAccess.get(keycloakClientId);
                if (clientAccess != null) {
                    @SuppressWarnings("unchecked")
                    List<String> clientRoles = (List<String>) clientAccess.get("roles");
                    if (clientRoles != null) {
                        authorities.addAll(clientRoles.stream()
                                .map(role -> new SimpleGrantedAuthority("ROLE_" + role))
                                .collect(Collectors.toList()));
                    }
                }
            }

            return authorities;
        }
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        String jwkSetUri = keycloakAuthServerUrl + "/realms/" + keycloakRealm + "/protocol/openid-connect/certs";
        String frameAncestors = buildFrameAncestorsDirective();
        
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .headers(headers -> headers
                // Content Security Policy - restrict resource loading
                // frame-ancestors: allow Angular dev/prod origins to embed backend pages (e.g. Stellarium viewer)
                // frame-src: Keycloak, cartes.gouv.fr, ISS live YouTube embeds, Stellarium Web sky map
                // script-src: Allow Bootstrap CDN and inline scripts
                // style-src: Allow Google Fonts, Bootstrap CDN, Font Awesome, Flag Icons
                // font-src: Allow Google Fonts (fonts.gstatic.com) and Font Awesome (maxcdn.bootstrapcdn.com)
                // img-src: Allow blob: for Angular image handling
                // media-src: Allow blob: for video compression and playback
                // connect-src: Allow source maps, Keycloak, Nominatim (OpenStreetMap), and OpenElevation API connections
                .contentSecurityPolicy(csp -> csp
                    .policyDirectives("default-src 'self'; " +
                        "frame-ancestors 'self' " + frameAncestors + "; " +
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://apis.google.com https://*.googleapis.com https://*.gstatic.com https://www.gstatic.com https://www.googleapis.com; " +
                        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maxcdn.bootstrapcdn.com https://cdn.jsdelivr.net; " +
                        "img-src 'self' data: https: blob:; " +
                        "media-src 'self' data: https: blob:; " +
                        "font-src 'self' data: https://fonts.gstatic.com https://maxcdn.bootstrapcdn.com; " +
                        "connect-src 'self' blob: http://localhost:8080 http://localhost:8000 https://www.patrickdeschamps.com:8543 https://cdn.jsdelivr.net https://*.googleapis.com https://www.googleapis.com https://*.gstatic.com https://www.gstatic.com https://nominatim.openstreetmap.org https://api.open-elevation.com ws://localhost:8000 http://localhost:8000/ws; " +
                        "frame-src 'self' https://www.patrickdeschamps.com:8543 http://localhost:8080 https://www.google.com https://maps.google.com https://*.google.com https://cartes.gouv.fr https://www.youtube.com https://www.youtube-nocookie.com https://stellarium-web.org https://*.stellarium-web.org https://d3ufh70wg9uzo4.cloudfront.net;")
                )
                // Disable X-Frame-Options (defaults to DENY in Spring Security); framing is governed by CSP frame-ancestors.
                .frameOptions(frame -> frame.disable())
                // Prevent MIME type sniffing - enables nosniff header
                .contentTypeOptions(contentType -> {})
                // HTTP Strict Transport Security (HSTS) - only in production with HTTPS
                .httpStrictTransportSecurity(hsts -> hsts
                    .maxAgeInSeconds(31536000) // 1 year
                    .includeSubDomains(true)
                )
                // XSS Protection - enabled with default settings
                .xssProtection(xss -> {})
                // Referrer: limit cross-origin URL leakage (explicit header for scanners / legacy browsers)
                .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .jwkSetUri(jwkSetUri)
                    .jwtAuthenticationConverter(jwtAuthenticationConverter())
                )
            )
            .authorizeHttpRequests(authz -> authz
                // ============================================
                // CORS PREFLIGHT - Allow OPTIONS without auth so browser preflight succeeds
                // (actual POST/GET still require auth via Authorization header)
                // ============================================
                .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                
                // ============================================
                // SECURITY BLOCKS - Explicitly deny access first
                // ============================================
                .requestMatchers("/.git/**", "*.php").denyAll()
                
                // ============================================
                // PUBLIC STATIC RESOURCES - Required for app initialization
                // These must be accessible for Angular to load and initialize Keycloak
                // ============================================
                // Health check endpoint (monitoring)
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/api/health/**").permitAll()
                
                // Root and index files
                .requestMatchers("/", "/index.html", "/favicon.ico", "/robots.txt").permitAll()
                
                // Static assets (JavaScript, CSS, images, fonts, etc.)
                .requestMatchers("/assets/**", "/*.js", "/*.js.map", "/*.css", "/*.css.map", 
                                "/i18n/**", "/.well-known/**").permitAll()
                
                // WebSocket endpoint (for real-time features)
                .requestMatchers("/ws/**").permitAll()
                
                // ============================================
                // ROLE-BASED API ENDPOINTS - Require specific roles
                // ============================================
                // IoT endpoints - require Iot role (hasAnyRole matches realm/client "Iot" / "iot")
                .requestMatchers("/iot", "/api/testarduino", "/api/opcl").hasAnyRole("Iot", "iot")

                // IoT Cameras CRUD - protected: only users with Iot role can list,
                // view, create, update or delete cameras. Case-insensitive match
                // on the role name ("Iot" / "iot") matches the frontend guard in
                // KeycloakService.hasIotRole().
                .requestMatchers("/api/cameras", "/api/cameras/**").hasAnyRole("Iot", "iot")

                // IoT LAN proxy: CRUD restricted to Iot; forward path (any method) validated inside controller (iotOpen cookie/query or Bearer + Iot).
                    // Forms and XHR on the proxied SPA use POST/PUT etc. — they must reach the controller without a PatTool JWT.
                .requestMatchers("/api/iot-proxies/forward/**").permitAll()
                .requestMatchers("/api/iot-proxies/**").hasAnyRole("Iot", "iot")

                // Home IoT relay (GET) — must not fall through to /api/** authenticated() only
                .requestMatchers("/api/relais1status", "/api/relais1statuson", "/api/relais1statusoff").hasAnyRole("Iot", "iot")
                .requestMatchers("/api/govee/**").hasAnyRole("Iot", "iot")
                
                // GET event details by ID: allow anonymous so controller can return 403 (no access) instead of 401
                // This way the frontend can show "ask owner for access" instead of redirecting to login
                .requestMatchers(HttpMethod.GET, "/api/even/*").permitAll()
                
                // Geo: geocode and altitudes (no sensitive data, allow without login for address/map tools)
                .requestMatchers(HttpMethod.GET, "/api/external/geocode/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/globe/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/globe/iss/global-prefs").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/globe/iss/trace/background").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/external/globe/iss/trace").permitAll()
                .requestMatchers(HttpMethod.DELETE, "/api/external/globe/iss/trace").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/altitudes").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/elevation").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/forecast/coordinates").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/forecast/aggregated").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/map/temperature/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/map/clouds/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/weather/map/temperature-labels").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/external/weather/map/temperature-labels").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/radar/wms").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/radar/wms/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/radar/mosaic").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/radar/preferences").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/radar/rainviewer/maps").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/radar/rainviewer/tile/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/clim/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/external/meteofrance/clim/cache/clear").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/external/meteofrance/forecast/cache/clear").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/obs/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteoswiss/obs/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/external/meteoswiss/obs/history/cache/clear").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteoswiss/precip/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/aromepi/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/meteofrance/arpege/**").permitAll()

                // News image proxy: <img src> tags cannot send a JWT. The proxy
                // itself enforces SSRF + size + content-type guards, so leaving
                // the endpoint public is safe.
                .requestMatchers(HttpMethod.GET, "/api/external/news/image").permitAll()

                // Calendar month view: activities use optional user-id header; personal appointments only when authenticated (see controller)
                .requestMatchers(HttpMethod.GET, "/api/calendar/entries").permitAll()
                // Public holidays proxy (Nager.Date) — données publiques, sans auth
                .requestMatchers(HttpMethod.GET, "/api/calendar/public-holidays/**").permitAll()
                // Currency rates proxy (Frankfurter / BCE) — données publiques, sans auth
                .requestMatchers(HttpMethod.GET, "/api/external/currency/**").permitAll()
                // IANA time-zone conversion — server-side java.time, no auth
                .requestMatchers(HttpMethod.GET, "/api/external/timezone/**").permitAll()
                // Stock exchange proxy (Twelve Data) — lecture seule + purge du cache ticker,
                // sans auth (la clé API est côté serveur, aucun secret n'est exposé).
                .requestMatchers(HttpMethod.GET, "/api/external/stock/**").permitAll()
                .requestMatchers(HttpMethod.DELETE, "/api/external/stock/quote/cached").permitAll()
                // Crypto prices proxy (CoinGecko) — données publiques, sans auth
                .requestMatchers(HttpMethod.GET, "/api/external/crypto/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/external/electricity/**").permitAll()
                // CERN Open Data & CDS Repository proxies — public read-only data
                .requestMatchers(HttpMethod.GET, "/api/external/cern/**").permitAll()
                // Chemistry proxy (PubChem) — public read-only data (periodic table, molecules, images)
                .requestMatchers(HttpMethod.GET, "/api/external/chem/**").permitAll()
                // Stellarium Web — sky map viewer + Noctua Sky catalogue proxy (read-only)
                .requestMatchers(HttpMethod.GET, "/api/external/stellarium/**").permitAll()
                // Tirages Loto importés (lecture seule, données publiques d'archive)
                .requestMatchers(HttpMethod.GET, "/api/loto/**").permitAll()
                // Sync Loto (scraping) — réservé aux administrateurs
                .requestMatchers(HttpMethod.POST, "/api/loto/sync").hasAnyRole("Admin", "admin")
                // Correction manuelle de la date de tirage en base — administrateurs
                .requestMatchers(HttpMethod.PATCH, "/api/loto/draws").hasAnyRole("Admin", "admin")
                // Tirages EuroMillions (CSV → Mongo ; lecture sans auth ; import / correction admin)
                .requestMatchers(HttpMethod.GET, "/api/euromillions/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/euromillions/sync").hasAnyRole("Admin", "admin")
                .requestMatchers(HttpMethod.POST, "/api/euromillions/fdj-archive/import")
                .hasAnyRole("Admin", "admin")
                .requestMatchers(HttpMethod.PATCH, "/api/euromillions/client-settings").hasAnyRole("Admin", "admin")
                .requestMatchers(HttpMethod.PATCH, "/api/euromillions/draws").hasAnyRole("Admin", "admin")
                .requestMatchers(HttpMethod.POST, "/api/euromillions/method-analytics/recompute")
                .hasAnyRole("Admin", "admin")
                // PATTOOL Parameters (read-only application.properties snapshot)
                .requestMatchers("/api/admin/**").hasAnyRole("Admin", "admin")

                // Stream event files (SSE): require authentication so SecurityContext has user and getCurrentUserId() works
                .requestMatchers(HttpMethod.GET, "/api/even/*/files/stream").authenticated()
                
                // ============================================
                // AUTHENTICATED API ENDPOINTS - Default: All APIs require authentication
                // ============================================
                // All API endpoints require authentication by default
                // Note: More specific API rules (role-based) are defined above and checked first
                // IMPORTANT: This rule MUST come before .anyRequest() to protect all /api/** endpoints
                .requestMatchers("/api/**").authenticated()
                
                // TEMPORARY: Allow POST /uploadfile without auth to confirm request reaches controller.
                // If controller is hit, the issue is JWT validation; remove this and fix token/issuer.
                .requestMatchers(HttpMethod.POST, "/uploadfile/**").permitAll()
                
                // Other authenticated endpoints (non-API)
                .requestMatchers("/database/**", "/uploadfile/**", "/uploadondisk/**").authenticated()
                
                // ============================================
                // FRONTEND ROUTING - Angular routes (permit for SPA routing)
                // ============================================
                // Angular routing paths (to be handled by WebConfig which forwards to index.html)
                // Note: /iot is protected above and requires Iot role
                .requestMatchers("/even", "/neweven", "/updeven/**", "/details-evenement/**", 
                                "/results", "/maps", "/links", "/links-admin",
                                "/friends", "/system", "/calendrier",
                                "/tools/pattool-parameters").permitAll()
                
                // ============================================
                // DEFAULT - Permit for Angular SPA routing
                // ============================================
                // SECURITY NOTE: This permits all other requests for Angular routing.
                // All API endpoints are protected above via /api/** rule.
                // Any new API endpoints MUST be under /api/** or explicitly protected above.
                // Frontend routes are safe to permit as they only serve index.html.
                .anyRequest().permitAll()
            );
        
        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        
        // SECURE: Use specific allowed origins instead of wildcard
        // Split comma-separated origins from configuration
        configuration.setAllowedOrigins(Arrays.asList(allowedOrigins.split(",")));
        
        // Allowed HTTP methods
        configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"));
        
        // Allowed headers - be specific for better security
        configuration.setAllowedHeaders(Arrays.asList(
            "Authorization",
            "Content-Type",
            "X-Requested-With",
            "Accept",
            "Origin",
            "Access-Control-Request-Method",
            "Access-Control-Request-Headers",
            "Cache-Control", // Required for SSE streaming
            "user-id", // Custom header used by your app
            "visibility-filter", // Custom header for visibility filtering
            "admin-override", // Custom header for admin override to see all events
            "Author",  // Custom header sent by frontend
            "User",    // Custom header sent by frontend (user data)
            "user"     // Custom header sent by frontend (lowercase variant)
        ));
        
        // Allow credentials (cookies, authorization headers)
        configuration.setAllowCredentials(true);
        
        // Exposed headers that frontend can read
        configuration.setExposedHeaders(Arrays.asList(
            "Authorization",
            "Content-Type",
            "Location",
            "Content-Disposition",
            "Cache-Control",
            "X-Upload-Error"
        ));
        
        // Cache preflight requests for 1 hour
        configuration.setMaxAge(3600L);
        
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }

    /**
     * Register CorsFilter at the highest priority so CORS headers are present
     * on ALL responses, including error responses from security filters or
     * other early-stage filters (e.g. MemoryCheckFilter, JWT auth failures).
     * Without this, the browser blocks error responses that lack CORS headers.
     */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilterRegistration() {
        FilterRegistrationBean<CorsFilter> bean = new FilterRegistrationBean<>(
            new CorsFilter(corsConfigurationSource())
        );
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return bean;
    }

    /** CSP {@code frame-ancestors} sources derived from {@link #allowedOrigins}. */
    private String buildFrameAncestorsDirective() {
        return Arrays.stream(allowedOrigins.split(","))
                .map(String::trim)
                .filter(origin -> !origin.isEmpty())
                .collect(Collectors.joining(" "));
    }
}
