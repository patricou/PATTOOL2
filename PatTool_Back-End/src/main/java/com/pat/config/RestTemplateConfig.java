package com.pat.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;

@Configuration
public class RestTemplateConfig {

    /**
     * Client HTTP court pour proxies et API externes (échec rapide si indisponible).
     */
    @Bean
    @Primary
    public RestTemplate restTemplate(RestTemplateBuilder builder) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(2))
                .setReadTimeout(Duration.ofSeconds(3))
                .build();
    }

    /**
     * Client HTTP OpenAI : connect / read timeouts (secondes) depuis
     * {@code openai.http.connect-timeout-seconds} et {@code openai.http.read-timeout-seconds}
     * dans {@code application.properties} (aucune valeur par défaut dans le code).
     */
    @Bean("openAiRestTemplate")
    public RestTemplate openAiRestTemplate(
            RestTemplateBuilder builder,
            @Value("${openai.http.connect-timeout-seconds}") int connectSeconds,
            @Value("${openai.http.read-timeout-seconds}") int readSeconds) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(connectSeconds))
                .setReadTimeout(Duration.ofSeconds(readSeconds))
                .build();
    }
}