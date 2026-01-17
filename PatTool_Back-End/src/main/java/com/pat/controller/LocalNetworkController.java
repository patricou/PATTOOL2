package com.pat.controller;

import com.pat.repo.NetworkDeviceMappingRepository;
import com.pat.repo.MacVendorMappingRepository;
import com.pat.repo.NewDeviceHistoryRepository;
import com.pat.service.LocalNetworkService;
import com.pat.service.NetworkScanScheduler;
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
    private final MacVendorMappingRepository macVendorMappingRepository;
    private final NewDeviceHistoryRepository newDeviceHistoryRepository;
    private final NetworkScanScheduler networkScanScheduler;

    @Autowired
    public LocalNetworkController(LocalNetworkService localNetworkService, NetworkDeviceMappingRepository deviceMappingRepository, MacVendorMappingRepository macVendorMappingRepository, NewDeviceHistoryRepository newDeviceHistoryRepository, NetworkScanScheduler networkScanScheduler) {
        this.localNetworkService = localNetworkService;
        this.deviceMappingRepository = deviceMappingRepository;
        this.macVendorMappingRepository = macVendorMappingRepository;
        this.newDeviceHistoryRepository = newDeviceHistoryRepository;
        this.networkScanScheduler = networkScanScheduler;
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
        log.debug("========== STREAM NETWORK SCAN REQUESTED ==========");
        log.debug("useExternalVendorAPI parameter: {}", useExternalVendorAPI);
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
                final List<Map<String, Object>> allFoundDevices = new ArrayList<>(); // Collect all devices for history
                
                localNetworkService.scanLocalNetworkStreaming(useExternalVendorAPI, (device, progress, total) -> {
                    try {
                        String deviceIp = (String) device.get("ipAddress");
                        String deviceType = (String) device.get("deviceType");
                        String hostname = (String) device.get("hostname");
                        int sentCount = devicesSent.incrementAndGet();
                        
                        // Collect device for history check
                        if (device != null && !device.isEmpty()) {
                            allFoundDevices.add(new HashMap<>(device)); // Create a copy to avoid modification issues
                        }
                        
                        String vendor = (String) device.get("vendor");
                        log.debug("[SSE] Sending device #{} via SSE: {} - Type: {} - Hostname: {} - Vendor: {} (progress: {}/{})", 
                                sentCount, deviceIp, deviceType, hostname != null ? hostname : "NONE", vendor != null ? vendor : "NONE", progress, total);
                        
                        // Ensure deviceType is set
                        if (deviceType == null || deviceType.isEmpty()) {
                            device.put("deviceType", "Unknown Device");
                            log.debug("[SSE] Device {} had no deviceType, setting to 'Unknown Device'", deviceIp);
                        }
                        
                        // Log if hostname is missing for debugging
                        if (hostname == null || hostname.isEmpty()) {
                            log.debug("[SSE] Device {} has no hostname in device map", deviceIp);
                        }
                        
                        // Log if vendor is missing for debugging
                        if (vendor == null || vendor.isEmpty()) {
                            log.debug("[SSE] Device {} has no vendor in device map (MAC: {})", deviceIp, device.get("macAddress"));
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
                
                // Detect and save new devices to history
                if (!allFoundDevices.isEmpty()) {
                    log.debug("[{}] Checking for new devices and saving to history...", streamId);
                    localNetworkService.detectAndSaveNewDevicesToHistory(allFoundDevices);
                }

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
                mappingData.put("deviceType", mapping.getDeviceType());
                mappingData.put("deviceDescription", mapping.getDeviceDescription());
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
            String deviceType = (String) mappingData.get("deviceType");
            String deviceDescription = (String) mappingData.get("deviceDescription");

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
            mapping.setDeviceType(deviceType != null ? deviceType.trim() : null);
            mapping.setDeviceDescription(deviceDescription != null ? deviceDescription.trim() : null);

            com.pat.repo.domain.NetworkDeviceMapping saved = deviceMappingRepository.save(mapping);
            log.debug("Created device mapping: {} -> {}", saved.getIpAddress(), saved.getDeviceName());

            Map<String, Object> response = new HashMap<>();
            response.put("message", "Device mapping created successfully");
            response.put("id", saved.getId());
            response.put("ipAddress", saved.getIpAddress());
            response.put("deviceName", saved.getDeviceName());
            response.put("macAddress", saved.getMacAddress());
            response.put("deviceNumber", saved.getDeviceNumber());
            response.put("deviceType", saved.getDeviceType());
            response.put("deviceDescription", saved.getDeviceDescription());

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
            String deviceType = (String) mappingData.get("deviceType");
            String deviceDescription = (String) mappingData.get("deviceDescription");

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
            mapping.setDeviceType(deviceType != null ? deviceType.trim() : null);
            mapping.setDeviceDescription(deviceDescription != null ? deviceDescription.trim() : null);

            com.pat.repo.domain.NetworkDeviceMapping saved = deviceMappingRepository.save(mapping);
            log.debug("Updated device mapping: {} -> {}", saved.getIpAddress(), saved.getDeviceName());

            Map<String, Object> response = new HashMap<>();
            response.put("message", "Device mapping updated successfully");
            response.put("id", saved.getId());
            response.put("ipAddress", saved.getIpAddress());
            response.put("deviceName", saved.getDeviceName());
            response.put("macAddress", saved.getMacAddress());
            response.put("deviceNumber", saved.getDeviceNumber());
            response.put("deviceType", saved.getDeviceType());
            response.put("deviceDescription", saved.getDeviceDescription());

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

    /**
     * Get vendor information from external API for a MAC address
     */
    @GetMapping("/vendor-info/{macAddress}")
    public ResponseEntity<?> getVendorInfo(@PathVariable String macAddress) {
        log.debug("========== GET VENDOR INFO REQUESTED ==========");
        log.debug("MAC Address: {}", macAddress);
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            Map<String, Object> result = localNetworkService.getVendorInfoFromAPI(macAddress);
            log.debug("Vendor info retrieved: {}", result);
            return ResponseEntity.ok(result);
        } catch (Exception e) {
            log.debug("Error retrieving vendor info", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to retrieve vendor info");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Get all MAC vendor mappings from MongoDB
     */
    @GetMapping("/mac-vendor-mappings")
    public ResponseEntity<?> getAllMacVendorMappings() {
        log.debug("========== GET MAC VENDOR MAPPINGS REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            long count = macVendorMappingRepository.count();
            log.debug("Total MAC vendor mappings in MongoDB: {}", count);
            
            List<com.pat.repo.domain.MacVendorMapping> mappings = macVendorMappingRepository.findAll();
            log.debug("Retrieved {} MAC vendor mappings from repository", mappings.size());
            
            List<Map<String, Object>> responseList = new ArrayList<>();
            for (com.pat.repo.domain.MacVendorMapping mapping : mappings) {
                Map<String, Object> mappingData = new HashMap<>();
                mappingData.put("id", mapping.getId());
                mappingData.put("oui", mapping.getOui());
                mappingData.put("vendor", mapping.getVendor());
                mappingData.put("dateCreation", mapping.getDateCreation());
                mappingData.put("dateModification", mapping.getDateModification());
                responseList.add(mappingData);
                log.debug("Added mapping: {} -> {}", mapping.getOui(), mapping.getVendor());
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("mappings", responseList);
            response.put("count", responseList.size());
            
            log.debug("Returning {} MAC vendor mappings to client", responseList.size());
            log.debug("========== GET MAC VENDOR MAPPINGS COMPLETED ==========");
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR GETTING MAC VENDOR MAPPINGS ==========");
            log.debug("Error getting MAC vendor mappings", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get mappings");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Create a new MAC vendor mapping
     */
    @PostMapping("/mac-vendor-mappings")
    public ResponseEntity<?> createMacVendorMapping(@RequestBody Map<String, Object> mappingData) {
        log.debug("========== CREATE MAC VENDOR MAPPING REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            String oui = (String) mappingData.get("oui");
            String vendor = (String) mappingData.get("vendor");

            // Validate required fields
            if (oui == null || oui.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "OUI is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            if (vendor == null || vendor.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "Vendor is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            // Normalize OUI format (uppercase, ensure XX:XX:XX format)
            String normalizedOui = oui.trim().toUpperCase().replace("-", ":");
            if (!normalizedOui.matches("^([0-9A-F]{2}:){2}[0-9A-F]{2}$")) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "Invalid OUI format. Expected format: XX:XX:XX");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            // Check if OUI already exists
            if (macVendorMappingRepository.findByOui(normalizedOui).isPresent()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Duplicate OUI");
                errorResponse.put("message", "A vendor mapping with this OUI already exists");
                return ResponseEntity.status(HttpStatus.CONFLICT).body(errorResponse);
            }

            com.pat.repo.domain.MacVendorMapping mapping = new com.pat.repo.domain.MacVendorMapping();
            mapping.setOui(normalizedOui);
            mapping.setVendor(vendor.trim());

            com.pat.repo.domain.MacVendorMapping saved = macVendorMappingRepository.save(mapping);
            log.debug("Created MAC vendor mapping: {} -> {}", saved.getOui(), saved.getVendor());

            Map<String, Object> response = new HashMap<>();
            response.put("message", "MAC vendor mapping created successfully");
            response.put("id", saved.getId());
            response.put("oui", saved.getOui());
            response.put("vendor", saved.getVendor());
            response.put("dateCreation", saved.getDateCreation());
            response.put("dateModification", saved.getDateModification());

            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (Exception e) {
            log.debug("========== ERROR CREATING MAC VENDOR MAPPING ==========");
            log.debug("Error creating MAC vendor mapping", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to create mapping");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Update an existing MAC vendor mapping
     */
    @PutMapping("/mac-vendor-mappings/{id}")
    public ResponseEntity<?> updateMacVendorMapping(@PathVariable String id, @RequestBody Map<String, Object> mappingData) {
        log.debug("========== UPDATE MAC VENDOR MAPPING REQUESTED ==========");
        log.debug("Mapping ID: {}", id);
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            java.util.Optional<com.pat.repo.domain.MacVendorMapping> optionalMapping = macVendorMappingRepository.findById(id);
            if (!optionalMapping.isPresent()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Not found");
                errorResponse.put("message", "MAC vendor mapping not found");
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorResponse);
            }

            com.pat.repo.domain.MacVendorMapping mapping = optionalMapping.get();
            
            String oui = (String) mappingData.get("oui");
            String vendor = (String) mappingData.get("vendor");

            // Validate required fields
            if (oui == null || oui.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "OUI is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            if (vendor == null || vendor.trim().isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "Vendor is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            // Normalize OUI format
            String normalizedOui = oui.trim().toUpperCase().replace("-", ":");
            if (!normalizedOui.matches("^([0-9A-F]{2}:){2}[0-9A-F]{2}$")) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "Invalid OUI format. Expected format: XX:XX:XX");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            // Check if OUI already exists in another mapping
            java.util.Optional<com.pat.repo.domain.MacVendorMapping> existingByOui = macVendorMappingRepository.findByOui(normalizedOui);
            if (existingByOui.isPresent() && !existingByOui.get().getId().equals(id)) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Duplicate OUI");
                errorResponse.put("message", "A vendor mapping with this OUI already exists");
                return ResponseEntity.status(HttpStatus.CONFLICT).body(errorResponse);
            }

            mapping.setOui(normalizedOui);
            mapping.setVendor(vendor.trim());

            com.pat.repo.domain.MacVendorMapping saved = macVendorMappingRepository.save(mapping);
            log.debug("Updated MAC vendor mapping: {} -> {}", saved.getOui(), saved.getVendor());

            Map<String, Object> response = new HashMap<>();
            response.put("message", "MAC vendor mapping updated successfully");
            response.put("id", saved.getId());
            response.put("oui", saved.getOui());
            response.put("vendor", saved.getVendor());
            response.put("dateCreation", saved.getDateCreation());
            response.put("dateModification", saved.getDateModification());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR UPDATING MAC VENDOR MAPPING ==========");
            log.debug("Error updating MAC vendor mapping", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to update mapping");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Delete a MAC vendor mapping
     */
    @DeleteMapping("/mac-vendor-mappings/{id}")
    public ResponseEntity<?> deleteMacVendorMapping(@PathVariable String id) {
        log.debug("========== DELETE MAC VENDOR MAPPING REQUESTED ==========");
        log.debug("Mapping ID: {}", id);
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            java.util.Optional<com.pat.repo.domain.MacVendorMapping> optionalMapping = macVendorMappingRepository.findById(id);
            if (!optionalMapping.isPresent()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Not found");
                errorResponse.put("message", "MAC vendor mapping not found");
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorResponse);
            }

            macVendorMappingRepository.deleteById(id);
            log.debug("Deleted MAC vendor mapping with ID: {}", id);
            
            Map<String, Object> response = new HashMap<>();
            response.put("message", "MAC vendor mapping deleted successfully");
            response.put("id", id);

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR DELETING MAC VENDOR MAPPING ==========");
            log.debug("Error deleting MAC vendor mapping", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to delete mapping");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Get network scan scheduler enabled status
     */
    @GetMapping("/scan-scheduler/enabled")
    public ResponseEntity<?> getScanSchedulerEnabled() {
        log.debug("========== GET SCAN SCHEDULER ENABLED REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            boolean enabled = networkScanScheduler.isSchedulerEnabled();
            Map<String, Object> response = new HashMap<>();
            response.put("enabled", enabled);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("Error getting scan scheduler enabled status", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get scheduler status");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Get network scan scheduler interval (in minutes)
     */
    @GetMapping("/scan-scheduler/interval")
    public ResponseEntity<?> getScanSchedulerInterval() {
        log.debug("========== GET SCAN SCHEDULER INTERVAL REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            int intervalMinutes = networkScanScheduler.getScanIntervalMinutes();
            Map<String, Object> response = new HashMap<>();
            response.put("intervalMinutes", intervalMinutes);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("Error getting scan scheduler interval", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get scheduler interval");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Set network scan scheduler enabled status
     */
    @PutMapping("/scan-scheduler/enabled")
    public ResponseEntity<?> setScanSchedulerEnabled(@RequestBody Map<String, Object> request) {
        log.debug("========== SET SCAN SCHEDULER ENABLED REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            Object enabledObj = request.get("enabled");
            if (enabledObj == null) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "enabled field is required");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            boolean enabled;
            if (enabledObj instanceof Boolean) {
                enabled = (Boolean) enabledObj;
            } else if (enabledObj instanceof String) {
                enabled = Boolean.parseBoolean((String) enabledObj);
            } else {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("error", "Validation failed");
                errorResponse.put("message", "enabled must be a boolean value");
                return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorResponse);
            }

            networkScanScheduler.setSchedulerEnabled(enabled);
            log.info("Scan scheduler enabled status updated to: {}", enabled);

            Map<String, Object> response = new HashMap<>();
            response.put("enabled", enabled);
            response.put("message", "Scheduler enabled status updated successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("Error setting scan scheduler enabled status", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to set scheduler status");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Get all new device history entries from MongoDB
     */
    @GetMapping("/new-device-history")
    public ResponseEntity<?> getNewDeviceHistory() {
        log.debug("========== GET NEW DEVICE HISTORY REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            List<com.pat.repo.domain.NewDeviceHistory> historyEntries = newDeviceHistoryRepository.findAllByOrderByDetectionDateDesc();
            log.debug("Retrieved {} new device history entries from repository", historyEntries.size());
            
            List<Map<String, Object>> responseList = new ArrayList<>();
            for (com.pat.repo.domain.NewDeviceHistory entry : historyEntries) {
                Map<String, Object> entryData = new HashMap<>();
                entryData.put("id", entry.getId());
                entryData.put("ipAddress", entry.getIpAddress());
                entryData.put("hostname", entry.getHostname());
                entryData.put("macAddress", entry.getMacAddress());
                entryData.put("vendor", entry.getVendor());
                entryData.put("deviceType", entry.getDeviceType());
                entryData.put("os", entry.getOs());
                entryData.put("openPorts", entry.getOpenPorts());
                entryData.put("detectionDate", entry.getDetectionDate());
                responseList.add(entryData);
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("history", responseList);
            response.put("count", responseList.size());
            
            log.debug("Returning {} new device history entries to client", responseList.size());
            log.debug("========== GET NEW DEVICE HISTORY COMPLETED ==========");
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR GETTING NEW DEVICE HISTORY ==========");
            log.debug("Error getting new device history", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to get history");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Delete new device history entries by MAC address
     */
    @DeleteMapping("/new-device-history/by-mac/{macAddress}")
    public ResponseEntity<?> deleteNewDeviceHistoryByMac(@PathVariable String macAddress) {
        log.debug("========== DELETE NEW DEVICE HISTORY BY MAC REQUESTED ==========");
        log.debug("MAC Address: {}", macAddress);
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            // Normalize MAC address for comparison
            String normalizedMac = macAddress.trim().toUpperCase().replaceAll("[:-]", "").replaceAll("\\s", "");
            
            List<com.pat.repo.domain.NewDeviceHistory> entriesToDelete = newDeviceHistoryRepository.findByMacAddress(normalizedMac);
            long countBefore = entriesToDelete.size();
            
            if (countBefore > 0) {
                newDeviceHistoryRepository.deleteAll(entriesToDelete);
                log.debug("Deleted {} new device history entries with MAC: {}", countBefore, normalizedMac);
            } else {
                log.debug("No history entries found with MAC: {}", normalizedMac);
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("message", "New device history entries deleted successfully");
            response.put("deletedCount", countBefore);
            response.put("macAddress", normalizedMac);

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR DELETING NEW DEVICE HISTORY BY MAC ==========");
            log.debug("Error deleting new device history by MAC", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to delete history entries");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }

    /**
     * Delete all new device history entries
     */
    @DeleteMapping("/new-device-history")
    public ResponseEntity<?> clearNewDeviceHistory() {
        log.debug("========== CLEAR NEW DEVICE HISTORY REQUESTED ==========");
        
        if (!hasAdminRole()) {
            log.debug("Access denied: Admin role required");
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Unauthorized");
            errorResponse.put("message", "Admin role required");
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(errorResponse);
        }

        try {
            long countBefore = newDeviceHistoryRepository.count();
            newDeviceHistoryRepository.deleteAll();
            log.debug("Deleted {} new device history entries", countBefore);
            
            Map<String, Object> response = new HashMap<>();
            response.put("message", "New device history cleared successfully");
            response.put("deletedCount", countBefore);

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.debug("========== ERROR CLEARING NEW DEVICE HISTORY ==========");
            log.debug("Error clearing new device history", e);
            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("error", "Failed to clear history");
            errorResponse.put("message", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
        }
    }
}

