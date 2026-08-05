package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-user Archive.org audio playlist, stored as JSON in {@code appParameters}.
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
