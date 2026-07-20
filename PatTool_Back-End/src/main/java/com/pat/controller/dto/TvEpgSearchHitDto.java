package com.pat.controller.dto;

/**
 * One EPG programme match from {@code GET /epg/search}.
 */
public class TvEpgSearchHitDto {

    private String country;
    private String channelId;
    private TvEpgProgrammeDto programme;
    /** Catalog channel when resolved; may be null. */
    private TvChannelDto channel;

    public TvEpgSearchHitDto() {
    }

    public TvEpgSearchHitDto(
            String country,
            String channelId,
            TvEpgProgrammeDto programme,
            TvChannelDto channel) {
        this.country = country;
        this.channelId = channelId;
        this.programme = programme;
        this.channel = channel;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }

    public String getChannelId() {
        return channelId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public TvEpgProgrammeDto getProgramme() {
        return programme;
    }

    public void setProgramme(TvEpgProgrammeDto programme) {
        this.programme = programme;
    }

    public TvChannelDto getChannel() {
        return channel;
    }

    public void setChannel(TvChannelDto channel) {
        this.channel = channel;
    }
}
