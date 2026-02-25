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
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.*;
import java.util.stream.Collectors;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Value("${keycloak.auth-server-url}")
    private String keycloakAuthServerUrl;

    @Value("${keycloak.realm}")
    private String keycloakRealm;

    @Value("${app.cors.allowed-origins:http://localhost:4200,http://localhost:8000}")
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
        
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .headers(headers -> headers
                // Content Security Policy - restrict resource loading
                // frame-src: Required for Keycloak login iframe, check-sso iframe, and Firebase iframes
                // script-src: Allow Bootstrap CDN, Firebase, and inline scripts
                // style-src: Allow Google Fonts, Bootstrap CDN, Font Awesome, Flag Icons
                // font-src: Allow Google Fonts (fonts.gstatic.com) and Font Awesome (maxcdn.bootstrapcdn.com)
                // img-src: Allow blob: for Angular image handling
                // media-src: Allow blob: for video compression and playback
                // connect-src: Allow source maps, Firebase, Keycloak, Nominatim (OpenStreetMap), and OpenElevation API connections
                .contentSecurityPolicy(csp -> csp
                    .policyDirectives("default-src 'self'; " +
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://sportpat-5e155.firebaseio.com https://*.firebaseio.com https://apis.google.com https://*.googleapis.com https://*.gstatic.com https://www.gstatic.com https://www.googleapis.com; " +
                        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maxcdn.bootstrapcdn.com https://cdn.jsdelivr.net; " +
                        "img-src 'self' data: https: blob:; " +
                        "media-src 'self' data: https: blob:; " +
                        "font-src 'self' data: https://fonts.gstatic.com https://maxcdn.bootstrapcdn.com; " +
                        "connect-src 'self' blob: http://localhost:8080 http://localhost:8000 https://www.patrickdeschamps.com:8543 https://cdn.jsdelivr.net https://sportpat-5e155.firebaseio.com https://*.firebaseio.com https://sportpat-5e155.firebaseapp.com https://*.firebaseapp.com https://*.googleapis.com https://www.googleapis.com https://*.gstatic.com https://www.gstatic.com https://nominatim.openstreetmap.org https://api.open-elevation.com wss://sportpat-5e155.firebaseio.com wss://*.firebaseio.com ws://localhost:8000 http://localhost:8000/ws; " +
                        "frame-src 'self' https://www.patrickdeschamps.com:8543 http://localhost:8080 https://*.firebaseio.com https://sportpat-5e155.firebaseio.com https://www.google.com https://maps.google.com https://*.google.com;")
                )
                // Note: frameOptions is not set to allow Keycloak iframes
                // Security is handled by CSP frame-src directive above
                // Prevent MIME type sniffing - enables nosniff header
                .contentTypeOptions(contentType -> {})
                // HTTP Strict Transport Security (HSTS) - only in production with HTTPS
                .httpStrictTransportSecurity(hsts -> hsts
                    .maxAgeInSeconds(31536000) // 1 year
                    .includeSubDomains(true)
                )
                // XSS Protection - enabled with default settings
                .xssProtection(xss -> {})
            )
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .jwkSetUri(jwkSetUri)
                    .jwtAuthenticationConverter(jwtAuthenticationConverter())
                )
            )
            .authorizeHttpRequests(authz -> authz
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
                // IoT endpoints - require Iot role
                .requestMatchers("/iot", "/api/testarduino", "/api/opcl").hasRole("Iot")
                
                // GET event details by ID: allow anonymous so controller can return 403 (no access) instead of 401
                // This way the frontend can show "ask owner for access" instead of redirecting to login
                .requestMatchers(HttpMethod.GET, "/api/even/*").permitAll()
                
                // ============================================
                // AUTHENTICATED API ENDPOINTS - Default: All APIs require authentication
                // ============================================
                // All API endpoints require authentication by default
                // Note: More specific API rules (role-based) are defined above and checked first
                // IMPORTANT: This rule MUST come before .anyRequest() to protect all /api/** endpoints
                .requestMatchers("/api/**").authenticated()
                
                // Other authenticated endpoints (non-API)
                .requestMatchers("/database/**", "/uploadfile/**", "/uploadondisk/**").authenticated()
                
                // ============================================
                // FRONTEND ROUTING - Angular routes (permit for SPA routing)
                // ============================================
                // Angular routing paths (to be handled by WebConfig which forwards to index.html)
                // Note: /iot is protected above and requires Iot role
                .requestMatchers("/even", "/neweven", "/updeven/**", "/details-evenement/**", 
                                "/results", "/maps", "/links", "/links-admin",
                                "/friends", "/patgpt", "/system").permitAll()
                
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
            "Cache-Control"
        ));
        
        // Cache preflight requests for 1 hour
        configuration.setMaxAge(3600L);
        
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}
