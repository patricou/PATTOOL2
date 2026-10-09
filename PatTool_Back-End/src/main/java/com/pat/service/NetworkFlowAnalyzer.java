package com.pat.service;

import com.pat.dto.SentinelBaseline;
import com.pat.dto.SentinelCaptureResult;
import com.pat.dto.SentinelFlowDto;
import com.pat.dto.SentinelLogonDto;
import com.pat.repo.domain.NetworkSentinelFinding;
import com.pat.service.NetworkSentinelHostProbeService.HostNetworkContext;
import com.pat.service.SentinelIpUtil.Cidr;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import static com.pat.repo.domain.NetworkSentinelFinding.SEV_CRITICAL;
import static com.pat.repo.domain.NetworkSentinelFinding.SEV_HIGH;
import static com.pat.repo.domain.NetworkSentinelFinding.SEV_INFO;
import static com.pat.repo.domain.NetworkSentinelFinding.SEV_LOW;
import static com.pat.repo.domain.NetworkSentinelFinding.SEV_MEDIUM;

/**
 * Rule engine of the network sentinel. Pure: no I/O, no Spring. Given what the host sees (connection table,
 * capture, logons, sessions, LAN devices) plus the learned baseline, produces findings. Findings flagged
 * {@code intrusionSucceeded} are those that mean someone is already inside (connected, logged on, on the LAN),
 * as opposed to attempts or exposure.
 */
public final class NetworkFlowAnalyzer {

    public static final String CAT_EXTERNAL_INBOUND = "EXTERNAL_INBOUND";
    public static final String CAT_REMOTE_SESSION = "REMOTE_SESSION";
    public static final String CAT_NEW_LISTENER = "NEW_LISTENER";
    public static final String CAT_NEW_LOGON = "NEW_LOGON";
    public static final String CAT_UNKNOWN_DEVICE = "UNKNOWN_DEVICE";
    public static final String CAT_PORT_SCAN = "PORT_SCAN";
    public static final String CAT_HOST_SWEEP = "HOST_SWEEP";
    public static final String CAT_ARP_SPOOF = "ARP_SPOOF";
    public static final String CAT_ARP_CHANGE = "ARP_CHANGE";
    public static final String CAT_UNKNOWN_DEVICE_TRAFFIC = "UNKNOWN_DEVICE_TRAFFIC";
    public static final String CAT_DNS_SUSPECT = "DNS_SUSPECT";
    public static final String CAT_SUSPICIOUS_OUTBOUND = "SUSPICIOUS_OUTBOUND";
    public static final String CAT_HIGH_FANOUT = "HIGH_FANOUT";
    public static final String CAT_EXPOSED_SERVICE = "EXPOSED_SERVICE";

    static final Set<Integer> SENSITIVE_PORTS = Set.of(21, 22, 23, 111, 135, 139, 161, 445, 1433, 2049, 2375, 2376,
            3306, 3389, 5432, 5900, 5901, 5902, 5985, 5986, 6379, 8291, 9200, 27017, 27018);
    static final Set<Integer> WEB_PORTS = Set.of(80, 443, 8080, 8443, 8000, 8008, 8888);
    static final Set<Integer> C2_LIKE_PORTS = Set.of(23, 445, 1337, 2323, 3389, 4444, 5555, 5900, 6666, 6667, 6697,
            9001, 9030, 9050, 31337);
    static final int SCAN_DISTINCT_PORTS = 15;
    static final int SWEEP_DISTINCT_HOSTS = 10;
    static final int FANOUT_PUBLIC_PEERS = 60;
    static final int DNS_LABEL_SUSPECT_LENGTH = 48;
    static final int DNS_QUERIES_PER_CLIENT_SUSPECT = 300;

    public record Input(
            HostNetworkContext ctx,
            List<SentinelFlowDto> flows,
            SentinelCaptureResult capture,
            List<SentinelLogonDto> logons,
            List<SentinelLogonDto> sessions,
            List<Map<String, Object>> devices,
            Set<String> knownDeviceMacs,
            SentinelBaseline baseline,
            List<Cidr> trustedCidrs,
            Set<String> expectedListeners,
            boolean learning) {
    }

