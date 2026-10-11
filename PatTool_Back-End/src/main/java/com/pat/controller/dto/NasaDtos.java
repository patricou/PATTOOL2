package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

public final class NasaDtos {

    private NasaDtos() {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Apod(
            String date,
            String title,
            String explanation,
            String mediaType,
            String url,
            String hdUrl,
            String thumbnailUrl,
            String copyright
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EpicImage(
            String image,
            String caption,
            String date,
            String time,
            Double latitude,
            Double longitude
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Epic(
            String date,
            List<EpicImage> images
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MarsPhoto(
            long id,
            int sol,
            String earthDate,
            String camera,
            String cameraFullName,
            String rover,
            String imageUrl
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Mars(
            String rover,
            Integer sol,
            int page,
            boolean hasMore,
            List<MarsPhoto> photos
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Neo(
            String id,
            String name,
            String approachDate,
            boolean hazardous,
            Double diameterMinM,
            Double diameterMaxM,
            Double missKm,
            Double missLunar,
            Double velocityKmh,
            String jplUrl
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record NeoFeed(
            String startDate,
            String endDate,
            int count,
            List<Neo> objects
    ) {}

    public record ApiError(String code) {}
}
