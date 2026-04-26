package com.pat.repo;

import com.pat.repo.domain.TodoList;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface TodoListRepository extends MongoRepository<TodoList, String>,
        TodoListRepositoryCustom {

    List<TodoList> findByOwnerMemberIdOrderByCreatedAtDesc(String ownerMemberId);

    Optional<TodoList> findByIdAndOwnerMemberId(String id, String ownerMemberId);
}
