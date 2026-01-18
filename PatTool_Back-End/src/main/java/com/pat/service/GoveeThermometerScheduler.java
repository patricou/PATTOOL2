package com.pat.service;

import com.pat.repo.GoveeThermometerHistoryRepository;
import com.pat.repo.domain.GoveeThermometerHistory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import jakarta.annotation.PostConstruct;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Scheduled task to refresh Govee thermometers and save history to MongoDB
 */
@Service
public class GoveeThermometerScheduler {

    private static final Logger log = LoggerFactory.getLogger(GoveeThermometerScheduler.class);

    @Autowired
    private GoveeService goveeService;

    @Autowired
    private GoveeThermometerHistoryRepository historyRepository;
    
    @Autowired
    private MongoTemplate mongoTemplate;

    @Value("${govee.thermometer.auto.refresh.enabled:true}")
    private boolean schedulerEnabledDefault;

    @Value("${govee.thermometer.auto.refresh.cron:0 */10 * * * ?}")
    private String schedulerCron;

    // Runtime flag that can be updated via API (defaults to application.properties value)
    private volatile boolean schedulerEnabled;

    /**
     * Initialize scheduler enabled flag from application.properties
     * Called after dependency injection
     */
    @PostConstruct
    public void init() {
        this.schedulerEnabled = schedulerEnabledDefault;
        log.debug("Govee thermometer scheduler initialized. Enabled: {}, Cron: {}", schedulerEnabled, schedulerCron);
    }

    /**
     * Get current scheduler enabled status
     */
    public boolean isSchedulerEnabled() {
        return schedulerEnabled;
    }

    /**
     * Set scheduler enabled status (can be updated at runtime)
     */
    public void setSchedulerEnabled(boolean enabled) {
        this.schedulerEnabled = enabled;
        log.debug("Govee thermometer scheduler enabled flag updated to: {}", enabled);
    }

    /**
     * Manually refresh thermometers and save history (can be called from controller)
     */
    public Map<String, Object> refreshThermometersAndSaveHistory() {
        Map<String, Object> result = new HashMap<>();
        int savedCount = 0;
        int errorCount = 0;

        try {
            log.debug("Starting manual thermometer refresh and history save");
            
            // Get all device states
            Map<String, Object> devicesResponse = goveeService.getAllDeviceStates();
            
            if (devicesResponse.containsKey("error")) {
                log.error("Error fetching device states: {}", devicesResponse.get("error"));
                result.put("error", devicesResponse.get("error"));
                result.put("savedCount", 0);
                return result;
            }

            // Extract devices with states
            List<Map<String, Object>> deviceStates = extractDeviceStates(devicesResponse);
            log.debug("Found {} device states to process", deviceStates.size());
            
            for (Map<String, Object> device : deviceStates) {
                try {
                    // Check if device is a thermometer (has temperature reading)
                    Map<String, Object> state = (Map<String, Object>) device.get("state");
                    if (state != null && isThermometerDevice(device, state)) {
                        saveThermometerHistory(device, state);
                        savedCount++;
                    }
                } catch (Exception e) {
                    log.error("Error saving history for device {}: {}", device.get("device"), e.getMessage(), e);
                    errorCount++;
                }
            }

            result.put("success", true);
            result.put("savedCount", savedCount);
            result.put("errorCount", errorCount);
            log.debug("Manual thermometer refresh completed. Saved: {}, Errors: {}", savedCount, errorCount);
            
        } catch (Exception e) {
            log.error("Error during manual thermometer refresh: {}", e.getMessage(), e);
            result.put("error", "Failed to refresh thermometers: " + e.getMessage());
            result.put("savedCount", savedCount);
        }

        return result;
    }

