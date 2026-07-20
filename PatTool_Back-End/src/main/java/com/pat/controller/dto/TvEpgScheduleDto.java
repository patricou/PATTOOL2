package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Full EPG schedule for one channel ({@code GET /epg/schedule}).
 */
public class TvEpgScheduleDto {

    private String channelId;
    private List<TvEpgProgrammeDto> programmes = new ArrayList<>();

    public TvEpgScheduleDto() {
    }

    public TvEpgScheduleDto(String channelId, List<TvEpgProgrammeDto> programmes) {
        this.channelId = channelId;
        this.programmes = programmes != null ? programmes : new ArrayList<>();
    }

    public String getChannelId() {
        return channelId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public List<TvEpgProgrammeDto> getProgrammes() {
        return programmes;
    }

    public void setProgrammes(List<TvEpgProgrammeDto> programmes) {
        this.programmes = programmes != null ? programmes : new ArrayList<>();
    }
}
