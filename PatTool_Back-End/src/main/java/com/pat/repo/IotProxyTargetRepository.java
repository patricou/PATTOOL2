package com.pat.repo;

import com.pat.repo.domain.IotProxyTarget;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface IotProxyTargetRepository extends MongoRepository<IotProxyTarget, String> {

    Optional<IotProxyTarget> findByPublicSlug(String publicSlug);

    List<IotProxyTarget> findByOwnerOrderByCreationDateDesc(String owner);
}