    /**
     * Scheduled thermometer refresh - runs according to cron expression when enabled
     */
    @Scheduled(cron = "${govee.thermometer.auto.refresh.cron:0 */10 * * * ?}")
    public void scheduledThermometerRefresh() {
        if (!schedulerEnabled) {
            log.debug("Govee thermometer scheduler is disabled (govee.thermometer.auto.refresh.enabled=false)");
            return;
        }

        log.debug("========== SCHEDULED THERMOMETER REFRESH STARTED ==========");
        long startTime = System.currentTimeMillis();

        try {
            // Get all device states
            Map<String, Object> devicesResponse = goveeService.getAllDeviceStates();
            
            if (devicesResponse.containsKey("error")) {
                log.error("Error fetching device states during scheduled refresh: {}", devicesResponse.get("error"));
                return;
            }

            // Extract devices with states
            List<Map<String, Object>> deviceStates = extractDeviceStates(devicesResponse);
            log.debug("Found {} device states to process in scheduled refresh", deviceStates.size());
            
            int savedCount = 0;
            int errorCount = 0;
            
            for (Map<String, Object> device : deviceStates) {
                try {
                    // Check if device is a thermometer (has temperature reading)
                    Map<String, Object> state = (Map<String, Object>) device.get("state");
                    if (state != null && isThermometerDevice(device, state)) {
                        saveThermometerHistory(device, state);
                        savedCount++;
                    }
                } catch (Exception e) {
                    log.error("Error saving history for device {} during scheduled refresh: {}", 
                            device.get("device"), e.getMessage(), e);
                    errorCount++;
                }
            }

            long duration = System.currentTimeMillis() - startTime;
            log.debug("Scheduled thermometer refresh completed in {} ms. Saved: {}, Errors: {}", 
                    duration, savedCount, errorCount);

        } catch (Exception e) {
            log.error("Error during scheduled thermometer refresh: {}", e.getMessage(), e);
        }

        log.debug("========== SCHEDULED THERMOMETER REFRESH COMPLETED ==========");
    }

    /**
     * Extract device states list from API response
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> extractDeviceStates(Map<String, Object> devicesResponse) {
        // Try different response structures
        if (devicesResponse.containsKey("deviceStates") && 
            devicesResponse.get("deviceStates") instanceof List) {
            return (List<Map<String, Object>>) devicesResponse.get("deviceStates");
        }
        
        if (devicesResponse.containsKey("devices")) {
            Object devicesObj = devicesResponse.get("devices");
            if (devicesObj instanceof Map) {
                Map<String, Object> devicesMap = (Map<String, Object>) devicesObj;
                if (devicesMap.containsKey("data") && devicesMap.get("data") instanceof List) {
                    return (List<Map<String, Object>>) devicesMap.get("data");
                }
            }
        }
        
        return new java.util.ArrayList<>();
    }

    /**
     * Check if device is a thermometer (has temperature sensor)
     */
    private boolean isThermometerDevice(Map<String, Object> device, Map<String, Object> state) {
        // Check if device has temperature in state
        if (state.containsKey("temperature")) {
            Object temp = state.get("temperature");
            if (temp != null) {
                // Check if it's a valid number
                if (temp instanceof Number) {
                    return true;
                }
                try {
                    Double.parseDouble(temp.toString());
                    return true;
                } catch (NumberFormatException e) {
                    // Not a valid number
                }
            }
        }
        
        // Also check device type/model/name for thermometer keywords
        String deviceType = (String) device.get("type");
        String model = (String) device.get("model");
        String sku = (String) device.get("sku");
        String deviceName = (String) device.get("deviceName");
        
        String allText = ((deviceType != null ? deviceType : "") + " " +
                         (model != null ? model : "") + " " +
                         (sku != null ? sku : "") + " " +
                         (deviceName != null ? deviceName : "")).toLowerCase();
        
        return allText.contains("thermometer") || allText.contains("temp");
    }

