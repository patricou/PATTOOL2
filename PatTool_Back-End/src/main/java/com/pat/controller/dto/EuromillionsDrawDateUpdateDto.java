package com.pat.controller.dto;

import java.time.LocalDate;

public class EuromillionsDrawDateUpdateDto {

    /** Code tirage FDJ (= id Mongo). */
    private String id;
    private LocalDate drawDate;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public LocalDate getDrawDate() {
        return drawDate;
    }

    public void setDrawDate(LocalDate drawDate) {
        this.drawDate = drawDate;
    }
}
