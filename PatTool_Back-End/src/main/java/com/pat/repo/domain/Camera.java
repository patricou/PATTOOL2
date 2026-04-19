package com.pat.repo.domain;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * Camera IoT device stored in MongoDB.
 * Collection: cameras
 */
@Document(collection = "cameras")
public class Camera {

    @Id
    private String id;
    private String uid;
    private String name;
    private String owner;
    private Date creationDate;
    private Date updateDate;
    private String brand;
    private String type;
    private String webUrl;
    private String snapshotUrl;
    private String username;
    /**
     * Camera password. Write-only in JSON:
     *   - accepted when the frontend sends it (POST/PUT);
     *   - never serialized back in responses (see {@link JsonProperty.Access#WRITE_ONLY}).
     * The computed {@link #isHasPassword()} getter is serialized as "hasPassword"
     * so the UI can know whether a password is stored without leaking it.
     */
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String password;
    private String service;
    private String macaddress;
    private String ip;
    private String place;
    private String room;
    private String param1;
    private String param2;
    private String param3;

    public Camera() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUid() { return uid; }
    public void setUid(String uid) { this.uid = uid; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getOwner() { return owner; }
    public void setOwner(String owner) { this.owner = owner; }

    public Date getCreationDate() { return creationDate; }
    public void setCreationDate(Date creationDate) { this.creationDate = creationDate; }

    public Date getUpdateDate() { return updateDate; }
    public void setUpdateDate(Date updateDate) { this.updateDate = updateDate; }

    public String getBrand() { return brand; }
    public void setBrand(String brand) { this.brand = brand; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getWebUrl() { return webUrl; }
    public void setWebUrl(String webUrl) { this.webUrl = webUrl; }

    public String getSnapshotUrl() { return snapshotUrl; }
    public void setSnapshotUrl(String snapshotUrl) { this.snapshotUrl = snapshotUrl; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }

    /** Serialized as {@code hasPassword} in JSON; used by the frontend to know whether a password is stored (without leaking it). */
    public boolean isHasPassword() {
        return password != null && !password.isEmpty();
    }

    public String getService() { return service; }
    public void setService(String service) { this.service = service; }

    public String getMacaddress() { return macaddress; }
    public void setMacaddress(String macaddress) { this.macaddress = macaddress; }

    public String getIp() { return ip; }
    public void setIp(String ip) { this.ip = ip; }

    public String getPlace() { return place; }
    public void setPlace(String place) { this.place = place; }

    public String getRoom() { return room; }
    public void setRoom(String room) { this.room = room; }

    public String getParam1() { return param1; }
    public void setParam1(String param1) { this.param1 = param1; }

    public String getParam2() { return param2; }
    public void setParam2(String param2) { this.param2 = param2; }

    public String getParam3() { return param3; }
    public void setParam3(String param3) { this.param3 = param3; }

    @Override
    public String toString() {
        return "Camera{" +
                "id='" + id + '\'' +
                ", uid='" + uid + '\'' +
                ", name='" + name + '\'' +
                ", owner='" + owner + '\'' +
                ", brand='" + brand + '\'' +
                ", type='" + type + '\'' +
                ", ip='" + ip + '\'' +
                ", place='" + place + '\'' +
                ", room='" + room + '\'' +
                '}';
    }
}
