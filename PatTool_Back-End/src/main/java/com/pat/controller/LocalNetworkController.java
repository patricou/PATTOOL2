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
            log.debug("Error scanning network", e);
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
    public SseEmitter streamNetworkScan(@RequestParam(value = "useExternalVendorAPI", defaultValue = "false") boolean useExternalVendorAPI) {
        log.debug("Network scan stream requested (useExternalVendorAPI: {})", useExternalVendorAPI);

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
        log.debug("========== SSE STREAM STARTED [{}] ==========", streamId);
        
        CompletableFuture.runAsync(() -> {
            try {
                log.debug("[{}] Starting network scan in async thread", streamId);
                
                // Send scan started event
                Map<String, Object> startData = new HashMap<>();
                startData.put("status", "started");
                startData.put("message", "Network scan started");
                startData.put("scanId", streamId);
                startData.put("timestamp", System.currentTimeMillis());
                
                emitter.send(SseEmitter.event()
                    .name("scan-started")
                    .data(startData));
                
                log.debug("[{}] Scan started event sent to client", streamId);

                // Scan network with callback to send devices as they are found
                final AtomicInteger devicesSent = new AtomicInteger(0);
                localNetworkService.scanLocalNetworkStreaming(useExternalVendorAPI, (device, progress, total) -> {
                    try {
                        String deviceIp = (String) device.get("ipAddress");
                        String deviceType = (String) device.get("deviceType");
                        String hostname = (String) device.get("hostname");
                        int sentCount = devicesSent.incrementAndGet();
                        
                        log.debug("[SSE] Sending device #{} via SSE: {} - Type: {} - Hostname: {} (progress: {}/{})", 
                                sentCount, deviceIp, deviceType, hostname != null ? hostname : "NONE", progress, total);
                        
                        // Ensure deviceType is set
                        if (deviceType == null || deviceType.isEmpty()) {
                            device.put("deviceType", "Unknown Device");
                            log.debug("[SSE] Device {} had no deviceType, setting to 'Unknown Device'", deviceIp);
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
                        log.debug("[SSE] Error sending device event for IP {}: {}", 
                                device.get("ipAddress"), e.getMessage(), e);
                    } catch (Exception e) {
                        log.debug("[SSE] Unexpected error sending device event: {}", e.getMessage(), e);
                    }
                });
                
                log.debug("[{}] Total devices sent via SSE: {}", streamId, devicesSent.get());

                log.debug("[{}] Network scan service completed. Sending scan-completed event...", streamId);

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
                
                log.debug("[{}] Scan completed event sent to client", streamId);
                log.debug("========== SSE STREAM COMPLETED [{}] ==========", streamId);

                emitter.complete();
            } catch (Exception e) {
                log.debug("========== SSE STREAM ERROR ==========");
                log.debug("Error during network scan stream", e);
                try {
                    Map<String, Object> errorResponse = new HashMap<>();
                    errorResponse.put("error", "Scan failed");
                    errorResponse.put("message", e.getMessage());
                    emitter.send(SseEmitter.event()
                        .name("error")
                        .data(errorResponse));
                    log.debug("Error event sent to client");
                } catch (IOException ioException) {
                    log.debug("Error sending error event", ioException);
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
            log.debug("Error getting device mappings count", e);
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
            log.debug("Access denied: Admin role required");
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
            log.debug("========== ERROR GETTING DEVICE MAPPINGS ==========");
            log.debug("Error getting device mappings", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get mappings");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }


    /**
     * Create a new device mapping
     */
    @PostMapping("/device-mappings")
    public ResponseEntity<?> createDeviceMapping(@RequestBody Map<String, Object> mappingData) {
        log.debug("========== CREATE DEVICE MAPPING REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            String ipAddress = (String) mappingData.get("ipAddress");
            String deviceName = (String) mappingData.get("deviceName");
            String macAddress = (String) mappingData.get("macAddress");
            Integer deviceNumber = mappingData.get("deviceNumber") != null 
                ? Integer.valueOf(mappingData.get("deviceNumber").toString()) 
                : null;

            // Validate required fields
            if (ipAddress == null || ipAddress.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "IP address is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            if (deviceName == null || deviceName.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "Device name is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            // Check if IP already exists
            if (deviceMappingRepository.findByIpAddress(ipAddress).isPresent()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Duplicate IP address");
                errorResponse.put("message", "A device mapping with this IP address already exists");
                return ResponseEntity.status(HttpStatus.CONFLICT).body(errorResponse);
            }

            com.pat.repo.domain.NetworkDeviceMapping mapping = new com.pat.repo.domain.NetworkDeviceMapping();
            mapping.setIpAddress(ipAddress.trim());
            mapping.setDeviceName(deviceName.trim());
            mapping.setMacAddress(macAddress != null ? macAddress.trim() : null);
            mapping.setDeviceNumber(deviceNumber);

            com.pat.repo.domain.NetworkDeviceMapping saved = deviceMappingRepository.save(mapping);
            log.debug("Created device mapping: {} -> {}", saved.getIpAddress(), saved.getDeviceName());

            Map<String, Object> response = new HashMap<>();
            response.put("message", "Device mapping created successfully");
            response.put("id", saved.getId());
            response.put("ipAddress", saved.getIpAddress());
            response.put("deviceName", saved.getDeviceName());
            response.put("macAddress", saved.getMacAddress());
            response.put("deviceNumber", saved.getDeviceNumber());

            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (Exception e) {
            log.debug("========== ERROR CREATING DEVICE MAPPING ==========");
            log.debug("Error creating device mapping", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to create mapping");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Update an existing device mapping
     */
    @PutMapping("/device-mappings/{id}")
    public ResponseEntity<?> updateDeviceMapping(@PathVariable String id, @RequestBody Map<String, Object> mappingData) {
        log.debug("========== UPDATE DEVICE MAPPING REQUESTED ==========");
        log.debug("Mapping ID: {}", id);
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            java.util.Optional<com.pat.repo.domain.NetworkDeviceMapping> optionalMapping = deviceMappingRepository.findById(id);
            if (!optionalMapping.isPresent()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Not found");
                errorResponse.put("message", "Device mapping not found");
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorResponse);
            }

            com.pat.repo.domain.NetworkDeviceMapping mapping = optionalMapping.get();
            
            String ipAddress = (String) mappingData.get("ipAddress");
            String deviceName = (String) mappingData.get("deviceName");
            String macAddress = (String) mappingData.get("macAddress");
            Integer deviceNumber = mappingData.get("deviceNumber") != null 
                ? Integer.valueOf(mappingData.get("deviceNumber").toString()) 
                : null;

            // Validate required fields
            if (ipAddress == null || ipAddress.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "IP address is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            if (deviceName == null || deviceName.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "Device name is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            // Check if IP already exists in another mapping
            java.util.Optional<com.pat.repo.domain.NetworkDeviceMapping> existingByIp = deviceMappingRepository.findByIpAddress(ipAddress);
            if (existingByIp.isPresent() && !existingByIp.get().getId().equals(id)) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Duplicate IP address");
                errorResponse.put("message", "A device mapping with this IP address already exists");
                return ResponseEntity.status(HttpStatus.CONFLICT).body(errorResponse);
            }

            mapping.setIpAddress(ipAddress.trim());
            mapping.setDeviceName(deviceName.trim());
            mapping.setMacAddress(macAddress != null ? macAddress.trim() : null);
            mapping.setDeviceNumber(deviceNumber);

            com.pat.repo.domain.NetworkDeviceMapping saved = deviceMappingRepository.save(mapping);
            log.debug("Updated device mapping: {} -> {}", saved.getIpAddress(), saved.getDeviceName());

            Map<String, Object> response = new HashMap<>();
            response.put("message", "Device mapping updated successfully");
            response.put("id", saved.getId());
            response.put("ipAddress", saved.getIpAddress());
            response.put("deviceName", saved.getDeviceName());
            response.put("macAddress", saved.getMacAddress());
            response.put("deviceNumber", saved.getDeviceNumber());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR UPDATING DEVICE MAPPING ==========");
            log.debug("Error updating device mapping", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to update mapping");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Delete a device mapping
     */
    @DeleteMapping("/device-mappings/{id}")
    public ResponseEntity<?> deleteDeviceMapping(@PathVariable String id) {
        log.debug("========== DELETE DEVICE MAPPING REQUESTED ==========");
        log.debug("Mapping ID: {}", id);
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            java.util.Optional<com.pat.repo.domain.NetworkDeviceMapping> optionalMapping = deviceMappingRepository.findById(id);
            if (!optionalMapping.isPresent()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Not found");
                errorResponse.put("message", "Device mapping not found");
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorResponse);
            }

            deviceMappingRepository.deleteById(id);
            log.debug("Deleted device mapping with ID: {}", id);
            
            Map<String, Object> response = new HashMap<>();
            response.put("message", "Device mapping deleted successfully");
            response.put("id", id);

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR DELETING DEVICE MAPPING ==========");
            log.debug("Error deleting device mapping", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to delete mapping");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }
}

