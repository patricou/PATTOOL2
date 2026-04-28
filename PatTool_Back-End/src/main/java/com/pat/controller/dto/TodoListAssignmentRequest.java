package com.pat.controller.dto;

/**
 * Body for {@code PATCH /api/todolists/{id}/assignment}: link a list to at most one calendar
 * appointment or one activity ({@link com.pat.repo.domain.Evenement}), never both.
 */
public class TodoListAssignmentRequest {

    private String calendarAppointmentId;

    private String evenementId;

    public String getCalendarAppointmentId() {
        return calendarAppointmentId;
    }

    public void setCalendarAppointmentId(String calendarAppointmentId) {
        this.calendarAppointmentId = calendarAppointmentId;
    }

    public String getEvenementId() {
        return evenementId;
    }

    public void setEvenementId(String evenementId) {
        this.evenementId = evenementId;
    }
}
