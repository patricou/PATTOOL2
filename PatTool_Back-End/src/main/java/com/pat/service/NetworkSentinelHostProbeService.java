package com.pat.service;

import com.pat.dto.SentinelCapabilitiesDto;
import com.pat.dto.SentinelCaptureResult;
import com.pat.dto.SentinelFlowDto;
import com.pat.dto.SentinelLogonDto;
import com.pat.service.SentinelIpUtil.Cidr;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads the local view of the network from the PatTool backend host: socket table, listening ports,
 * open remote sessions, successful logons and (when tshark / tcpdump exist) a short packet capture.
 * Everything is best effort and OS dependent; failures are returned as warnings, never thrown.
 */
@Service
public class NetworkSentinelHostProbeService {

    private static final Logger log = LoggerFactory.getLogger(NetworkSentinelHostProbeService.class);

    public enum Platform { WINDOWS, LINUX, MACOS, OTHER }

    private static final int CMD_TIMEOUT_SEC = 25;
    private static final long TOOL_CACHE_MS = 10 * 60_000L;

    private static final Pattern SS_PROCESS = Pattern.compile("\\(\\(\"([^\"]+)\",pid=(\\d+)");
    private static final Pattern LSOF_LINE = Pattern.compile(
            "^(\\S+)\\s+(\\d+)\\s+\\S+\\s+\\S+\\s+(IPv4|IPv6)\\s+\\S+\\s+\\S+\\s+(TCP|UDP)\\s+(\\S+)(?:\\s+\\((\\w+)\\))?");
    private static final Pattern SSH_ACCEPTED = Pattern.compile(
            "Accepted (\\S+) for (\\S+) from (\\S+) port (\\d+)");
    private static final Pattern WHO_LINE = Pattern.compile("^(\\S+)\\s+(\\S+)\\s+(\\S+(?: \\S+)?)\\s*(?:\\((.+)\\))?\\s*$");
    private static final Pattern XML_DATA = Pattern.compile("<Data Name='([^']+)'>([^<]*)</Data>");
    private static final Pattern XML_TIME = Pattern.compile("SystemTime='([^']+)'");
    private static final Pattern TCPDUMP_IP = Pattern.compile(
            "(\\d{1,3}(?:\\.\\d{1,3}){3})\\.(\\d+) > (\\d{1,3}(?:\\.\\d{1,3}){3})\\.(\\d+):\\s*(tcp|udp|TCP|UDP)");
    private static final Pattern TCPDUMP_LEN = Pattern.compile("length (\\d+)");
    private static final Pattern TCPDUMP_ARP_REPLY = Pattern.compile("Reply (\\S+) is-at ([0-9a-fA-F:]{17})");
    private static final Pattern TCPDUMP_ARP_REQ = Pattern.compile("Request who-has (\\S+) tell (\\S+)");
    private static final Pattern TCPDUMP_MACS = Pattern.compile("^\\S+\\s+([0-9a-f:]{17}) > ([0-9a-f:]{17})");
    private static final Pattern TSHARK_D_LINE = Pattern.compile("^\\d+\\.\\s+(\\S+)(?:\\s+\\((.*)\\))?\\s*$");

    private volatile Map<String, String> toolCache = Map.of();
    private volatile long toolCacheAt = 0;

    public record HostNetworkContext(String hostName, String osName, Platform platform,
            List<String> localAddresses, List<Cidr> lanCidrs, Map<String, String> ifaceByAddress) {
    }

    private record CommandResult(int exitCode, List<String> stdout, String stderr, boolean timedOut, boolean started) {
        boolean ok() {
            return started && !timedOut && exitCode == 0;
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Platform / context
    // ------------------------------------------------------------------------------------------------------------

    public Platform platform() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("win")) {
            return Platform.WINDOWS;
        }
        if (os.contains("mac") || os.contains("darwin")) {
            return Platform.MACOS;
        }
        if (os.contains("nux") || os.contains("nix") || os.contains("bsd")) {
            return Platform.LINUX;
        }
        return Platform.OTHER;
    }

