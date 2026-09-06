package com.pat.controller.dto;

public class CodeRepoFileDto {

    private String path;
    private String language;
    private String content;
    private int size;

    public CodeRepoFileDto() {
    }

    public CodeRepoFileDto(String path, String language, String content, int size) {
        this.path = path;
        this.language = language;
        this.content = content;
        this.size = size;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getLanguage() {
        return language;
    }

    public void setLanguage(String language) {
        this.language = language;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public int getSize() {
        return size;
    }

    public void setSize(int size) {
        this.size = size;
    }
}
