package com.pat.controller.dto;

import java.util.Date;

/**
 * Activity (evenement) linked to a GPS outing, for display on the session detail.
 */
public class GpsLinkedActivityDto {

    private String id;
    private String title;
    private Date beginEventDate;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public Date getBeginEventDate() {
        return beginEventDate;
    }

    public void setBeginEventDate(Date beginEventDate) {
        this.beginEventDate = beginEventDate;
    }
}