    public HostNetworkContext networkContext() {
        List<String> locals = new ArrayList<>();
        List<Cidr> cidrs = new ArrayList<>();
        Map<String, String> ifaceByAddress = new HashMap<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) {
                    continue;
                }
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a == null || a.isLoopbackAddress() || a.isLinkLocalAddress()) {
                        continue;
                    }
                    String host = a.getHostAddress();
                    int zone = host.indexOf('%');
                    if (zone > 0) {
                        host = host.substring(0, zone);
                    }
                    locals.add(host);
                    ifaceByAddress.put(host, ni.getName());
                    short prefix = ia.getNetworkPrefixLength();
                    if (a instanceof Inet4Address && prefix > 0 && prefix <= 32) {
                        Cidr c = SentinelIpUtil.parseCidr(host + "/" + prefix);
                        if (c != null) {
                            cidrs.add(c);
                        }
                    } else if (a instanceof Inet6Address && prefix > 0 && prefix <= 128 && !SentinelIpUtil.isPrivateRange(a)) {
                        Cidr c = SentinelIpUtil.parseCidr(host + "/" + prefix);
                        if (c != null) {
                            cidrs.add(c);
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Interface enumeration failed: {}", e.toString());
        }
        String hostName = "PatTool-backend";
        try {
            String h = InetAddress.getLocalHost().getHostName();
            if (h != null && !h.isBlank()) {
                hostName = h;
            }
        } catch (Exception ignored) {
            // keep default
        }
        return new HostNetworkContext(hostName, System.getProperty("os.name", "unknown"), platform(), locals, cidrs,
                ifaceByAddress);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Capabilities
    // ------------------------------------------------------------------------------------------------------------

    public SentinelCapabilitiesDto capabilities(boolean deviceScanAvailable) {
        HostNetworkContext ctx = networkContext();
        Platform p = ctx.platform();
        List<String> hints = new ArrayList<>();

        String connTool = switch (p) {
            case WINDOWS -> "netstat";
            case LINUX -> tool("ss") != null ? "ss" : (tool("netstat") != null ? "netstat" : null);
            case MACOS -> tool("lsof") != null ? "lsof" : null;
            default -> null;
        };

        String captureTool = resolveCaptureTool();
        List<String> ifaces = captureTool != null ? listCaptureInterfaces(captureTool) : List.of();
        if (captureTool == null) {
            switch (p) {
                case WINDOWS -> hints.add("Install Wireshark (with Npcap) so that tshark.exe is available: packet capture "
                        + "enables ARP-spoofing, port-scan and unknown-device-traffic detection.");
                case LINUX -> hints.add("Install tshark (apt install tshark, then add the service user to the 'wireshark' group) "
                        + "or tcpdump (setcap cap_net_raw,cap_net_admin=eip $(which tcpdump)) to enable packet capture.");
                case MACOS -> hints.add("Install Wireshark (brew install --cask wireshark) so that tshark is available, or allow "
                        + "tcpdump access to /dev/bpf*.");
                default -> hints.add("No packet capture tool detected.");
            }
        } else if (p != Platform.WINDOWS) {
            hints.add("Packet capture needs raw socket privileges for the PatTool service user (wireshark group / setcap).");
        }

        String logonTool = switch (p) {
            case WINDOWS -> "wevtutil (Security log, needs elevated service)";
            case LINUX -> tool("journalctl") != null ? "journalctl" : (Files.isReadable(Path.of("/var/log/auth.log"))
                    ? "/var/log/auth.log" : (tool("last") != null ? "last" : null));
            case MACOS -> tool("last") != null ? "last" : null;
            default -> null;
        };
        if (p == Platform.WINDOWS) {
            hints.add("Reading successful logons (event 4624) requires the PatTool service to run elevated or as a member of "
                    + "'Event Log Readers'.");
        }
        String sessionTool = switch (p) {
            case WINDOWS -> "query user";
            case LINUX, MACOS -> tool("who") != null ? "who" : null;
            default -> null;
        };
        hints.add("The sentinel sees the traffic of the host running PatTool and broadcast/ARP traffic of its LAN segment. "
                + "On a switched network it cannot see unicast traffic between two other devices.");

        return new SentinelCapabilitiesDto(ctx.hostName(), ctx.osName(), p.name(), ctx.localAddresses(),
                ctx.lanCidrs().stream().map(Cidr::toString).toList(), connTool != null, connTool, captureTool != null,
                captureTool, ifaces, logonTool != null, logonTool, sessionTool != null, sessionTool, deviceScanAvailable,
                hints);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Connection table
    // ------------------------------------------------------------------------------------------------------------

    public List<SentinelFlowDto> snapshotConnections(HostNetworkContext ctx, List<String> warnings) {
        List<SentinelFlowDto> raw;
        try {
            raw = switch (ctx.platform()) {
                case WINDOWS -> readWindowsNetstat(warnings);
                case LINUX -> tool("ss") != null ? readLinuxSs(warnings) : readGenericNetstat(warnings);
                case MACOS -> readMacLsof(warnings);
                default -> readGenericNetstat(warnings);
            };
        } catch (Exception e) {
            warnings.add("Connection table unavailable: " + e.getMessage());
            return List.of();
        }
        return finalizeFlows(raw, ctx);
    }

    private List<SentinelFlowDto> finalizeFlows(List<SentinelFlowDto> raw, HostNetworkContext ctx) {
        Set<String> listenerPorts = new HashSet<>();
        for (SentinelFlowDto f : raw) {
            if (f.isListener()) {
                listenerPorts.add(family(f.protocol()) + ":" + f.localPort());
            }
        }
        List<SentinelFlowDto> out = new ArrayList<>(raw.size());
        for (SentinelFlowDto f : raw) {
            String direction = f.direction();
            if (!f.isListener()) {
                boolean inbound = listenerPorts.contains(family(f.protocol()) + ":" + f.localPort());
                direction = inbound ? SentinelFlowDto.DIR_INBOUND : SentinelFlowDto.DIR_OUTBOUND;
            }
            String scope = SentinelIpUtil.classify(f.remoteAddress(), ctx.lanCidrs());
            out.add(new SentinelFlowDto(f.protocol(), f.localAddress(), f.localPort(), f.remoteAddress(), f.remotePort(),
                    f.state(), f.pid(), f.processName(), direction, scope));
        }
        return out;
    }

    private static String family(String protocol) {
        if (protocol == null) {
            return "tcp";
        }
        return protocol.toLowerCase(Locale.ROOT).startsWith("udp") ? "udp" : "tcp";
    }

    private List<SentinelFlowDto> readWindowsNetstat(List<String> warnings) {
        CommandResult res = run(List.of("netstat", "-ano"), CMD_TIMEOUT_SEC, Charset.defaultCharset());
        if (!res.started()) {
            warnings.add("netstat not available on this host.");
            return List.of();
        }
        Map<Integer, String> names = windowsProcessNames();
        List<SentinelFlowDto> flows = new ArrayList<>();
        for (String line : res.stdout()) {
            String t = line.trim();
            if (!(t.startsWith("TCP") || t.startsWith("UDP"))) {
                continue;
            }
            String[] tok = t.split("\\s+");
            if (tok.length < 4) {
                continue;
            }
            String proto = tok[0].toLowerCase(Locale.ROOT);
            String[] local = splitHostPort(tok[1]);
            String[] remote = splitHostPort(tok[2]);
            String state;
            Integer pid;
            if (proto.startsWith("tcp")) {
                state = tok.length >= 5 ? tok[3] : "";
                pid = parseIntOrNull(tok[tok.length - 1]);
            } else {
                state = "UNCONN";
                pid = parseIntOrNull(tok[tok.length - 1]);
            }
            if (local[0].contains(":") && !proto.endsWith("6")) {
                proto = proto + "6";
            }
            boolean listener = "LISTENING".equalsIgnoreCase(state) || "UNCONN".equals(state);
            flows.add(new SentinelFlowDto(proto, local[0], parseIntOrZero(local[1]), remote[0], parseIntOrZero(remote[1]),
                    normalizeState(state), pid, pid != null ? names.get(pid) : null,
                    listener ? SentinelFlowDto.DIR_LISTEN : SentinelFlowDto.DIR_UNKNOWN, null));
        }
        return flows;
    }

    private Map<Integer, String> windowsProcessNames() {
        Map<Integer, String> names = new HashMap<>();
        CommandResult res = run(List.of("tasklist", "/fo", "csv", "/nh"), CMD_TIMEOUT_SEC, Charset.defaultCharset());
        if (!res.started()) {
            return names;
        }
        for (String line : res.stdout()) {
            if (!line.startsWith("\"")) {
                continue;
            }
            String[] parts = line.split("\",\"");
            if (parts.length < 2) {
                continue;
            }
            String name = parts[0].replace("\"", "").trim();
            Integer pid = parseIntOrNull(parts[1].replace("\"", "").trim());
            if (pid != null) {
                names.put(pid, name);
            }
        }
        return names;
    }

    private List<SentinelFlowDto> readLinuxSs(List<String> warnings) {
        CommandResult res = run(List.of("ss", "-tunapH"), CMD_TIMEOUT_SEC, StandardCharsets.UTF_8);
        if (!res.started()) {
            warnings.add("ss not available on this host.");
            return List.of();
        }
        if (!res.ok() && res.stdout().isEmpty()) {
            warnings.add("ss failed: " + firstLine(res.stderr()));
            return List.of();
        }
        List<SentinelFlowDto> flows = new ArrayList<>();
        for (String line : res.stdout()) {
            String t = line.trim();
            if (t.isEmpty() || t.startsWith("Netid")) {
                continue;
            }
            String[] tok = t.split("\\s+");
            if (tok.length < 6) {
                continue;
            }
            String proto = tok[0].toLowerCase(Locale.ROOT);
            String state = tok[1];
            String[] local = splitHostPort(tok[4]);
            String[] remote = splitHostPort(tok[5]);
            Integer pid = null;
            String pname = null;
            Matcher m = SS_PROCESS.matcher(t);
            if (m.find()) {
                pname = m.group(1);
                pid = parseIntOrNull(m.group(2));
            }
            if (local[0].contains(":") && !proto.endsWith("6")) {
                proto = proto + "6";
            }
            boolean listener = "LISTEN".equalsIgnoreCase(state) || "UNCONN".equalsIgnoreCase(state);
            flows.add(new SentinelFlowDto(proto, local[0], parseIntOrZero(local[1]), remote[0], parseIntOrZero(remote[1]),
                    normalizeState(state), pid, pname, listener ? SentinelFlowDto.DIR_LISTEN : SentinelFlowDto.DIR_UNKNOWN,
                    null));
        }
        return flows;
    }

    private List<SentinelFlowDto> readGenericNetstat(List<String> warnings) {
        CommandResult res = run(List.of("netstat", "-tunap"), CMD_TIMEOUT_SEC, StandardCharsets.UTF_8);
        if (!res.started()) {
            warnings.add("Neither ss nor netstat available on this host.");
            return List.of();
        }
        List<SentinelFlowDto> flows = new ArrayList<>();
        for (String line : res.stdout()) {
            String t = line.trim();
            if (!(t.startsWith("tcp") || t.startsWith("udp"))) {
                continue;
            }
            String[] tok = t.split("\\s+");
            if (tok.length < 5) {
                continue;
            }
            String proto = tok[0].toLowerCase(Locale.ROOT);
            String[] local = splitHostPort(tok[3]);
            String[] remote = splitHostPort(tok[4]);
            String state = proto.startsWith("tcp") && tok.length >= 6 ? tok[5] : "UNCONN";
            Integer pid = null;
            String pname = null;
            String last = tok[tok.length - 1];
            int slash = last.indexOf('/');
            if (slash > 0) {
                pid = parseIntOrNull(last.substring(0, slash));
                pname = last.substring(slash + 1);
            }
            boolean listener = "LISTEN".equalsIgnoreCase(state) || "UNCONN".equals(state);
            flows.add(new SentinelFlowDto(proto, local[0], parseIntOrZero(local[1]), remote[0], parseIntOrZero(remote[1]),
                    normalizeState(state), pid, pname, listener ? SentinelFlowDto.DIR_LISTEN : SentinelFlowDto.DIR_UNKNOWN,
                    null));
        }
        return flows;
    }

    private List<SentinelFlowDto> readMacLsof(List<String> warnings) {
        CommandResult res = run(List.of("lsof", "-nP", "-iTCP", "-iUDP"), CMD_TIMEOUT_SEC, StandardCharsets.UTF_8);
        if (!res.started()) {
            warnings.add("lsof not available on this host.");
            return List.of();
        }
        List<SentinelFlowDto> flows = new ArrayList<>();
        for (String line : res.stdout()) {
            Matcher m = LSOF_LINE.matcher(line.trim());
            if (!m.find()) {
                continue;
            }
            String pname = m.group(1);
            Integer pid = parseIntOrNull(m.group(2));
            boolean v6 = "IPv6".equals(m.group(3));
            String proto = m.group(4).toLowerCase(Locale.ROOT) + (v6 ? "6" : "");
            String name = m.group(5);
            String state = m.group(6) != null ? m.group(6) : (proto.startsWith("udp") ? "UNCONN" : "");
            String localPart = name;
            String remotePart = "*:0";
            int arrow = name.indexOf("->");
            if (arrow > 0) {
                localPart = name.substring(0, arrow);
                remotePart = name.substring(arrow + 2);
            }
            String[] local = splitHostPort(localPart);
            String[] remote = splitHostPort(remotePart);
            boolean listener = "LISTEN".equalsIgnoreCase(state) || "UNCONN".equals(state);
            flows.add(new SentinelFlowDto(proto, local[0], parseIntOrZero(local[1]), remote[0], parseIntOrZero(remote[1]),
                    normalizeState(state), pid, pname, listener ? SentinelFlowDto.DIR_LISTEN : SentinelFlowDto.DIR_UNKNOWN,
                    null));
        }
        return flows;
    }

    /** "192.168.1.10:443" / "[::1]:443" / "*:*" / "0.0.0.0%eth0:68" → [host, port]. */
    static String[] splitHostPort(String s) {
        if (s == null || s.isEmpty()) {
            return new String[] {"*", "0"};
        }
        String host;
        String port;
        if (s.startsWith("[")) {
            int close = s.indexOf("]:");
            if (close > 0) {
                host = s.substring(1, close);
                port = s.substring(close + 2);
            } else {
                host = s.replace("[", "").replace("]", "");
                port = "0";
            }
        } else {
            int last = s.lastIndexOf(':');
            if (last < 0) {
                host = s;
                port = "0";
            } else {
                host = s.substring(0, last);
                port = s.substring(last + 1);
            }
        }
        int zone = host.indexOf('%');
        if (zone > 0) {
            host = host.substring(0, zone);
        }
        if (host.isEmpty()) {
            host = "*";
        }
        if (port.equals("*")) {
            port = "0";
        }
        return new String[] {host, port};
    }

    private static String normalizeState(String s) {
        if (s == null) {
            return "";
        }
        String u = s.toUpperCase(Locale.ROOT);
        if (u.equals("LISTENING")) {
            return "LISTEN";
        }
        if (u.equals("ESTAB")) {
            return "ESTABLISHED";
        }
        return u;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Logons and sessions
    // ------------------------------------------------------------------------------------------------------------

    public List<SentinelLogonDto> recentLogons(HostNetworkContext ctx, int hours, List<String> warnings) {
        try {
            return switch (ctx.platform()) {
                case WINDOWS -> windowsLogons(ctx, warnings);
                case LINUX -> linuxLogons(ctx, hours, warnings);
                case MACOS -> lastLogons(ctx, warnings);
                default -> List.of();
            };
        } catch (Exception e) {
            warnings.add("Logon history unavailable: " + e.getMessage());
            return List.of();
        }
    }

    private List<SentinelLogonDto> windowsLogons(HostNetworkContext ctx, List<String> warnings) {
        CommandResult res = run(List.of("wevtutil", "qe", "Security", "/q:*[System[(EventID=4624)]]", "/c:300",
                "/rd:true", "/f:xml"), CMD_TIMEOUT_SEC, Charset.defaultCharset());
        if (!res.started()) {
            warnings.add("wevtutil not available.");
            return List.of();
        }
        if (!res.ok() && res.stdout().isEmpty()) {
            warnings.add("Security event log not readable (run PatTool elevated or as 'Event Log Readers'): "
                    + firstLine(res.stderr()));
            return List.of();
        }
        String xml = String.join("\n", res.stdout());
        List<SentinelLogonDto> out = new ArrayList<>();
        for (String ev : xml.split("</Event>")) {
            Map<String, String> data = new HashMap<>();
            Matcher m = XML_DATA.matcher(ev);
            while (m.find()) {
                data.put(m.group(1), m.group(2));
            }
            if (data.isEmpty()) {
                continue;
            }
            String type = data.getOrDefault("LogonType", "");
            if (!(type.equals("3") || type.equals("10") || type.equals("8") || type.equals("9"))) {
                continue;
            }
            String user = data.getOrDefault("TargetUserName", "");
            String ip = data.getOrDefault("IpAddress", "-");
            if (user.isEmpty() || user.endsWith("$") || user.equalsIgnoreCase("ANONYMOUS LOGON")
                    || user.equalsIgnoreCase("SYSTEM") || user.startsWith("DWM-") || user.startsWith("UMFD-")) {
                continue;
            }
            if (ip.equals("-") || ip.isEmpty() || ip.equals("::1") || ip.equals("127.0.0.1")) {
                continue;
            }
            String when = null;
            Matcher tm = XML_TIME.matcher(ev);
            if (tm.find()) {
                when = tm.group(1);
            }
            String method = switch (type) {
                case "10" -> "rdp";
                case "3" -> "network";
                case "8" -> "network-cleartext";
                default -> "new-credentials";
            };
            String domain = data.getOrDefault("TargetDomainName", "");
            String fullUser = domain.isEmpty() ? user : domain + "\\" + user;
            out.add(new SentinelLogonDto(SentinelLogonDto.KIND_LOGON, fullUser, ip,
                    SentinelIpUtil.classify(ip, ctx.lanCidrs()), method, when,
                    "4624 LogonType=" + type + " " + data.getOrDefault("AuthenticationPackageName", "")));
        }
        return out;
    }

    private List<SentinelLogonDto> linuxLogons(HostNetworkContext ctx, int hours, List<String> warnings) {
        List<String> lines = new ArrayList<>();
        if (tool("journalctl") != null) {
            CommandResult res = run(List.of("journalctl", "-o", "short-iso", "--no-pager", "--since", "-" + hours + "h",
                    "_COMM=sshd"), CMD_TIMEOUT_SEC, StandardCharsets.UTF_8);
            if (res.started() && res.ok()) {
                lines.addAll(res.stdout());
            } else if (res.started()) {
                warnings.add("journalctl sshd query failed: " + firstLine(res.stderr()));
            }
        }
        if (lines.isEmpty()) {
            for (String p : List.of("/var/log/auth.log", "/var/log/secure")) {
                Path path = Path.of(p);
                if (Files.isReadable(path)) {
                    try {
                        List<String> all = Files.readAllLines(path, StandardCharsets.ISO_8859_1);
                        lines.addAll(all.subList(Math.max(0, all.size() - 5000), all.size()));
                        break;
                    } catch (IOException e) {
                        warnings.add("Cannot read " + p + ": " + e.getMessage());
                    }
                }
            }
        }
        List<SentinelLogonDto> out = new ArrayList<>();
        for (String line : lines) {
            Matcher m = SSH_ACCEPTED.matcher(line);
            if (!m.find()) {
                continue;
            }
            String when = line.length() > 25 ? line.substring(0, Math.min(line.length(), 32)).split("\\s+")[0] : null;
            out.add(new SentinelLogonDto(SentinelLogonDto.KIND_LOGON, m.group(2), m.group(3),
                    SentinelIpUtil.classify(m.group(3), ctx.lanCidrs()), "ssh-" + m.group(1), when, line.trim()));
        }
        if (out.isEmpty() && lines.isEmpty()) {
            return lastLogons(ctx, warnings);
        }
        return out;
    }

    private List<SentinelLogonDto> lastLogons(HostNetworkContext ctx, List<String> warnings) {
        if (tool("last") == null) {
            return List.of();
        }
        CommandResult res = run(List.of("last", "-i", "-n", "100"), CMD_TIMEOUT_SEC, StandardCharsets.UTF_8);
        if (!res.started() || !res.ok()) {
            return List.of();
        }
        List<SentinelLogonDto> out = new ArrayList<>();
        for (String line : res.stdout()) {
            String[] tok = line.trim().split("\\s+");
            if (tok.length < 4) {
                continue;
            }
            String user = tok[0];
            String src = tok[2];
            if (user.equals("reboot") || user.equals("wtmp") || user.equals("shutdown")) {
                continue;
            }
            if (SentinelIpUtil.parseAddress(src) == null || src.equals("0.0.0.0")) {
                continue;
            }
            out.add(new SentinelLogonDto(SentinelLogonDto.KIND_LOGON, user, src,
                    SentinelIpUtil.classify(src, ctx.lanCidrs()), tok[1], null, line.trim()));
        }
        return out;
    }

    public List<SentinelLogonDto> activeSessions(HostNetworkContext ctx, List<String> warnings) {
        try {
            return switch (ctx.platform()) {
                case WINDOWS -> windowsSessions(warnings);
                case LINUX, MACOS -> whoSessions(ctx, warnings);
                default -> List.of();
            };
        } catch (Exception e) {
            warnings.add("Session list unavailable: " + e.getMessage());
            return List.of();
        }
    }

    private List<SentinelLogonDto> windowsSessions(List<String> warnings) {
        String sysRoot = System.getenv("SystemRoot") != null ? System.getenv("SystemRoot") : "C:\\Windows";
        CommandResult res = null;
        for (List<String> cmd : List.of(
                List.of("query", "user"),
                List.of(sysRoot + "\\Sysnative\\query.exe", "user"),
                List.of(sysRoot + "\\System32\\query.exe", "user"),
                List.of("qwinsta"),
                List.of(sysRoot + "\\Sysnative\\qwinsta.exe"))) {
            CommandResult r = run(cmd, CMD_TIMEOUT_SEC, Charset.defaultCharset());
            if (r.started()) {
                res = r;
                break;
            }
        }
        if (res == null) {
            warnings.add("'query user' / 'qwinsta' unavailable on this Windows edition: open RDP sessions cannot be listed; "
                    + "inbound RDP/SSH connections are still detected from the socket table.");
            return List.of();
        }
        List<SentinelLogonDto> out = new ArrayList<>();
        boolean first = true;
        for (String line : res.stdout()) {
            if (first) {
                first = false;
                continue; // header (localized)
            }
            String t = line.replace(">", " ").trim();
            if (t.isEmpty()) {
                continue;
            }
            String[] tok = t.split("\\s+");
            if (tok.length < 3) {
                continue;
            }
            String user = tok[0];
            String session = tok[1];
            boolean rdp = session.toLowerCase(Locale.ROOT).startsWith("rdp");
            if (!rdp && !session.toLowerCase(Locale.ROOT).startsWith("console")) {
                // "query user" rows for disconnected sessions have no session name: shift
                if (parseIntOrNull(session) != null) {
                    session = "(disconnected)";
                }
            }
            out.add(new SentinelLogonDto(SentinelLogonDto.KIND_SESSION, user, null, null, rdp ? "rdp" : session, null,
                    t));
        }
        return out;
    }

    private List<SentinelLogonDto> whoSessions(HostNetworkContext ctx, List<String> warnings) {
        if (tool("who") == null) {
            return List.of();
        }
        CommandResult res = run(List.of("who"), CMD_TIMEOUT_SEC, StandardCharsets.UTF_8);
        if (!res.started() || !res.ok()) {
            return List.of();
        }
        List<SentinelLogonDto> out = new ArrayList<>();
        for (String line : res.stdout()) {
            Matcher m = WHO_LINE.matcher(line.trim());
            if (!m.find()) {
                continue;
            }
            String src = m.group(4);
            String scope = src != null && SentinelIpUtil.parseAddress(src) != null
                    ? SentinelIpUtil.classify(src, ctx.lanCidrs()) : null;
            out.add(new SentinelLogonDto(SentinelLogonDto.KIND_SESSION, m.group(1), src, scope, m.group(2), m.group(3),
                    line.trim()));
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Packet capture
    // ------------------------------------------------------------------------------------------------------------

    public String resolveCaptureTool() {
        if (tool("tshark") != null) {
            return "tshark";
        }
        if (platform() != Platform.WINDOWS && tool("tcpdump") != null) {
            return "tcpdump";
        }
        return null;
    }

    public List<String> listCaptureInterfaces(String captureTool) {
        String exe = tool(captureTool);
        if (exe == null) {
            return List.of();
        }
        CommandResult res = run(List.of(exe, "-D"), 15, StandardCharsets.UTF_8);
        if (!res.started()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String line : res.stdout()) {
            String t = line.trim();
            if (t.isEmpty()) {
                continue;
            }
            Matcher m = TSHARK_D_LINE.matcher(t);
            if (m.find()) {
                String name = m.group(1);
                String friendly = m.group(2);
                out.add(friendly != null && !friendly.isBlank() ? name + " (" + friendly + ")" : name);
            } else {
                out.add(t);
            }
        }
        return out;
    }

    public SentinelCaptureResult capture(int seconds, String ifaceOverride, HostNetworkContext ctx,
            Consumer<String> status) {
        int secs = Math.max(5, Math.min(seconds, 120));
        String toolName = resolveCaptureTool();
        if (toolName == null) {
            return SentinelCaptureResult.unavailable(secs, "No packet capture tool (tshark / tcpdump) on this host.");
        }
        String exe = tool(toolName);
        String iface = ifaceOverride != null && !ifaceOverride.isBlank() ? ifaceOverride.trim() : defaultInterface(ctx);
        if (status != null) {
            status.accept("Capturing packets for " + secs + " s with " + toolName
                    + (iface != null ? " on " + iface : "") + "…");
        }
        try {
            if ("tshark".equals(toolName)) {
                return captureTshark(exe, iface, secs, ctx);
            }
            return captureTcpdump(exe, iface, secs, ctx);
        } catch (Exception e) {
            log.warn("Packet capture failed: {}", e.toString());
            return SentinelCaptureResult.unavailable(secs, "Packet capture failed: " + e.getMessage());
        }
    }

    private String defaultInterface(HostNetworkContext ctx) {
        if (ctx.platform() == Platform.WINDOWS) {
            return null; // let tshark pick its first non-loopback adapter (override via prefs)
        }
        // Prefer the interface carrying the primary IPv4 address.
        for (String a : ctx.localAddresses()) {
            if (!a.contains(":")) {
                String ifn = ctx.ifaceByAddress().get(a);
                if (ifn != null && !ifn.isBlank()) {
                    return ifn;
                }
            }
        }
        return ctx.platform() == Platform.LINUX ? "any" : null;
    }

    private static final class Agg {
        long packets;
        long bytes;
        long syn;
        long ack;
    }

    private SentinelCaptureResult captureTshark(String exe, String iface, int secs, HostNetworkContext ctx)
            throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<>(List.of(exe));
        if (iface != null) {
            cmd.add("-i");
            cmd.add(iface);
        }
        cmd.addAll(List.of("-a", "duration:" + secs, "-l", "-n", "-T", "fields", "-E", "separator=|", "-E",
                "occurrence=f"));
        String[] fields = {"frame.len", "eth.src", "eth.dst", "ip.src", "ip.dst", "ipv6.src", "ipv6.dst",
                "_ws.col.Protocol", "tcp.srcport", "tcp.dstport", "udp.srcport", "udp.dstport", "tcp.flags.syn",
                "tcp.flags.ack", "dns.flags.response", "dns.qry.name", "arp.opcode", "arp.src.proto_ipv4",
                "arp.src.hw_mac"};
        for (String f : fields) {
            cmd.add("-e");
            cmd.add(f);
        }
        CommandResult res = run(cmd, secs + 20, StandardCharsets.UTF_8);
        if (!res.started()) {
            return SentinelCaptureResult.unavailable(secs, "tshark could not be started.");
        }
        if (res.stdout().isEmpty() && !res.ok()) {
            return SentinelCaptureResult.unavailable(secs, "tshark error: " + firstLine(res.stderr()));
        }

        Map<String, Agg> convs = new LinkedHashMap<>();
        Map<String, Set<Integer>> dstPortsByPair = new HashMap<>();
        Map<String, Long> dns = new LinkedHashMap<>();
        Map<String, long[]> arp = new LinkedHashMap<>(); // ip|mac|reply -> count
        Map<String, Agg> byHost = new HashMap<>();
        Set<String> ipMacPairs = new LinkedHashSet<>();
        long packets = 0;
        long bytes = 0;

        for (String line : res.stdout()) {
            String[] c = line.split("\\|", -1);
            if (c.length < fields.length) {
                continue;
            }
            packets++;
            long len = parseLongOrZero(c[0]);
            bytes += len;
            String ethSrc = c[1];
            String src = !c[3].isEmpty() ? c[3] : c[5];
            String dst = !c[4].isEmpty() ? c[4] : c[6];
            String protoCol = c[7];
            Integer sport = firstPort(c[8], c[10]);
            Integer dport = firstPort(c[9], c[11]);
            boolean syn = isTrue(c[12]);
            boolean ack = isTrue(c[13]);
            String dnsResp = c[14];
            String dnsName = c[15];
            String arpOp = c[16];
            String arpIp = c[17];
            String arpMac = c[18];

            if (!arpOp.isEmpty() && !arpIp.isEmpty() && !arpMac.isEmpty()) {
                boolean reply = "2".equals(arpOp);
                String k = arpIp + "|" + arpMac.toLowerCase(Locale.ROOT) + "|" + reply;
                arp.computeIfAbsent(k, x -> new long[1])[0]++;
                if (!arpIp.equals("0.0.0.0")) {
                    ipMacPairs.add(arpIp + "|" + arpMac.toLowerCase(Locale.ROOT));
                }
                continue;
            }
            if (src.isEmpty() || dst.isEmpty()) {
                continue;
            }
            String proto = protoCol.isEmpty() ? (sport != null && c[8].isEmpty() ? "UDP" : "TCP") : protoCol;
            String convKey = proto + "|" + src + "|" + dst + "|" + (dport != null ? dport : -1);
            Agg a = convs.computeIfAbsent(convKey, x -> new Agg());
            a.packets++;
            a.bytes += len;
            if (syn) {
                a.syn++;
            }
            if (ack) {
                a.ack++;
            }
            if (dport != null) {
                dstPortsByPair.computeIfAbsent(src + "|" + dst, x -> new HashSet<>()).add(dport);
            }
            Agg h = byHost.computeIfAbsent(src, x -> new Agg());
            h.packets++;
            h.bytes += len;

            if (!ethSrc.isEmpty() && !SentinelIpUtil.isBroadcastOrEmptyMac(ethSrc) && !src.contains(":")
                    && SentinelFlowDto.SCOPE_LAN.equals(SentinelIpUtil.classify(src, ctx.lanCidrs()))) {
                ipMacPairs.add(src + "|" + ethSrc.toLowerCase(Locale.ROOT));
            }
            if (!dnsName.isEmpty() && (dnsResp.isEmpty() || dnsResp.equals("0") || dnsResp.equalsIgnoreCase("false"))) {
                dns.merge(src + "|" + dnsName.toLowerCase(Locale.ROOT), 1L, Long::sum);
            }
        }

        return buildCaptureResult("tshark", secs, packets, bytes, convs, dstPortsByPair, dns, arp, byHost, ipMacPairs,
                res.timedOut() ? "tshark did not stop by itself; capture was interrupted." : null);
    }

    private SentinelCaptureResult captureTcpdump(String exe, String iface, int secs, HostNetworkContext ctx)
            throws IOException, InterruptedException {
        boolean ethernet = iface != null && !iface.equals("any");
        List<String> cmd = new ArrayList<>(List.of(exe, "-nn", "-l", "-q", "-tt"));
        if (ethernet) {
            cmd.add("-e");
        }
        if (iface != null) {
            cmd.add("-i");
            cmd.add(iface);
        }
        if (tool("timeout") != null) {
            cmd.addAll(0, List.of(tool("timeout"), String.valueOf(secs)));
        }
        CommandResult res = run(cmd, secs + 10, StandardCharsets.UTF_8);
        if (!res.started()) {
            return SentinelCaptureResult.unavailable(secs, "tcpdump could not be started.");
        }
        if (res.stdout().isEmpty() && res.stderr() != null && res.stderr().toLowerCase(Locale.ROOT).contains("permission")) {
            return SentinelCaptureResult.unavailable(secs, "tcpdump: permission denied (setcap cap_net_raw,cap_net_admin=eip "
                    + exe + ").");
        }

        Map<String, Agg> convs = new LinkedHashMap<>();
        Map<String, Set<Integer>> dstPortsByPair = new HashMap<>();
        Map<String, Long> dns = new LinkedHashMap<>();
        Map<String, long[]> arp = new LinkedHashMap<>();
        Map<String, Agg> byHost = new HashMap<>();
        Set<String> ipMacPairs = new LinkedHashSet<>();
        long packets = 0;
        long bytes = 0;

        for (String line : res.stdout()) {
            Matcher lm = TCPDUMP_LEN.matcher(line);
            long len = lm.find() ? parseLongOrZero(lm.group(1)) : 0;
            Matcher ar = TCPDUMP_ARP_REPLY.matcher(line);
            if (ar.find()) {
                packets++;
                bytes += len;
                String k = ar.group(1) + "|" + ar.group(2).toLowerCase(Locale.ROOT) + "|true";
                arp.computeIfAbsent(k, x -> new long[1])[0]++;
                ipMacPairs.add(ar.group(1) + "|" + ar.group(2).toLowerCase(Locale.ROOT));
                continue;
            }
            Matcher aq = TCPDUMP_ARP_REQ.matcher(line);
            if (aq.find()) {
                packets++;
                bytes += len;
                Matcher macs = TCPDUMP_MACS.matcher(line);
                if (macs.find()) {
                    String k = aq.group(2) + "|" + macs.group(1) + "|false";
                    arp.computeIfAbsent(k, x -> new long[1])[0]++;
                    ipMacPairs.add(aq.group(2) + "|" + macs.group(1));
                }
                continue;
            }
            Matcher m = TCPDUMP_IP.matcher(line);
            if (!m.find()) {
                continue;
            }
            packets++;
            bytes += len;
            String src = m.group(1);
            String dst = m.group(3);
            int dport = parseIntOrZero(m.group(4));
            String proto = m.group(5).toUpperCase(Locale.ROOT);
            if (dport == 53 && proto.equals("UDP")) {
                proto = "DNS";
            }
            String convKey = proto + "|" + src + "|" + dst + "|" + dport;
            Agg a = convs.computeIfAbsent(convKey, x -> new Agg());
            a.packets++;
            a.bytes += len;
            if (line.contains("Flags [S]")) {
                a.syn++;
            } else if (line.contains("Flags [") && line.contains(".]")) {
                a.ack++;
            }
            dstPortsByPair.computeIfAbsent(src + "|" + dst, x -> new HashSet<>()).add(dport);
            Agg h = byHost.computeIfAbsent(src, x -> new Agg());
            h.packets++;
            h.bytes += len;
            Matcher macs = TCPDUMP_MACS.matcher(line);
            if (macs.find() && SentinelFlowDto.SCOPE_LAN.equals(SentinelIpUtil.classify(src, ctx.lanCidrs()))) {
                ipMacPairs.add(src + "|" + macs.group(1));
            }
        }
        return buildCaptureResult("tcpdump", secs, packets, bytes, convs, dstPortsByPair, dns, arp, byHost, ipMacPairs,
                null);
    }

    private SentinelCaptureResult buildCaptureResult(String toolName, int secs, long packets, long bytes,
            Map<String, Agg> convs, Map<String, Set<Integer>> dstPortsByPair, Map<String, Long> dns,
            Map<String, long[]> arp, Map<String, Agg> byHost, Set<String> ipMacPairs, String warning) {
        List<SentinelCaptureResult.Conversation> conversations = new ArrayList<>();
        for (Map.Entry<String, Agg> e : convs.entrySet()) {
            String[] k = e.getKey().split("\\|", -1);
            Agg a = e.getValue();
            int dport = parseIntOrZero(k[3]);
            Set<Integer> ports = dstPortsByPair.getOrDefault(k[1] + "|" + k[2], Set.of());
            conversations.add(new SentinelCaptureResult.Conversation(k[0], k[1], null, k[2], dport >= 0 ? dport : null,
                    a.packets, a.bytes, ports.size(), a.syn > 0 && a.ack == 0));
        }
        conversations.sort(Comparator.comparingLong(SentinelCaptureResult.Conversation::packets).reversed());
        if (conversations.size() > 400) {
            conversations = new ArrayList<>(conversations.subList(0, 400));
        }
        List<SentinelCaptureResult.DnsQuery> dnsList = new ArrayList<>();
        for (Map.Entry<String, Long> e : dns.entrySet()) {
            String[] k = e.getKey().split("\\|", 2);
            dnsList.add(new SentinelCaptureResult.DnsQuery(k[0], k[1], e.getValue()));
        }
        dnsList.sort(Comparator.comparingLong(SentinelCaptureResult.DnsQuery::count).reversed());
        if (dnsList.size() > 200) {
            dnsList = new ArrayList<>(dnsList.subList(0, 200));
        }
        List<SentinelCaptureResult.ArpObservation> arpList = new ArrayList<>();
        for (Map.Entry<String, long[]> e : arp.entrySet()) {
            String[] k = e.getKey().split("\\|", -1);
            arpList.add(new SentinelCaptureResult.ArpObservation(k[0], k[1], e.getValue()[0], Boolean.parseBoolean(k[2])));
        }
        List<SentinelCaptureResult.HostCount> hosts = new ArrayList<>();
        for (Map.Entry<String, Agg> e : byHost.entrySet()) {
            hosts.add(new SentinelCaptureResult.HostCount(e.getKey(), e.getValue().packets, e.getValue().bytes));
        }
        hosts.sort(Comparator.comparingLong(SentinelCaptureResult.HostCount::packets).reversed());
        if (hosts.size() > 100) {
            hosts = new ArrayList<>(hosts.subList(0, 100));
        }
        List<SentinelCaptureResult.IpMac> pairs = new ArrayList<>();
        for (String p : ipMacPairs) {
            String[] k = p.split("\\|", 2);
            pairs.add(new SentinelCaptureResult.IpMac(k[0], k[1]));
        }
        return new SentinelCaptureResult(toolName, true, secs, packets, bytes, conversations, dnsList, arpList, hosts,
                pairs, warning);
    }

    private static Integer firstPort(String tcp, String udp) {
        if (tcp != null && !tcp.isEmpty()) {
            return parseIntOrNull(tcp.split(",")[0]);
        }
        if (udp != null && !udp.isEmpty()) {
            return parseIntOrNull(udp.split(",")[0]);
        }
        return null;
    }

    private static boolean isTrue(String s) {
        return s != null && (s.equals("1") || s.equalsIgnoreCase("true") || s.equalsIgnoreCase("set"));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Tool resolution and process execution
    // ------------------------------------------------------------------------------------------------------------

    /** Absolute path (or bare name when on PATH) of a tool, null when not found. Cached. */
    public String tool(String name) {
        long now = System.currentTimeMillis();
        Map<String, String> cache = toolCache;
        if (now - toolCacheAt > TOOL_CACHE_MS || !cache.containsKey(name)) {
            Map<String, String> fresh = new HashMap<>(cache);
            fresh.put(name, locate(name));
            toolCache = fresh;
            toolCacheAt = now;
            cache = fresh;
        }
        return cache.get(name);
    }

    private String locate(String name) {
        Platform p = platform();
        List<String> candidates = new ArrayList<>();
        if (p == Platform.WINDOWS) {
            String pf = System.getenv("ProgramFiles");
            String pf86 = System.getenv("ProgramFiles(x86)");
            if (name.equals("tshark")) {
                if (pf != null) {
                    candidates.add(pf + "\\Wireshark\\tshark.exe");
                }
                if (pf86 != null) {
                    candidates.add(pf86 + "\\Wireshark\\tshark.exe");
                }
            }
            CommandResult w = run(List.of("where", name), 10, Charset.defaultCharset());
            if (w.started() && w.ok() && !w.stdout().isEmpty()) {
                return w.stdout().get(0).trim();
            }
        } else {
            for (String dir : List.of("/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local/bin", "/usr/local/sbin",
                    "/opt/homebrew/bin")) {
                candidates.add(dir + "/" + name);
            }
            CommandResult w = run(List.of("sh", "-c", "command -v " + name), 10, StandardCharsets.UTF_8);
            if (w.started() && w.ok() && !w.stdout().isEmpty() && !w.stdout().get(0).isBlank()) {
                return w.stdout().get(0).trim();
            }
        }
        for (String c : candidates) {
            if (Files.isExecutable(Path.of(c))) {
                return c;
            }
        }
        return null;
    }

    private CommandResult run(List<String> cmd, int timeoutSec, Charset charset) {
        Process process;
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(false);
            process = pb.start();
        } catch (IOException e) {
            log.debug("Cannot start {}: {}", cmd.get(0), e.getMessage());
            return new CommandResult(-1, List.of(), e.getMessage(), false, false);
        }
        List<String> out = Collections.synchronizedList(new ArrayList<>());
        StringBuilder err = new StringBuilder();
        Thread tOut = pump(process.getInputStream(), charset, out::add);
        Thread tErr = pump(process.getErrorStream(), charset, l -> {
            if (err.length() < 4000) {
                err.append(l).append('\n');
            }
        });
        boolean finished;
        try {
            finished = process.waitFor(timeoutSec, TimeUnit.SECONDS);
            if (!finished) {
                process.destroy();
                if (!process.waitFor(3, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            }
            tOut.join(3000);
            tErr.join(3000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            return new CommandResult(-1, new ArrayList<>(out), err.toString(), true, true);
        }
        int exit = finished ? process.exitValue() : -1;
        return new CommandResult(exit, new ArrayList<>(out), err.toString(), !finished, true);
    }

    private static Thread pump(InputStream in, Charset charset, Consumer<String> sink) {
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, charset))) {
                String line;
                while ((line = r.readLine()) != null) {
                    sink.accept(line);
                }
            } catch (IOException ignored) {
                // stream closed by destroy()
            }
        }, "sentinel-pump");
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static String firstLine(String s) {
        if (s == null || s.isBlank()) {
            return "(no error output)";
        }
        return s.trim().split("\n")[0];
    }

    private static Integer parseIntOrNull(String s) {
        try {
            return Integer.valueOf(s.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static int parseIntOrZero(String s) {
        Integer v = parseIntOrNull(s);
        return v != null ? v : 0;
    }

    private static long parseLongOrZero(String s) {
        try {
            return Long.parseLong(s.trim());
        } catch (Exception e) {
            return 0L;
        }
    }
}
