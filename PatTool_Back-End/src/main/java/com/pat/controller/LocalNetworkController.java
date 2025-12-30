package com.pat.controller;

import com.pat.repo.NetworkDeviceMappingRepository;
import com.pat.service.LocalNetworkService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

@RestController
@RequestMapping("/api/network")
public class LocalNetworkController {

    private static final Logger log = LoggerFactory.getLogger(LocalNetworkController.class);

    private final LocalNetworkService localNetworkService;
    private final NetworkDeviceMappingRepository deviceMappingRepository;

    @Autowired
    public LocalNetworkController(LocalNetworkService localNetworkService, NetworkDeviceMappingRepository deviceMappingRepository) {
        this.localNetworkService = localNetworkService;
        this.deviceMappingRepository = deviceMappingRepository;
    }

    /**
     * Check if the current user has Admin role (case-insensitive)
     */
    private boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Admin") || 
                                     authority.equalsIgnoreCase("ROLE_admin"));
    }

    @GetMapping(value = "/scan", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> scanNetwork() {
        log.debug("Network scan requested");

        if (!hasAdminRole()) {
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required to scan network");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            Map<String, Object> scanResult = localNetworkService.scanLocalNetwork();
            return ResponseEntity.ok(scanResult);
        } catch (Exception e) {
            log.error("Error scanning network", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Scan failed");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Stream network scan results using Server-Sent Events (SSE)
     * Sends devices as they are detected in real-time
     */
    @GetMapping(value = "/scan/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamNetworkScan() {
        log.debug("Network scan stream requested");

        if (!hasAdminRole()) {
            SseEmitter emitter = new SseEmitter(1000L);
            try {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Unauthorized");
                errorResponse.put("message", "Admin role required to scan network");
                emitter.send(SseEmitter.event()
                    .name("error")
                    .data(errorResponse));
                emitter.complete();
            } catch (IOException e) {
                emitter.completeWithError(e);
            }
            return emitter;
        }

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE); // No timeout

        String streamId = "STREAM-" + System.currentTimeMillis();
        log.info("========== SSE STREAM STARTED [{}] ==========", streamId);
        
        CompletableFuture.runAsync(() -> {
            try {
                log.info("[{}] Starting network scan in async thread", streamId);
                
                // Send scan started event
                Map<String, Object> startData = new HashMap<>();
                startData.put("status", "started");
                startData.put("message", "Network scan started");
                startData.put("scanId", streamId);
                startData.put("timestamp", System.currentTimeMillis());
                
                emitter.send(SseEmitter.event()
                    .name("scan-started")
                    .data(startData));
                
                log.info("[{}] Scan started event sent to client", streamId);

                // Scan network with callback to send devices as they are found
                final AtomicInteger devicesSent = new AtomicInteger(0);
                localNetworkService.scanLocalNetworkStreaming((device, progress, total) -> {
                    try {
                        String deviceIp = (String) device.get("ipAddress");
                        String deviceType = (String) device.get("deviceType");
                        String hostname = (String) device.get("hostname");
                        int sentCount = devicesSent.incrementAndGet();
                        
                        log.info("[SSE] Sending device #{} via SSE: {} - Type: {} - Hostname: {} (progress: {}/{})", 
                                sentCount, deviceIp, deviceType, hostname != null ? hostname : "NONE", progress, total);
                        
                        // Ensure deviceType is set
                        if (deviceType == null || deviceType.isEmpty()) {
                            device.put("deviceType", "Unknown Device");
                            log.warn("[SSE] Device {} had no deviceType, setting to 'Unknown Device'", deviceIp);
                        }
                        
                        // Log if hostname is missing for debugging
                        if (hostname == null || hostname.isEmpty()) {
                            log.debug("[SSE] Device {} has no hostname in device map", deviceIp);
                        }
                        
                        Map<String, Object> eventData = new HashMap<>();
                        eventData.put("device", device);
                        eventData.put("progress", progress);
                        eventData.put("total", total);
                        
                        emitter.send(SseEmitter.event()
                            .name("device-found")
                            .data(eventData));
                        
                        log.debug("[SSE] Device event sent successfully for IP: {} with type: {}", deviceIp, device.get("deviceType"));
                    } catch (IOException e) {
                        log.error("[SSE] Error sending device event for IP {}: {}", 
                                device.get("ipAddress"), e.getMessage(), e);
                    } catch (Exception e) {
                        log.error("[SSE] Unexpected error sending device event: {}", e.getMessage(), e);
                    }
                });
                
                log.info("[{}] Total devices sent via SSE: {}", streamId, devicesSent.get());

                log.info("[{}] Network scan service completed. Sending scan-completed event...", streamId);

                // Send scan completed event
                Map<String, Object> completeData = new HashMap<>();
                completeData.put("status", "completed");
                completeData.put("message", "Network scan completed");
                completeData.put("scanId", streamId);
                completeData.put("devicesFound", devicesSent.get());
                completeData.put("timestamp", System.currentTimeMillis());
                
                emitter.send(SseEmitter.event()
                    .name("scan-completed")
                    .data(completeData));
                
                log.info("[{}] Scan completed event sent to client", streamId);
                log.info("========== SSE STREAM COMPLETED [{}] ==========", streamId);

                emitter.complete();
            } catch (Exception e) {
                log.error("========== SSE STREAM ERROR ==========");
                log.error("Error during network scan stream", e);
                try {
                    Map<String, Object> errorResponse = new HashMap<>();
                    errorResponse.put("error", "Scan failed");
                    errorResponse.put("message", e.getMessage());
                    emitter.send(SseEmitter.event()
                        .name("error")
                        .data(errorResponse));
                    log.info("Error event sent to client");
                } catch (IOException ioException) {
                    log.error("Error sending error event", ioException);
                }
                emitter.completeWithError(e);
            }
        });

        return emitter;
    }

    /**
     * Get device mappings count from MongoDB
     */
    @GetMapping("/device-mappings/count")
    public ResponseEntity<?> getDeviceMappingsCount() {
        if (!hasAdminRole()) {
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            long count = deviceMappingRepository.count();
            Map<String, Object> response = new HashMap<>();
            response.put("count", count);
            response.put("collection", "network_device_mappings");
            response.put("database", "rando2");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error getting device mappings count", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get count");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Get all device mappings from MongoDB
     */
    @GetMapping("/device-mappings")
    public ResponseEntity<?> getAllDeviceMappings() {
        log.debug("========== GET DEVICE MAPPINGS REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.warn("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            long count = deviceMappingRepository.count();
            log.debug("Total device mappings in MongoDB: {}", count);
            
            List<com.pat.repo.domain.NetworkDeviceMapping> mappings = deviceMappingRepository.findAll();
            log.debug("Retrieved {} device mappings from repository", mappings.size());
            
            List<Map<String, Object>> responseList = new ArrayList<>();
            for (com.pat.repo.domain.NetworkDeviceMapping mapping : mappings) {
                Map<String, Object> mappingData = new HashMap<>();
                mappingData.put("id", mapping.getId());
                mappingData.put("ipAddress", mapping.getIpAddress());
                mappingData.put("deviceName", mapping.getDeviceName());
                mappingData.put("macAddress", mapping.getMacAddress());
                mappingData.put("deviceNumber", mapping.getDeviceNumber());
                responseList.add(mappingData);
                log.debug("Added mapping: {} -> {}", mapping.getIpAddress(), mapping.getDeviceName());
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("devices", responseList);
            response.put("count", responseList.size());
            
            log.debug("Returning {} device mappings to client", responseList.size());
            log.debug("========== GET DEVICE MAPPINGS COMPLETED ==========");
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("========== ERROR GETTING DEVICE MAPPINGS ==========");
            log.error("Error getting device mappings", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get mappings");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Force reload device mappings from CSV file into MongoDB
     * This will clear existing mappings and reload from file
     */
    @PostMapping("/device-mappings/reload")
    public ResponseEntity<?> reloadDeviceMappings() {
        log.debug("========== RELOAD DEVICE MAPPINGS REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.warn("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            long beforeCount = deviceMappingRepository.count();
            log.debug("Device mappings before reload: {}", beforeCount);
            
            // Force reload by clearing and reloading
            deviceMappingRepository.deleteAll();
            log.debug("Cleared all existing device mappings");
            
            localNetworkService.initializeDeviceMappingsFromFile();
            long afterCount = deviceMappingRepository.count();
            log.debug("Device mappings after reload: {}", afterCount);
            
            Map<String, Object> response = new HashMap<>();
            response.put("message", "Device mappings reloaded successfully");
            response.put("beforeCount", beforeCount);
            response.put("afterCount", afterCount);
            response.put("collection", "network_device_mappings");
            
            log.debug("========== RELOAD DEVICE MAPPINGS COMPLETED ==========");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("========== ERROR RELOADING DEVICE MAPPINGS ==========");
            log.error("Error reloading device mappings", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to reload");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }
}

