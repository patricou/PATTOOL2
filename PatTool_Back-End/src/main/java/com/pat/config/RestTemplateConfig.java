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

    /** Longer timeouts: globe proxy may hit large JPEGs/WMS payloads and flaky public ISS APIs. */
    public static final String GLOBE_PROXY_REST_TEMPLATE = "globeProxyRestTemplate";

    /** CERN Open Data / CDS Repository — responses can be large JSON payloads. */
    public static final String CERN_REST_TEMPLATE = "cernRestTemplate";


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

    @Bean(CERN_REST_TEMPLATE)
    public RestTemplate cernRestTemplate(RestTemplateBuilder builder) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(5))
                .setReadTimeout(Duration.ofSeconds(20))
                .build();
    }

    @Bean(GLOBE_PROXY_REST_TEMPLATE)
    public RestTemplate globeProxyRestTemplate(
            RestTemplateBuilder builder,
            @Value("${globe.proxy.http.connect-timeout-seconds:10}") int connectSeconds,
            @Value("${globe.proxy.http.read-timeout-seconds:90}") int readSeconds) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(Math.max(connectSeconds, 1)))
                .setReadTimeout(Duration.ofSeconds(Math.max(readSeconds, 1)))
                .build();
    }

    /**
     * Client HTTP réservé aux appels assistant OpenAI (chat, billing liste crédits, etc.).
     */
    @Bean("openAiRestTemplate")
    public RestTemplate openAiRestTemplate(
            RestTemplateBuilder builder,
            @Value("${openai.http.connect-timeout-seconds:300}") int connectSeconds,
            @Value("${openai.http.read-timeout-seconds:300}") int readSeconds) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(connectSeconds))
                .setReadTimeout(Duration.ofSeconds(readSeconds))
                .build();
    }

    /**
     * Client HTTP réservé aux appels Anthropic Messages (assistant + liste des modèles).
     */
    @Bean("anthropicRestTemplate")
    public RestTemplate anthropicRestTemplate(
            RestTemplateBuilder builder,
            @Value("${anthropic.http.connect-timeout-seconds:300}") int connectSeconds,
            @Value("${anthropic.http.read-timeout-seconds:300}") int readSeconds) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(connectSeconds))
                .setReadTimeout(Duration.ofSeconds(readSeconds))
                .build();
    }

    /**
     * Client HTTP réservé aux appels Google Gemini generateContent / liste modèles.
     */
    @Bean("geminiRestTemplate")
    public RestTemplate geminiRestTemplate(
            RestTemplateBuilder builder,
            @Value("${gemini.http.connect-timeout-seconds:300}") int connectSeconds,
            @Value("${gemini.http.read-timeout-seconds:300}") int readSeconds) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(connectSeconds))
                .setReadTimeout(Duration.ofSeconds(readSeconds))
                .build();
    }
}