    private NetworkFlowAnalyzer() {
    }

    public static List<NetworkSentinelFinding> analyze(Input in) {
        Map<String, NetworkSentinelFinding> out = new LinkedHashMap<>();
        Set<String> localAddresses = new HashSet<>(in.ctx() != null ? in.ctx().localAddresses() : List.of());
        List<Cidr> lan = in.ctx() != null ? in.ctx().lanCidrs() : List.of();
        List<SentinelFlowDto> flows = in.flows() != null ? in.flows() : List.of();
        SentinelBaseline baseline = in.baseline() != null ? in.baseline() : new SentinelBaseline();
        Set<String> knownMacs = in.knownDeviceMacs() != null ? in.knownDeviceMacs() : Set.of();
        Map<String, String> ipToMac = buildIpToMac(in);

        analyzeInboundPublic(in, flows, out);
        analyzeSuspiciousOutbound(in, flows, out);
        analyzeFanout(flows, out);
        analyzeListeners(in, flows, baseline, out);
        analyzeSessions(in, flows, out);
        analyzeLogons(in, baseline, out);
        analyzeDevices(in, knownMacs, out);
        if (in.capture() != null && in.capture().available()) {
            analyzeCapture(in, lan, localAddresses, knownMacs, ipToMac, baseline, out);
        }

        List<NetworkSentinelFinding> list = new ArrayList<>(out.values());
        for (NetworkSentinelFinding f : list) {
            if (baseline.getAcknowledgedKeys().contains(f.getKey())) {
                f.setAcknowledged(true);
                f.setSeverity(SEV_INFO);
                f.setIntrusionSucceeded(false);
            }
        }
        list.sort(Comparator.comparingInt((NetworkSentinelFinding f) -> NetworkSentinelFinding.severityRank(f.getSeverity()))
                .reversed().thenComparing(NetworkSentinelFinding::getCategory));
        return list;
    }

    // ------------------------------------------------------------------------------------------------------------

    private static void analyzeInboundPublic(Input in, List<SentinelFlowDto> flows, Map<String, NetworkSentinelFinding> out) {
        Map<String, List<SentinelFlowDto>> byPeer = new LinkedHashMap<>();
        for (SentinelFlowDto f : flows) {
            if (!SentinelFlowDto.DIR_INBOUND.equals(f.direction()) || !f.isEstablished()) {
                continue;
            }
            if (!SentinelIpUtil.isPublic(f.remoteScope()) || SentinelIpUtil.inAny(f.remoteAddress(), in.trustedCidrs())) {
                continue;
            }
            byPeer.computeIfAbsent(f.remoteAddress() + "|" + family(f.protocol()) + ":" + f.localPort(), k -> new ArrayList<>())
                    .add(f);
        }
        for (Map.Entry<String, List<SentinelFlowDto>> e : byPeer.entrySet()) {
            SentinelFlowDto f = e.getValue().get(0);
            int port = f.localPort();
            String sev;
            boolean intrusion;
            if (SENSITIVE_PORTS.contains(port)) {
                sev = SEV_CRITICAL;
                intrusion = true;
            } else if (WEB_PORTS.contains(port)) {
                sev = SEV_LOW;
                intrusion = false;
            } else {
                sev = SEV_HIGH;
                intrusion = true;
            }
            String key = CAT_EXTERNAL_INBOUND + "|" + e.getKey();
            NetworkSentinelFinding finding = new NetworkSentinelFinding(key, CAT_EXTERNAL_INBOUND, sev,
                    "Established inbound connection from the Internet on port " + port,
                    f.remoteAddress() + " is connected to " + f.localAddress() + ":" + port
                            + (f.processName() != null ? " (" + f.processName() + ")" : "")
                            + (SENSITIVE_PORTS.contains(port) ? " — administrative / data service reachable from outside."
                                    : WEB_PORTS.contains(port) ? " — web service; expected if this host is published."
                                            : " — non-web service reachable from outside."),
                    intrusion)
                    .evidence("remoteAddress", f.remoteAddress())
                    .evidence("remotePort", f.remotePort())
                    .evidence("localPort", port)
                    .evidence("protocol", f.protocol())
                    .evidence("process", f.processName())
                    .evidence("pid", f.pid())
                    .evidence("connections", e.getValue().size());
            put(out, finding);
        }
    }

