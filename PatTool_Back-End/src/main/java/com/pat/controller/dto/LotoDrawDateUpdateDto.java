package com.pat.controller.dto;

import java.time.LocalDate;

/**
 * Corps {@code PATCH /api/loto/draws} : identifiant du document Mongo (= URL détail) + nouvelle date de tirage.
 */
public class LotoDrawDateUpdateDto {

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
