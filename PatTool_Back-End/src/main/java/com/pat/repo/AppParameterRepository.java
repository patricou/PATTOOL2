package com.pat.repo;

import com.pat.repo.domain.AppParameter;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

/**
 * MongoDB repository for {@link AppParameter}, PATTOOL's generic
 * parameter/configuration store. Lookup by {@code paramKey}.
 */
@Repository
public interface AppParameterRepository extends MongoRepository<AppParameter, String> {

    /** Retrieve a parameter by its business key (e.g. {@code newsapi.requests.log}). */
    Optional<AppParameter> findByParamKey(String paramKey);

    /** Quickly test whether a key exists (without loading the value). */
    boolean existsByParamKey(String paramKey);
}
