package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

@Document(collection = "network_device_mappings")
public class NetworkDeviceMapping {
    
    @Id
    private String id;
    
    private String ipAddress;
    private String deviceName;
    private String macAddress;
    private Integer deviceNumber;
    private String deviceType;
    private String deviceDescription;
    
    public NetworkDeviceMapping() {
    }
    
    public NetworkDeviceMapping(String ipAddress, String deviceName, String macAddress, Integer deviceNumber) {
        this.ipAddress = ipAddress;
        this.deviceName = deviceName;
        this.macAddress = macAddress;
        this.deviceNumber = deviceNumber;
    }
    
    public String getId() {
        return id;
    }
    
    public void setId(String id) {
        this.id = id;
    }
    
    public String getIpAddress() {
        return ipAddress;
    }
    
    public void setIpAddress(String ipAddress) {
        this.ipAddress = ipAddress;
    }
    
    public String getDeviceName() {
        return deviceName;
    }
    
    public void setDeviceName(String deviceName) {
        this.deviceName = deviceName;
    }
    
    public String getMacAddress() {
        return macAddress;
    }
    
    public void setMacAddress(String macAddress) {
        this.macAddress = macAddress;
    }
    
    public Integer getDeviceNumber() {
        return deviceNumber;
    }
    
    public void setDeviceNumber(Integer deviceNumber) {
        this.deviceNumber = deviceNumber;
    }
    
    public String getDeviceType() {
        return deviceType;
    }
    
    public void setDeviceType(String deviceType) {
        this.deviceType = deviceType;
    }
    
    public String getDeviceDescription() {
        return deviceDescription;
    }
    
    public void setDeviceDescription(String deviceDescription) {
        this.deviceDescription = deviceDescription;
    }
}

