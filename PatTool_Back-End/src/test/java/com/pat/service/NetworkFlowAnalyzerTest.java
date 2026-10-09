package com.pat.service;

import com.pat.dto.SentinelBaseline;
import com.pat.dto.SentinelCaptureResult;
import com.pat.dto.SentinelFlowDto;
import com.pat.dto.SentinelLogonDto;
import com.pat.repo.domain.NetworkSentinelFinding;
import com.pat.service.NetworkSentinelHostProbeService.HostNetworkContext;
import com.pat.service.NetworkSentinelHostProbeService.Platform;
import com.pat.service.SentinelIpUtil.Cidr;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NetworkFlowAnalyzerTest {

    private static final Cidr LAN = SentinelIpUtil.parseCidr("192.168.1.0/24");
    private static final HostNetworkContext CTX = new HostNetworkContext("host", "Linux", Platform.LINUX,
            List.of("192.168.1.10"), List.of(LAN), Map.of("192.168.1.10", "eth0"));

    private static SentinelFlowDto flow(String dir, String state, String local, int lport, String remote, int rport,
            String proc) {
        return new SentinelFlowDto("tcp", local, lport, remote, rport, state, 42, proc, dir,
                SentinelIpUtil.classify(remote, List.of(LAN)));
    }

    private static NetworkFlowAnalyzer.Input input(List<SentinelFlowDto> flows, SentinelCaptureResult capture,
            List<SentinelLogonDto> logons, List<SentinelLogonDto> sessions, List<Map<String, Object>> devices,
            Set<String> knownMacs, SentinelBaseline baseline, boolean learning) {
        return new NetworkFlowAnalyzer.Input(CTX, flows, capture, logons, sessions, devices, knownMacs, baseline,
                List.of(), Set.of(), learning);
    }

    private static NetworkSentinelFinding byCategory(List<NetworkSentinelFinding> findings, String category) {
        return findings.stream().filter(f -> category.equals(f.getCategory())).findFirst().orElse(null);
    }

    @Test
    void scopeClassification() {
        assertEquals(SentinelFlowDto.SCOPE_LAN, SentinelIpUtil.classify("192.168.1.55", List.of(LAN)));
        assertEquals(SentinelFlowDto.SCOPE_PRIVATE, SentinelIpUtil.classify("10.8.0.3", List.of(LAN)));
        assertEquals(SentinelFlowDto.SCOPE_PUBLIC, SentinelIpUtil.classify("8.8.8.8", List.of(LAN)));
        assertEquals(SentinelFlowDto.SCOPE_LOOPBACK, SentinelIpUtil.classify("127.0.0.1", List.of(LAN)));
        assertEquals(SentinelFlowDto.SCOPE_MULTICAST, SentinelIpUtil.classify("224.0.0.251", List.of(LAN)));
        assertEquals(SentinelFlowDto.SCOPE_UNSPECIFIED, SentinelIpUtil.classify("0.0.0.0", List.of(LAN)));
        assertEquals(SentinelFlowDto.SCOPE_PRIVATE, SentinelIpUtil.classify("fe80::1%eth0", List.of(LAN)));
        assertTrue(SentinelIpUtil.inAny("203.0.113.7", SentinelIpUtil.parseCidrs(List.of("203.0.113.0/24"))));
    }

    @Test
    void splitHostPortHandlesV4V6AndWildcards() {
        assertEquals("192.168.1.10", NetworkSentinelHostProbeService.splitHostPort("192.168.1.10:443")[0]);
        assertEquals("443", NetworkSentinelHostProbeService.splitHostPort("192.168.1.10:443")[1]);
        assertEquals("::1", NetworkSentinelHostProbeService.splitHostPort("[::1]:8080")[0]);
        assertEquals("8080", NetworkSentinelHostProbeService.splitHostPort("[::1]:8080")[1]);
        assertEquals("*", NetworkSentinelHostProbeService.splitHostPort("*:*")[0]);
        assertEquals("0", NetworkSentinelHostProbeService.splitHostPort("*:*")[1]);
        assertEquals("0.0.0.0", NetworkSentinelHostProbeService.splitHostPort("0.0.0.0%eth0:68")[0]);
    }

    @Test
    void establishedInboundFromInternetOnSshIsCriticalIntrusion() {
        List<SentinelFlowDto> flows = List.of(
                flow(SentinelFlowDto.DIR_LISTEN, "LISTEN", "0.0.0.0", 22, "*", 0, "sshd"),
                flow(SentinelFlowDto.DIR_INBOUND, "ESTABLISHED", "192.168.1.10", 22, "203.0.113.9", 51000, "sshd"));
        List<NetworkSentinelFinding> out = NetworkFlowAnalyzer.analyze(
                input(flows, null, null, null, null, Set.of(), new SentinelBaseline(), true));
        NetworkSentinelFinding f = byCategory(out, NetworkFlowAnalyzer.CAT_EXTERNAL_INBOUND);
        assertEquals(NetworkSentinelFinding.SEV_CRITICAL, f.getSeverity());
        assertTrue(f.isIntrusionSucceeded());
        assertEquals("203.0.113.9", f.getEvidence().get("remoteAddress"));
    }

    @Test
    void inboundFromInternetOnWebPortIsLowAndNotIntrusion() {
        List<SentinelFlowDto> flows = List.of(
                flow(SentinelFlowDto.DIR_LISTEN, "LISTEN", "0.0.0.0", 443, "*", 0, "java"),
                flow(SentinelFlowDto.DIR_INBOUND, "ESTABLISHED", "192.168.1.10", 443, "203.0.113.9", 51000, "java"));
        List<NetworkSentinelFinding> out = NetworkFlowAnalyzer.analyze(
                input(flows, null, null, null, null, Set.of(), new SentinelBaseline(), true));
        NetworkSentinelFinding f = byCategory(out, NetworkFlowAnalyzer.CAT_EXTERNAL_INBOUND);
        assertEquals(NetworkSentinelFinding.SEV_LOW, f.getSeverity());
        assertFalse(f.isIntrusionSucceeded());
    }

    @Test
    void trustedCidrSuppressesInboundFinding() {
        List<SentinelFlowDto> flows = List.of(
                flow(SentinelFlowDto.DIR_INBOUND, "ESTABLISHED", "192.168.1.10", 22, "203.0.113.9", 51000, "sshd"));
        NetworkFlowAnalyzer.Input in = new NetworkFlowAnalyzer.Input(CTX, flows, null, null, null, null, Set.of(),
                new SentinelBaseline(), SentinelIpUtil.parseCidrs(List.of("203.0.113.0/24")), Set.of(), true);
        assertTrue(NetworkFlowAnalyzer.analyze(in).stream()
                .noneMatch(f -> NetworkFlowAnalyzer.CAT_EXTERNAL_INBOUND.equals(f.getCategory())));
    }

    @Test
    void newListenerOnlyAfterLearningAndNotWhenExpected() {
        List<SentinelFlowDto> flows = List.of(
                flow(SentinelFlowDto.DIR_LISTEN, "LISTEN", "0.0.0.0", 4444, "*", 0, null));
        SentinelBaseline baseline = new SentinelBaseline();
        baseline.setInitialized(true);

        List<NetworkSentinelFinding> learning = NetworkFlowAnalyzer.analyze(
                input(flows, null, null, null, null, Set.of(), baseline, true));
        assertTrue(learning.stream().noneMatch(f -> NetworkFlowAnalyzer.CAT_NEW_LISTENER.equals(f.getCategory())));

        List<NetworkSentinelFinding> armed = NetworkFlowAnalyzer.analyze(
                input(flows, null, null, null, null, Set.of(), baseline, false));
        NetworkSentinelFinding f = byCategory(armed, NetworkFlowAnalyzer.CAT_NEW_LISTENER);
        assertEquals(NetworkSentinelFinding.SEV_HIGH, f.getSeverity());

        NetworkFlowAnalyzer.Input expected = new NetworkFlowAnalyzer.Input(CTX, flows, null, null, null, null, Set.of(),
                baseline, List.of(), Set.of("tcp:4444"), false);
        assertTrue(NetworkFlowAnalyzer.analyze(expected).stream()
                .noneMatch(x -> NetworkFlowAnalyzer.CAT_NEW_LISTENER.equals(x.getCategory())));

        baseline.getKnownListeners().add("tcp:4444");
        assertTrue(NetworkFlowAnalyzer.analyze(input(flows, null, null, null, null, Set.of(), baseline, false)).stream()
                .noneMatch(x -> NetworkFlowAnalyzer.CAT_NEW_LISTENER.equals(x.getCategory())));
    }

    @Test
    void logonFromInternetIsCriticalEvenWhileLearning() {
        List<SentinelLogonDto> logons = List.of(new SentinelLogonDto(SentinelLogonDto.KIND_LOGON, "root",
                "198.51.100.4", SentinelFlowDto.SCOPE_PUBLIC, "ssh-password", "2026-10-09T03:12:00", "raw"));
        List<NetworkSentinelFinding> out = NetworkFlowAnalyzer.analyze(
                input(List.of(), null, logons, null, null, Set.of(), new SentinelBaseline(), true));
        NetworkSentinelFinding f = byCategory(out, NetworkFlowAnalyzer.CAT_NEW_LOGON);
        assertEquals(NetworkSentinelFinding.SEV_CRITICAL, f.getSeverity());
        assertTrue(f.isIntrusionSucceeded());
    }

    @Test
    void lanLogonIsMediumOnceThenAbsorbedByBaseline() {
        List<SentinelLogonDto> logons = List.of(new SentinelLogonDto(SentinelLogonDto.KIND_LOGON, "pat",
                "192.168.1.20", SentinelFlowDto.SCOPE_LAN, "rdp", null, "raw"));
        SentinelBaseline baseline = new SentinelBaseline();
        baseline.setInitialized(true);
        NetworkSentinelFinding f = byCategory(NetworkFlowAnalyzer.analyze(
                input(List.of(), null, logons, null, null, Set.of(), baseline, false)), NetworkFlowAnalyzer.CAT_NEW_LOGON);
        assertEquals(NetworkSentinelFinding.SEV_MEDIUM, f.getSeverity());

        baseline.getKnownLogons().add("pat@192.168.1.20");
        assertTrue(NetworkFlowAnalyzer.analyze(input(List.of(), null, logons, null, null, Set.of(), baseline, false))
                .stream().noneMatch(x -> NetworkFlowAnalyzer.CAT_NEW_LOGON.equals(x.getCategory())));
    }

    @Test
    void unknownLanDeviceIsHighIntrusion() {
        List<Map<String, Object>> devices = List.of(
                Map.of("ipAddress", "192.168.1.77", "macAddress", "aa:bb:cc:dd:ee:ff", "vendor", "Espressif"),
                Map.of("ipAddress", "192.168.1.2", "macAddress", "11:22:33:44:55:66"));
        List<NetworkSentinelFinding> out = NetworkFlowAnalyzer.analyze(
                input(List.of(), null, null, null, devices, Set.of("112233445566"), new SentinelBaseline(), true));
        List<NetworkSentinelFinding> unknown = out.stream()
                .filter(f -> NetworkFlowAnalyzer.CAT_UNKNOWN_DEVICE.equals(f.getCategory())).toList();
        assertEquals(1, unknown.size());
        assertEquals("AA:BB:CC:DD:EE:FF", unknown.get(0).getEvidence().get("macAddress"));
        assertTrue(unknown.get(0).isIntrusionSucceeded());
    }

    @Test
    void captureDetectsPortScanArpSpoofAndUnknownDeviceTraffic() {
        SentinelCaptureResult cap = new SentinelCaptureResult("tshark", true, 20, 1000, 90000,
                List.of(
                        new SentinelCaptureResult.Conversation("TCP", "192.168.1.66", null, "192.168.1.10", 22, 40, 2400,
                                25, true),
                        new SentinelCaptureResult.Conversation("TLS", "192.168.1.66", null, "198.51.100.9", 443, 30, 9000,
                                1, false),
                        // this host scanning the LAN must not be reported
                        new SentinelCaptureResult.Conversation("TCP", "192.168.1.10", null, "192.168.1.20", 80, 40, 2400,
                                30, true)),
                List.of(new SentinelCaptureResult.DnsQuery("192.168.1.66",
                        "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBsYWJlbCBmb3IgZXhmaWw.evil.example", 3)),
                List.of(),
                List.of(),
                List.of(new SentinelCaptureResult.IpMac("192.168.1.1", "00:11:22:33:44:55"),
                        new SentinelCaptureResult.IpMac("192.168.1.1", "66:77:88:99:aa:bb"),
                        new SentinelCaptureResult.IpMac("192.168.1.66", "de:ad:be:ef:00:01")),
                null);
        SentinelBaseline baseline = new SentinelBaseline();
        baseline.setInitialized(true);
        List<NetworkSentinelFinding> out = NetworkFlowAnalyzer.analyze(
                input(List.of(), cap, null, null, null, Set.of("001122334455"), baseline, false));

        NetworkSentinelFinding scan = byCategory(out, NetworkFlowAnalyzer.CAT_PORT_SCAN);
        assertEquals("192.168.1.66", scan.getEvidence().get("source"));
        assertEquals(NetworkSentinelFinding.SEV_CRITICAL, scan.getSeverity());
        assertTrue(out.stream().filter(f -> NetworkFlowAnalyzer.CAT_PORT_SCAN.equals(f.getCategory()))
                .noneMatch(f -> "192.168.1.10".equals(f.getEvidence().get("source"))));

        NetworkSentinelFinding spoof = byCategory(out, NetworkFlowAnalyzer.CAT_ARP_SPOOF);
        assertEquals("192.168.1.1", spoof.getEvidence().get("ip"));
        assertEquals(NetworkSentinelFinding.SEV_CRITICAL, spoof.getSeverity());

        NetworkSentinelFinding traffic = byCategory(out, NetworkFlowAnalyzer.CAT_UNKNOWN_DEVICE_TRAFFIC);
        assertEquals("192.168.1.66", traffic.getEvidence().get("source"));
        assertTrue(traffic.isIntrusionSucceeded());

        assertTrue(out.stream().anyMatch(f -> NetworkFlowAnalyzer.CAT_DNS_SUSPECT.equals(f.getCategory())));
    }

    @Test
    void acknowledgedKeyIsDowngradedToInfo() {
        List<SentinelFlowDto> flows = List.of(
                flow(SentinelFlowDto.DIR_INBOUND, "ESTABLISHED", "192.168.1.10", 22, "203.0.113.9", 51000, "sshd"));
        SentinelBaseline baseline = new SentinelBaseline();
        baseline.getAcknowledgedKeys().add(NetworkFlowAnalyzer.CAT_EXTERNAL_INBOUND + "|203.0.113.9|tcp:22");
        NetworkSentinelFinding f = byCategory(NetworkFlowAnalyzer.analyze(
                input(flows, null, null, null, null, Set.of(), baseline, true)), NetworkFlowAnalyzer.CAT_EXTERNAL_INBOUND);
        assertTrue(f.isAcknowledged());
        assertEquals(NetworkSentinelFinding.SEV_INFO, f.getSeverity());
        assertFalse(f.isIntrusionSucceeded());
    }

    @Test
    void suspiciousOutboundPortIsHigh() {
        List<SentinelFlowDto> flows = List.of(
                flow(SentinelFlowDto.DIR_OUTBOUND, "ESTABLISHED", "192.168.1.10", 50123, "198.51.100.77", 4444, "nc"));
        NetworkSentinelFinding f = byCategory(NetworkFlowAnalyzer.analyze(
                input(flows, null, null, null, null, Set.of(), new SentinelBaseline(), true)),
                NetworkFlowAnalyzer.CAT_SUSPICIOUS_OUTBOUND);
        assertEquals(NetworkSentinelFinding.SEV_HIGH, f.getSeverity());
        assertTrue(f.isIntrusionSucceeded());
    }
}
