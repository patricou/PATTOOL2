package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Short live windows: trim only the slow M6/W9 mirror. Mezzo keeps its playlist
 * and is not pulled by the parallel prefetcher. Dailymotion DVR (Public Sénat) is trimmed.
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
    void keepsPerSegmentAesKeyWithTheNewestSegments() {
        String playlist = """
                #EXTM3U
                #EXT-X-VERSION:6
                #EXT-X-TARGETDURATION:7
                #EXT-X-MEDIA-SEQUENCE:100
                #EXT-X-DISCONTINUITY-SEQUENCE:2
                #EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x01
                #EXTINF:6.72,
                a.ts
                #EXT-X-DISCONTINUITY
                #EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x02
                #EXTINF:6.72,
                b.ts
                #EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x03
                #EXTINF:6.72,
                c.ts
                """;
        String trimmed = TvStreamProxyService.keepNewestLiveSegments(playlist, 2);
        assertTrue(trimmed.contains("#EXT-X-MEDIA-SEQUENCE:101"));
        // The discontinuity sits on a kept segment, so the sequence header stays put.
        assertTrue(trimmed.contains("#EXT-X-DISCONTINUITY-SEQUENCE:2"));
        assertTrue(trimmed.contains("#EXT-X-DISCONTINUITY\n") || trimmed.contains("#EXT-X-DISCONTINUITY\r\n"));
        assertFalse(trimmed.contains("IV=0x01"));
        assertFalse(trimmed.contains("a.ts"));
        assertTrue(trimmed.contains("IV=0x02"));
        assertTrue(trimmed.contains("b.ts"));
        assertTrue(trimmed.contains("IV=0x03"));
        assertTrue(trimmed.contains("c.ts"));
        int key2 = trimmed.indexOf("IV=0x02");
        int segB = trimmed.indexOf("b.ts");
        int key3 = trimmed.indexOf("IV=0x03");
        int segC = trimmed.indexOf("c.ts");
        assertTrue(key2 >= 0 && key2 < segB && segB < key3 && key3 < segC);
    }

    @Test
    void repeatsLeadingAesKeyOnTheFirstKeptSegment() {
        String playlist = """
                #EXTM3U
                #EXT-X-TARGETDURATION:6
                #EXT-X-MEDIA-SEQUENCE:10
                #EXT-X-KEY:METHOD=AES-128,URI="k",IV=0xaa
                #EXTINF:6.0,
                a.ts
                #EXTINF:6.0,
                b.ts
                #EXTINF:6.0,
                c.ts
                """;
        String trimmed = TvStreamProxyService.keepNewestLiveSegments(playlist, 1);
        assertTrue(trimmed.contains("#EXT-X-MEDIA-SEQUENCE:12"));
        assertTrue(trimmed.contains("IV=0xaa"));
        assertTrue(trimmed.contains("c.ts"));
        assertFalse(trimmed.contains("a.ts"));
        assertFalse(trimmed.contains("b.ts"));
        assertTrue(trimmed.indexOf("IV=0xaa") < trimmed.indexOf("c.ts"));
    }

    @Test
    void detectsFranceTvSaiDvrHost() {
        assertTrue(TvStreamProxyService.isFranceTvDvrUpstream(
                "https://live-ssai-p.ftven.fr/token/dai/manifest/session/0.m3u8"));
        assertFalse(TvStreamProxyService.isFranceTvDvrUpstream(
                "https://hdfauth.ftven.fr/esi/TA?format=json"));
        assertFalse(TvStreamProxyService.isFranceTvDvrUpstream(
                "https://live2.eu-north-1a.cf.dmcdn.net/sec/live.m3u8"));
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
        assertFalse(TvStreamProxyService.isShortWindowTrimUpstream(
                "http://5.180.164.197:8080/M6/index.m3u8"));
        assertFalse(TvStreamProxyService.isM6ShortWindowUpstream(
                "https://live-3.otcnet.ru/Mezzo/index.m3u8"));
    }

    @Test
    void detectsOtcnetMezzoOnly() {
        assertTrue(TvStreamProxyService.isMezzoOtcnetUpstream(
                "https://live-3.otcnet.ru/Mezzo/tracks-v1a1/mono.ts.m3u8"));
        assertFalse(TvStreamProxyService.isMezzoOtcnetUpstream(
                "http://stream.mcquack.net/276/index.m3u8"));
        assertFalse(TvStreamProxyService.isMezzoOtcnetUpstream(
                "http://str2.iptvhd.ru:8080/Mezzo_HD/index.m3u8"));
        assertFalse(TvStreamProxyService.isShortWindowTrimUpstream(
                "https://live-3.otcnet.ru/Mezzo/tracks-v1a1/mono.ts.m3u8"));
        assertTrue(TvStreamProxyService.isShortWindowPrefetchUpstream(
                "https://live-3.otcnet.ru/Mezzo/tracks-v1a1/mono.ts.m3u8"));
        assertFalse(TvStreamProxyService.shouldPrefetchShortWindow(
                "https://live-3.otcnet.ru/Mezzo/tracks-v1a1/mono.ts.m3u8"));
        assertTrue(TvStreamProxyService.shouldPrefetchShortWindow(
                "http://145.239.5.177/359a/index.m3u8"));
        assertEquals(2, TvStreamProxyService.MEZZO_PREFETCH_SEGMENTS);
        assertEquals(0, TvStreamProxyService.mezzoSlotWaitMs(0, 0));
        assertEquals(0, TvStreamProxyService.mezzoSlotWaitMs(1, 200));
        assertEquals(0, TvStreamProxyService.mezzoSlotWaitMs(2, 200));
        assertEquals(3_800, TvStreamProxyService.mezzoSlotWaitMs(3, 200));
        assertEquals(0, TvStreamProxyService.mezzoSlotWaitMs(3, 4_000));
        assertEquals(0, TvStreamProxyService.mezzoSlotWaitMs(1, 5_000));
        assertTrue(TvStreamProxyService.isDailymotionCdnUpstream(
                "https://live2.eu-north-1a.cf.dmcdn.net/sec2(abc)/cloud/3/xkxbzc/d/live-480.m3u8"));
        assertFalse(TvStreamProxyService.isDailymotionCdnUpstream(
                "https://www.dailymotion.com/player/metadata/video/xkxbzc"));
    }
}
