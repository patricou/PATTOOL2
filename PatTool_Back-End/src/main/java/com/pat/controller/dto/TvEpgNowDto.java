package com.pat.controller.dto;

/**
 * Now + next programme for a TV channel.
 */
public class TvEpgNowDto {

    private TvEpgProgrammeDto now;
    private TvEpgProgrammeDto next;

    public TvEpgNowDto() {
    }

    public TvEpgNowDto(TvEpgProgrammeDto now, TvEpgProgrammeDto next) {
        this.now = now;
        this.next = next;
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
}
