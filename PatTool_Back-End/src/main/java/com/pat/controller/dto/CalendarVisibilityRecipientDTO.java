package com.pat.controller.dto;

/**
 * One person who would see a calendar appointment (owner or visibility rules).
 */
public class CalendarVisibilityRecipientDTO {

    private String memberId;
    private String displayName;
    /** Nom d’utilisateur PatTool (login), si renseigné. */
    private String userName;
    private boolean hasEmail;

    public CalendarVisibilityRecipientDTO() {
    }

    public CalendarVisibilityRecipientDTO(String memberId, String displayName, String userName, boolean hasEmail) {
        this.memberId = memberId;
        this.displayName = displayName;
        this.userName = userName;
        this.hasEmail = hasEmail;
    }

    public String getMemberId() {
        return memberId;
    }

    public void setMemberId(String memberId) {
        this.memberId = memberId;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public String getUserName() {
        return userName;
    }

    public void setUserName(String userName) {
        this.userName = userName;
    }

    public boolean isHasEmail() {
        return hasEmail;
    }

    public void setHasEmail(boolean hasEmail) {
        this.hasEmail = hasEmail;
    }
}
