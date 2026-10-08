package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Mezzo on otcnet publishes a ~20 s media playlist. Starting at the oldest
 * segment 404s before the proxy can deliver it.
 */
class TvStreamProxyMezzoPlaylistTest {

    private static final String MEDIA = """
            #EXTM3U
            #EXT-X-TARGETDURATION:5
            #EXT-X-VERSION:3
            #EXT-X-MEDIA-SEQUENCE:445731
            #EXT-X-PROGRAM-DATE-TIME:2026-10-05T18:38:20.017Z
            #EXTINF:5.000,
            2026/10/05/18/38/20-05000.ts
            #EXTINF:5.000,
            2026/10/05/18/38/25-05000.ts
            #EXTINF:5.000,
            2026/10/05/18/38/30-05000.ts
            #EXTINF:5.000,
            2026/10/05/18/38/35-05000.ts
            """;

    @Test
    void keepsTheTwoNewestSegmentsAndAdvancesSequence() {
        String trimmed = TvStreamProxyService.keepNewestLiveSegments(MEDIA, 2);
        assertTrue(trimmed.contains("#EXT-X-MEDIA-SEQUENCE:445733"));
        assertFalse(trimmed.contains("18/38/20-05000.ts"));
        assertFalse(trimmed.contains("18/38/25-05000.ts"));
        assertTrue(trimmed.contains("18/38/30-05000.ts"));
        assertTrue(trimmed.contains("18/38/35-05000.ts"));
        assertFalse(trimmed.contains("PROGRAM-DATE-TIME"));
        assertTrue(trimmed.contains("#EXT-X-TARGETDURATION:5"));
    }

    @Test
    void leavesMasterPlaylistsUntouched() {
        String master = """
                #EXTM3U
                #EXT-X-STREAM-INF:BANDWIDTH=6550000
                tracks-v1a1/mono.ts.m3u8
                """;
        assertEquals(master, TvStreamProxyService.keepNewestLiveSegments(master, 2));
    }

    @Test
    void detectsM6ShortWindowMirrorOnly() {
        assertTrue(TvStreamProxyService.isM6ShortWindowUpstream(
                "http://151.80.18.177:86/M6_HD/tracks-v1a1/mono.m3u8"));
        assertTrue(TvStreamProxyService.isM6ShortWindowUpstream(
                "http://151.80.18.177:86/W9_HD/index.m3u8"));
        assertTrue(TvStreamProxyService.isShortWindowTrimUpstream(
                "http://151.80.18.177:86/M6_HD/tracks-v1a1/2026/10/08/17/50/01-06000.ts"));
        assertFalse(TvStreamProxyService.isM6ShortWindowUpstream(
                "http://151.80.18.177:86/TF1_HD/index.m3u8"));
        assertFalse(TvStreamProxyService.isM6ShortWindowUpstream(
                "http://145.239.5.177/319/index.m3u8"));
        assertFalse(TvStreamProxyService.isShortWindowTrimUpstream(
                "http://145.239.5.177/359a/index.m3u8"));
    }

    @Test
    void detectsOtcnetMezzoOnly() {
        assertTrue(TvStreamProxyService.isMezzoOtcnetUpstream(
                "https://live-3.otcnet.ru/Mezzo/tracks-v1a1/mono.ts.m3u8"));
        assertFalse(TvStreamProxyService.isMezzoOtcnetUpstream(
                "http://stream.mcquack.net/276/index.m3u8"));
        assertFalse(TvStreamProxyService.isMezzoOtcnetUpstream(
                "http://str2.iptvhd.ru:8080/Mezzo_HD/index.m3u8"));
    }
}
