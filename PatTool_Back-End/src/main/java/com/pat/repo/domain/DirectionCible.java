package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

/**
 * Couple position utilisateur / cible visuelle, persisté par Member.
 * Le cap téléphone au moment du calage sert de zéro local (pas le Nord).
 */
@Document(collection = "direction_cibles")
public class DirectionCible {

    @Id
    private String id;

    @Indexed
    private String ownerSubject;

    @Indexed
    private String ownerUsername;

    private String name;

    private Double userLat;
    private Double userLon;
    private Double userAccM;

    /** Cap téléphone (degrés) quand la caméra vise la cible. */
    private Double phoneHeadingDeg;

    /** Azimut géographique estimé de la cible au premier enregistrement. */
    private Double refAzimuthDeg;

    /** Inclinaison téléphone (degrés) au calage. */
    private Double phoneElevationDeg;

    /** JPEG compressé {@code data:image/jpeg;base64,...}. */
    private String photoDataUrl;

    private boolean active;

    private String createdAt;
    private String updatedAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOwnerSubject() {
        return ownerSubject;
    }

    public void setOwnerSubject(String ownerSubject) {
        this.ownerSubject = ownerSubject;
    }

    public String getOwnerUsername() {
        return ownerUsername;
    }

    public void setOwnerUsername(String ownerUsername) {
        this.ownerUsername = ownerUsername;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Double getUserLat() {
        return userLat;
    }

    public void setUserLat(Double userLat) {
        this.userLat = userLat;
    }

    public Double getUserLon() {
        return userLon;
    }

    public void setUserLon(Double userLon) {
        this.userLon = userLon;
    }

    public Double getUserAccM() {
        return userAccM;
    }

    public void setUserAccM(Double userAccM) {
        this.userAccM = userAccM;
    }

    public Double getPhoneHeadingDeg() {
        return phoneHeadingDeg;
    }

    public void setPhoneHeadingDeg(Double phoneHeadingDeg) {
        this.phoneHeadingDeg = phoneHeadingDeg;
    }

    public Double getRefAzimuthDeg() {
        return refAzimuthDeg;
    }

    public void setRefAzimuthDeg(Double refAzimuthDeg) {
        this.refAzimuthDeg = refAzimuthDeg;
    }

    public Double getPhoneElevationDeg() {
        return phoneElevationDeg;
    }

    public void setPhoneElevationDeg(Double phoneElevationDeg) {
        this.phoneElevationDeg = phoneElevationDeg;
    }

    public String getPhotoDataUrl() {
        return photoDataUrl;
    }

    public void setPhotoDataUrl(String photoDataUrl) {
        this.photoDataUrl = photoDataUrl;
    }

    public boolean isActive() {
        return active;
    }

    public void setActive(boolean active) {
        this.active = active;
    }

    public String getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(String createdAt) {
        this.createdAt = createdAt;
    }

    public String getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(String updatedAt) {
        this.updatedAt = updatedAt;
    }
}
