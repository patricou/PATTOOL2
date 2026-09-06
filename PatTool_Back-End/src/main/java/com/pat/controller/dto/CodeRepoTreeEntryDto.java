package com.pat.controller.dto;

public class CodeRepoTreeEntryDto {

    private String name;
    private String path;
    /** dir or file */
    private String type;
    private int size;

    public CodeRepoTreeEntryDto() {
    }

    public CodeRepoTreeEntryDto(String name, String path, String type, int size) {
        this.name = name;
        this.path = path;
        this.type = type;
        this.size = size;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public int getSize() {
        return size;
    }

    public void setSize(int size) {
        this.size = size;
    }
}
