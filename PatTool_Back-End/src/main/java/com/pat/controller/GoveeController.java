package com.pat.controller;

import com.pat.repo.GoveeThermometerHistoryRepository;
import com.pat.repo.domain.GoveeThermometerHistory;
import com.pat.repo.domain.Member;
import com.pat.service.GoveeService;
import com.pat.service.GoveeThermometerScheduler;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class GoveeController {

    @Autowired
    private GoveeService goveeService;

    @Autowired
    private GoveeThermometerScheduler thermometerScheduler;

    @Autowired
    private GoveeThermometerHistoryRepository historyRepository;

    /**
     * Check if the current user has Iot role (case-insensitive)
     */
    private boolean hasIotRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Iot") || 
                                     authority.equalsIgnoreCase("ROLE_iot"));
    }

    /**
     * Get all Govee devices
     */
    @PostMapping(value = "/govee/devices", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getGoveeDevices(@RequestBody Member member) {
        if (hasIotRole()) {
            return goveeService.getDevices();
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", member.getUserName() + " : You are not Authorized to access Govee devices. Iot role required.");
            return map;
        }
    }

    /**
     * Get state for a specific Govee device
     */
    @PostMapping(value = "/govee/device/state", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getGoveeDeviceState(@RequestBody Map<String, String> request) {
        String device = request.get("device");
        String model = request.get("model");
        
        if (hasIotRole()) {
            if (device == null || model == null) {
                Map<String, Object> error = new HashMap<>();
                error.put("error", "Device and model parameters are required");
                return error;
            }
            return goveeService.getDeviceState(device, model);
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", "You are not Authorized to access Govee device state. Iot role required.");
            return map;
        }
    }

    /**
     * Get all Govee devices with their states
     */
    @PostMapping(value = "/govee/devices/all", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getAllGoveeDevicesWithStates(@RequestBody Member member) {
        if (hasIotRole()) {
            return goveeService.getAllDeviceStates();
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", member.getUserName() + " : You are not Authorized to access Govee devices. Iot role required.");
            return map;
        }
    }

    /**
     * Get history for a specific thermometer device or all thermometers
     */
    @PostMapping(value = "/govee/thermometer/history", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getThermometerHistory(@RequestBody Map<String, String> request) {
        String deviceId = request.get("deviceId");
        
        if (hasIotRole()) {
            try {
                Map<String, Object> result = new HashMap<>();
                result.put("success", true);
                
                if (deviceId == null || deviceId.trim().isEmpty()) {
                    // Get all history, grouped by deviceId
                    List<GoveeThermometerHistory> allHistory = historyRepository.findAll();
                    Map<String, List<GoveeThermometerHistory>> historyByDevice = new HashMap<>();
                    
                    for (GoveeThermometerHistory entry : allHistory) {
                        String entryDeviceId = entry.getDeviceId();
                        if (entryDeviceId != null) {
                            historyByDevice.computeIfAbsent(entryDeviceId, k -> new java.util.ArrayList<>()).add(entry);
                        }
                    }
                    
                    // Sort each device's history by timestamp
                    for (List<GoveeThermometerHistory> deviceHistory : historyByDevice.values()) {
                        deviceHistory.sort((a, b) -> {
                            if (a.getTimestamp() == null && b.getTimestamp() == null) return 0;
                            if (a.getTimestamp() == null) return -1;
                            if (b.getTimestamp() == null) return 1;
                            return a.getTimestamp().compareTo(b.getTimestamp());
                        });
                    }
                    
                    result.put("historyByDevice", historyByDevice);
                    result.put("totalCount", allHistory.size());
                    result.put("deviceCount", historyByDevice.size());
                } else {
                    // Get history for specific device
                    List<GoveeThermometerHistory> history = historyRepository.findByDeviceIdOrderByTimestampAsc(deviceId);
                    result.put("deviceId", deviceId);
                    result.put("history", history);
                    result.put("count", history.size());
                }
                
                return result;
            } catch (Exception e) {
                Map<String, Object> error = new HashMap<>();
                error.put("error", "Failed to fetch thermometer history: " + e.getMessage());
                return error;
            }
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", "You are not Authorized to access thermometer history. Iot role required.");
            return map;
        }
    }

    /**
     * Clear history for a specific thermometer device
     */
    @DeleteMapping(value = "/govee/thermometer/history", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> clearThermometerHistory(@RequestBody Map<String, String> request) {
        String deviceId = request.get("deviceId");
        
        if (hasIotRole()) {
            try {
                if (deviceId == null || deviceId.trim().isEmpty()) {
                    // Clear all history if no deviceId specified
                    historyRepository.deleteAll();
                    Map<String, Object> result = new HashMap<>();
                    result.put("success", true);
                    result.put("message", "All thermometer history cleared");
                    return result;
                } else {
                    // Clear history for specific device
                    long countBefore = historyRepository.countByDeviceId(deviceId);
                    historyRepository.deleteByDeviceId(deviceId);
                    Map<String, Object> result = new HashMap<>();
                    result.put("success", true);
                    result.put("deviceId", deviceId);
                    result.put("deletedCount", countBefore);
                    result.put("message", "Thermometer history cleared for device: " + deviceId);
                    return result;
                }
            } catch (Exception e) {
                Map<String, Object> error = new HashMap<>();
                error.put("error", "Failed to clear thermometer history: " + e.getMessage());
                return error;
            }
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", "You are not Authorized to clear thermometer history. Iot role required.");
            return map;
        }
    }

    /**
     * Manually refresh thermometers and save history
     */
    @PostMapping(value = "/govee/thermometer/refresh", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> refreshThermometers(@RequestBody Member member) {
        if (hasIotRole()) {
            return thermometerScheduler.refreshThermometersAndSaveHistory();
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", member.getUserName() + " : You are not Authorized to refresh thermometers. Iot role required.");
            return map;
        }
    }

    /**
     * Get the current state of the automatic refresh scheduler
     */
    @GetMapping(value = "/govee/thermometer/scheduler/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> getSchedulerStatus() {
        if (hasIotRole()) {
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("enabled", thermometerScheduler.isSchedulerEnabled());
            return result;
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", "You are not Authorized to access scheduler status. Iot role required.");
            return map;
        }
    }

    /**
     * Enable or disable the automatic refresh scheduler
     */
    @PostMapping(value = "/govee/thermometer/scheduler/toggle", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> toggleScheduler(@RequestBody Map<String, Object> request) {
        if (hasIotRole()) {
            try {
                Object enabledObj = request.get("enabled");
                boolean enabled = enabledObj instanceof Boolean ? (Boolean) enabledObj : 
                                 enabledObj instanceof String ? Boolean.parseBoolean((String) enabledObj) : false;
                
                thermometerScheduler.setSchedulerEnabled(enabled);
                
                Map<String, Object> result = new HashMap<>();
                result.put("success", true);
                result.put("enabled", enabled);
                result.put("message", "Scheduler " + (enabled ? "enabled" : "disabled"));
                return result;
            } catch (Exception e) {
                Map<String, Object> error = new HashMap<>();
                error.put("error", "Failed to toggle scheduler: " + e.getMessage());
                return error;
            }
        } else {
            Map<String, Object> map = new HashMap<>();
            map.put("Unauthorized", "You are not Authorized to toggle scheduler. Iot role required.");
            return map;
        }
    }
}
