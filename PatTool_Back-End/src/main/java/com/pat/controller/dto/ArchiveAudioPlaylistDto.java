package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Legacy per-user Archive.org audio playlist JSON blob in {@code appParameters}.
 * Kept for one-shot migration into {@code archive_audio_collections}.
 */
public class ArchiveAudioPlaylistDto {

    private List<ArchiveItemDto> items = new ArrayList<>();

    public ArchiveAudioPlaylistDto() {
    }

    public ArchiveAudioPlaylistDto(List<ArchiveItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }

    public List<ArchiveItemDto> getItems() {
        return items;
    }

    public void setItems(List<ArchiveItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }
}
