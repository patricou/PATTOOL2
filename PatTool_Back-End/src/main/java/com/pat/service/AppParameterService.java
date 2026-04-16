package com.pat.service;

import com.pat.repo.AppParameterRepository;
import com.pat.repo.domain.AppParameter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Date;
import java.util.Optional;

/**
 * High-level accessor over {@link AppParameter}. Keeps callers from having
 * to deal with {@link AppParameterRepository} directly and normalizes
 * create-or-update, missing-value defaults and type coercion.
 *
 * All writes are persisted to MongoDB, so values survive backend restarts
 * (this is the whole point of moving to DB-backed storage).
 */
@Service
public class AppParameterService {

    private static final Logger log = LoggerFactory.getLogger(AppParameterService.class);

    @Autowired
    private AppParameterRepository repository;

    // ---------------------------------------------------------------------
    // Generic read
    // ---------------------------------------------------------------------

    public Optional<AppParameter> find(String paramKey) {
        if (paramKey == null) return Optional.empty();
        return repository.findByParamKey(paramKey);
    }

    /** Returns the raw string value, or {@code defaultValue} if the key is absent. */
    public String getString(String paramKey, String defaultValue) {
        return find(paramKey).map(AppParameter::getParamValue).orElse(defaultValue);
    }

    /** Returns a long value, or {@code defaultValue} if missing / unparseable. */
    public long getLong(String paramKey, long defaultValue) {
        return find(paramKey).map(p -> {
            try { return Long.parseLong(p.getParamValue()); }
            catch (NumberFormatException nfe) { return defaultValue; }
        }).orElse(defaultValue);
    }

    /** Returns a boolean value, or {@code defaultValue} if missing / unparseable. */
    public boolean getBoolean(String paramKey, boolean defaultValue) {
        return find(paramKey).map(p -> Boolean.parseBoolean(p.getParamValue()))
                .orElse(defaultValue);
    }

    // ---------------------------------------------------------------------
    // Generic write (create or update)
    // ---------------------------------------------------------------------

    /**
     * Create the row if missing, otherwise update {@code paramValue} and
     * touch {@code dateModification}. {@code valueType} / {@code description}
     * are only applied on creation (they describe the shape of the key,
     * not the latest value).
     */
    public AppParameter setValue(String paramKey, String paramValue, String valueType, String description) {
        Optional<AppParameter> existing = repository.findByParamKey(paramKey);
        AppParameter entity = existing.orElseGet(AppParameter::new);
        if (!existing.isPresent()) {
            entity.setParamKey(paramKey);
            entity.setValueType(valueType);
            entity.setDescription(description);
            log.info("Creating new AppParameter '{}' (type={})", paramKey, valueType);
        }
        entity.setParamValue(paramValue);
        entity.setDateModification(new Date());
        return repository.save(entity);
    }

    /** Convenience: string value, type defaulted to {@link AppParameter#TYPE_STRING}. */
    public AppParameter setString(String paramKey, String value, String description) {
        return setValue(paramKey, value, AppParameter.TYPE_STRING, description);
    }

    /** Convenience: long value stored as its decimal string representation. */
    public AppParameter setLong(String paramKey, long value, String description) {
        return setValue(paramKey, Long.toString(value), AppParameter.TYPE_LONG, description);
    }

    /** Convenience: boolean value stored as "true" / "false". */
    public AppParameter setBoolean(String paramKey, boolean value, String description) {
        return setValue(paramKey, Boolean.toString(value), AppParameter.TYPE_BOOLEAN, description);
    }

    /** Convenience: arbitrary JSON payload (caller is responsible for the serialization). */
    public AppParameter setJson(String paramKey, String jsonValue, String description) {
        return setValue(paramKey, jsonValue, AppParameter.TYPE_JSON, description);
    }

    public void delete(String paramKey) {
        repository.findByParamKey(paramKey).ifPresent(repository::delete);
    }
}
