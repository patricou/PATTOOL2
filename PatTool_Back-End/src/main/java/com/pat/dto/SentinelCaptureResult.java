package com.pat.dto;

import java.util.List;

/**
 * Aggregated result of a short packet capture performed on the PatTool backend host
 * (tshark preferred, tcpdump fallback). Empty when no capture tool is available.
 * Lists instead of IP-keyed maps: MongoDB forbids dots in map keys.
 */
public record SentinelCaptureResult(
        String tool,
        boolean available,
        int requestedSeconds,
        long packets,
        long bytes,
        List<Conversation> conversations,
        List<DnsQuery> dnsQueries,
        List<ArpObservation> arpObservations,
        List<HostCount> packetsByHost,
        /** IP -> MAC learned from Ethernet headers (tshark only). */
        List<IpMac> ipToMac,
        String warning) {

    public record Conversation(
            String protocol,
            String srcAddress,
            Integer srcPort,
            String dstAddress,
            Integer dstPort,
            long packets,
            long bytes,
            /** Number of distinct destination ports seen from src to dst (scan heuristic). */
            int distinctDstPorts,
            boolean synOnly) {
    }

    public record DnsQuery(String client, String name, long count) {
    }

    public record ArpObservation(String ip, String mac, long count, boolean reply) {
    }

    public record HostCount(String address, long packets, long bytes) {
    }

    public record IpMac(String ip, String mac) {
    }

    public static SentinelCaptureResult unavailable(int requestedSeconds, String warning) {
        return new SentinelCaptureResult(null, false, requestedSeconds, 0, 0, List.of(), List.of(), List.of(),
                List.of(), List.of(), warning);
    }
}
