package com.pat.controller.dto;

/** One page of a Deezer list. {@code index} is the first item, 0 then 100, 200… */
public record DeezerSliceDto(int index, int total, boolean hasNext) {
}