    private static void analyzeSuspiciousOutbound(Input in, List<SentinelFlowDto> flows,
            Map<String, NetworkSentinelFinding> out) {
        for (SentinelFlowDto f : flows) {
            if (!SentinelFlowDto.DIR_OUTBOUND.equals(f.direction()) || !f.isEstablished()) {
                continue;
            }
            if (!SentinelIpUtil.isPublic(f.remoteScope()) || SentinelIpUtil.inAny(f.remoteAddress(), in.trustedCidrs())) {
                continue;
            }
            if (!C2_LIKE_PORTS.contains(f.remotePort())) {
                continue;
            }
            String key = CAT_SUSPICIOUS_OUTBOUND + "|" + f.remoteAddress() + "|" + f.remotePort();
            put(out, new NetworkSentinelFinding(key, CAT_SUSPICIOUS_OUTBOUND, SEV_HIGH,
                    "Outbound connection to an Internet host on a reverse-shell / C2 style port " + f.remotePort(),
                    (f.processName() != null ? f.processName() + " (pid " + f.pid() + ")" : "A local process")
                            + " is connected to " + f.remoteAddress() + ":" + f.remotePort()
                            + ". Legitimate software rarely uses this port towards the Internet.",
                    true)
                    .evidence("remoteAddress", f.remoteAddress())
                    .evidence("remotePort", f.remotePort())
                    .evidence("process", f.processName())
                    .evidence("pid", f.pid()));
        }
    }

    private static void analyzeFanout(List<SentinelFlowDto> flows, Map<String, NetworkSentinelFinding> out) {
        Map<String, Set<String>> peersByProcess = new HashMap<>();
        for (SentinelFlowDto f : flows) {
            if (!SentinelFlowDto.DIR_OUTBOUND.equals(f.direction()) || !SentinelIpUtil.isPublic(f.remoteScope())) {
                continue;
            }
            String proc = f.processName() != null ? f.processName() : "pid " + f.pid();
            peersByProcess.computeIfAbsent(proc, k -> new HashSet<>()).add(f.remoteAddress());
        }
        for (Map.Entry<String, Set<String>> e : peersByProcess.entrySet()) {
            if (e.getValue().size() < FANOUT_PUBLIC_PEERS) {
                continue;
            }
            String key = CAT_HIGH_FANOUT + "|" + e.getKey();
            put(out, new NetworkSentinelFinding(key, CAT_HIGH_FANOUT, SEV_MEDIUM,
                    "Process talking to an unusually large number of Internet hosts",
                    e.getKey() + " has sockets towards " + e.getValue().size()
                            + " distinct public addresses (peer-to-peer, crawler, botnet or scanner behaviour).",
                    false)
                    .evidence("process", e.getKey())
                    .evidence("distinctPublicPeers", e.getValue().size()));
        }
    }

