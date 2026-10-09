package com.pat.dto;

import java.util.List;

/**
 * What the sentinel can do on this backend host (tools detected at runtime).
 */
public record SentinelCapabilitiesDto(
        String hostName,
        String os,
        String platform,
        List<String> localAddresses,
        List<String> lanCidrs,
        boolean connectionTable,
        String connectionTool,
        boolean packetCapture,
        String captureTool,
        List<String> captureInterfaces,
        boolean logonHistory,
        String logonTool,
        boolean sessions,
        String sessionTool,
        boolean deviceScan,
        List<String> hints) {
}
