package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.web.client.RestTemplateBuilder;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class YoutubeInnertubeTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void searchParamsMatchYoutubeFilters() {
        assertEquals("EgIQAQ==", YoutubeInnertube.searchParams("video", ""));
        assertEquals("CAMSAhAB", YoutubeInnertube.searchParams("video", "viewCount"));
        assertEquals("CAISAhAB", YoutubeInnertube.searchParams("video", "date"));
    }

    @Test
    void parsesClockViewsAndRelativeDates() {
        assertEquals("PT2M36S", YoutubeInnertube.clockToIso("2:36"));
        assertEquals("PT1H2M3S", YoutubeInnertube.clockToIso("1:02:03"));
        assertEquals(88_914_733L, YoutubeInnertube.views("88\u202f914\u202f733 vues"));
        assertEquals(1_200_000L, YoutubeInnertube.views("1,2 M de vues"));
        Instant now = Instant.parse("2026-10-24T12:00:00Z");
        assertEquals("2025-12-24T12:00:00Z", YoutubeInnertube.relativeToIso("il y a 10 mois", now));
        assertEquals("2026-10-24T09:00:00Z", YoutubeInnertube.relativeToIso("3 hours ago", now));
    }

    @Test
    void readsVideoRenderer() throws Exception {
        String json = """
                {"contents":{"videoRenderer":{
                  "videoId":"jodJzaVZfj8",
                  "title":{"runs":[{"text":"Mauvais djo - Pilé"}]},
                  "ownerText":{"runs":[{"text":"Mauvais djo","navigationEndpoint":{"browseEndpoint":{"browseId":"UCJ2deOSM_0syVxf_HO4HR7g"}}}]},
                  "publishedTimeText":{"simpleText":"il y a 10 mois"},
                  "lengthText":{"simpleText":"2:36"},
                  "viewCountText":{"simpleText":"88 914 733 vues"},
                  "descriptionSnippet":{"runs":[{"text":"Clip officiel"}]}
                },"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"NEXT"}}}}}
                """;
        List<YoutubeItemDto> items = YoutubeInnertube.items(mapper.readTree(json), "video", 5);
        assertEquals(1, items.size());
        YoutubeItemDto item = items.get(0);
        assertEquals("jodJzaVZfj8", item.id());
        assertEquals("video", item.kind());
        assertEquals("Mauvais djo - Pilé", item.title());
        assertEquals("Mauvais djo", item.channelTitle());
        assertEquals("UCJ2deOSM_0syVxf_HO4HR7g", item.channelId());
        assertEquals("PT2M36S", item.duration());
        assertEquals(88_914_733L, item.viewCount());
        assertTrue(item.thumbnailUrl().startsWith("external/youtube/image?u="));
        assertEquals("NEXT", YoutubeInnertube.continuation(mapper.readTree(json)));
        assertNull(YoutubeInnertube.clockToIso("live"));
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "YOUTUBE_LIVE", matches = "true")
    void publicSearchWorksWhenDataApiKeyIsRejected() {
        YoutubeProxyService service = new YoutubeProxyService(
                new RestTemplateBuilder(),
                new ObjectMapper(),
                "https://www.googleapis.com/youtube/v3",
                "invalid-key");
        YoutubeSearchPageDto page = service.search(
                "Mauvais djo Pile", "video", "FR", "fr", null, null, 5, null, null);
        assertNull(page.error());
        assertFalse(page.items().isEmpty());
        assertEquals("video", page.items().get(0).kind());
        assertTrue(page.items().get(0).id().matches("[A-Za-z0-9_-]{11}"));
    }
}
