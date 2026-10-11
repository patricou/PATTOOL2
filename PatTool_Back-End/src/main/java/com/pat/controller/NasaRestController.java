package com.pat.controller;

import com.pat.controller.dto.NasaDtos.Apod;
import com.pat.controller.dto.NasaDtos.Epic;
import com.pat.controller.dto.NasaDtos.ApiError;
import com.pat.controller.dto.NasaDtos.Mars;
import com.pat.controller.dto.NasaDtos.NeoFeed;
import com.pat.service.NasaProxyException;
import com.pat.service.NasaProxyService;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Proxy lecture seule de l'API NASA ({@code api.nasa.gov}).
 * <ul>
 *   <li>{@code GET /api/external/nasa/apod}</li>
 *   <li>{@code GET /api/external/nasa/epic}</li>
 *   <li>{@code GET /api/external/nasa/epic/image}</li>
 *   <li>{@code GET /api/external/nasa/mars}</li>
 *   <li>{@code GET /api/external/nasa/neo}</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/external/nasa")
public class NasaRestController {

    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern EPIC_NAME = Pattern.compile("epic_[a-z0-9_]{4,64}");
    private static final Pattern CAMERA = Pattern.compile("[A-Z0-9_]{2,32}");
    private static final LocalDate APOD_MIN = LocalDate.of(1995, 6, 16);
    private static final LocalDate EPIC_MIN = LocalDate.of(2015, 6, 13);

    private final NasaProxyService nasaProxyService;

    public NasaRestController(NasaProxyService nasaProxyService) {
        this.nasaProxyService = nasaProxyService;
    }

    @GetMapping("/apod")
    public Apod apod(@RequestParam(required = false) String date) {
        return nasaProxyService.apod(parseDate(date, APOD_MIN, LocalDate.now().plusDays(1)));
    }

    @GetMapping("/epic")
    public Epic epic(@RequestParam(required = false) String date) {
        return nasaProxyService.epic(parseDate(date, EPIC_MIN, LocalDate.now().plusDays(1)));
    }

    @GetMapping(value = "/epic/image", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> epicImage(@RequestParam String date, @RequestParam String name) {
        LocalDate day = parseDate(date, EPIC_MIN, LocalDate.now().plusDays(1));
        if (day == null || name == null || !EPIC_NAME.matcher(name).matches()) {
            throw new NasaProxyException("not_found");
        }
        byte[] bytes = nasaProxyService.epicImage(day, name);
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.maxAge(Duration.ofHours(12)).cachePublic())
                .body(bytes);
    }

    @GetMapping("/mars")
    public Mars mars(
            @RequestParam(defaultValue = "curiosity") String rover,
            @RequestParam(required = false) Integer sol,
            @RequestParam(required = false) String date,
            @RequestParam(required = false) String camera,
            @RequestParam(defaultValue = "1") int page) {
        String roverId = rover == null ? "" : rover.trim().toLowerCase(Locale.ROOT);
        if (!NasaProxyService.ROVERS.contains(roverId)) {
            throw new IllegalArgumentException("rover");
        }
        if (sol != null && (sol < 0 || sol > 100_000)) {
            throw new IllegalArgumentException("sol");
        }
        LocalDate earthDate = parseDate(date, LocalDate.of(2004, 1, 4), LocalDate.now().plusDays(1));
        if (camera != null && !camera.isBlank() && !CAMERA.matcher(camera.trim()).matches()) {
            throw new IllegalArgumentException("camera");
        }
        int boundedPage = Math.min(Math.max(page, 1), 100);
        String cameraId = camera == null || camera.isBlank() ? null : camera.trim();
        return nasaProxyService.mars(roverId, sol, earthDate, cameraId, boundedPage);
    }

    @GetMapping("/neo")
    public NeoFeed neo(@RequestParam String start, @RequestParam String end) {
        LocalDate startDate = requiredDate(start);
        LocalDate endDate = requiredDate(end);
        if (endDate.isBefore(startDate) || startDate.plusDays(7).isBefore(endDate)) {
            throw new IllegalArgumentException("range");
        }
        return nasaProxyService.neo(startDate, endDate);
    }

    @ExceptionHandler(NasaProxyException.class)
    public ResponseEntity<ApiError> nasaError(NasaProxyException ex) {
        HttpStatus status = switch (ex.code()) {
            case "quota" -> HttpStatus.TOO_MANY_REQUESTS;
            case "not_found" -> HttpStatus.NOT_FOUND;
            default -> HttpStatus.BAD_GATEWAY;
        };
        return ResponseEntity.status(status).body(new ApiError(ex.code()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> badRequest(IllegalArgumentException ex) {
        return ResponseEntity.badRequest().body(new ApiError("bad_request"));
    }

    private static LocalDate parseDate(String raw, LocalDate min, LocalDate max) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        LocalDate date = requiredDate(raw);
        if (date.isBefore(min) || date.isAfter(max)) {
            throw new IllegalArgumentException("date");
        }
        return date;
    }

    private static LocalDate requiredDate(String raw) {
        if (raw == null || !DATE.matcher(raw).matches()) {
            throw new IllegalArgumentException("date");
        }
        try {
            return LocalDate.parse(raw);
        } catch (DateTimeParseException ex) {
            throw new IllegalArgumentException("date");
        }
    }
}
