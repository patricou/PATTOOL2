package com.pat.controller.dto;

/**
 * Switches of the Deezer page, stored per user.
 * Style is kept separately: it is the cabinet skin shared with TV and radio.
 */
public class DeezerPageSwitches {

    /** Sound only, no picture. */
    private boolean audioOnly;
    /** Keep playing when leaving the page. */
    private boolean keepAlive;
    /** Scrolling title band. */
    private boolean ticker;
    /** Cover on the cabinet screen. */
    private boolean sleeve = true;
    /** Look up a YouTube clip for each title. */
    private boolean youtubeSearch;
    /** Repeat the list. */
    private boolean listLoop = true;
    /** Repeat the clips of one title. */
    private boolean youtubeListLoop = true;

    public boolean isAudioOnly() {
        return audioOnly;
    }

    public void setAudioOnly(boolean audioOnly) {
        this.audioOnly = audioOnly;
    }

    public boolean isKeepAlive() {
        return keepAlive;
    }

    public void setKeepAlive(boolean keepAlive) {
        this.keepAlive = keepAlive;
    }

    public boolean isTicker() {
        return ticker;
    }

    public void setTicker(boolean ticker) {
        this.ticker = ticker;
    }

    public boolean isSleeve() {
        return sleeve;
    }

    public void setSleeve(boolean sleeve) {
        this.sleeve = sleeve;
    }

    public boolean isYoutubeSearch() {
        return youtubeSearch;
    }

    public void setYoutubeSearch(boolean youtubeSearch) {
        this.youtubeSearch = youtubeSearch;
    }

    public boolean isListLoop() {
        return listLoop;
    }

    public void setListLoop(boolean listLoop) {
        this.listLoop = listLoop;
    }

    public boolean isYoutubeListLoop() {
        return youtubeListLoop;
    }

    public void setYoutubeListLoop(boolean youtubeListLoop) {
        this.youtubeListLoop = youtubeListLoop;
    }
}
