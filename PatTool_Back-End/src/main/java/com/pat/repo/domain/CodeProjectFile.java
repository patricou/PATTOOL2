package com.pat.repo.domain;

/**
 * One source file inside a {@link CodeProject}.
 */
public class CodeProjectFile {

    private String path;

    private String content;

    /** Hint for highlighting / AI (e.g. java, python, typescript). */
    private String language;

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public String getLanguage() {
        return language;
    }

    public void setLanguage(String language) {
        this.language = language;
    }
}
