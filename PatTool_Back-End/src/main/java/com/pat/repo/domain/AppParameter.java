package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * Generic key/value parameter store, shared across the whole PATTOOL
 * backend. One document per parameter, identified by {@link #paramKey}.
 *
 * Initial use case: persistence of the NewsAPI 24h request log
 * ({@code newsapi.requests.log}) so the counter survives backend restarts.
 *
 * Designed to grow. Typical upcoming candidates:
 *  - {@code newsapi.requests.log}         - JSON array of ISO-8601 timestamps
 *  - {@code ui.feature.flags}             - JSON map of feature toggles
 *  - {@code newsapi.last.error.code}      - last NewsAPI error, for diagnostics
 *  - {@code system.maintenance.message}   - banner string for all users
 *
 * {@link #valueType} is a hint for callers that want to deserialize
 * {@link #paramValue} consistently:
 *  - {@code STRING}   : plain text
 *  - {@code LONG}     : parseable as a long
 *  - {@code BOOLEAN}  : "true" / "false"
 *  - {@code JSON}     : arbitrary JSON (object or array)
 */
@Document(collection = "appParameters")
public class AppParameter {

    /** Well-known {@link #valueType} values. */
    public static final String TYPE_STRING = "STRING";
    public static final String TYPE_LONG = "LONG";
    public static final String TYPE_BOOLEAN = "BOOLEAN";
    public static final String TYPE_JSON = "JSON";

    @Id
    private String id;

    /** Unique business identifier, e.g. {@code newsapi.requests.log}. */
    @Indexed(unique = true)
    private String paramKey;

    /** Serialized value. JSON blob when {@link #valueType} is {@code JSON}. */
    private String paramValue;

    /** One of the {@code TYPE_*} constants. */
    private String valueType;

    /** Short human-readable description, helpful when browsing MongoDB. */
    private String description;

    private Date dateCreation;
    private Date dateModification;

    public AppParameter() {
        Date now = new Date();
        this.dateCreation = now;
        this.dateModification = now;
    }

    public AppParameter(String paramKey, String paramValue, String valueType, String description) {
        this();
        this.paramKey = paramKey;
        this.paramValue = paramValue;
        this.valueType = valueType;
        this.description = description;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getParamKey() { return paramKey; }
    public void setParamKey(String paramKey) { this.paramKey = paramKey; }

    public String getParamValue() { return paramValue; }
    public void setParamValue(String paramValue) {
        this.paramValue = paramValue;
        this.dateModification = new Date();
    }

    public String getValueType() { return valueType; }
    public void setValueType(String valueType) { this.valueType = valueType; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public Date getDateCreation() { return dateCreation; }
    public void setDateCreation(Date dateCreation) { this.dateCreation = dateCreation; }

    public Date getDateModification() { return dateModification; }
    public void setDateModification(Date dateModification) { this.dateModification = dateModification; }

    @Override
    public String toString() {
        return "AppParameter{" +
                "paramKey='" + paramKey + '\'' +
                ", valueType='" + valueType + '\'' +
                ", paramValue='" + (paramValue != null && paramValue.length() > 80
                                    ? paramValue.substring(0, 80) + "..." : paramValue) + '\'' +
                '}';
    }
}