    private static void analyzeListeners(Input in, List<SentinelFlowDto> flows, SentinelBaseline baseline,
            Map<String, NetworkSentinelFinding> out) {
        Set<String> expected = in.expectedListeners() != null ? in.expectedListeners() : Set.of();
        Set<String> seen = new HashSet<>();
        for (SentinelFlowDto f : flows) {
            if (!f.isListener() || isLoopbackBound(f.localAddress())) {
                continue;
            }
            String lk = family(f.protocol()) + ":" + f.localPort();
            if (!seen.add(lk)) {
                continue;
            }
            boolean sensitive = SENSITIVE_PORTS.contains(f.localPort());
            if (sensitive && family(f.protocol()).equals("tcp")) {
                put(out, new NetworkSentinelFinding(CAT_EXPOSED_SERVICE + "|" + lk, CAT_EXPOSED_SERVICE, SEV_INFO,
                        "Administrative / data service listening on a network interface (" + lk + ")",
                        (f.processName() != null ? f.processName() : "A process") + " listens on " + f.localAddress() + ":"
                                + f.localPort() + ". Make sure it is not forwarded from your router.",
                        false)
                        .evidence("localAddress", f.localAddress())
                        .evidence("port", f.localPort())
                        .evidence("process", f.processName())
                        .evidence("pid", f.pid()));
            }
            if (in.learning() || expected.contains(lk) || baseline.getKnownListeners().contains(lk)) {
                continue;
            }
            boolean unknownProcess = f.processName() == null || f.processName().isBlank();
            String sev = sensitive ? SEV_HIGH : (f.localPort() >= 1024 && unknownProcess ? SEV_HIGH : SEV_MEDIUM);
            put(out, new NetworkSentinelFinding(CAT_NEW_LISTENER + "|" + lk, CAT_NEW_LISTENER, sev,
                    "New listening port appeared on this host (" + lk + ")",
                    (f.processName() != null ? f.processName() + " (pid " + f.pid() + ")" : "An unidentified process")
                            + " now listens on " + f.localAddress() + ":" + f.localPort()
                            + ", which was not present in previous sweeps. A backdoor or an unexpected service.",
                    sev.equals(SEV_HIGH))
                    .evidence("localAddress", f.localAddress())
                    .evidence("port", f.localPort())
                    .evidence("protocol", f.protocol())
                    .evidence("process", f.processName())
                    .evidence("pid", f.pid()));
        }
    }

    private static void analyzeSessions(Input in, List<SentinelFlowDto> flows, Map<String, NetworkSentinelFinding> out) {
        if (in.sessions() == null) {
            return;
        }
        boolean publicRdpInbound = flows.stream().anyMatch(f -> SentinelFlowDto.DIR_INBOUND.equals(f.direction())
                && f.isEstablished() && f.localPort() == 3389 && SentinelIpUtil.isPublic(f.remoteScope()));
        for (SentinelLogonDto s : in.sessions()) {
            boolean remote = "rdp".equalsIgnoreCase(s.method()) || (s.method() != null && s.method().startsWith("pts"))
                    || (s.sourceAddress() != null && !s.sourceAddress().isBlank());
            if (!remote) {
                continue;
            }
            String src = s.sourceAddress() != null ? s.sourceAddress() : "?";
            String scope = s.sourceScope();
            boolean trusted = s.sourceAddress() != null && SentinelIpUtil.inAny(s.sourceAddress(), in.trustedCidrs());
            String sev;
            boolean intrusion;
            if (SentinelIpUtil.isPublic(scope) && !trusted) {
                sev = SEV_CRITICAL;
                intrusion = true;
            } else if ("rdp".equalsIgnoreCase(s.method()) && s.sourceAddress() == null && publicRdpInbound) {
                sev = SEV_CRITICAL;
                intrusion = true;
            } else if ("rdp".equalsIgnoreCase(s.method()) && s.sourceAddress() == null) {
                sev = SEV_MEDIUM;
                intrusion = false;
            } else {
                sev = SEV_LOW;
                intrusion = false;
            }
            String key = CAT_REMOTE_SESSION + "|" + s.user() + "|" + src;
            put(out, new NetworkSentinelFinding(key, CAT_REMOTE_SESSION, sev,
                    "Remote session open on this host (" + s.user() + ")",
                    "User " + s.user() + " has an active " + (s.method() != null ? s.method() : "remote") + " session"
                            + (s.sourceAddress() != null ? " from " + s.sourceAddress() : "")
                            + (SentinelIpUtil.isPublic(scope) ? " — the source is on the Internet." : "."),
                    intrusion)
                    .evidence("user", s.user())
                    .evidence("source", s.sourceAddress())
                    .evidence("scope", scope)
                    .evidence("method", s.method())
                    .evidence("raw", s.raw()));
        }
    }

