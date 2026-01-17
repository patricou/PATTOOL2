package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * New device history entity
 * Stores information about newly detected devices on the network
 */
@Document(collection = "new_device_history")
public class NewDeviceHistory {

    @Id
    private String id;

    private String ipAddress;
    private String hostname;
    private String macAddress;
    private String vendor;
    private String deviceType;
    private String os;
    private String openPorts; // Comma-separated list of open ports
    private Date detectionDate; // Date when the device was first detected

    public NewDeviceHistory() {
        this.detectionDate = new Date();
    }

    public NewDeviceHistory(String ipAddress, String hostname, String macAddress, String vendor, 
                           String deviceType, String os, String openPorts) {
        this.ipAddress = ipAddress;
        this.hostname = hostname;
        this.macAddress = macAddress;
        this.vendor = vendor;
        this.deviceType = deviceType;
        this.os = os;
        this.openPorts = openPorts;
        this.detectionDate = new Date();
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

    public String getHostname() {
        return hostname;
    }

    public void setHostname(String hostname) {
        this.hostname = hostname;
    }

    public String getMacAddress() {
        return macAddress;
    }

    public void setMacAddress(String macAddress) {
        this.macAddress = macAddress;
    }

    public String getVendor() {
        return vendor;
    }

    public void setVendor(String vendor) {
        this.vendor = vendor;
    }

    public String getDeviceType() {
        return deviceType;
    }

    public void setDeviceType(String deviceType) {
        this.deviceType = deviceType;
    }

    public String getOs() {
        return os;
    }

    public void setOs(String os) {
        this.os = os;
    }

    public String getOpenPorts() {
        return openPorts;
    }

    public void setOpenPorts(String openPorts) {
        this.openPorts = openPorts;
    }

    public Date getDetectionDate() {
        return detectionDate;
    }

    public void setDetectionDate(Date detectionDate) {
        this.detectionDate = detectionDate;
    }
}