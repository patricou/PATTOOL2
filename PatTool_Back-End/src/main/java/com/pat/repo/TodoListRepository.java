package com.pat.repo;

import com.pat.repo.domain.TodoList;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface TodoListRepository extends MongoRepository<TodoList, String>,
        TodoListRepositoryCustom {

    List<TodoList> findByOwnerMemberIdOrderByCreatedAtDesc(String ownerMemberId);

    Optional<TodoList> findByIdAndOwnerMemberId(String id, String ownerMemberId);

    Optional<TodoList> findFirstByCalendarAppointmentId(String calendarAppointmentId);

    Optional<TodoList> findFirstByEvenementId(String evenementId);

    List<TodoList> findByCalendarAppointmentIdIn(Collection<String> calendarAppointmentIds);

    List<TodoList> findByEvenementIdIn(Collection<String> evenementIds);
}
