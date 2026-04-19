package com.pat.controller;

import com.pat.repo.CameraRepository;
import com.pat.repo.domain.Camera;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Date;
import java.util.Optional;
import java.util.UUID;

/**
 * REST endpoints for Camera CRUD operations.
 * Base path: /api/cameras
 *
 * Security: all endpoints are restricted to users holding the "Iot" realm/client
 * role in Keycloak. Authorization is enforced at two layers:
 *   - URL-level rule in {@code SecurityConfig} ({@code hasAnyRole("Iot","iot")});
 *   - defense-in-depth check in {@link #ensureIotRole()} invoked by every handler.
 */
@RestController
@RequestMapping("/api")
public class CameraRestController {

    private static final Logger log = LoggerFactory.getLogger(CameraRestController.class);

    @Autowired
    private CameraRepository cameraRepository;

    /**
     * Verifies that the current authenticated user holds the Iot role
     * (case-insensitive, matching the frontend {@code hasIotRole()} check).
     *
     * @return empty {@link Optional} when authorized, otherwise a 401/403
     *         {@link ResponseEntity} to return to the client.
     */
    private Optional<ResponseEntity<?>> ensureIotRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return Optional.of(ResponseEntity.status(HttpStatus.UNAUTHORIZED).build());
        }
        boolean hasIot = authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(a -> a.equalsIgnoreCase("ROLE_Iot") || a.equalsIgnoreCase("ROLE_iot"));
        if (!hasIot) {
            log.warn("Access denied to /api/cameras - user '{}' lacks Iot role",
                    authentication.getName());
            return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
        }
        return Optional.empty();
    }

    @GetMapping(value = "/cameras", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getAllCameras(@RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.debug("Get all cameras / User Id: {}", userId);
        Sort sort = Sort.by(Sort.Direction.ASC, "name");
        return ResponseEntity.ok(cameraRepository.findAll(sort));
    }

    @GetMapping(value = "/cameras/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getCameraById(@PathVariable("id") String id) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.debug("Get camera by id: {}", id);
        Optional<Camera> camera = cameraRepository.findById(id);
        return camera.<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping(value = "/cameras/owner/{owner}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getCamerasByOwner(@PathVariable("owner") String owner) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.debug("Get cameras by owner: {}", owner);
        return ResponseEntity.ok(cameraRepository.findByOwner(owner));
    }

    @PostMapping(value = "/cameras", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> createCamera(@RequestBody Camera camera,
                                          @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.info("Create camera: {}", camera.getName());
        try {
            camera.setId(null);
            Date now = new Date();
            camera.setCreationDate(now);
            camera.setUpdateDate(now);
            if ((camera.getOwner() == null || camera.getOwner().isEmpty()) && userId != null && !userId.isEmpty()) {
                camera.setOwner(userId);
            }
            if (camera.getUid() == null || camera.getUid().trim().isEmpty()) {
                camera.setUid(UUID.randomUUID().toString());
            } else {
                cameraRepository.findByUid(camera.getUid()).ifPresent(existing -> {
                    log.warn("UID collision detected ('{}'), generating a new one", camera.getUid());
                    camera.setUid(UUID.randomUUID().toString());
                });
            }
            Camera saved = cameraRepository.save(camera);
            return new ResponseEntity<>(saved, HttpStatus.CREATED);
        } catch (Exception e) {
            log.error("Error creating camera", e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @GetMapping(value = "/cameras/uid/{uid}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getCameraByUid(@PathVariable("uid") String uid) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.debug("Get camera by uid: {}", uid);
        return cameraRepository.findByUid(uid)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PutMapping(value = "/cameras/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> updateCamera(@PathVariable("id") String id,
                                          @RequestBody Camera details) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.info("Update camera with id: {}", id);
        Optional<Camera> opt = cameraRepository.findById(id);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        Camera camera = opt.get();
        camera.setName(details.getName());
        camera.setOwner(details.getOwner());
        if (details.getUid() != null && !details.getUid().trim().isEmpty()) {
            camera.setUid(details.getUid());
        } else if (camera.getUid() == null || camera.getUid().trim().isEmpty()) {
            camera.setUid(UUID.randomUUID().toString());
        }
        camera.setBrand(details.getBrand());
        camera.setType(details.getType());
        camera.setWebUrl(details.getWebUrl());
        camera.setSnapshotUrl(details.getSnapshotUrl());
        camera.setUsername(details.getUsername());
        // Preserve existing password if the caller did not supply a new one
        // (the frontend sends empty/null to mean "keep current value" because
        // passwords are never serialized back in responses).
        if (details.getPassword() != null && !details.getPassword().isEmpty()) {
            camera.setPassword(details.getPassword());
        }
        camera.setService(details.getService());
        camera.setMacaddress(details.getMacaddress());
        camera.setIp(details.getIp());
        camera.setPlace(details.getPlace());
        camera.setRoom(details.getRoom());
        camera.setParam1(details.getParam1());
        camera.setParam2(details.getParam2());
        camera.setParam3(details.getParam3());
        camera.setUpdateDate(new Date());
        Camera updated = cameraRepository.save(camera);
        return ResponseEntity.ok(updated);
    }

    /**
     * Duplicates an existing camera. Produces a new document with:
     *   - a brand new MongoDB id and UUID,
     *   - the same fields as the source (including the stored password),
     *   - the name suffixed with the value of the optional {@code suffix}
     *     request parameter (defaults to " (copy)"),
     *   - fresh creation/update timestamps.
     * The password is copied server-side because it is never serialized back
     * to the browser ({@link Camera#getPassword()} is marked write-only), so
     * the frontend would otherwise be unable to carry it over.
     */
    @PostMapping(value = "/cameras/{id}/duplicate", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> duplicateCamera(@PathVariable("id") String id,
                                             @RequestParam(value = "suffix", required = false) String suffix,
                                             @RequestHeader(value = "user-id", required = false) String userId) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.info("Duplicate camera with id: {}", id);
        Optional<Camera> opt = cameraRepository.findById(id);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        try {
            Camera source = opt.get();
            Camera copy = new Camera();
            copy.setName((source.getName() == null ? "" : source.getName())
                    + (suffix == null || suffix.isEmpty() ? " (copy)" : suffix));
            copy.setOwner(userId != null && !userId.isEmpty() ? userId : source.getOwner());
            copy.setUid(UUID.randomUUID().toString());
            copy.setBrand(source.getBrand());
            copy.setType(source.getType());
            copy.setWebUrl(source.getWebUrl());
            copy.setSnapshotUrl(source.getSnapshotUrl());
            copy.setUsername(source.getUsername());
            copy.setPassword(source.getPassword());
            copy.setService(source.getService());
            copy.setMacaddress(source.getMacaddress());
            copy.setIp(source.getIp());
            copy.setPlace(source.getPlace());
            copy.setRoom(source.getRoom());
            copy.setParam1(source.getParam1());
            copy.setParam2(source.getParam2());
            copy.setParam3(source.getParam3());
            Date now = new Date();
            copy.setCreationDate(now);
            copy.setUpdateDate(now);
            Camera saved = cameraRepository.save(copy);
            return new ResponseEntity<>(saved, HttpStatus.CREATED);
        } catch (Exception e) {
            log.error("Error duplicating camera", e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @DeleteMapping(value = "/cameras/{id}")
    public ResponseEntity<?> deleteCamera(@PathVariable("id") String id) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }
        log.info("Delete camera with id: {}", id);
        try {
            cameraRepository.deleteById(id);
            return new ResponseEntity<>(HttpStatus.NO_CONTENT);
        } catch (Exception e) {
            log.error("Error deleting camera", e);
            return new ResponseEntity<>(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    // ==========================================================================
    // Snapshot proxy: fetches the camera snapshot URL server-side and streams
    // the image back. Keeps credentials out of the browser and bypasses CORS /
    // mixed-content restrictions that would otherwise block a direct request.
    //
    // The camera.snapshotUrl may contain the tokens {USER} and {PASSWORD} which
    // are substituted at request time (some cameras - e.g. Reolink - require
    // credentials as query parameters rather than Basic Auth).
    // If camera.username is set, HTTP Basic Auth is also added to the request.
    // ==========================================================================

    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    @GetMapping(value = "/cameras/{id}/snapshot")
    public ResponseEntity<?> getCameraSnapshot(@PathVariable("id") String id) {
        Optional<ResponseEntity<?>> denied = ensureIotRole();
        if (denied.isPresent()) {
            return denied.get();
        }

        Optional<Camera> opt = cameraRepository.findById(id);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        Camera camera = opt.get();

        String rawUrl = camera.getSnapshotUrl();
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body("Camera has no snapshotUrl configured");
        }

        String username = camera.getUsername();
        String password = camera.getPassword();

        // Substitute {USER} / {PASSWORD} placeholders in the URL (e.g. Reolink).
        String resolvedUrl = rawUrl;
        if (username != null) {
            resolvedUrl = resolvedUrl.replace("{USER}", urlEncode(username));
        }
        if (password != null) {
            resolvedUrl = resolvedUrl.replace("{PASSWORD}", urlEncode(password));
        }

        try {
            HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(resolvedUrl))
                    .timeout(Duration.ofSeconds(8))
                    .GET();

            // Also add HTTP Basic Auth when a username is configured. Harmless
            // on cameras that ignore it, and required for many brands (Axis,
            // Hikvision, Dahua without query-auth, etc.).
            if (username != null && !username.isEmpty()) {
                String creds = username + ":" + (password == null ? "" : password);
                String basic = Base64.getEncoder().encodeToString(creds.getBytes(StandardCharsets.UTF_8));
                requestBuilder.header("Authorization", "Basic " + basic);
            }

            HttpResponse<byte[]> response = HTTP_CLIENT.send(
                    requestBuilder.build(),
                    HttpResponse.BodyHandlers.ofByteArray());

            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                String contentType = response.headers().firstValue("Content-Type")
                        .orElse(MediaType.IMAGE_JPEG_VALUE);
                HttpHeaders headers = new HttpHeaders();
                headers.add(HttpHeaders.CONTENT_TYPE, contentType);
                headers.add(HttpHeaders.CACHE_CONTROL, "no-store, max-age=0");
                return new ResponseEntity<>(response.body(), headers, HttpStatus.OK);
            }

            log.warn("Camera snapshot upstream returned HTTP {} for camera '{}'",
                    response.statusCode(), camera.getName());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body("Camera returned HTTP " + response.statusCode());
        } catch (java.net.http.HttpTimeoutException e) {
            log.warn("Timeout fetching snapshot for camera '{}': {}", camera.getName(), e.getMessage());
            return ResponseEntity.status(HttpStatus.GATEWAY_TIMEOUT)
                    .body("Timeout fetching snapshot");
        } catch (Exception e) {
            log.error("Error fetching snapshot for camera '{}'", camera.getName(), e);
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body("Error fetching snapshot: " + e.getClass().getSimpleName());
        }
    }

    private static String urlEncode(String v) {
        return java.net.URLEncoder.encode(v, StandardCharsets.UTF_8);
    }
}
