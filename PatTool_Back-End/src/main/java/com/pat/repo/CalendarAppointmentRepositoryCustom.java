package com.pat.repo;

import com.pat.repo.domain.CalendarAppointment;

import java.util.Date;
import java.util.List;

public interface CalendarAppointmentRepositoryCustom {

    /**
     * Appointments overlapping [rangeStart, rangeEnd] that the user may see (owner, public, friends, friend groups).
     * When {@code userId} is null, only {@code visibility == "public"} entries are returned.
     */
    List<CalendarAppointment> findAccessibleOverlappingRange(Date rangeStart, Date rangeEnd, String userId);

    /**
     * All appointments whose time range intersects [{@code rangeStart}, {@code rangeEnd}] (inclusive intent:
     * {@code startDate} &le; {@code rangeEnd} and {@code endDate} &ge; {@code rangeStart}).
     * Used by scheduled jobs (e.g. morning reminder); not filtered by visibility.
     */
    List<CalendarAppointment> findAllOverlappingRange(Date rangeStart, Date rangeEnd);
}
