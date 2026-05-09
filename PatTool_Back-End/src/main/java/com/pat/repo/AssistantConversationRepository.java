package com.pat.repo;

import com.pat.repo.domain.AssistantConversation;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface AssistantConversationRepository extends MongoRepository<AssistantConversation, String> {

    List<AssistantConversation> findTop100ByOwnerSubjectOrderByUpdatedAtDesc(String ownerSubject);

    /** Vue administrateur : dernières conversations mises à jour (tous utilisateurs). */
    List<AssistantConversation> findTop100ByOrderByUpdatedAtDesc();
}
