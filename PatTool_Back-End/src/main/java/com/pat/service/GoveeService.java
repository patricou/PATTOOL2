package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@Service
public class GoveeService {

    private static final Logger log = LoggerFactory.getLogger(GoveeService.class);

    private final RestTemplate restTemplate;

    @Value("${govee.api.key:}")
    private String goveeApiKey;

    @Value("${govee.api.base.url:https://openapi.api.govee.com}")
    private String goveeApiBaseUrl;

    public GoveeService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    /**
     * Get all devices from Govee API
     */
    public Map<String, Object> getDevices() {
        String url = goveeApiBaseUrl + "/router/api/v1/user/devices";
        
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("Govee-API-Key", goveeApiKey);
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            log.info("Govee devices response: {}", response.getBody());
            return response.getBody() != null ? response.getBody() : new HashMap<>();
            
        } catch (Exception e) {
            log.error("Error fetching Govee devices: ", e);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Failed to fetch Govee devices: " + e.getMessage());
            return errorMap;
        }
    }

    /**
     * Get device state for a specific device
     * According to Govee API docs, the request format should be:
     * {
     *   "requestId": "unique-request-id",
     *   "payload": {
     *     "sku": "H5051",
     *     "device": "1C:F9:E3:60:59:21:94:7E"
     *   }
     * }
     */
    public Map<String, Object> getDeviceState(String device, String sku) {
        String url = goveeApiBaseUrl + "/router/api/v1/device/state";
        
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("Govee-API-Key", goveeApiKey);
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            // Create request body with proper Govee API format
            Map<String, Object> payload = new HashMap<>();
            payload.put("sku", sku);
            payload.put("device", device);
            
            Map<String, Object> requestBody = new HashMap<>();
            requestBody.put("requestId", java.util.UUID.randomUUID().toString());
            requestBody.put("payload", payload);
            
            log.info("Requesting device state - URL: {}, Device: {}, SKU: {}", url, device, sku);
            log.info("Request body: {}", requestBody);
            
            HttpEntity<Map<String, Object>> requestEntity = new HttpEntity<>(requestBody, headers);
            
            @SuppressWarnings("unchecked")
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.POST,
                    requestEntity,
                    (Class<Map<String, Object>>) (Class<?>) Map.class
            );
            
            log.info("Govee device state response: {}", response.getBody());
            return response.getBody() != null ? response.getBody() : new HashMap<>();
            
        } catch (org.springframework.web.client.HttpClientErrorException e) {
            String responseBody = e.getResponseBodyAsString();
            log.error("HTTP error fetching Govee device state - Status: {}, Response body: {}", 
                    e.getStatusCode(), responseBody);
            
            // Try to parse error response as JSON
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Failed to fetch device state: " + e.getStatusCode());
            errorMap.put("errorMessage", responseBody);
            errorMap.put("code", e.getStatusCode().value());
            
            // Try to extract message from error response if it's JSON
            try {
                if (responseBody != null && responseBody.startsWith("{")) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> errorResponse = new com.fasterxml.jackson.databind.ObjectMapper().readValue(responseBody, Map.class);
                    if (errorResponse.containsKey("message")) {
                        errorMap.put("message", errorResponse.get("message"));
                    }
                }
            } catch (Exception parseEx) {
                log.debug("Could not parse error response as JSON", parseEx);
            }
            
            return errorMap;
        } catch (Exception e) {
            log.error("Error fetching Govee device state: ", e);
            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("error", "Failed to fetch device state: " + e.getMessage());
            return errorMap;
        }
    }

    /**
     * Get all device states (for all devices)
     */
    public Map<String, Object> getAllDeviceStates() {
        // First get all devices
        Map<String, Object> devicesResponse = getDevices();
        
        if (devicesResponse.containsKey("error")) {
            return devicesResponse;
        }
        
        Map<String, Object> result = new HashMap<>();
        result.put("devices", devicesResponse);
        
        // Try to get states for each device if available
        try {
            java.util.List<Map<String, Object>> devices = null;
            
            // Structure 1: response.devices.data (array) - Actual Govee API structure
            if (devicesResponse.containsKey("devices")) {
                Object devicesObj = devicesResponse.get("devices");
                if (devicesObj instanceof Map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> devicesMap = (Map<String, Object>) devicesObj;
                    if (devicesMap.containsKey("data") && devicesMap.get("data") instanceof java.util.List) {
                        @SuppressWarnings("unchecked")
                        java.util.List<Map<String, Object>> devicesList = (java.util.List<Map<String, Object>>) devicesMap.get("data");
                        devices = devicesList;
                    }
                }
            }
            // Structure 2: response.data (array)
            else if (devicesResponse.containsKey("data") && devicesResponse.get("data") instanceof java.util.List) {
                @SuppressWarnings("unchecked")
                java.util.List<Map<String, Object>> devicesList = (java.util.List<Map<String, Object>>) devicesResponse.get("data");
                devices = devicesList;
            }
            // Structure 3: response.data.devices (nested)
            else if (devicesResponse.containsKey("data") && devicesResponse.get("data") instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> data = (Map<String, Object>) devicesResponse.get("data");
                if (data.containsKey("devices") && data.get("devices") instanceof java.util.List) {
                    @SuppressWarnings("unchecked")
                    java.util.List<Map<String, Object>> devicesList = (java.util.List<Map<String, Object>>) data.get("devices");
                    devices = devicesList;
                }
            }
            
            if (devices != null && !devices.isEmpty()) {
                java.util.List<Map<String, Object>> deviceStates = new java.util.ArrayList<>();
                for (Map<String, Object> device : devices) {
                    String deviceId = (String) device.get("device");
                    // Use SKU as model (devices have SKU, not model in the response)
                    String model = (String) device.get("sku");
                    if (model == null || model.isEmpty()) {
                        model = (String) device.get("model");
                    }
                    
                    // Check if device is retrievable or has sensor capabilities
                    Boolean retrievable = (Boolean) device.get("retrievable");
                    if (retrievable == null) {
                        retrievable = false;
                    }
                    
                    // Check if device has sensor capabilities (thermometer, hygrometer, etc.)
                    boolean hasSensorCapabilities = false;
                    if (device.containsKey("capabilities") && device.get("capabilities") instanceof java.util.List) {
                        @SuppressWarnings("unchecked")
                        java.util.List<Map<String, Object>> capabilities = (java.util.List<Map<String, Object>>) device.get("capabilities");
                        for (Map<String, Object> cap : capabilities) {
                            String instance = (String) cap.get("instance");
                            if (instance != null && (instance.contains("sensor") || instance.contains("Temperature") || instance.contains("Humidity"))) {
                                hasSensorCapabilities = true;
                                break;
                            }
                        }
                    }
                    
                    Map<String, Object> deviceWithState = new HashMap<>(device);
                    
                    // Try to get state if device is retrievable OR has sensor capabilities
                    if ((retrievable || hasSensorCapabilities) && deviceId != null && model != null && !model.isEmpty()) {
                        log.info("Fetching state for device: {}, SKU: {} (retrievable: true)", deviceId, model);
                        
                        Map<String, Object> stateResponse = getDeviceState(deviceId, model);
                        log.info("State response for device {}: {}", deviceId, stateResponse);
                        
                        // Extract state data from response according to Govee API format:
                        // Response structure: { "code": 200, "msg": "success", "payload": { "capabilities": [...] } }
                        Map<String, Object> state = new HashMap<>();
                        if (stateResponse.containsKey("payload")) {
                            Object payloadObj = stateResponse.get("payload");
                            if (payloadObj instanceof Map) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> payloadMap = (Map<String, Object>) payloadObj;
                                // Check for capabilities array in payload
                                if (payloadMap.containsKey("capabilities") && payloadMap.get("capabilities") instanceof java.util.List) {
                                    @SuppressWarnings("unchecked")
                                    java.util.List<Map<String, Object>> capabilities = (java.util.List<Map<String, Object>>) payloadMap.get("capabilities");
                                    // Extract sensor values from capabilities
                                    for (Map<String, Object> capability : capabilities) {
                                        String instance = (String) capability.get("instance");
                                        if (capability.containsKey("state") && capability.get("state") instanceof Map) {
                                            @SuppressWarnings("unchecked")
                                            Map<String, Object> stateObj = (Map<String, Object>) capability.get("state");
                                            Object value = stateObj.get("value");
                                            
                                            // Map instance names to state properties
                                            if ("sensorTemperature".equals(instance) || "sensorTe".equals(instance)) {
                                                state.put("temperature", value);
                                            } else if ("sensorHumidity".equals(instance) || "sensorHu".equals(instance)) {
                                                state.put("humidity", value);
                                            } else if ("online".equals(instance)) {
                                                state.put("online", value);
                                            } else if ("powerState".equals(instance) || "power".equals(instance)) {
                                                state.put("powerState", value);
                                            } else if ("brightness".equals(instance)) {
                                                state.put("brightness", value);
                                            } else if ("colorTem".equals(instance) || "colorTemp".equals(instance)) {
                                                state.put("colorTem", value);
                                            } else if ("color".equals(instance)) {
                                                state.put("color", value);
                                            }
                                        }
                                    }
                                }
                            }
                        } else if (stateResponse.containsKey("data")) {
                            // Fallback to old format
                            Object dataObj = stateResponse.get("data");
                            if (dataObj instanceof Map) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> dataMap = (Map<String, Object>) dataObj;
                                if (dataMap.containsKey("properties") && dataMap.get("properties") instanceof java.util.List) {
                                    @SuppressWarnings("unchecked")
                                    java.util.List<Map<String, Object>> properties = (java.util.List<Map<String, Object>>) dataMap.get("properties");
                                    for (Map<String, Object> prop : properties) {
                                        state.putAll(prop);
                                    }
                                } else {
                                    state.putAll(dataMap);
                                }
                            }
                        } else if (!stateResponse.containsKey("error")) {
                            // State might be directly in response
                            state.putAll(stateResponse);
                        }
                        
                        deviceWithState.put("state", state);
                        log.info("Successfully extracted state for device {}: {}", deviceId, state);
                    } else {
                        if (!retrievable && !hasSensorCapabilities) {
                            log.info("Device {} is not retrievable and has no sensor capabilities, skipping state fetch", deviceId);
                        } else if (!retrievable && hasSensorCapabilities) {
                            log.warn("Device {} has sensor capabilities but is not marked as retrievable. Attempting state fetch anyway...", deviceId);
                            // Try to fetch state even if not marked as retrievable
                            if (deviceId != null && model != null && !model.isEmpty()) {
                                Map<String, Object> stateResponse = getDeviceState(deviceId, model);
                                log.info("State response for non-retrievable device {}: {}", deviceId, stateResponse);
                                
                                Map<String, Object> state = new HashMap<>();
                                if (stateResponse.containsKey("payload")) {
                                    Object payloadObj = stateResponse.get("payload");
                                    if (payloadObj instanceof Map) {
                                        @SuppressWarnings("unchecked")
                                        Map<String, Object> payloadMap = (Map<String, Object>) payloadObj;
                                        if (payloadMap.containsKey("capabilities") && payloadMap.get("capabilities") instanceof java.util.List) {
                                            @SuppressWarnings("unchecked")
                                            java.util.List<Map<String, Object>> capabilities = (java.util.List<Map<String, Object>>) payloadMap.get("capabilities");
                                            for (Map<String, Object> capability : capabilities) {
                                                String instance = (String) capability.get("instance");
                                                if (capability.containsKey("state") && capability.get("state") instanceof Map) {
                                                    @SuppressWarnings("unchecked")
                                                    Map<String, Object> stateObj = (Map<String, Object>) capability.get("state");
                                                    Object value = stateObj.get("value");
                                                    
                                                    if ("sensorTemperature".equals(instance) || "sensorTe".equals(instance)) {
                                                        state.put("temperature", value);
                                                    } else if ("sensorHumidity".equals(instance) || "sensorHu".equals(instance)) {
                                                        state.put("humidity", value);
                                                    } else if ("online".equals(instance)) {
                                                        state.put("online", value);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                deviceWithState.put("state", state);
                                log.info("State extracted for non-retrievable device {}: {}", deviceId, state);
                            } else {
                                deviceWithState.put("state", new HashMap<>());
                            }
                        } else {
                            log.warn("Cannot fetch state for device {}: missing deviceId or model/SKU (deviceId: {}, model: {})", 
                                    deviceId, deviceId != null ? "present" : "null", model != null ? model : "null");
                            deviceWithState.put("state", new HashMap<>());
                        }
                    }
                    
                    deviceStates.add(deviceWithState);
                }
                result.put("deviceStates", deviceStates);
            }
        } catch (Exception e) {
            log.warn("Could not fetch individual device states: ", e);
        }
        
        return result;
    }
}
