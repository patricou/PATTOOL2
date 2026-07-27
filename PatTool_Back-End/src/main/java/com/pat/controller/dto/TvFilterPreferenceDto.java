package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Per-user TV Watcher global filter preferences (JSON in {@code appParameters}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class TvFilterPreferenceDto {

    /** When true, channel/program/country/group filters apply across all TV Watcher tabs. */
    private Boolean applyToAllTabs;
    private String channelQuery;
    private String programQuery;
    private String country;
    private String group;
    private Boolean persisted;

    public TvFilterPreferenceDto() {
    }

    public TvFilterPreferenceDto(
            Boolean applyToAllTabs,
            String channelQuery,
            String programQuery,
            String country,
            String group,
            Boolean persisted) {
        this.applyToAllTabs = applyToAllTabs;
        this.channelQuery = channelQuery;
        this.programQuery = programQuery;
        this.country = country;
        this.group = group;
        this.persisted = persisted;
    }

    public Boolean getApplyToAllTabs() {
        return applyToAllTabs;
    }

    public void setApplyToAllTabs(Boolean applyToAllTabs) {
        this.applyToAllTabs = applyToAllTabs;
    }

    public String getChannelQuery() {
        return channelQuery;
    }

    public void setChannelQuery(String channelQuery) {
        this.channelQuery = channelQuery;
    }

    public String getProgramQuery() {
        return programQuery;
    }

    public void setProgramQuery(String programQuery) {
        this.programQuery = programQuery;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }

    public String getGroup() {
        return group;
    }

    public void setGroup(String group) {
        this.group = group;
    }

    public Boolean getPersisted() {
        return persisted;
    }

    public void setPersisted(Boolean persisted) {
        this.persisted = persisted;
    }
}
