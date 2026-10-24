package com.pat.service;

import com.pat.controller.dto.DeezerYoutubeLookupRequest;
import com.pat.controller.dto.DeezerYoutubeLookupResponse;
import com.pat.controller.dto.YoutubeItemDto;
import com.pat.controller.dto.YoutubeSearchPageDto;
import com.pat.repo.DeezerYoutubeLinkRepository;
import com.pat.repo.domain.DeezerYoutubeLink;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DeezerYoutubeLinkServiceTest {

    @Mock
    private DeezerYoutubeLinkRepository repository;

    @Mock
    private YoutubeProxyService youtubeProxyService;

    @Test
    void prefersVideoWhoseTitleContainsTheTrackTitle() {
        List<YoutubeItemDto> items = List.of(
                video("aaaaaaaaaaa", "Interview"),
                video("bbbbbbbbbbb", "Hélène Ségara - Et si tu n'existais pas")
        );
        assertEquals("bbbbbbbbbbb", DeezerYoutubeLinkService.pickVideoId(items, "Et si tu n'existais pas"));
    }

    @Test
    void storedHitSkipsYoutube() {
        DeezerYoutubeLink stored = hit(3135556L, "Daft Punk Get Lucky", "ccccccccccc");
        when(repository.findById("3135556")).thenReturn(Optional.of(stored));
        DeezerYoutubeLinkService service = new DeezerYoutubeLinkService(repository, youtubeProxyService);

        DeezerYoutubeLookupResponse response = service.resolve(List.of(
                new DeezerYoutubeLookupRequest.Track(3135556L, "Daft Punk", "Get Lucky")
        ), false);

        assertEquals(1, response.links().size());
        assertEquals("ccccccccccc", response.links().get(0).videoId());
        assertTrue(response.links().get(0).cached());
        verifyNoInteractions(youtubeProxyService);
        verify(repository, never()).save(any());
    }

    @Test
    void disabledSearchReadsCacheAndSkipsYoutube() {
        when(repository.findById("9")).thenReturn(Optional.empty());
        DeezerYoutubeLinkService service = new DeezerYoutubeLinkService(repository, youtubeProxyService);

        DeezerYoutubeLookupResponse response = service.resolve(List.of(
                new DeezerYoutubeLookupRequest.Track(9L, "Daft Punk", "Within")
        ), false);

        assertTrue(response.links().isEmpty());
        verifyNoInteractions(youtubeProxyService);
        verify(repository, never()).save(any());
    }

    @Test
    void missIsSearchedOnceAndStored() {
        when(repository.findById("9")).thenReturn(Optional.empty());
        when(youtubeProxyService.isConfigured()).thenReturn(true);
        when(youtubeProxyService.search(eq("Daft Punk Within"), eq("video"), isNull(), isNull(), isNull(), isNull(), eq(5), isNull(), isNull()))
                .thenReturn(new YoutubeSearchPageDto(
                        true, null, null, "search", "Daft Punk Within", "video", "", null, null, 1,
                        List.of(video("ddddddddddd", "Within"))
                ));
        DeezerYoutubeLinkService service = new DeezerYoutubeLinkService(repository, youtubeProxyService);

        DeezerYoutubeLookupResponse response = service.resolve(List.of(
                new DeezerYoutubeLookupRequest.Track(9L, "Daft Punk", "Within")
        ), true);

        assertEquals("ddddddddddd", response.links().get(0).videoId());
        assertFalse(response.links().get(0).cached());
        ArgumentCaptor<DeezerYoutubeLink> saved = ArgumentCaptor.forClass(DeezerYoutubeLink.class);
        verify(repository).save(saved.capture());
        assertEquals(9L, saved.getValue().getTrackId());
        assertEquals("ddddddddddd", saved.getValue().getVideoId());
        assertEquals("Daft Punk Within", saved.getValue().getQuery());
    }

    @Test
    void upstreamErrorIsNotCached() {
        when(repository.findById("9")).thenReturn(Optional.empty());
        when(youtubeProxyService.isConfigured()).thenReturn(true);
        when(youtubeProxyService.search(eq("Daft Punk Within"), eq("video"), isNull(), isNull(), isNull(), isNull(), eq(5), isNull(), isNull()))
                .thenReturn(YoutubeSearchPageDto.failure("quota_exceeded", "quota"));
        DeezerYoutubeLinkService service = new DeezerYoutubeLinkService(repository, youtubeProxyService);

        DeezerYoutubeLookupResponse response = service.resolve(List.of(
                new DeezerYoutubeLookupRequest.Track(9L, "Daft Punk", "Within")
        ), true);

        assertTrue(response.links().isEmpty());
        verify(repository, never()).save(any());
    }

    @Test
    void oldMissIsSearchedAgain() {
        DeezerYoutubeLink stored = hit(9L, "Daft Punk Within", "");
        stored.setUpdatedAt(Instant.now().minus(8, ChronoUnit.DAYS));
        when(repository.findById("9")).thenReturn(Optional.of(stored));
        when(youtubeProxyService.isConfigured()).thenReturn(true);
        when(youtubeProxyService.search(eq("Daft Punk Within"), eq("video"), isNull(), isNull(), isNull(), isNull(), eq(5), isNull(), isNull()))
                .thenReturn(new YoutubeSearchPageDto(
                        true, null, null, "search", "Daft Punk Within", "video", "", null, null, 0, List.of()
                ));
        DeezerYoutubeLinkService service = new DeezerYoutubeLinkService(repository, youtubeProxyService);

        DeezerYoutubeLookupResponse response = service.resolve(List.of(
                new DeezerYoutubeLookupRequest.Track(9L, "Daft Punk", "Within")
        ), true);

        assertEquals("", response.links().get(0).videoId());
        assertFalse(response.links().get(0).cached());
        verify(repository).save(any());
    }

    private static DeezerYoutubeLink hit(long id, String query, String videoId) {
        DeezerYoutubeLink link = new DeezerYoutubeLink();
        link.setId(Long.toString(id));
        link.setTrackId(id);
        link.setQuery(query);
        link.setVideoId(videoId);
        link.setUpdatedAt(Instant.now());
        return link;
    }

    private static YoutubeItemDto video(String id, String title) {
        return new YoutubeItemDto(id, "video", title, "", "", "", "", "", null, null, "");
    }
}
