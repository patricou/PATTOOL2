package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class YoutubeAudioServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void keepsAudioAndDropsThePicture() throws Exception {
        var root = mapper.readTree("""
                {"streamingData":{"adaptiveFormats":[
                  {"itag":137,"mimeType":"video/mp4; codecs=\\"avc1\\"","url":"https://rr.googlevideo.com/videoplayback?id=v"},
                  {"itag":251,"mimeType":"audio/webm; codecs=\\"opus\\"","url":"https://rr.googlevideo.com/videoplayback?id=w"},
                  {"itag":140,"mimeType":"audio/mp4; codecs=\\"mp4a.40.2\\"","url":"https://rr.googlevideo.com/videoplayback?id=a"}
                ]}}
                """);
        var audio = YoutubeAudioService.pickAudio(root);
        assertEquals("audio/webm", audio.mime());
        assertTrue(audio.url().contains("id=w"));
        var aac = YoutubeAudioService.pickAudio(root, false);
        assertEquals("audio/mp4", aac.mime());
    }

    @Test
    void refusesAStreamThatIsNotOnGooglevideo() throws Exception {
        var root = mapper.readTree("""
                {"streamingData":{"adaptiveFormats":[
                  {"itag":140,"mimeType":"audio/mp4","url":"https://evil.example/audio"}
                ]}}
                """);
        assertNull(YoutubeAudioService.pickAudio(root));
        assertFalse(YoutubeAudioService.googlevideo("https://evil.example/audio"));
        assertTrue(YoutubeAudioService.googlevideo("https://rr3---sn.googlevideo.com/videoplayback"));
        var picture = mapper.readTree("""
                {"streamingData":{"formats":[
                  {"itag":22,"mimeType":"video/mp4","contentLength":"400","url":"https://rr.googlevideo.com/videoplayback?id=big"},
                  {"itag":18,"mimeType":"video/mp4","contentLength":"100","url":"https://rr.googlevideo.com/videoplayback?id=small"}
                ]}}
                """);
        assertTrue(YoutubeAudioService.pickProgressiveUrl(picture).contains("id=small"));
        assertEquals("bytes=0-1048575", YoutubeAudioService.upstreamRange(null));
        assertEquals("bytes=0-1048575", YoutubeAudioService.upstreamRange("bytes=0-"));
        assertEquals("bytes=1048576-2097151", YoutubeAudioService.upstreamRange("bytes=1048576-"));
        assertEquals("bytes=0-31", YoutubeAudioService.upstreamRange("bytes=0-31"));
        assertEquals("", YoutubeAudioService.safeId("not-an-id"));
        assertEquals("dQw4w9WgXcQ", YoutubeAudioService.safeId("dQw4w9WgXcQ"));
    }
}
