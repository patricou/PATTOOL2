package com.pat.service;

import com.pat.dto.VisibleWifiNetwork;
import com.pat.dto.WifiScanResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Enumerates BSSIDs reachable from the PatTool server's WLAN adapter via OS tooling.
 */
@Service
public class WifiScanService {

    private static final Logger log = LoggerFactory.getLogger(WifiScanService.class);
    private static final int SCAN_TIMEOUT_SEC = 45;

    static final Pattern MAC_COLON = Pattern.compile("^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$");

    private static final Pattern WIN_SSID = Pattern.compile("^SSID\\s+\\d+\\s*:\\s*(.*)$");
    private static final Pattern WIN_BSSID = Pattern.compile(
            "^\\s*BSSID\\s+\\d+\\s*:\\s*([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})\\s*$");
    private static final Pattern WIN_SIGNAL = Pattern.compile("^\\s*Signal\\s*:\\s*(\\d+)\\s*%", Pattern.CASE_INSENSITIVE);
    private static final Pattern WIN_AUTH = Pattern.compile("^\\s*Authentication\\s*:\\s*(.+)$",
            Pattern.CASE_INSENSITIVE);

    private static final Path MACOS_AIRPORT = Path.of(
            "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport");

    /**
     * @return scan payload; networks may be empty when host has Ethernet only or tooling is unavailable
     */
    public WifiScanResult scanVisibleNetworks() {
        Instant scannedAt = Instant.now();
        String hostName = resolveHostIdentifier();
        String osRaw = System.getProperty("os.name", "");
        String os = osRaw.toLowerCase(Locale.ROOT);

        String warn = null;
        List<VisibleWifiNetwork> networks;

        try {
            if (os.contains("win")) {
                networks = scanWindows();
                if (networks.isEmpty() && warn == null) {
                    warn = "No BSSIDs parsed (inactive Wi‑Fi adapter or wlan service disabled on backend).";
                }
            } else if (os.contains("mac") || os.contains("darwin")) {
                networks = scanMacOs();
                if (networks.isEmpty()) {
                    warn = "macOS WLAN scan unavailable (missing airport CLI or Wi‑Fi off).";
                }
            } else {
                networks = scanLinuxNmCli();
                if (networks.isEmpty()) {
                    warn = "WLAN scan unavailable (needs NetworkManager `nmcli`; no adapter; or sandbox).";
                }
            }
        } catch (Exception ex) {
            log.warn("Wi-Fi scan failed: {}", ex.toString());
            warn = trimMessage(ex.getMessage());
            networks = List.of();
        }

        networks = sortUniqueByMac(networks);
        networks = sortBySignal(networks);

        return new WifiScanResult(
                hostName,
                hostName,
                enExplanation(hostName),
                frExplanation(hostName),
                platformKey(os),
                osRaw,
                scannedAt,
                networks,
                warn
        );
    }

    private static String trimMessage(String m) {
        if (m == null || m.isBlank()) {
            return "Wi-Fi scan failed.";
        }
        return m.trim();
    }

    private static String enExplanation(String host) {
        return "Networks listed here were detected via the WLAN radio on the PatTool backend host (%s)."
                .formatted(host)
                + " This is not the view from your browser or user workstation.";
    }

    private static String frExplanation(String host) {
        return "Les réseaux affichés ici sont détectés par la radio Wi‑Fi du serveur PatTool (%s)."
                .formatted(host)
                + " Ce n’est pas ce que voit votre navigateur ni votre poste utilisateur.";
    }

    private static String resolveHostIdentifier() {
        try {
            String h = java.net.InetAddress.getLocalHost().getHostName();
            if (h != null && !h.isBlank()) {
                return h;
            }
        } catch (Exception ignored) {
            // omit
        }
        return System.getenv().getOrDefault("COMPUTERNAME",
                System.getenv().getOrDefault("HOSTNAME", "PatTool-backend"));
    }

    private static String platformKey(String osLower) {
        if (osLower.contains("win")) {
            return "WINDOWS";
        }
        if (osLower.contains("mac") || osLower.contains("darwin")) {
            return "MACOS";
        }
        return "LINUX_OTHER";
    }

    private static List<VisibleWifiNetwork> sortUniqueByMac(List<VisibleWifiNetwork> in) {
        Map<String, VisibleWifiNetwork> byMac = new LinkedHashMap<>();
        for (VisibleWifiNetwork n : in) {
            if (n.bssid() != null && MAC_COLON.matcher(n.bssid()).matches()) {
                byMac.putIfAbsent(n.bssid().toUpperCase(Locale.ROOT), n);
            }
        }
        return new ArrayList<>(byMac.values());
    }

