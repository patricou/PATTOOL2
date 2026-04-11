package com.pat.repo.domain;

import org.springframework.data.mongodb.core.mapping.DBRef;

/**
 * Created by patricou on 5/8/2017.
 */
public class FileUploaded {

    //note : I have not created any @id as the object is not saved in a particular collection,
    // but in one Evenement
    //.....

    private String fieldId;
    private String fileName;
    private String fileType;
    /** Nom affiché optionnel (ex. trace GPX / KML sur le mur de photos et dans les listes). */
    private String displayName;
    /** Distance (km) saisie à la main pour une trace ; prioritaire sur le calcul auto (mur de photos). */
    private Double manualDistanceKm;
    /** Dénivelé positif (m) saisi à la main ; prioritaire sur le calcul auto. */
    private Double manualElevationGainM;
    /** Date d’activité liée au fichier (ex. yyyy-MM-dd), affichée sur le mur à la place de l’extraction GPX. */
    private String manualActivityDate;
    @DBRef
    private Member uploaderMember;

    public String getFieldId() {
        return fieldId;
    }

    public void setFieldId(String fieldId) {
        this.fieldId = fieldId;
    }

    public String getFileName() {
        return fileName;
    }

    public void setFileName(String fileName) {
        this.fileName = fileName;
    }

    public String getFileType() {
        return fileType;
    }

    public void setFileType(String fileType) {
        this.fileType = fileType;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public Double getManualDistanceKm() {
        return manualDistanceKm;
    }

    public void setManualDistanceKm(Double manualDistanceKm) {
        this.manualDistanceKm = manualDistanceKm;
    }

    public Double getManualElevationGainM() {
        return manualElevationGainM;
    }

    public void setManualElevationGainM(Double manualElevationGainM) {
        this.manualElevationGainM = manualElevationGainM;
    }

    public String getManualActivityDate() {
        return manualActivityDate;
    }

    public void setManualActivityDate(String manualActivityDate) {
        this.manualActivityDate = manualActivityDate;
    }

    public Member getUploaderMember() {
        return uploaderMember;
    }

    public void setUploaderMember(Member uploaderMember) {
        this.uploaderMember = uploaderMember;
    }

    public FileUploaded(String fieldId, String fileName, String fileType, Member uploaderMember) {
        this.fieldId = fieldId;
        this.fileName = fileName;
        this.fileType = fileType;
        this.uploaderMember = uploaderMember;
    }

    public FileUploaded(){};
}
