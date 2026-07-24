package com.pat.controller.dto;

/**
 * One EPG channel overview for the TV programme browser modal
 * (now / next + optional full schedule when expanded).
 */
public class TvEpgBrowseChannelDto {

    private String channelId;
    private String name;
    private TvChannelDto channel;
    private TvEpgProgrammeDto now;
    private TvEpgProgrammeDto next;
    private int programmeCount;

    public TvEpgBrowseChannelDto() {
    }

    public TvEpgBrowseChannelDto(
            String channelId,
            String name,
            TvChannelDto channel,
            TvEpgProgrammeDto now,
            TvEpgProgrammeDto next,
            int programmeCount) {
        this.channelId = channelId;
        this.name = name;
        this.channel = channel;
        this.now = now;
        this.next = next;
        this.programmeCount = programmeCount;
    }

    public String getChannelId() {
        return channelId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public TvChannelDto getChannel() {
        return channel;
    }

    public void setChannel(TvChannelDto channel) {
        this.channel = channel;
    }

    public TvEpgProgrammeDto getNow() {
        return now;
    }

    public void setNow(TvEpgProgrammeDto now) {
        this.now = now;
    }

    public TvEpgProgrammeDto getNext() {
        return next;
    }

    public void setNext(TvEpgProgrammeDto next) {
        this.next = next;
    }

    public int getProgrammeCount() {
        return programmeCount;
    }

    public void setProgrammeCount(int programmeCount) {
        this.programmeCount = programmeCount;
    }
}
