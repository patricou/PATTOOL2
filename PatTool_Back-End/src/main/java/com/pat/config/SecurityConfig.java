package com.pat.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Value("${keycloak.auth-server-url}")
    private String keycloakAuthServerUrl;

    @Value("${keycloak.realm}")
    private String keycloakRealm;

    @Value("${app.cors.allowed-origins:http://localhost:4200,http://localhost:8000}")
    private String allowedOrigins;

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
                // connect-src: Allow source maps, Firebase, and Keycloak connections
                .contentSecurityPolicy(csp -> csp
                    .policyDirectives("default-src 'self'; " +
                        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://sportpat-5e155.firebaseio.com https://*.firebaseio.com https://*.googleapis.com https://*.gstatic.com https://www.gstatic.com https://www.googleapis.com; " +
                        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://maxcdn.bootstrapcdn.com https://cdn.jsdelivr.net; " +
                        "img-src 'self' data: https: blob:; " +
                        "media-src 'self' data: https: blob:; " +
                        "font-src 'self' data: https://fonts.gstatic.com https://maxcdn.bootstrapcdn.com; " +
                        "connect-src 'self' http://localhost:8080 http://localhost:8000 https://www.patrickdeschamps.com:8543 https://cdn.jsdelivr.net https://sportpat-5e155.firebaseio.com https://*.firebaseio.com https://sportpat-5e155.firebaseapp.com https://*.firebaseapp.com https://*.googleapis.com https://www.googleapis.com https://*.gstatic.com https://www.gstatic.com wss://sportpat-5e155.firebaseio.com wss://*.firebaseio.com ws://localhost:8000 http://localhost:8000/ws; " +
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
                )
            )
            .authorizeHttpRequests(authz -> authz
                // WebSocket endpoint - must be permitted first
                .requestMatchers("/ws/**").permitAll()
                // ============================================
                // SECURITY BLOCKS - Explicitly deny access
                // ============================================
                .requestMatchers("/.git/**", "*.php").denyAll()
                
                // ============================================
                // PUBLIC ENDPOINTS - No authentication required
                // ============================================
                .requestMatchers("/actuator/health").permitAll()
                
                // ============================================
                // STATIC FILES - Allow access without authentication
                // These files must be accessible for Angular to load and initialize Keycloak
                // ============================================
                // Root and index files
                .requestMatchers("/", "/index.html", "/favicon.ico", "/robots.txt").permitAll()
                // All assets directory
                .requestMatchers("/assets/**").permitAll()
                // JavaScript files (Angular bundles)
                .requestMatchers("/*.js", "/*.js.map").permitAll()
                // CSS files
                .requestMatchers("/*.css", "/*.css.map").permitAll()
                // Other static resources
                .requestMatchers("/i18n/**", "/.well-known/**").permitAll()
                // Angular routing paths (to be handled by WebConfig which forwards to index.html)
                .requestMatchers("/even", "/neweven", "/updeven/**", "/details-evenement/**", 
                                "/results", "/maps", "/links", "/links-admin", "/friends", "/iot", "/patgpt", "/system").permitAll()
                
                // ============================================
                // AUTHENTICATED ENDPOINTS - Require authentication
                // ============================================
                // Discussion file serving endpoint - allow public access for images/videos
                .requestMatchers("/api/discussions/files/**").permitAll()
                .requestMatchers("/api/**").authenticated()
                .requestMatchers("/database/**").authenticated()
                .requestMatchers("/uploadfile/**").authenticated()
                .requestMatchers("/uploadondisk/**").authenticated()
                // WebSocket endpoint - allow for real-time discussions
                .requestMatchers("/ws/**").permitAll()
                
                // All other requests - permit all (will be handled by Angular routing)
                // Note: API endpoints above are protected, static files are permitted above
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
