package com.pat.controller.dto;

/** Artist and album pages for one Deezer selection. Either side may be absent. */
public record AudioDbDossierDto(
        AudioDbArtistDto artist,
        AudioDbAlbumDto album
) {
}
