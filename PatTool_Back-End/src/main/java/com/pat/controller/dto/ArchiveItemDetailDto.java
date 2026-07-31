package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Full Internet Archive item: metadata + files + best playable URL.
 */
public class ArchiveItemDetailDto extends ArchiveItemDto {

    private String runtime;
    private String publisher;
    private String licenseUrl;
    private Long itemSize;
    private boolean dark;
    private String playUrl;
    private String playKind;
    private List<String> collections = new ArrayList<>();
    private List<String> subjects = new ArrayList<>();
    private List<ArchiveFileDto> files = new ArrayList<>();

    public ArchiveItemDetailDto() {
    }

    public String getRuntime() {
        return runtime;
    }

    public void setRuntime(String runtime) {
        this.runtime = runtime;
    }

    public String getPublisher() {
        return publisher;
    }

    public void setPublisher(String publisher) {
        this.publisher = publisher;
    }

    public String getLicenseUrl() {
        return licenseUrl;
    }

    public void setLicenseUrl(String licenseUrl) {
        this.licenseUrl = licenseUrl;
    }

    public Long getItemSize() {
        return itemSize;
    }

    public void setItemSize(Long itemSize) {
        this.itemSize = itemSize;
    }

    public boolean isDark() {
        return dark;
    }

    public void setDark(boolean dark) {
        this.dark = dark;
    }

    public String getPlayUrl() {
        return playUrl;
    }

    public void setPlayUrl(String playUrl) {
        this.playUrl = playUrl;
    }

    public String getPlayKind() {
        return playKind;
    }

    public void setPlayKind(String playKind) {
        this.playKind = playKind;
    }

    public List<String> getCollections() {
        return collections;
    }

    public void setCollections(List<String> collections) {
        this.collections = collections != null ? collections : new ArrayList<>();
    }

    public List<String> getSubjects() {
        return subjects;
    }

    public void setSubjects(List<String> subjects) {
        this.subjects = subjects != null ? subjects : new ArrayList<>();
    }

    public List<ArchiveFileDto> getFiles() {
        return files;
    }

    public void setFiles(List<ArchiveFileDto> files) {
        this.files = files != null ? files : new ArrayList<>();
    }
}
