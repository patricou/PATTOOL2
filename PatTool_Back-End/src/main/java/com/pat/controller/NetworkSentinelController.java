package com.pat.controller;

import com.pat.dto.SentinelPrefsDto;
import com.pat.repo.domain.NetworkSentinelSweep;
import com.pat.service.NetworkSentinelService;
import com.pat.service.NetworkSentinelService.SweepOptions;
import com.pat.service.NetworkSentinelPrefsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Network sentinel API (admin only): live socket view, full sweeps streamed over SSE, history, settings,
 * acknowledgements. Detects intrusions that already succeeded on the PatTool host and its LAN.
 */
@RestController
@RequestMapping("/api/network/sentinel")
public class NetworkSentinelController {

    private static final Logger log = LoggerFactory.getLogger(NetworkSentinelController.class);

    private final NetworkSentinelService sentinelService;
    private final NetworkSentinelPrefsService prefsService;

    public NetworkSentinelController(NetworkSentinelService sentinelService, NetworkSentinelPrefsService prefsService) {
        this.sentinelService = sentinelService;
        this.prefsService = prefsService;
    }

    private boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(a -> a.equalsIgnoreCase("ROLE_Admin"));
    }

    private ResponseEntity<Map<String, Object>> forbidden() {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("error", "Unauthorized");
        err.put("message", "Admin role required");
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(err);
    }

    private ResponseEntity<Map<String, Object>> serverError(String title, Exception e) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("error", title);
        err.put("message", e.getMessage());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(err);
    }

    // ------------------------------------------------------------------------------------------------------------

    @GetMapping("/capabilities")
    public ResponseEntity<?> capabilities() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        try {
            return ResponseEntity.ok(sentinelService.capabilities());
        } catch (Exception e) {
            return serverError("Capabilities failed", e);
        }
    }

    @GetMapping("/status")
    public ResponseEntity<?> status() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        try {
            return ResponseEntity.ok(sentinelService.status());
        } catch (Exception e) {
            return serverError("Status failed", e);
        }
    }

    @GetMapping("/live")
    public ResponseEntity<?> live() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        try {
            return ResponseEntity.ok(sentinelService.liveSnapshot());
        } catch (Exception e) {
            log.debug("Sentinel live snapshot failed", e);
            return serverError("Live snapshot failed", e);
        }
    }

    @GetMapping("/prefs")
    public ResponseEntity<?> getPrefs() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        return ResponseEntity.ok(prefsService.getPrefs());
    }

    @PutMapping("/prefs")
    public ResponseEntity<?> setPrefs(@RequestBody SentinelPrefsDto body) {
        if (!hasAdminRole()) {
            return forbidden();
        }
        if (body == null) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", "Validation failed");
            err.put("message", "Request body is required");
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(err);
        }
        try {
            return ResponseEntity.ok(prefsService.updatePrefs(body));
        } catch (Exception e) {
            return serverError("Update failed", e);
        }
    }

    /**
     * Full sweep streamed as SSE: sweep-started, phase, status, flows, sessions, capture, device-found, finding,
     * sweep-completed, error.
     */
    @GetMapping(value = "/sweep/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter sweepStream(
            @RequestParam(value = "includeDeviceScan", required = false) Boolean includeDeviceScan,
            @RequestParam(value = "includeCapture", required = false) Boolean includeCapture,
            @RequestParam(value = "captureSeconds", required = false) Integer captureSeconds) {
        if (!hasAdminRole()) {
            SseEmitter emitter = new SseEmitter(1000L);
            try {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "Unauthorized");
                err.put("message", "Admin role required");
                emitter.send(SseEmitter.event().name("error").data(err));
                emitter.complete();
            } catch (IOException e) {
                emitter.completeWithError(e);
            }
            return emitter;
        }
        if (sentinelService.isRunning()) {
            SseEmitter emitter = new SseEmitter(1000L);
            try {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("error", "Busy");
                err.put("message", "A sentinel sweep is already running.");
                emitter.send(SseEmitter.event().name("error").data(err));
                emitter.complete();
            } catch (IOException e) {
                emitter.completeWithError(e);
            }
            return emitter;
        }

        SentinelPrefsDto prefs = prefsService.getPrefs();
        SweepOptions options = new SweepOptions(
                includeDeviceScan != null ? includeDeviceScan : Boolean.TRUE.equals(prefs.includeDeviceScan()),
                includeCapture != null ? includeCapture : Boolean.TRUE.equals(prefs.includeCapture()),
                captureSeconds != null ? captureSeconds : prefs.captureSeconds(),
                "MANUAL");

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);
        CompletableFuture.runAsync(() -> {
            try {
                sentinelService.runSweep(options, (name, data) -> {
                    try {
                        emitter.send(SseEmitter.event().name(name).data(data));
                    } catch (IOException | IllegalStateException e) {
                        log.debug("[sentinel SSE] emit {} failed: {}", name, e.getMessage());
                    }
                });
                emitter.complete();
            } catch (Exception e) {
                log.debug("Sentinel sweep stream failed", e);
                try {
                    Map<String, Object> err = new LinkedHashMap<>();
                    err.put("error", "Sweep failed");
                    err.put("message", e.getMessage());
                    emitter.send(SseEmitter.event().name("error").data(err));
                } catch (IOException | IllegalStateException ignored) {
                    // client gone
                }
                emitter.completeWithError(e);
            }
        });
        return emitter;
    }

    @GetMapping("/sweeps")
    public ResponseEntity<?> sweeps(@RequestParam(value = "limit", defaultValue = "30") int limit) {
        if (!hasAdminRole()) {
            return forbidden();
        }
        try {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("sweeps", sentinelService.history(limit).stream().map(NetworkSentinelController::summary).toList());
            return ResponseEntity.ok(out);
        } catch (Exception e) {
            return serverError("History failed", e);
        }
    }

    @GetMapping("/sweeps/latest")
    public ResponseEntity<?> latest() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        Optional<NetworkSentinelSweep> s = sentinelService.latest();
        return s.<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/sweeps/{id}")
    public ResponseEntity<?> sweep(@PathVariable String id) {
        if (!hasAdminRole()) {
            return forbidden();
        }
        Optional<NetworkSentinelSweep> s = sentinelService.get(id);
        return s.<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/sweeps")
    public ResponseEntity<?> clearSweeps() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        try {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("deletedCount", sentinelService.clearHistory());
            return ResponseEntity.ok(out);
        } catch (Exception e) {
            return serverError("Clear failed", e);
        }
    }

    @PostMapping("/findings/ack")
    public ResponseEntity<?> acknowledge(@RequestBody Map<String, Object> body) {
        if (!hasAdminRole()) {
            return forbidden();
        }
        Object key = body != null ? body.get("key") : null;
        if (key == null || String.valueOf(key).isBlank()) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", "Validation failed");
            err.put("message", "key is required");
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(err);
        }
        boolean ack = body.get("acknowledged") == null || Boolean.parseBoolean(String.valueOf(body.get("acknowledged")));
        try {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("key", key);
            out.put("acknowledged", ack);
            out.put("acknowledgedKeys", sentinelService.acknowledge(String.valueOf(key), ack).getAcknowledgedKeys());
            return ResponseEntity.ok(out);
        } catch (Exception e) {
            return serverError("Acknowledge failed", e);
        }
    }

    @DeleteMapping("/baseline")
    public ResponseEntity<?> resetBaseline() {
        if (!hasAdminRole()) {
            return forbidden();
        }
        try {
            sentinelService.resetBaseline();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("message", "Baseline reset; next sweep will learn again.");
            return ResponseEntity.ok(out);
        } catch (Exception e) {
            return serverError("Reset failed", e);
        }
    }

    private static Map<String, Object> summary(NetworkSentinelSweep s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", s.getId());
        m.put("startedAt", s.getStartedAt());
        m.put("finishedAt", s.getFinishedAt());
        m.put("durationMs", s.getDurationMs());
        m.put("trigger", s.getTrigger());
        m.put("hostName", s.getHostName());
        m.put("deviceScanIncluded", s.isDeviceScanIncluded());
        m.put("deviceCount", s.getDeviceCount());
        m.put("unknownDeviceCount", s.getUnknownDeviceCount());
        m.put("flowCount", s.getFlowCount());
        m.put("inboundPublicCount", s.getInboundPublicCount());
        m.put("outboundPublicCount", s.getOutboundPublicCount());
        m.put("captureIncluded", s.isCaptureIncluded());
        m.put("capturePackets", s.getCapture() != null ? s.getCapture().packets() : 0);
        m.put("findingCount", s.getFindings().size());
        m.put("severityCounts", s.getSeverityCounts());
        m.put("intrusionSucceededCount", s.getIntrusionSucceededCount());
        m.put("maxSeverity", s.getMaxSeverity());
        m.put("emailSent", s.isEmailSent());
        m.put("baselineLearning", s.isBaselineLearning());
        m.put("warningCount", s.getWarnings().size());
        return m;
    }
}
