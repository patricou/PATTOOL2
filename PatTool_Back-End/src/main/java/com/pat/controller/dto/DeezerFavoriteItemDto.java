package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One Deezer favorite. Only the object matching {@code kind} is stored.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class DeezerFavoriteItemDto {

    private String kind;
    private DeezerTrackDto track;
    private DeezerAlbumDto album;
    private DeezerArtistDto artist;
    private DeezerPlaylistDto playlist;

    public String getKind() {
        return kind;
    }

    public void setKind(String kind) {
        this.kind = kind;
    }

    public DeezerTrackDto getTrack() {
        return track;
    }

    public void setTrack(DeezerTrackDto track) {
        this.track = track;
    }

    public DeezerAlbumDto getAlbum() {
        return album;
    }

    public void setAlbum(DeezerAlbumDto album) {
        this.album = album;
    }

    public DeezerArtistDto getArtist() {
        return artist;
    }

    public void setArtist(DeezerArtistDto artist) {
        this.artist = artist;
    }

    public DeezerPlaylistDto getPlaylist() {
        return playlist;
    }

    public void setPlaylist(DeezerPlaylistDto playlist) {
        this.playlist = playlist;
    }
}