    /**
     * Save thermometer history to MongoDB
     */
    @SuppressWarnings("unchecked")
    private void saveThermometerHistory(Map<String, Object> device, Map<String, Object> state) {
        try {
            String deviceId = (String) device.get("device");
            String deviceName = (String) device.get("deviceName");
            String model = (String) device.get("model");
            
            log.debug("saveThermometerHistory called for device: {} ({})", deviceId, deviceName);
            if (model == null || model.isEmpty()) {
                model = (String) device.get("sku");
            }
            
            // Extract temperature (convert from Fahrenheit to Celsius if needed)
            Double temperature = null;
            if (state.containsKey("temperature")) {
                Object tempObj = state.get("temperature");
                if (tempObj != null) {
                    try {
                        double tempValue;
                        if (tempObj instanceof Number) {
                            tempValue = ((Number) tempObj).doubleValue();
                        } else {
                            tempValue = Double.parseDouble(tempObj.toString());
                        }
                        // Govee API returns temperature in Fahrenheit, convert to Celsius
                        // C = (F - 32) × 5/9
                        temperature = (tempValue - 32) * 5.0 / 9.0;
                    } catch (NumberFormatException e) {
                        log.error("Could not parse temperature value: {}", tempObj, e);
                    }
                }
            }
            
            // Extract humidity
            Double humidity = null;
            if (state.containsKey("humidity")) {
                Object humObj = state.get("humidity");
                if (humObj != null) {
                    try {
                        if (humObj instanceof Number) {
                            humidity = ((Number) humObj).doubleValue();
                        } else {
                            humidity = Double.parseDouble(humObj.toString());
                        }
                    } catch (NumberFormatException e) {
                        log.error("Could not parse humidity value: {}", humObj, e);
                    }
                }
            }
            
            // Extract online status
            Boolean online = null;
            if (state.containsKey("online")) {
                Object onlineObj = state.get("online");
                if (onlineObj instanceof Boolean) {
                    online = (Boolean) onlineObj;
                } else if (onlineObj instanceof String) {
                    online = "true".equalsIgnoreCase((String) onlineObj);
                }
            }
            
            // Only save if we have at least temperature or humidity
            if (temperature != null || humidity != null) {
                // Get the last entry stored in MongoDB for this device (the one with the most recent timestamp)
                // This is the previous measurement that we will compare with the new measurement from Govee API
                // Using MongoTemplate with Query and limit(1) for optimal performance and reliability
                GoveeThermometerHistory lastEntryInDb = null;
                try {
                    Query query = new Query(Criteria.where("deviceId").is(deviceId));
                    query.with(org.springframework.data.domain.Sort.by(org.springframework.data.domain.Sort.Direction.DESC, "timestamp"));
                    query.limit(1);
                    List<GoveeThermometerHistory> results = mongoTemplate.find(query, GoveeThermometerHistory.class, "govee_thermometer_history");
                    if (results != null && !results.isEmpty()) {
                        lastEntryInDb = results.get(0);
                        log.debug("Found last entry for device {}: timestamp={}, temp={}°C, humidity={}%, id={}", 
                                deviceId, lastEntryInDb.getTimestamp(), 
                                lastEntryInDb.getTemperature(), lastEntryInDb.getHumidity(), lastEntryInDb.getId());
                    } else {
                        log.debug("No previous entries found for device {}", deviceId);
                    }
                } catch (Exception e) {
                    log.error("Error fetching last entry for device {}: {}", deviceId, e.getMessage(), e);
                }
                
                // Compare the new measurement (from Govee API, with current timestamp) 
                // with the last entry in MongoDB (previous measurement)
                // If values are equal (rounded to 2 decimals), we will delete the old entry and save the new one
                boolean valuesAreEqual = false;
                if (lastEntryInDb != null) {
                    // Compare temperature from new Govee measurement with last entry in MongoDB (rounded to 2 decimals)
                    boolean tempMatches = false;
                    if (temperature != null && lastEntryInDb.getTemperature() != null) {
                        double roundedNewTemp = Math.round(temperature * 100.0) / 100.0;
                        double roundedLastTemp = Math.round(lastEntryInDb.getTemperature() * 100.0) / 100.0;
                        tempMatches = (Math.abs(roundedNewTemp - roundedLastTemp) < 0.001); // Use epsilon comparison for floating point
                        log.debug("Temperature comparison for device {}: new={}°C (rounded={}), last={}°C (rounded={}), diff={}, match={}", 
                                deviceId, temperature, roundedNewTemp, lastEntryInDb.getTemperature(), roundedLastTemp, 
                                Math.abs(roundedNewTemp - roundedLastTemp), tempMatches);
                    } else if (temperature == null && lastEntryInDb.getTemperature() == null) {
                        tempMatches = true;
                        log.debug("Temperature comparison for device {}: both null, match=true", deviceId);
                    } else {
                        log.debug("Temperature comparison for device {}: new={}, last={}, match=false (one is null)", 
                                deviceId, temperature, lastEntryInDb.getTemperature());
                    }
                    
                    // Compare humidity from new Govee measurement with last entry in MongoDB (rounded to 2 decimals)
                    boolean humMatches = false;
                    if (humidity != null && lastEntryInDb.getHumidity() != null) {
                        double roundedNewHum = Math.round(humidity * 100.0) / 100.0;
                        double roundedLastHum = Math.round(lastEntryInDb.getHumidity() * 100.0) / 100.0;
                        humMatches = (Math.abs(roundedNewHum - roundedLastHum) < 0.001); // Use epsilon comparison for floating point
                        log.debug("Humidity comparison for device {}: new={}% (rounded={}), last={}% (rounded={}), diff={}, match={}", 
                                deviceId, humidity, roundedNewHum, lastEntryInDb.getHumidity(), roundedLastHum,
                                Math.abs(roundedNewHum - roundedLastHum), humMatches);
                    } else if (humidity == null && lastEntryInDb.getHumidity() == null) {
                        humMatches = true;
                        log.debug("Humidity comparison for device {}: both null, match=true", deviceId);
                    } else {
                        log.debug("Humidity comparison for device {}: new={}, last={}, match=false (one is null)", 
                                deviceId, humidity, lastEntryInDb.getHumidity());
                    }
                    
                    // Values are equal only if both temperature AND humidity match
                    valuesAreEqual = (tempMatches && humMatches);
                    log.debug("Values comparison result for device {}: tempMatch={}, humMatch={}, valuesAreEqual={}", 
                            deviceId, tempMatches, humMatches, valuesAreEqual);
                    
                    // If values are equal: delete the old entry in MongoDB before saving the new measurement with current timestamp
                    if (valuesAreEqual) {
                        String oldEntryId = lastEntryInDb.getId();
                        if (oldEntryId == null || oldEntryId.isEmpty()) {
                            log.error("Cannot delete last entry for device {}: ID is null or empty", deviceId);
                        } else {
                            java.time.LocalDateTime oldTimestamp = lastEntryInDb.getTimestamp();
                            try {
                                historyRepository.deleteById(oldEntryId);
                                log.debug("Successfully deleted last entry in MongoDB for device {} (same values: temp={}°C, humidity={}%, old timestamp={}, old id={}) - will replace with new measurement from Govee", 
                                        deviceId, temperature, humidity, oldTimestamp, oldEntryId);
                            } catch (Exception deleteEx) {
                                log.error("Failed to delete last entry for device {} with id {}: {}", 
                                        deviceId, oldEntryId, deleteEx.getMessage(), deleteEx);
                            }
                        }
                    } else {
                        log.debug("Values are different for device {}, keeping old entry and adding new one", deviceId);
                    }
                } else {
                    log.debug("No previous entry found for device {}, will add new entry", deviceId);
                }
                
                // Always save the new measurement from Govee API with current timestamp
                // Create new measurement object (without ID to ensure it's a new document)
                GoveeThermometerHistory newMeasurement = new GoveeThermometerHistory();
                newMeasurement.setDeviceId(deviceId);
                newMeasurement.setDeviceName(deviceName != null ? deviceName : "Unknown Device");
                newMeasurement.setModel(model != null ? model : "Unknown Model");
                newMeasurement.setTemperature(temperature);  // New temperature from Govee API
                newMeasurement.setHumidity(humidity);          // New humidity from Govee API
                newMeasurement.setOnline(online);
                
                // Ensure ID is null so MongoDB creates a new document (not update existing)
                newMeasurement.setId(null);
                
                // Explicitly set timestamp to current time to ensure it's always updated
                // This is the timestamp of the measurement taken from Govee API right now
                java.time.LocalDateTime currentTimestamp = java.time.LocalDateTime.now();
                newMeasurement.setTimestamp(currentTimestamp);
                
                log.debug("About to save new measurement: device={}, temp={}°C, humidity={}%, timestamp={}, id={}", 
                        deviceId, temperature, humidity, currentTimestamp, newMeasurement.getId());
                
                historyRepository.save(newMeasurement);
                
                log.debug("Saved new measurement from Govee API: device={}, temp={}°C, humidity={}%, timestamp={}, id={}{}", 
                        deviceId, temperature, humidity, newMeasurement.getTimestamp(), newMeasurement.getId(),
                        valuesAreEqual ? " (replaced old entry with same values)" : " (added as new entry)");
            }
        } catch (Exception e) {
            log.error("Error saving thermometer history for device {}: {}", 
                    device.get("device"), e.getMessage(), e);
            throw e; // Re-throw to be caught by caller
        }
    }
}
