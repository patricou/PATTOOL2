package com.pat.repo;

import com.pat.repo.domain.CalendarAppointment;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Date;
import java.util.List;
import java.util.Optional;

public interface CalendarAppointmentRepository extends MongoRepository<CalendarAppointment, String> {

    List<CalendarAppointment> findByOwnerMemberIdAndStartDateBeforeAndEndDateAfter(
            String ownerMemberId, Date rangeEndExclusive, Date rangeStartExclusive);

    Optional<CalendarAppointment> findByIdAndOwnerMemberId(String id, String ownerMemberId);
}