    /** Strongest signal first; entries without usable strength sort last by SSID. */
    private static List<VisibleWifiNetwork> sortBySignal(List<VisibleWifiNetwork> in) {
        List<VisibleWifiNetwork> copy = new ArrayList<>(in);
        copy.sort(
                Comparator
                        .comparingInt(WifiScanService::signalSortKey).reversed()
                        .thenComparing(VisibleWifiNetwork::ssid, Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)));
        return copy;
    }

    /**
     * Monotonic-ish sort key derived from %-style strength or dBm-derived proxy.
     * Unknown strength uses {@link Integer#MIN_VALUE} so it sinks to the tail after reverse-order.
     */
    private static int signalSortKey(VisibleWifiNetwork n) {
        if (n.signalPercent() != null) {
            return n.signalPercent();
        }
        if (n.signalDbm() != null) {
            return rssiApproxPercent(n.signalDbm());
        }
        return Integer.MIN_VALUE;
    }

    /* -------- Windows ---------- */

    private List<VisibleWifiNetwork> scanWindows() throws Exception {
        ProcessBuilder pb = new ProcessBuilder("cmd.exe", "/c", "netsh wlan show networks mode=BSSID");
        pb.redirectErrorStream(true);

        Process p = pb.start();
        Charset cs = Charset.defaultCharset();
        String text = consumeProcessStdout(p.getInputStream(), cs);

        if (!p.waitFor(SCAN_TIMEOUT_SEC, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new RuntimeException("netsh wlan timed out");
        }

        if (text.toLowerCase(Locale.ROOT).contains("failed while loading")) {
            throw new RuntimeException("netsh failed (wlan service?).");
        }
        return parseNetShBssid(text);
    }

    static List<VisibleWifiNetwork> parseNetShBssid(String text) {
        List<VisibleWifiNetwork> out = new ArrayList<>();

        String currentSsid = null;
        String currentAuth = null;
        String pendingBssid = null;

        for (String rawLine : text.split("\\R")) {
            Matcher ssidM = WIN_SSID.matcher(rawLine.trim());
            if (ssidM.matches()) {
                currentSsid = ssidM.group(1).trim();
                if (currentSsid.isEmpty()) {
                    currentSsid = "(hidden)";
                }
                currentAuth = null;
                pendingBssid = null;
                continue;
            }

            Matcher authM = WIN_AUTH.matcher(rawLine);
            if (authM.matches()) {
                currentAuth = authM.group(1).trim();
                continue;
            }

            Matcher bssidM = WIN_BSSID.matcher(rawLine);
            if (bssidM.matches()) {
                pendingBssid = bssidM.group(1).toUpperCase(Locale.ROOT);
                continue;
            }

            Matcher sigM = WIN_SIGNAL.matcher(rawLine);
            if (sigM.find() && pendingBssid != null && currentSsid != null) {
                int pct = Integer.parseInt(sigM.group(1));
                String authOut = currentAuth != null && !currentAuth.isBlank() ? currentAuth : null;
                out.add(new VisibleWifiNetwork(currentSsid, pendingBssid, pct, authOut, null));
                pendingBssid = null;
            }
        }
        return out;
    }

    /* -------- Linux (nmcli) ---------- */

    private List<VisibleWifiNetwork> scanLinuxNmCli() throws Exception {
        List<VisibleWifiNetwork> first = invokeNmCli(false);
        if (!first.isEmpty()) {
            return first;
        }
        List<VisibleWifiNetwork> rescanned = invokeNmCli(true);
        return rescanned.isEmpty() ? first : rescanned;
    }

    private List<VisibleWifiNetwork> invokeNmCli(boolean rescan) throws Exception {
        List<String> cmd = new ArrayList<>(List.of(
                "nmcli", "-t", "-m", "tabular",
                "-f", "SSID,SIGNAL,BSSID,SECURITY",
                "device", "wifi", "list"));
        if (rescan) {
            cmd.add("--rescan");
            cmd.add("yes");
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);

        Process p = pb.start();
        String text = consumeProcessStdout(p.getInputStream(), Charset.defaultCharset());
        boolean ok = p.waitFor(SCAN_TIMEOUT_SEC, TimeUnit.SECONDS);
        if (!ok) {
            p.destroyForcibly();
            return List.of();
        }
        if (p.exitValue() != 0) {
            return List.of();
        }
        return parseNmCliTabs(text);
    }

    static List<VisibleWifiNetwork> parseNmCliTabs(String text) {
        List<VisibleWifiNetwork> out = new ArrayList<>();
        Pattern mac = MAC_COLON;

        for (String rawRow : text.split("\\R")) {
            if (rawRow.trim().isEmpty()) {
                continue;
            }

            String[] parts = rawRow.split("\\t", -1);
            if (parts.length < 3) {
                continue;
            }

            String bssidCandidate = parts[2].trim();
            /* Header row emitted by some nmcli builds */
            if (!mac.matcher(bssidCandidate).matches() || "BSSID".equalsIgnoreCase(bssidCandidate)) {
                continue;
            }

            String ssidRaw = unescapeNm(parts[0].trim());
            if ("SSID".equalsIgnoreCase(ssidRaw)) {
                continue;
            }

            String ssid = ssidRaw.isBlank() ? "(hidden)" : ssidRaw;

            Integer sigPct = parseIntSafe(parts[1].trim());
            /* Header row guard */
            if ("SIGNAL".equalsIgnoreCase(parts[1].trim())) {
                continue;
            }

            String secRaw = parts.length > 3 ? unescapeNm(parts[3].trim()) : "";
            String sec = secRaw.isBlank() ? null : secRaw;

            out.add(new VisibleWifiNetwork(ssid, bssidCandidate.toUpperCase(Locale.ROOT), sigPct, sec, null));
        }
        return out;
    }

    private static String unescapeNm(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        return s.replace("\\:", ":").replace("\\\\", "\\");
    }

    private static Integer parseIntSafe(String s) {
        if (s.isEmpty()) {
            return null;
        }
        try {
            return Integer.parseInt(s.replace("%", "").trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /* -------- macOS airport ---------- */

    private List<VisibleWifiNetwork> scanMacOs() throws Exception {
        if (!Files.isExecutable(MACOS_AIRPORT)) {
            return List.of();
        }
        ProcessBuilder pb = new ProcessBuilder(MACOS_AIRPORT.toString(), "-s");
        pb.redirectErrorStream(true);

        Process p = pb.start();
        String text = consumeProcessStdout(p.getInputStream(), Charset.defaultCharset());

        if (!p.waitFor(SCAN_TIMEOUT_SEC, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            return List.of();
        }

        return parseAirportListing(text);
    }

    /** airport -s legacy table: leading SSID columns, MAC, RSSI remainder. */
    static List<VisibleWifiNetwork> parseAirportListing(String text) {
        List<VisibleWifiNetwork> out = new ArrayList<>();
        Pattern macPat = Pattern.compile("(?i)(?<![0-9A-F])([0-9A-F]{2}(?::[0-9A-F]{2}){5})(?![0-9A-F]:)");

        for (String rawLine : text.split("\\R")) {
            String line = rawLine.trim();
            if (line.isEmpty() || line.contains("SSID BSSID")) {
                continue;
            }

            Matcher mMac = macPat.matcher(line);
            if (!mMac.find()) {
                continue;
            }

            String ssidSlice = line.substring(0, mMac.start()).trim();
            String mac = mMac.group(1).toUpperCase(Locale.ROOT);
            String tail = line.substring(mMac.end()).trim();

            String ssid = ssidSlice.isEmpty() ? "(hidden)" : ssidSlice.replaceAll("\\s+", " ");

            Matcher rssiM = Pattern.compile("^(-?\\d+)").matcher(tail);

            Integer rssi = null;
            Integer pct = null;
            if (rssiM.find()) {
                try {
                    rssi = Integer.parseInt(rssiM.group(1));
                    pct = rssiApproxPercent(rssi);
                } catch (NumberFormatException ignored) {
                    // omit
                }
            }

            out.add(new VisibleWifiNetwork(ssid, mac, pct, null, rssi));
        }

        return out;
    }

    private static Integer rssiApproxPercent(int dbm) {
        float pct = Math.round(((dbm + 100f) / 70f) * 100f);
        pct = Math.max(0f, Math.min(100f, pct));
        return Math.round(pct);
    }

    private static String consumeProcessStdout(java.io.InputStream stream, Charset cs) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, cs))) {
            reader.lines().forEach(l -> sb.append(l).append('\n'));
        }
        return sb.toString();
    }
}
