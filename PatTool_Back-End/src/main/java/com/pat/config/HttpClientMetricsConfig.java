package com.pat.config;

import io.micrometer.common.KeyValue;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.observation.ClientHttpObservationDocumentation.LowCardinalityKeyNames;
import org.springframework.http.client.observation.ClientRequestObservationContext;
import org.springframework.http.client.observation.ClientRequestObservationConvention;
import org.springframework.http.client.observation.DefaultClientRequestObservationConvention;

import java.net.URI;
import java.util.regex.Pattern;

/**
 * RestTemplate outbound metrics: keep {@code uri} low-cardinality (host + path, no query string;
 * numeric path segments collapsed) so tile proxies (WMS BBOX, z/x/y) do not exhaust Micrometer tags.
 */
@Configuration
public class HttpClientMetricsConfig {

    private static final Pattern NUMERIC_PATH_SEGMENT = Pattern.compile("/\\d+");
    private static final Pattern SCHEME_AND_HOST = Pattern.compile("^https?://[^/]+");

    @Bean
    ClientRequestObservationConvention clientRequestObservationConvention() {
        return new DefaultClientRequestObservationConvention() {
            @Override
            protected KeyValue uri(ClientRequestObservationContext context) {
                if (context.getCarrier() != null && context.getCarrier().getURI() != null) {
                    return KeyValue.of(LowCardinalityKeyNames.URI,
                            normalizeClientUri(context.getCarrier().getURI()));
                }
                if (context.getUriTemplate() != null) {
                    return KeyValue.of(LowCardinalityKeyNames.URI,
                            normalizeUriTemplate(context.getUriTemplate()));
                }
                return KeyValue.of(LowCardinalityKeyNames.URI, KeyValue.NONE_VALUE);
            }
        };
    }

    static String normalizeClientUri(URI uri) {
        if (uri == null) {
            return KeyValue.NONE_VALUE;
        }
        String host = uri.getHost() != null ? uri.getHost() : "unknown";
        String path = uri.getPath();
        if (path == null || path.isBlank()) {
            path = "/";
        }
        return host + collapseNumericPathSegments(path);
    }

    static String normalizeUriTemplate(String uriTemplate) {
        if (uriTemplate == null || uriTemplate.isBlank()) {
            return KeyValue.NONE_VALUE;
        }
        String withoutQuery = uriTemplate;
        int queryIdx = withoutQuery.indexOf('?');
        if (queryIdx >= 0) {
            withoutQuery = withoutQuery.substring(0, queryIdx);
        }
        String path = SCHEME_AND_HOST.matcher(withoutQuery).replaceFirst("");
        if (path.isEmpty()) {
            path = "/";
        } else if (!path.startsWith("/")) {
            path = "/" + path;
        }
        return collapseNumericPathSegments(path);
    }

    private static String collapseNumericPathSegments(String path) {
        return NUMERIC_PATH_SEGMENT.matcher(path).replaceAll("/{n}");
    }
}
