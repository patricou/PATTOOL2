package com.pat.controller.dto;

/**
 * LibriVox chapter / section.
 */
public class BookSectionDto {

    private String id;
    private String title;
    private Integer sectionNumber;
    private String listenUrl;
    private Integer durationSecs;
    private String readers;

    public BookSectionDto() {
    }

    public BookSectionDto(String id, String title, Integer sectionNumber, String listenUrl,
                          Integer durationSecs, String readers) {
        this.id = id;
        this.title = title;
        this.sectionNumber = sectionNumber;
        this.listenUrl = listenUrl;
        this.durationSecs = durationSecs;
        this.readers = readers;
    }

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

    public Integer getSectionNumber() {
        return sectionNumber;
    }

    public void setSectionNumber(Integer sectionNumber) {
        this.sectionNumber = sectionNumber;
    }

    public String getListenUrl() {
        return listenUrl;
    }

    public void setListenUrl(String listenUrl) {
        this.listenUrl = listenUrl;
    }

    public Integer getDurationSecs() {
        return durationSecs;
    }

    public void setDurationSecs(Integer durationSecs) {
        this.durationSecs = durationSecs;
    }

    public String getReaders() {
        return readers;
    }

    public void setReaders(String readers) {
        this.readers = readers;
    }
}
