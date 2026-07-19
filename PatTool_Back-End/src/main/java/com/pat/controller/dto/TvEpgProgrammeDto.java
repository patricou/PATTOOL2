package com.pat.controller.dto;

/**
 * One EPG programme entry (now or next).
 */
public class TvEpgProgrammeDto {

    private String title;
    private String description;
    private String start;
    private String stop;

    public TvEpgProgrammeDto() {
    }

    public TvEpgProgrammeDto(String title, String description, String start, String stop) {
        this.title = title;
        this.description = description;
        this.start = start;
        this.stop = stop;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getStart() {
        return start;
    }

    public void setStart(String start) {
        this.start = start;
    }

    public String getStop() {
        return stop;
    }

    public void setStop(String stop) {
        this.stop = stop;
    }
}
