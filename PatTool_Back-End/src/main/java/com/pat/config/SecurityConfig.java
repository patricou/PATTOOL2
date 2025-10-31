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
                .contentSecurityPolicy(csp -> csp
                    .policyDirectives("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' http://localhost:8080 https://www.patrickdeschamps.com:8543;")
                )
                // Prevent clickjacking attacks
                .frameOptions(frame -> frame.deny())
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
                                "/results", "/maps", "/links", "/links-admin", "/iot", "/patgpt").permitAll()
                
                // ============================================
                // AUTHENTICATED ENDPOINTS - Require authentication
                // ============================================
                .requestMatchers("/api/**").authenticated()
                .requestMatchers("/database/**").authenticated()
                .requestMatchers("/uploadfile/**").authenticated()
                .requestMatchers("/uploadondisk/**").authenticated()
                
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
            "user-id", // Custom header used by your app
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
            "Location"
        ));
        
        // Cache preflight requests for 1 hour
        configuration.setMaxAge(3600L);
        
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}
