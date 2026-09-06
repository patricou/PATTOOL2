package com.pat.repo.domain;

/**
 * One chat turn stored with a {@link CodeProject}.
 */
public class CodeChatTurn {

    /** {@code user} or {@code assistant}. */
    private String role;

    private String content;

    public String getRole() {
        return role;
    }

    public void setRole(String role) {
        this.role = role;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }
}
