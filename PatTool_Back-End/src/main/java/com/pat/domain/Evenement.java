package com.pat.domain;


import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.DBRef;
import org.springframework.data.mongodb.core.mapping.Document;

import jakarta.validation.constraints.NotNull;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Created by patricou on 4/20/2017.
 */
@Document(collection = "evenements")
public class Evenement {

    @Id
    private String id;
    @NotNull
    private String evenementName;
    @NotNull
    private Date creationDate;
    @NotNull
    private Date openInscriptionDate;
    @NotNull
    private Date closeInscriptionDate;
    @NotNull
    @DBRef
    private Member author;
    @NotNull
    private String map;
    @NotNull
    private String photosUrl;
    @NotNull
    private String comments;
    @NotNull
    private Date endEventDate;
    @NotNull
    private Date beginEventDate;
    @NotNull
    private String status;
    @NotNull
    private String type;
    private Integer ratingPlus=0;
    private Integer ratingMinus=0;
    @DBRef
    private List<Member> members = new ArrayList<Member>();
    private List<FileUploaded> fileUploadeds = new ArrayList<FileUploaded>();
    private String startHour;
    private String diffculty;
    private String startLocation;
    private String durationEstimation;
    private String visibility;

    public List<Member> getMembers() {
        return members;
    }

    public Date getCreationDate() {
        return creationDate;
    }

    public void setCreationDate(Date creationDate) {
        this.creationDate = creationDate;
    }

    public Date getOpenInscriptionDate() {
        return openInscriptionDate;
    }

    public void setOpenInscriptionDate(Date openInscriptionDate) {
        this.openInscriptionDate = openInscriptionDate;
    }

    public Date getCloseInscriptionDate() {
        return closeInscriptionDate;
    }

    public void setCloseInscriptionDate(Date closeInscriptionDate) {
        this.closeInscriptionDate = closeInscriptionDate;
    }

    public Member getAuthor() {
        return author;
    }

    public void setAuthor(Member author) {
        this.author = author;
    }

    public String getMap() {
        return map;
    }

    public void setMap(String map) {
        this.map = map;
    }

    public String getComments() {
        return comments;
    }

    public void setComments(String comments) {
        this.comments = comments;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Date getEndEventDate() {
        return endEventDate;
    }

    public void setEndEventDate(Date endEventDate) {
        this.endEventDate = endEventDate;
    }

    public Date getBeginEventDate() {
        return beginEventDate;
    }

    public void setBeginEventDate(Date beginEventDate) {
        this.beginEventDate = beginEventDate;
    }

    public void setMembers(List<Member> members) {
        this.members = members;
    }

    public String getEvenementName() {
        return evenementName;
    }

    public void setEvenementName(String evenementName) {
        this.evenementName = evenementName;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public List<FileUploaded> getFileUploadeds() {
        return fileUploadeds;
    }

    public void setFileUploadeds(List<FileUploaded> fileUploadeds) {
        this.fileUploadeds = fileUploadeds;
    }

    public String getStartHour() {
        return startHour;
    }

    public void setStartHour(String startHour) {
        this.startHour = startHour;
    }

    public String getDiffculty() {
        return diffculty;
    }

    public void setDiffculty(String diffculty) {
        this.diffculty = diffculty;
    }

    public String getStartLocation() {
        return startLocation;
    }

    public void setStartLocation(String startLocation) {
        this.startLocation = startLocation;
    }

    public String getDurationEstimation() {
        return durationEstimation;
    }

    public void setDurationEstimation(String durationEstimation) {
        this.durationEstimation = durationEstimation;
    }

    public Integer getRatingPlus() {
        return ratingPlus;
    }

    public void setRatingPlus(Integer ratingPlus) {
        this.ratingPlus = ratingPlus;
    }

    public Integer getRatingMinus() {
        return ratingMinus;
    }

    public void setRatingMinus(Integer ratingMinus) {
        this.ratingMinus = ratingMinus;
    }

    public String getPhotosUrl() {
        return photosUrl;
    }

    public void setPhotosUrl(String photosUrl) {
        this.photosUrl = photosUrl;
    }

    public String getVisibility() {
        return visibility;
    }

    public void setVisibility(String visibility) {
        this.visibility = visibility;
    }

    @Override
    public String toString() {
        return "Evenement{" +
                "id='" + id + '\'' +
                ", evenementName='" + evenementName + '\'' +
                ", creationDate=" + creationDate +
                ", openInscriptionDate=" + openInscriptionDate +
                ", closeInscriptionDate=" + closeInscriptionDate +
                ", author=" + author +
                ", map='" + map + '\'' +
                ", photosUrl='" + photosUrl + '\'' +
                ", comments='" + comments + '\'' +
                ", endEventDate=" + endEventDate +
                ", beginEventDate=" + beginEventDate +
                ", status='" + status + '\'' +
                ", type='" + type + '\'' +
                ", ratingPlus=" + ratingPlus +
                ", ratingMinus=" + ratingMinus +
                ", members=" + members +
                ", fileUploadeds=" + fileUploadeds +
                ", startHour='" + startHour + '\'' +
                ", diffculty='" + diffculty + '\'' +
                ", startLocation='" + startLocation + '\'' +
                ", durationEstimation='" + durationEstimation + '\'' +
                ", Visibility=" + visibility +
                '}';
    }
}


