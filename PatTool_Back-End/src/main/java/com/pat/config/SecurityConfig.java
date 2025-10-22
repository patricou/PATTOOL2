package com.pat.config;

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

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(authz -> authz
                // Allow public access to categories endpoint
                .requestMatchers("/api/categories/**").permitAll()
                // Allow public access to member endpoints
                .requestMatchers("/api/memb/**").permitAll()
                // Allow public access to URL link endpoints
                .requestMatchers("/api/urllink/**").permitAll()
                // Allow public access to event endpoints
                .requestMatchers("/api/even/**").permitAll()
                .requestMatchers("/api/evenements/**").permitAll()
                    .requestMatchers("/api/evenements").permitAll()
                // Allow public access to file endpoints
                .requestMatchers("/api/file/**").permitAll()
                // Allow public access to chat endpoints
                .requestMatchers("/api/chat/**").permitAll()
                // Allow public access to Arduino test endpoints
                .requestMatchers("/api/testarduino/**").permitAll()
                // Allow public access to opcl endpoints
                .requestMatchers("/api/opcl/**").permitAll()
                // Allow public access to upload file
                .requestMatchers("/uploadondisk").permitAll()
                // Allow public access to upload in the DB
                .requestMatchers("/uploadfile").permitAll()
                // to migrate fields photoUrls
                    .requestMatchers("/api/migration/**").permitAll()
                // Allow public access to Swagger/OpenAPI
                .requestMatchers("/swagger-ui/**", "/v3/api-docs/**", "/swagger-ui.html").permitAll()
                // Allow public access to actuator health endpoint
                .requestMatchers("/actuator/health").permitAll()
                // Protect other API endpoints
                .requestMatchers("/api/**").authenticated()
                // Allow all other requests
                .anyRequest().permitAll()
            );
        
        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOriginPatterns(Arrays.asList("*"));
        configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(Arrays.asList("*"));
        configuration.setAllowCredentials(true);
        
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}
