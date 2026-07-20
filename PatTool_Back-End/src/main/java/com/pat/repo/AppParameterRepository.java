package com.pat.repo;

import com.pat.repo.domain.AppParameter;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * MongoDB repository for {@link AppParameter}, PATTOOL's generic
 * parameter/configuration store. Lookup by {@code paramKey}.
 */
@Repository
public interface AppParameterRepository extends MongoRepository<AppParameter, String> {

    /**
     * All documents for a business key. Prefer {@link AppParameterService#find(String)}
     * which collapses duplicates; use this when healing non-unique rows.
     */
    List<AppParameter> findAllByParamKey(String paramKey);

    /** Quickly test whether a key exists (without loading the value). */
    boolean existsByParamKey(String paramKey);

    /** All parameters whose key starts with the given prefix (e.g. per-user alert configs). */
    List<AppParameter> findByParamKeyStartingWith(String prefix);

    /** All parameters whose key ends with the given suffix (e.g. {@code .<JWT sub>}). */
    List<AppParameter> findByParamKeyEndingWith(String suffix);
}
