package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Unified book / audiobook entry from Open Library, Project Gutenberg (Gutendex) or LibriVox.
 */
public class BookItemDto {

    private String id;
    /** openlibrary | gutenberg | librivox */
    private String source;
    private String title;
    private String authors;
    private String coverUrl;
    private Integer year;
    private String language;
    private String description;
    private String subjects;
    /** External catalogue / borrow page. */
    private String homepage;
    /** Preferred plain-text URL (proxyable). */
    private String textUrl;
    /** Preferred HTML URL (proxyable or iframe). */
    private String htmlUrl;
    /** EPUB download URL when available. */
    private String epubUrl;
    private boolean hasFulltext;
    /** Internet Archive identifier (Open Library). */
    private String iaId;
    private String totalTime;
    private Integer totalTimeSecs;
    private List<BookSectionDto> sections = new ArrayList<>();

    public BookItemDto() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getAuthors() {
        return authors;
    }

    public void setAuthors(String authors) {
        this.authors = authors;
    }

    public String getCoverUrl() {
        return coverUrl;
    }

    public void setCoverUrl(String coverUrl) {
        this.coverUrl = coverUrl;
    }

    public Integer getYear() {
        return year;
    }

    public void setYear(Integer year) {
        this.year = year;
    }

    public String getLanguage() {
        return language;
    }

    public void setLanguage(String language) {
        this.language = language;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getSubjects() {
        return subjects;
    }

    public void setSubjects(String subjects) {
        this.subjects = subjects;
    }

    public String getHomepage() {
        return homepage;
    }

    public void setHomepage(String homepage) {
        this.homepage = homepage;
    }

    public String getTextUrl() {
        return textUrl;
    }

    public void setTextUrl(String textUrl) {
        this.textUrl = textUrl;
    }

    public String getHtmlUrl() {
        return htmlUrl;
    }

    public void setHtmlUrl(String htmlUrl) {
        this.htmlUrl = htmlUrl;
    }

    public String getEpubUrl() {
        return epubUrl;
    }

    public void setEpubUrl(String epubUrl) {
        this.epubUrl = epubUrl;
    }

    public boolean isHasFulltext() {
        return hasFulltext;
    }

    public void setHasFulltext(boolean hasFulltext) {
        this.hasFulltext = hasFulltext;
    }

    public String getIaId() {
        return iaId;
    }

    public void setIaId(String iaId) {
        this.iaId = iaId;
    }

    public String getTotalTime() {
        return totalTime;
    }

    public void setTotalTime(String totalTime) {
        this.totalTime = totalTime;
    }

    public Integer getTotalTimeSecs() {
        return totalTimeSecs;
    }

    public void setTotalTimeSecs(Integer totalTimeSecs) {
        this.totalTimeSecs = totalTimeSecs;
    }

    public List<BookSectionDto> getSections() {
        return sections;
    }

    public void setSections(List<BookSectionDto> sections) {
        this.sections = sections != null ? sections : new ArrayList<>();
    }
}
