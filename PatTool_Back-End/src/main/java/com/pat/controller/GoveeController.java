package com.pat.controller;

import com.pat.repo.domain.Member;
import com.pat.service.GoveeService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class GoveeController {

    @Autowired
    private GoveeService goveeService;

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
}
