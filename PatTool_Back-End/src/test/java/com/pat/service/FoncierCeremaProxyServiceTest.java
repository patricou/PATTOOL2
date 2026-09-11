package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.RestTemplate;

import java.net.URI;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class FoncierCeremaProxyServiceTest {

    private RestTemplate restTemplate;
    private FoncierGeoService geoService;
    private FoncierCeremaProxyService service;

    @BeforeEach
    void setUp() {
        restTemplate = mock(RestTemplate.class);
        geoService = mock(FoncierGeoService.class);
        service = new FoncierCeremaProxyService(restTemplate, new ObjectMapper(), geoService);
        ReflectionTestUtils.setField(service, "apiBase", "https://apidf-preprod.cerema.fr");
        when(geoService.communeByInsee("01419")).thenReturn(null);
    }

    @Test
    void http503DoesNotFallBackToCodeInsee() {
        when(restTemplate.exchange(any(URI.class), eq(HttpMethod.GET), any(), eq(String.class)))
                .thenThrow(HttpServerErrorException.create(
                        HttpStatus.SERVICE_UNAVAILABLE, "Service Unavailable",
                        HttpHeaders.EMPTY, new byte[0], StandardCharsets.UTF_8));

        IllegalStateException ex = assertThrows(IllegalStateException.class,
                () -> service.mutations("01419", null, 1, 10, 10, null, null, null, 46.2, 5.2));
        assertEquals("upstream_unavailable", ex.getMessage());
        verify(restTemplate, times(1)).exchange(any(URI.class), eq(HttpMethod.GET), any(), eq(String.class));
    }

    @Test
    void http400FallsBackToCodeInsee() {
        when(restTemplate.exchange(any(URI.class), eq(HttpMethod.GET), any(), eq(String.class)))
                .thenAnswer(invocation -> {
                    URI uri = invocation.getArgument(0);
                    if (uri.toString().contains("in_bbox")) {
                        throw HttpClientErrorException.create(
                                HttpStatus.BAD_REQUEST, "Bad Request",
                                HttpHeaders.EMPTY, new byte[0], StandardCharsets.UTF_8);
                    }
                    return ResponseEntity.ok("{\"count\":0,\"results\":[]}");
                });

        var page = service.mutations("01419", null, 1, 10, 10, null, null, null, 46.2, 5.2);
        assertEquals(0, page.get("count").asInt());
        verify(restTemplate, times(2)).exchange(any(URI.class), eq(HttpMethod.GET), any(), eq(String.class));
    }

    @Test
    void cooldownSkipsCeremaAfter503() {
        when(restTemplate.exchange(any(URI.class), eq(HttpMethod.GET), any(), eq(String.class)))
                .thenThrow(HttpServerErrorException.create(
                        HttpStatus.SERVICE_UNAVAILABLE, "Service Unavailable",
                        HttpHeaders.EMPTY, new byte[0], StandardCharsets.UTF_8));

        assertThrows(IllegalStateException.class,
                () -> service.mutations("01419", null, 1, 10, 10, null, null, null, 46.2, 5.2));
        assertThrows(IllegalStateException.class,
                () -> service.mutations("01419", null, 1, 10, 10, null, null, null, 46.2, 5.2));
        verify(restTemplate, times(1)).exchange(any(URI.class), eq(HttpMethod.GET), any(), eq(String.class));
    }
}