    private static void analyzeLogons(Input in, SentinelBaseline baseline, Map<String, NetworkSentinelFinding> out) {
        if (in.logons() == null) {
            return;
        }
        Map<String, Integer> counts = new LinkedHashMap<>();
        Map<String, SentinelLogonDto> sample = new HashMap<>();
        for (SentinelLogonDto l : in.logons()) {
            String k = l.user() + "@" + l.sourceAddress();
            counts.merge(k, 1, Integer::sum);
            sample.putIfAbsent(k, l);
        }
        for (Map.Entry<String, Integer> e : counts.entrySet()) {
            SentinelLogonDto l = sample.get(e.getKey());
            boolean known = baseline.getKnownLogons().contains(e.getKey());
            boolean trusted = SentinelIpUtil.inAny(l.sourceAddress(), in.trustedCidrs());
            boolean isPublic = SentinelIpUtil.isPublic(l.sourceScope()) && !trusted;
            if (known && !isPublic) {
                continue;
            }
            if (in.learning() && !isPublic) {
                continue;
            }
            String sev = isPublic ? (known ? SEV_HIGH : SEV_CRITICAL) : SEV_MEDIUM;
            String key = CAT_NEW_LOGON + "|" + e.getKey();
            put(out, new NetworkSentinelFinding(key, CAT_NEW_LOGON, sev,
                    isPublic ? "Successful logon from the Internet (" + l.user() + ")"
                            : "Successful logon from a new source (" + l.user() + ")",
                    l.user() + " logged on via " + (l.method() != null ? l.method() : "unknown method") + " from "
                            + l.sourceAddress() + " (" + e.getValue() + " time(s)"
                            + (l.when() != null ? ", last " + l.when() : "") + ")."
                            + (isPublic ? " The source address is public: this is a successful remote access from outside."
                                    : " This user / source pair had never been seen before."),
                    true)
                    .evidence("user", l.user())
                    .evidence("source", l.sourceAddress())
                    .evidence("scope", l.sourceScope())
                    .evidence("method", l.method())
                    .evidence("count", e.getValue())
                    .evidence("last", l.when()));
        }
    }

    private static void analyzeDevices(Input in, Set<String> knownMacs, Map<String, NetworkSentinelFinding> out) {
        if (in.devices() == null) {
            return;
        }
        for (Map<String, Object> d : in.devices()) {
            String mac = SentinelIpUtil.normalizeMac(str(d.get("macAddress")));
            if (mac.length() != 12 || knownMacs.contains(mac)) {
                continue;
            }
            String ip = str(d.get("ipAddress"));
            String key = CAT_UNKNOWN_DEVICE + "|" + mac;
            put(out, new NetworkSentinelFinding(key, CAT_UNKNOWN_DEVICE, SEV_HIGH,
                    "Unknown device present on the LAN (" + (ip != null ? ip : mac) + ")",
                    "A device with MAC " + formatMac(mac) + (ip != null ? " at " + ip : "")
                            + (d.get("hostname") != null ? " (" + d.get("hostname") + ")" : "")
                            + (d.get("vendor") != null ? ", vendor " + d.get("vendor") : "")
                            + " is on your network and is not in the known-device inventory.",
                    true)
                    .evidence("ipAddress", ip)
                    .evidence("macAddress", formatMac(mac))
                    .evidence("hostname", d.get("hostname"))
                    .evidence("vendor", d.get("vendor"))
                    .evidence("deviceType", d.get("deviceType"))
                    .evidence("openPorts", d.get("openPorts")));
        }
    }

