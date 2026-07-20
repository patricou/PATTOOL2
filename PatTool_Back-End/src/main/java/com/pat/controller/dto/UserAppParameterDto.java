package com.pat.controller.dto;

import java.util.Date;

/**
 * One {@code appParameters} row owned by the current user
 * (key ends with {@code .<JWT sub>} or {@code .<preferred_username>}).
 */
public class UserAppParameterDto {

    private String paramKey;
    /** Key without the owner suffix, for display. */
    private String featureKey;
    private String paramValue;
    private String valueType;
    private String description;
    private Date dateModification;
    /** Suffix that matched ({@code sub} or {@code preferred_username}). */
    private String ownerKey;

    public UserAppParameterDto() {
    }

    public UserAppParameterDto(
            String paramKey,
            String featureKey,
            String paramValue,
            String valueType,
            String description,
            Date dateModification) {
        this(paramKey, featureKey, paramValue, valueType, description, dateModification, null);
    }

    public UserAppParameterDto(
            String paramKey,
            String featureKey,
            String paramValue,
            String valueType,
            String description,
            Date dateModification,
            String ownerKey) {
        this.paramKey = paramKey;
        this.featureKey = featureKey;
        this.paramValue = paramValue;
        this.valueType = valueType;
        this.description = description;
        this.dateModification = dateModification;
        this.ownerKey = ownerKey;
    }

    public String getParamKey() {
        return paramKey;
    }

    public void setParamKey(String paramKey) {
        this.paramKey = paramKey;
    }

    public String getFeatureKey() {
        return featureKey;
    }

    public void setFeatureKey(String featureKey) {
        this.featureKey = featureKey;
    }

    public String getParamValue() {
        return paramValue;
    }

    public void setParamValue(String paramValue) {
        this.paramValue = paramValue;
    }

    public String getValueType() {
        return valueType;
    }

    public void setValueType(String valueType) {
        this.valueType = valueType;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public Date getDateModification() {
        return dateModification;
    }

    public void setDateModification(Date dateModification) {
        this.dateModification = dateModification;
    }

    public String getOwnerKey() {
        return ownerKey;
    }

    public void setOwnerKey(String ownerKey) {
        this.ownerKey = ownerKey;
    }
}
