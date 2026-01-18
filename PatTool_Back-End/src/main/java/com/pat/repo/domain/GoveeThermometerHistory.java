package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.LocalDateTime;

/**
 * Model for storing Govee thermometer history data
 */
@Document(collection = "govee_thermometer_history")
public class GoveeThermometerHistory {

    @Id
    private String id;
    
    private String deviceId;
    private String deviceName;
    private String model;
    
    private Double temperature; // Temperature in Celsius
    private Double humidity;    // Humidity percentage
    
    private LocalDateTime timestamp;
    private Boolean online;     // Device online status

    // Constructors
    public GoveeThermometerHistory() {
        this.timestamp = LocalDateTime.now();
    }

    public GoveeThermometerHistory(String deviceId, String deviceName, String model, Double temperature, Double humidity, Boolean online) {
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.model = model;
        this.temperature = temperature;
        this.humidity = humidity;
        this.online = online;
        this.timestamp = LocalDateTime.now();
    }

    // Getters and Setters
    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getDeviceId() {
        return deviceId;
    }

    public void setDeviceId(String deviceId) {
        this.deviceId = deviceId;
    }

    public String getDeviceName() {
        return deviceName;
    }

    public void setDeviceName(String deviceName) {
        this.deviceName = deviceName;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public Double getTemperature() {
        return temperature;
    }

    public void setTemperature(Double temperature) {
        this.temperature = temperature;
    }

    public Double getHumidity() {
        return humidity;
    }

    public void setHumidity(Double humidity) {
        this.humidity = humidity;
    }

    public LocalDateTime getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(LocalDateTime timestamp) {
        this.timestamp = timestamp;
    }

    public Boolean getOnline() {
        return online;
    }

    public void setOnline(Boolean online) {
        this.online = online;
    }

    @Override
    public String toString() {
        return "GoveeThermometerHistory{" +
                "id='" + id + '\'' +
                ", deviceId='" + deviceId + '\'' +
                ", deviceName='" + deviceName + '\'' +
                ", model='" + model + '\'' +
                ", temperature=" + temperature +
                ", humidity=" + humidity +
                ", timestamp=" + timestamp +
                ", online=" + online +
                '}';
    }
}
