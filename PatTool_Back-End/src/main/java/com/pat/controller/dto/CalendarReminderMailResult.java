package com.pat.controller.dto;

/**
 * Result of sending calendar reminder e-mails (scheduled digest or manual send from UI).
 */
public class CalendarReminderMailResult {

    private int emailsSent;
    private int skippedNoEmail;

    public CalendarReminderMailResult() {
    }

    public CalendarReminderMailResult(int emailsSent, int skippedNoEmail) {
        this.emailsSent = emailsSent;
        this.skippedNoEmail = skippedNoEmail;
    }

    public int getEmailsSent() {
        return emailsSent;
    }

    public void setEmailsSent(int emailsSent) {
        this.emailsSent = emailsSent;
    }

    public int getSkippedNoEmail() {
        return skippedNoEmail;
    }

    public void setSkippedNoEmail(int skippedNoEmail) {
        this.skippedNoEmail = skippedNoEmail;
    }
}
