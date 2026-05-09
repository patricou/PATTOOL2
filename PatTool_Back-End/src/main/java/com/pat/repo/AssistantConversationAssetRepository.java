package com.pat.repo;

import com.pat.repo.domain.AssistantConversationAsset;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface AssistantConversationAssetRepository extends MongoRepository<AssistantConversationAsset, String> {}