    private static void analyzeCapture(Input in, List<Cidr> lan, Set<String> localAddresses, Set<String> knownMacs,
            Map<String, String> ipToMac, SentinelBaseline baseline, Map<String, NetworkSentinelFinding> out) {
        SentinelCaptureResult cap = in.capture();

        // Port scans and host sweeps (ignore this host: its own device scan looks exactly like that).
        Map<String, Set<String>> synTargetsBySrc = new HashMap<>();
        Map<String, Set<String>> publicDstByLanSrc = new HashMap<>();
        for (SentinelCaptureResult.Conversation c : cap.conversations()) {
            if (c.srcAddress() == null || localAddresses.contains(c.srcAddress())) {
                continue;
            }
            String srcScope = SentinelIpUtil.classify(c.srcAddress(), lan);
            String dstScope = SentinelIpUtil.classify(c.dstAddress(), lan);
            if (c.distinctDstPorts() >= SCAN_DISTINCT_PORTS) {
                String srcMac = ipToMac.get(c.srcAddress());
                boolean unknownSrc = SentinelIpUtil.isPublic(srcScope) || (srcMac != null && !knownMacs.contains(srcMac));
                String key = CAT_PORT_SCAN + "|" + c.srcAddress() + "|" + c.dstAddress();
                put(out, new NetworkSentinelFinding(key, CAT_PORT_SCAN, unknownSrc ? SEV_CRITICAL : SEV_HIGH,
                        "Port scan observed from " + c.srcAddress() + " towards " + c.dstAddress(),
                        c.srcAddress() + " probed " + c.distinctDstPorts() + " distinct ports on " + c.dstAddress()
                                + " during the capture"
                                + (unknownSrc ? " — the scanner is not a known device." : "."),
                        SentinelFlowDto.SCOPE_LAN.equals(srcScope))
                        .evidence("source", c.srcAddress())
                        .evidence("sourceMac", srcMac != null ? formatMac(srcMac) : null)
                        .evidence("target", c.dstAddress())
                        .evidence("distinctPorts", c.distinctDstPorts())
                        .evidence("packets", c.packets()));
            }
            if (c.synOnly() && SentinelFlowDto.SCOPE_LAN.equals(dstScope)) {
                synTargetsBySrc.computeIfAbsent(c.srcAddress(), k -> new HashSet<>()).add(c.dstAddress());
            }
            if (SentinelFlowDto.SCOPE_LAN.equals(srcScope) && SentinelIpUtil.isPublic(dstScope)
                    && !SentinelIpUtil.inAny(c.dstAddress(), in.trustedCidrs())) {
                publicDstByLanSrc.computeIfAbsent(c.srcAddress(), k -> new HashSet<>()).add(c.dstAddress());
            }
        }
        for (Map.Entry<String, Set<String>> e : synTargetsBySrc.entrySet()) {
            if (e.getValue().size() < SWEEP_DISTINCT_HOSTS) {
                continue;
            }
            String src = e.getKey();
            String srcMac = ipToMac.get(src);
            boolean unknownSrc = srcMac != null && !knownMacs.contains(srcMac);
            put(out, new NetworkSentinelFinding(CAT_HOST_SWEEP + "|" + src, CAT_HOST_SWEEP,
                    unknownSrc ? SEV_CRITICAL : SEV_HIGH,
                    "Host discovery sweep observed from " + src,
                    src + " sent connection attempts (SYN without reply) to " + e.getValue().size()
                            + " different LAN hosts: reconnaissance of your network from inside.",
                    true)
                    .evidence("source", src)
                    .evidence("sourceMac", srcMac != null ? formatMac(srcMac) : null)
                    .evidence("targets", e.getValue().size()));
        }
        for (Map.Entry<String, Set<String>> e : publicDstByLanSrc.entrySet()) {
            String src = e.getKey();
            String mac = ipToMac.get(src);
            if (mac == null || knownMacs.contains(mac)) {
                continue;
            }
            put(out, new NetworkSentinelFinding(CAT_UNKNOWN_DEVICE_TRAFFIC + "|" + src, CAT_UNKNOWN_DEVICE_TRAFFIC,
                    SEV_HIGH,
                    "Unknown LAN device exchanging traffic with the Internet (" + src + ")",
                    src + " (MAC " + formatMac(mac) + ") is not in the known-device inventory and talked to "
                            + e.getValue().size() + " Internet host(s) during the capture.",
                    true)
                    .evidence("source", src)
                    .evidence("sourceMac", formatMac(mac))
                    .evidence("publicPeers", e.getValue().size())
                    .evidence("samplePeers", new ArrayList<>(e.getValue()).subList(0, Math.min(5, e.getValue().size()))));
        }

        // ARP: one IP, several MACs within the same capture = spoofing; drift vs baseline = change.
        Map<String, Set<String>> macsByIp = new LinkedHashMap<>();
        for (SentinelCaptureResult.IpMac p : cap.ipToMac()) {
            if (p.ip() == null || p.mac() == null || SentinelIpUtil.isBroadcastOrEmptyMac(p.mac())) {
                continue;
            }
            macsByIp.computeIfAbsent(p.ip(), k -> new HashSet<>()).add(SentinelIpUtil.normalizeMac(p.mac()));
        }
        for (Map.Entry<String, Set<String>> e : macsByIp.entrySet()) {
            String ip = e.getKey();
            if (e.getValue().size() >= 2) {
                put(out, new NetworkSentinelFinding(CAT_ARP_SPOOF + "|" + ip, CAT_ARP_SPOOF, SEV_CRITICAL,
                        "ARP spoofing: several MAC addresses claim " + ip,
                        ip + " was announced by " + e.getValue().size() + " different MAC addresses during the same capture ("
                                + String.join(", ", e.getValue().stream().map(NetworkFlowAnalyzer::formatMac).toList())
                                + "). Someone may be intercepting traffic (man-in-the-middle).",
                        true)
                        .evidence("ip", ip)
                        .evidence("macs", e.getValue().stream().map(NetworkFlowAnalyzer::formatMac).toList()));
                continue;
            }
            String mac = e.getValue().iterator().next();
            String previous = baseline.getArpTable().get(ip);
            if (!in.learning() && previous != null && !previous.equals(mac) && !localAddresses.contains(ip)) {
                boolean gatewayLike = ip.endsWith(".1") || ip.endsWith(".254");
                put(out, new NetworkSentinelFinding(CAT_ARP_CHANGE + "|" + ip, CAT_ARP_CHANGE,
                        gatewayLike ? SEV_HIGH : SEV_MEDIUM,
                        "MAC address changed for " + ip + (gatewayLike ? " (gateway-like address)" : ""),
                        ip + " was " + formatMac(previous) + " in previous sweeps and is now " + formatMac(mac)
                                + ". Legitimate after a DHCP reassignment or hardware swap; otherwise a spoofing indicator.",
                        gatewayLike)
                        .evidence("ip", ip)
                        .evidence("previousMac", formatMac(previous))
                        .evidence("currentMac", formatMac(mac)));
            }
        }

        // DNS: tunneling-like names and abnormal query volume.
        Map<String, Long> queriesByClient = new HashMap<>();
        for (SentinelCaptureResult.DnsQuery q : cap.dnsQueries()) {
            queriesByClient.merge(q.client(), q.count(), Long::sum);
            String name = q.name() != null ? q.name() : "";
            int longestLabel = 0;
            for (String label : name.split("\\.")) {
                longestLabel = Math.max(longestLabel, label.length());
            }
            if (longestLabel >= DNS_LABEL_SUSPECT_LENGTH || name.length() > 120) {
                put(out, new NetworkSentinelFinding(CAT_DNS_SUSPECT + "|" + q.client() + "|" + registrable(name),
                        CAT_DNS_SUSPECT, SEV_MEDIUM,
                        "DNS query with tunneling-like name from " + q.client(),
                        q.client() + " asked for " + abbreviate(name, 90) + " (label length " + longestLabel
                                + "). Very long labels are typical of data exfiltration over DNS.",
                        false)
                        .evidence("client", q.client())
                        .evidence("name", abbreviate(name, 200))
                        .evidence("count", q.count()));
            }
        }
        for (Map.Entry<String, Long> e : queriesByClient.entrySet()) {
            if (e.getValue() >= DNS_QUERIES_PER_CLIENT_SUSPECT) {
                put(out, new NetworkSentinelFinding(CAT_DNS_SUSPECT + "|" + e.getKey() + "|volume", CAT_DNS_SUSPECT,
                        SEV_MEDIUM,
                        "Abnormal DNS query volume from " + e.getKey(),
                        e.getKey() + " issued " + e.getValue() + " DNS queries in " + cap.requestedSeconds()
                                + " s (malware beaconing, DNS tunnel or misconfigured software).",
                        false)
                        .evidence("client", e.getKey())
                        .evidence("queries", e.getValue()));
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------

    private static Map<String, String> buildIpToMac(Input in) {
        Map<String, String> m = new HashMap<>();
        if (in.devices() != null) {
            for (Map<String, Object> d : in.devices()) {
                String ip = str(d.get("ipAddress"));
                String mac = SentinelIpUtil.normalizeMac(str(d.get("macAddress")));
                if (ip != null && mac.length() == 12) {
                    m.put(ip, mac);
                }
            }
        }
        if (in.capture() != null && in.capture().ipToMac() != null) {
            for (SentinelCaptureResult.IpMac p : in.capture().ipToMac()) {
                String mac = SentinelIpUtil.normalizeMac(p.mac());
                if (p.ip() != null && mac.length() == 12 && !SentinelIpUtil.isBroadcastOrEmptyMac(mac)) {
                    m.putIfAbsent(p.ip(), mac);
                }
            }
        }
        return m;
    }

    private static void put(Map<String, NetworkSentinelFinding> out, NetworkSentinelFinding f) {
        NetworkSentinelFinding existing = out.get(f.getKey());
        if (existing == null || NetworkSentinelFinding.severityRank(f.getSeverity()) > NetworkSentinelFinding
                .severityRank(existing.getSeverity())) {
            out.put(f.getKey(), f);
        }
    }

    static boolean isLoopbackBound(String address) {
        if (address == null) {
            return false;
        }
        return address.startsWith("127.") || address.equals("::1") || address.equals("0:0:0:0:0:0:0:1");
    }

    static String family(String protocol) {
        return protocol != null && protocol.toLowerCase(Locale.ROOT).startsWith("udp") ? "udp" : "tcp";
    }

    static String formatMac(String normalized) {
        String n = SentinelIpUtil.normalizeMac(normalized);
        if (n.length() != 12) {
            return normalized;
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 12; i += 2) {
            if (i > 0) {
                sb.append(':');
            }
            sb.append(n, i, i + 2);
        }
        return sb.toString();
    }

    private static String registrable(String name) {
        String[] parts = name.split("\\.");
        if (parts.length <= 2) {
            return name;
        }
        return parts[parts.length - 2] + "." + parts[parts.length - 1];
    }

    private static String abbreviate(String s, int max) {
        if (s == null || s.length() <= max) {
            return s;
        }
        return s.substring(0, max - 1) + "…";
    }

    private static String str(Object o) {
        if (o == null) {
            return null;
        }
        String s = String.valueOf(o).trim();
        return s.isEmpty() ? null : s;
    }

    /** Collection → Set of normalized MACs (12 hex chars). */
    public static Set<String> normalizeMacs(Collection<String> macs) {
        Set<String> out = new HashSet<>();
        if (macs == null) {
            return out;
        }
        for (String m : macs) {
            String n = SentinelIpUtil.normalizeMac(m);
            if (n.length() == 12) {
                out.add(n);
            }
        }
        return out;
    }
}
