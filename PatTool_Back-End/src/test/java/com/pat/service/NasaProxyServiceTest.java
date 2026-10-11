package com.pat.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.NasaDtos.Apod;
import com.pat.controller.dto.NasaDtos.Epic;
import com.pat.controller.dto.NasaDtos.Mars;
import com.pat.controller.dto.NasaDtos.NeoFeed;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NasaProxyServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void parsesApodAndDropsUnknownHosts() throws Exception {
        Apod apod = NasaProxyService.parseApod(mapper.readTree("""
                {
                  "date": "2026-10-11",
                  "title": "Galaxy",
                  "explanation": "A spiral.",
                  "media_type": "image",
                  "url": "https://apod.nasa.gov/apod/image/a.jpg",
                  "hdurl": "http://apod.nasa.gov/apod/image/a_hd.jpg",
                  "copyright": "ESA"
                }
                """));
        assertEquals("Galaxy", apod.title());
        assertEquals("https://apod.nasa.gov/apod/image/a.jpg", apod.url());
        assertEquals("https://apod.nasa.gov/apod/image/a_hd.jpg", apod.hdUrl());
        assertNull(NasaProxyService.safeHttpsUrl("https://evil.example/a.jpg"));
        assertNull(NasaProxyService.safeHttpsUrl("javascript:alert(1)"));
    }

    @Test
    void parsesEpicDay() throws Exception {
        Epic epic = NasaProxyService.parseEpic(LocalDate.of(2024, 10, 10), mapper.readTree("""
                [
                  {
                    "image": "epic_1b_20241010003633",
                    "caption": "Earth",
                    "date": "2024-10-10 00:36:33",
                    "centroid_coordinates": { "lat": 1.5, "lon": -20.25 }
                  }
                ]
                """));
        assertEquals("2024-10-10", epic.date());
        assertEquals(1, epic.images().size());
        assertEquals("00:36:33", epic.images().get(0).time());
        assertEquals(1.5, epic.images().get(0).latitude());
    }

    @Test
    void epicArchiveUriSkipsTheApiGateway() {
        URI uri = NasaProxyService.epicArchiveUri(LocalDate.of(2026, 10, 8), "epic_1b_20261008000831");
        assertEquals(
                "https://epic.gsfc.nasa.gov/archive/natural/2026/10/08/png/epic_1b_20261008000831.png",
                uri.toString());
    }

    @Test
    void epicCatalogUriDoesNotUseTheApiKey() {
        assertEquals(
                "https://epic.gsfc.nasa.gov/api/natural",
                NasaProxyService.epicCatalogUri(null).toString());
        assertEquals(
                "https://epic.gsfc.nasa.gov/api/natural/date/2026-10-08",
                NasaProxyService.epicCatalogUri(LocalDate.of(2026, 10, 8)).toString());
    }

    @Test
    void marsCatalogUriUsesThePublicSiteAndTheChosenDay() {
        URI uri = NasaProxyService.marsCatalogUri(null, LocalDate.of(2026, 10, 8), 1);
        String value = uri.toString();
        assertTrue(value.startsWith("https://mars.nasa.gov/api/v1/raw_image_items/"));
        assertTrue(value.contains("condition_1=msl:mission") || value.contains("condition_1=msl%3Amission"));
        assertTrue(value.contains("2026-10-08"));
        assertTrue(value.contains("2026-10-09"));
        assertFalse(value.contains("api_key"));
    }

    @Test
    void parsesMarsCatalogItem() throws Exception {
        Mars mars = NasaProxyService.parseMarsCatalog("curiosity", null, 1, mapper.readTree("""
                {
                  "more": true,
                  "items": [
                    {
                      "id": 7,
                      "sol": 5038,
                      "instrument": "RHAZ_RIGHT_B",
                      "title": "Rear Hazcam",
                      "date_taken": "2026-10-08T19:59:44.000Z",
                      "https_url": "https://mars.nasa.gov/msl-raw-images/photo.jpg"
                    }
                  ]
                }
                """));
        assertEquals(1, mars.photos().size());
        assertEquals("2026-10-08", mars.photos().get(0).earthDate());
        assertEquals("RHAZ_RIGHT_B", mars.photos().get(0).camera());
        assertTrue(mars.hasMore());
    }

    @Test
    void parsesMarsPhotosAndKeepsNasaHostsOnly() throws Exception {
        Mars mars = NasaProxyService.parseMars("curiosity", 1000, 1, true, mapper.readTree("""
                {
                  "photos": [
                    {
                      "id": 1,
                      "sol": 1000,
                      "earth_date": "2015-05-30",
                      "img_src": "http://mars.jpl.nasa.gov/msl-raw-images/a.jpg",
                      "camera": { "name": "FHAZ", "full_name": "Front Hazard" },
                      "rover": { "name": "Curiosity" }
                    },
                    {
                      "id": 2,
                      "sol": 1000,
                      "img_src": "https://cdn.example/secret.jpg",
                      "camera": { "name": "RHAZ" }
                    }
                  ]
                }
                """));
        assertEquals(1, mars.photos().size());
        assertTrue(mars.photos().get(0).imageUrl().startsWith("https://mars.jpl.nasa.gov/"));
        assertEquals("FHAZ", mars.photos().get(0).camera());
        assertFalse(mars.hasMore());
    }

    @Test
    void sortsNeoByMissDistance() throws Exception {
        NeoFeed feed = NasaProxyService.parseNeo(
                LocalDate.of(2026, 10, 11),
                LocalDate.of(2026, 10, 11),
                mapper.readTree("""
                        {
                          "element_count": 2,
                          "near_earth_objects": {
                            "2026-10-11": [
                              {
                                "id": "far",
                                "name": "Far",
                                "is_potentially_hazardous_asteroid": false,
                                "estimated_diameter": { "meters": { "estimated_diameter_min": 10, "estimated_diameter_max": 20 } },
                                "close_approach_data": [{
                                  "close_approach_date": "2026-10-11",
                                  "miss_distance": { "kilometers": "5000000", "lunar": "13" },
                                  "relative_velocity": { "kilometers_per_hour": "40000" }
                                }],
                                "nasa_jpl_url": "http://ssd.jpl.nasa.gov/sbdb.cgi?sstr=far"
                              },
                              {
                                "id": "near",
                                "name": "Near",
                                "is_potentially_hazardous_asteroid": true,
                                "estimated_diameter": { "meters": { "estimated_diameter_min": 100, "estimated_diameter_max": 200 } },
                                "close_approach_data": [{
                                  "close_approach_date": "2026-10-11",
                                  "miss_distance": { "kilometers": "120000", "lunar": "0.3" },
                                  "relative_velocity": { "kilometers_per_hour": "80000" }
                                }],
                                "nasa_jpl_url": "https://ssd.jpl.nasa.gov/sbdb.cgi?sstr=near"
                              }
                            ]
                          }
                        }
                        """));
        assertEquals(2, feed.count());
        assertEquals("near", feed.objects().get(0).id());
        assertTrue(feed.objects().get(0).hazardous());
        assertEquals(120000d, feed.objects().get(0).missKm());
        assertTrue(feed.objects().get(0).jplUrl().startsWith("https://"));
    }

    @Test
    void parsesApodFeedWhenTheJsonApiIsDown() {
        var byDate = NasaProxyService.parseApodFeed("""
                <?xml version="1.0" encoding="UTF-8" ?>
                <rss version="2.0" xmlns:apod="https://science.nasa.gov/apod/">
                <channel>
                <item>
                  <title>Ice Fishing for Cosmic Neutrinos</title>
                  <link>https://science.nasa.gov/image-article/apod-2026-october-11-ice-fishing/</link>
                  <apod:hdurl>https://assets.science.nasa.gov/dynamicimage/deephole.jpg</apod:hdurl>
                  <apod:explanation><![CDATA[<strong>Explanation:</strong> A hole in the ice.<br>Second line.]]></apod:explanation>
                  <apod:copyright><![CDATA[<a href="https://www.nsf.gov/">NSF</a>]]></apod:copyright>
                </item>
                </channel>
                </rss>
                """);
        var apod = byDate.get("2026-10-11");
        assertEquals("Ice Fishing for Cosmic Neutrinos", apod.title());
        assertEquals("image", apod.mediaType());
        assertEquals("https://assets.science.nasa.gov/dynamicimage/deephole.jpg", apod.url());
        assertTrue(apod.explanation().startsWith("A hole in the ice."));
        assertTrue(apod.explanation().contains("Second line."));
        assertEquals("NSF", apod.copyright());
    }
}
