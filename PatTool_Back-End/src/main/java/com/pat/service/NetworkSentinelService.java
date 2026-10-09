package com.pat.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.MailController;
import com.pat.dto.SentinelBaseline;
import com.pat.dto.SentinelCapabilitiesDto;
import com.pat.dto.SentinelCaptureResult;
import com.pat.dto.SentinelFlowDto;
import com.pat.dto.SentinelLogonDto;
import com.pat.dto.SentinelPrefsDto;
import com.pat.repo.NetworkDeviceMappingRepository;
import com.pat.repo.NetworkSentinelSweepRepository;
import com.pat.repo.domain.AppParameter;
import com.pat.repo.domain.NetworkDeviceMapping;
import com.pat.repo.domain.NetworkSentinelFinding;
import com.pat.repo.domain.NetworkSentinelSweep;
import com.pat.service.NetworkSentinelHostProbeService.HostNetworkContext;
import com.pat.service.SentinelIpUtil.Cidr;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * Network sentinel orchestration: runs sweeps (connection table + sessions/logons + packet capture + LAN device scan),
 * analyses them with {@link NetworkFlowAnalyzer}, keeps a learned baseline, stores history and e-mails new
 * high-severity findings. One sweep at a time.
 */
@Service
public class NetworkSentinelService {

    private static final Logger log = LoggerFactory.getLogger(NetworkSentinelService.class);

    public static final String PARAM_BASELINE = "network.sentinel.baseline";
    private static final int FLOWS_STORED_MAX = 400;
    private static final int HISTORY_KEEP = 200;
    private static final int LOGON_LOOKBACK_HOURS = 48;
    private static final long ALERT_DEDUP_MS = 12 * 60 * 60_000L;
    private static final int PUBLIC_PEERS_CAP = 2000;
    private static final int ALERTED_KEYS_CAP = 2000;

    public interface SweepListener {
        void onEvent(String name, Object data);
    }

    public record SweepOptions(boolean includeDeviceScan, boolean includeCapture, int captureSeconds, String trigger) {
    }

    private final NetworkSentinelHostProbeService probe;
    private final NetworkSentinelPrefsService prefsService;
    private final AppParameterService appParameterService;
    private final ObjectMapper objectMapper;
    private final NetworkSentinelSweepRepository sweepRepository;
    private final LocalNetworkService localNetworkService;
    private final NetworkDeviceMappingRepository deviceMappingRepository;
    private final MailController mailController;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile long lastSweepStartedAt = 0L;
    private volatile String currentPhase = null;

    public NetworkSentinelService(NetworkSentinelHostProbeService probe, NetworkSentinelPrefsService prefsService,
            AppParameterService appParameterService, ObjectMapper objectMapper,
            NetworkSentinelSweepRepository sweepRepository, LocalNetworkService localNetworkService,
            NetworkDeviceMappingRepository deviceMappingRepository, MailController mailController) {
        this.probe = probe;
        this.prefsService = prefsService;
        this.appParameterService = appParameterService;
        this.objectMapper = objectMapper;
        this.sweepRepository = sweepRepository;
        this.localNetworkService = localNetworkService;
        this.deviceMappingRepository = deviceMappingRepository;
        this.mailController = mailController;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Status / capabilities
    // ------------------------------------------------------------------------------------------------------------

    public boolean isRunning() {
        return running.get();
    }

    public Map<String, Object> status() {
        SentinelBaseline b = loadBaseline();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("running", running.get());
        m.put("currentPhase", currentPhase);
        m.put("lastSweepStartedAt", lastSweepStartedAt > 0 ? new Date(lastSweepStartedAt) : null);
        m.put("baselineInitialized", b.isInitialized());
        m.put("baselineSweepCount", b.getSweepCount());
        m.put("baselineListeners", b.getKnownListeners().size());
        m.put("baselineLogons", b.getKnownLogons().size());
        m.put("baselineArpEntries", b.getArpTable().size());
        m.put("acknowledgedKeys", b.getAcknowledgedKeys().size());
        m.put("historyCount", sweepRepository.count());
        return m;
    }

    public SentinelCapabilitiesDto capabilities() {
        return probe.capabilities(true);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Live snapshot (fast, no persistence, no capture)
    // ------------------------------------------------------------------------------------------------------------

    public Map<String, Object> liveSnapshot() {
        List<String> warnings = new ArrayList<>();
        HostNetworkContext ctx = probe.networkContext();
        List<SentinelFlowDto> flows = probe.snapshotConnections(ctx, warnings);
        List<SentinelLogonDto> sessions = probe.activeSessions(ctx, warnings);
        SentinelPrefsDto prefs = prefsService.getPrefs();
        SentinelBaseline baseline = loadBaseline();

        List<NetworkSentinelFinding> findings = NetworkFlowAnalyzer.analyze(new NetworkFlowAnalyzer.Input(ctx, flows,
                null, null, sessions, null, Set.of(), baseline, SentinelIpUtil.parseCidrs(prefs.trustedRemoteCidrs()),
                new HashSet<>(prefs.expectedListeners()), !baseline.isInitialized()));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("at", new Date());
        out.put("hostName", ctx.hostName());
        out.put("os", ctx.osName());
        out.put("localAddresses", ctx.localAddresses());
        out.put("lanCidrs", ctx.lanCidrs().stream().map(Cidr::toString).toList());
        out.put("flows", sortFlows(flows, FLOWS_STORED_MAX));
        out.put("flowCount", flows.size());
        out.put("counts", flowCounts(flows));
        out.put("sessions", sessions);
        out.put("findings", findings);
        out.put("severityCounts", severityCounts(findings));
        out.put("warnings", warnings);
        out.put("running", running.get());
        out.put("currentPhase", currentPhase);
        return out;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Full sweep
    // ------------------------------------------------------------------------------------------------------------

    public NetworkSentinelSweep runSweep(SweepOptions options, SweepListener listener) {
        if (!running.compareAndSet(false, true)) {
            throw new IllegalStateException("A sentinel sweep is already running.");
        }
        long start = System.currentTimeMillis();
        lastSweepStartedAt = start;
        SweepListener emit = listener != null ? listener : (n, d) -> { };
        List<String> warnings = new ArrayList<>();
        NetworkSentinelSweep sweep = new NetworkSentinelSweep();
        try {
            SentinelPrefsDto prefs = prefsService.getPrefs();
            HostNetworkContext ctx = probe.networkContext();
            sweep.setStartedAt(new Date(start));
            sweep.setTrigger(options.trigger());
            sweep.setHostName(ctx.hostName());
            sweep.setOs(ctx.osName());
            sweep.setDeviceScanIncluded(options.includeDeviceScan());
            sweep.setCaptureIncluded(options.includeCapture());

            Map<String, Object> started = new LinkedHashMap<>();
            started.put("hostName", ctx.hostName());
            started.put("os", ctx.osName());
            started.put("localAddresses", ctx.localAddresses());
            started.put("lanCidrs", ctx.lanCidrs().stream().map(Cidr::toString).toList());
            started.put("options", options);
            started.put("timestamp", start);
            emit.onEvent("sweep-started", started);

            // 1. Connection table
            phase(emit, "connections", "Reading the socket table of " + ctx.hostName() + "…");
            List<SentinelFlowDto> flows = probe.snapshotConnections(ctx, warnings);
            Map<String, Object> flowsEvt = new LinkedHashMap<>();
            flowsEvt.put("flows", sortFlows(flows, FLOWS_STORED_MAX));
            flowsEvt.put("flowCount", flows.size());
            flowsEvt.put("counts", flowCounts(flows));
            emit.onEvent("flows", flowsEvt);

            // 2. Sessions and logons
            phase(emit, "sessions", "Listing open remote sessions and recent successful logons…");
            List<SentinelLogonDto> sessions = probe.activeSessions(ctx, warnings);
            List<SentinelLogonDto> logons = probe.recentLogons(ctx, LOGON_LOOKBACK_HOURS, warnings);
            Map<String, Object> sessEvt = new LinkedHashMap<>();
            sessEvt.put("sessions", sessions);
            sessEvt.put("logons", logons);
            emit.onEvent("sessions", sessEvt);

            // 3. Packet capture
            SentinelCaptureResult capture = null;
            if (options.includeCapture()) {
                int secs = options.captureSeconds() > 0 ? options.captureSeconds() : prefs.captureSeconds();
                phase(emit, "capture", "Capturing packets for " + secs + " s…");
                capture = probe.capture(secs, prefs.captureInterface(), ctx, msg -> status(emit, msg));
                if (!capture.available() && capture.warning() != null) {
                    warnings.add(capture.warning());
                }
                emit.onEvent("capture", capture);
            }

            // 4. LAN device scan
            List<Map<String, Object>> devices = null;
            if (options.includeDeviceScan()) {
                phase(emit, "devices", "Scanning the LAN for active devices…");
                final List<Map<String, Object>> found = new ArrayList<>();
                try {
                    localNetworkService.scanLocalNetworkStreaming(false, (device, progress, total) -> {
                        if (device == null || device.isEmpty()) {
                            return;
                        }
                        synchronized (found) {
                            found.add(new LinkedHashMap<>(device));
                        }
                        Map<String, Object> evt = new LinkedHashMap<>();
                        evt.put("device", device);
                        evt.put("progress", progress);
                        evt.put("total", total);
                        emit.onEvent("device-found", evt);
                    }, msg -> status(emit, msg));
                } catch (Exception e) {
                    warnings.add("LAN device scan failed: " + e.getMessage());
                }
                devices = new ArrayList<>(found);
                try {
                    localNetworkService.detectAndSaveNewDevicesToHistory(devices);
                } catch (Exception e) {
                    log.debug("new device history update failed: {}", e.getMessage());
                }
            }

            // 5. Analysis
            phase(emit, "analysis", "Correlating flows, sessions, logons, capture and devices…");
            Set<String> knownMacs = knownDeviceMacs();
            SentinelBaseline baseline = loadBaseline();
            boolean learning = !baseline.isInitialized();
            List<NetworkSentinelFinding> findings = NetworkFlowAnalyzer.analyze(new NetworkFlowAnalyzer.Input(ctx, flows,
                    capture, logons, sessions, devices, knownMacs, baseline,
                    SentinelIpUtil.parseCidrs(prefs.trustedRemoteCidrs()), new HashSet<>(prefs.expectedListeners()),
                    learning));
            for (NetworkSentinelFinding f : findings) {
                emit.onEvent("finding", f);
            }

            // 6. Fill and store sweep
            sweep.setBaselineLearning(learning);
            sweep.setFlowCount(flows.size());
            Map<String, Integer> counts = flowCounts(flows);
            sweep.setListenerCount(counts.getOrDefault("listeners", 0));
            sweep.setInboundPublicCount(counts.getOrDefault("inboundPublic", 0));
            sweep.setOutboundPublicCount(counts.getOrDefault("outboundPublic", 0));
            sweep.setFlows(sortFlows(flows, FLOWS_STORED_MAX));
            sweep.setCapture(capture);
            sweep.setLogons(logons);
            sweep.setSessions(sessions);
            if (devices != null) {
                sweep.setDeviceCount(devices.size());
                List<Map<String, Object>> unknown = new ArrayList<>();
                for (Map<String, Object> d : devices) {
                    String mac = SentinelIpUtil.normalizeMac(String.valueOf(d.getOrDefault("macAddress", "")));
                    if (mac.length() == 12 && !knownMacs.contains(mac)) {
                        unknown.add(compactDevice(d));
                    }
                }
                sweep.setUnknownDevices(unknown);
                sweep.setUnknownDeviceCount(unknown.size());
            }
            sweep.setFindings(findings);
            sweep.setSeverityCounts(severityCounts(findings));
            sweep.setIntrusionSucceededCount((int) findings.stream()
                    .filter(f -> f.isIntrusionSucceeded() && !f.isAcknowledged()).count());
            sweep.setMaxSeverity(findings.stream().map(NetworkSentinelFinding::getSeverity)
                    .max(Comparator.comparingInt(NetworkSentinelFinding::severityRank)).orElse(null));
            sweep.setWarnings(warnings);

            // 7. Baseline update
            updateBaseline(baseline, flows, logons, capture, ctx);

            // 8. Alerts
            boolean emailed = false;
            if (Boolean.TRUE.equals(prefs.emailAlertsEnabled())) {
                emailed = sendAlertsIfNeeded(sweep, findings, baseline, prefs, ctx);
            }
            sweep.setEmailSent(emailed);
            saveBaseline(baseline);

            long end = System.currentTimeMillis();
            sweep.setFinishedAt(new Date(end));
            sweep.setDurationMs(end - start);
            NetworkSentinelSweep saved = sweepRepository.save(sweep);
            pruneHistory();
            emit.onEvent("sweep-completed", saved);
            return saved;
        } catch (RuntimeException e) {
            log.warn("Sentinel sweep failed: {}", e.toString());
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", "Sweep failed");
            err.put("message", e.getMessage());
            emit.onEvent("error", err);
            throw e;
        } finally {
            currentPhase = null;
            running.set(false);
        }
    }

    private void phase(SweepListener emit, String phase, String message) {
        currentPhase = phase;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("phase", phase);
        m.put("message", message);
        m.put("timestamp", System.currentTimeMillis());
        emit.onEvent("phase", m);
    }

    private void status(SweepListener emit, String message) {
        if (message == null || message.isBlank()) {
            return;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("message", message);
        m.put("timestamp", System.currentTimeMillis());
        emit.onEvent("status", m);
    }

    private Set<String> knownDeviceMacs() {
        List<NetworkDeviceMapping> mappings = deviceMappingRepository.findAll();
        return NetworkFlowAnalyzer.normalizeMacs(mappings.stream().map(NetworkDeviceMapping::getMacAddress).toList());
    }

    private static Map<String, Object> compactDevice(Map<String, Object> d) {
        Map<String, Object> c = new LinkedHashMap<>();
        for (String k : List.of("ipAddress", "hostname", "macAddress", "vendor", "deviceType", "os", "openPorts")) {
            if (d.get(k) != null) {
                c.put(k, d.get(k));
            }
        }
        return c;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Flow helpers
    // ------------------------------------------------------------------------------------------------------------

    static List<SentinelFlowDto> sortFlows(List<SentinelFlowDto> flows, int max) {
        List<SentinelFlowDto> sorted = new ArrayList<>(flows);
        sorted.sort(Comparator.comparingInt(NetworkSentinelService::flowRank)
                .thenComparing(SentinelFlowDto::remoteAddress, Comparator.nullsLast(String::compareTo))
                .thenComparingInt(SentinelFlowDto::localPort));
        return sorted.size() > max ? new ArrayList<>(sorted.subList(0, max)) : sorted;
    }

    private static int flowRank(SentinelFlowDto f) {
        boolean pub = SentinelIpUtil.isPublic(f.remoteScope());
        if (SentinelFlowDto.DIR_INBOUND.equals(f.direction()) && pub) {
            return 0;
        }
        if (SentinelFlowDto.DIR_OUTBOUND.equals(f.direction()) && pub) {
            return 1;
        }
        if (SentinelFlowDto.DIR_INBOUND.equals(f.direction())) {
            return 2;
        }
        if (SentinelFlowDto.DIR_OUTBOUND.equals(f.direction())) {
            return 3;
        }
        if (f.isListener() && !NetworkFlowAnalyzer.isLoopbackBound(f.localAddress())) {
            return 4;
        }
        return 5;
    }

    static Map<String, Integer> flowCounts(List<SentinelFlowDto> flows) {
        int listeners = 0;
        int inboundPublic = 0;
        int inboundLan = 0;
        int outboundPublic = 0;
        int outboundLan = 0;
        int established = 0;
        for (SentinelFlowDto f : flows) {
            if (f.isListener()) {
                if (!NetworkFlowAnalyzer.isLoopbackBound(f.localAddress())) {
                    listeners++;
                }
                continue;
            }
            if (f.isEstablished()) {
                established++;
            }
            boolean pub = SentinelIpUtil.isPublic(f.remoteScope());
            boolean lan = SentinelFlowDto.SCOPE_LAN.equals(f.remoteScope());
            if (SentinelFlowDto.DIR_INBOUND.equals(f.direction())) {
                if (pub) {
                    inboundPublic++;
                } else if (lan) {
                    inboundLan++;
                }
            } else if (SentinelFlowDto.DIR_OUTBOUND.equals(f.direction())) {
                if (pub) {
                    outboundPublic++;
                } else if (lan) {
                    outboundLan++;
                }
            }
        }
        Map<String, Integer> m = new LinkedHashMap<>();
        m.put("total", flows.size());
        m.put("established", established);
        m.put("listeners", listeners);
        m.put("inboundPublic", inboundPublic);
        m.put("inboundLan", inboundLan);
        m.put("outboundPublic", outboundPublic);
        m.put("outboundLan", outboundLan);
        return m;
    }

    static Map<String, Integer> severityCounts(List<NetworkSentinelFinding> findings) {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (String s : List.of(NetworkSentinelFinding.SEV_CRITICAL, NetworkSentinelFinding.SEV_HIGH,
                NetworkSentinelFinding.SEV_MEDIUM, NetworkSentinelFinding.SEV_LOW, NetworkSentinelFinding.SEV_INFO)) {
            m.put(s, 0);
        }
        for (NetworkSentinelFinding f : findings) {
            m.merge(f.getSeverity() != null ? f.getSeverity() : NetworkSentinelFinding.SEV_INFO, 1, Integer::sum);
        }
        return m;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Baseline
    // ------------------------------------------------------------------------------------------------------------

    public SentinelBaseline loadBaseline() {
        Optional<AppParameter> row = appParameterService.find(PARAM_BASELINE);
        if (row.isEmpty() || row.get().getParamValue() == null || row.get().getParamValue().isBlank()) {
            return new SentinelBaseline();
        }
        try {
            return objectMapper.readValue(row.get().getParamValue(), SentinelBaseline.class);
        } catch (JsonProcessingException e) {
            log.warn("network.sentinel.baseline unreadable JSON, starting fresh: {}", e.getMessage());
            return new SentinelBaseline();
        }
    }

    public void saveBaseline(SentinelBaseline baseline) {
        baseline.setUpdatedAt(System.currentTimeMillis());
        try {
            appParameterService.setJson(PARAM_BASELINE, objectMapper.writeValueAsString(baseline),
                    "Network sentinel learned baseline (listeners, logons, ARP, acknowledged findings).");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Serialization network sentinel baseline", e);
        }
    }

    private void updateBaseline(SentinelBaseline b, List<SentinelFlowDto> flows, List<SentinelLogonDto> logons,
            SentinelCaptureResult capture, HostNetworkContext ctx) {
        for (SentinelFlowDto f : flows) {
            if (f.isListener() && !NetworkFlowAnalyzer.isLoopbackBound(f.localAddress())) {
                b.getKnownListeners().add(NetworkFlowAnalyzer.family(f.protocol()) + ":" + f.localPort());
            } else if (SentinelFlowDto.DIR_OUTBOUND.equals(f.direction()) && SentinelIpUtil.isPublic(f.remoteScope())
                    && b.getKnownPublicPeers().size() < PUBLIC_PEERS_CAP) {
                b.getKnownPublicPeers().add(f.remoteAddress());
            }
        }
        if (logons != null) {
            for (SentinelLogonDto l : logons) {
                b.getKnownLogons().add(l.user() + "@" + l.sourceAddress());
            }
        }
        if (capture != null && capture.available()) {
            Map<String, Set<String>> macsByIp = new LinkedHashMap<>();
            for (SentinelCaptureResult.IpMac p : capture.ipToMac()) {
                String mac = SentinelIpUtil.normalizeMac(p.mac());
                if (p.ip() != null && mac.length() == 12 && !SentinelIpUtil.isBroadcastOrEmptyMac(mac)) {
                    macsByIp.computeIfAbsent(p.ip(), k -> new HashSet<>()).add(mac);
                }
            }
            for (Map.Entry<String, Set<String>> e : macsByIp.entrySet()) {
                if (e.getValue().size() == 1) {
                    b.getArpTable().put(e.getKey(), e.getValue().iterator().next());
                }
            }
        }
        b.setInitialized(true);
        b.setSweepCount(b.getSweepCount() + 1);
    }

    public SentinelBaseline acknowledge(String key, boolean acknowledged) {
        SentinelBaseline b = loadBaseline();
        if (acknowledged) {
            b.getAcknowledgedKeys().add(key);
        } else {
            b.getAcknowledgedKeys().remove(key);
        }
        saveBaseline(b);
        return b;
    }

    public void resetBaseline() {
        SentinelBaseline fresh = new SentinelBaseline();
        saveBaseline(fresh);
    }

    // ------------------------------------------------------------------------------------------------------------
    // History
    // ------------------------------------------------------------------------------------------------------------

    public List<NetworkSentinelSweep> history(int limit) {
        int l = Math.max(1, Math.min(limit, HISTORY_KEEP));
        return sweepRepository.findAllByOrderByStartedAtDesc(PageRequest.of(0, l));
    }

    public Optional<NetworkSentinelSweep> latest() {
        return sweepRepository.findFirstByOrderByStartedAtDesc();
    }

    public Optional<NetworkSentinelSweep> get(String id) {
        return sweepRepository.findById(id);
    }

    public long clearHistory() {
        long count = sweepRepository.count();
        sweepRepository.deleteAll();
        return count;
    }

    private void pruneHistory() {
        try {
            if (sweepRepository.count() <= HISTORY_KEEP) {
                return;
            }
            List<NetworkSentinelSweep> older = sweepRepository
                    .findAllByOrderByStartedAtDesc(PageRequest.of(1, HISTORY_KEEP));
            if (!older.isEmpty()) {
                sweepRepository.deleteAll(older);
            }
        } catch (Exception e) {
            log.debug("Sentinel history prune failed: {}", e.getMessage());
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------------------

    @Scheduled(fixedDelay = 60_000L, initialDelay = 90_000L)
    public void scheduledTick() {
        SentinelPrefsDto prefs;
        try {
            prefs = prefsService.getPrefs();
        } catch (Exception e) {
            log.debug("Sentinel scheduler: prefs unavailable: {}", e.getMessage());
            return;
        }
        if (!Boolean.TRUE.equals(prefs.schedulerEnabled()) || running.get()) {
            return;
        }
        long intervalMs = Math.max(5, prefs.schedulerIntervalMinutes()) * 60_000L;
        if (System.currentTimeMillis() - lastSweepStartedAt < intervalMs) {
            return;
        }
        log.info("Sentinel scheduled sweep starting (interval {} min)", prefs.schedulerIntervalMinutes());
        try {
            runSweep(new SweepOptions(Boolean.TRUE.equals(prefs.includeDeviceScan()),
                    Boolean.TRUE.equals(prefs.includeCapture()), prefs.captureSeconds(), "SCHEDULED"), null);
        } catch (IllegalStateException busy) {
            log.debug("Sentinel scheduled sweep skipped: {}", busy.getMessage());
        } catch (Exception e) {
            log.warn("Sentinel scheduled sweep failed: {}", e.toString());
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // E-mail alerts
    // ------------------------------------------------------------------------------------------------------------

    private boolean sendAlertsIfNeeded(NetworkSentinelSweep sweep, List<NetworkSentinelFinding> findings,
            SentinelBaseline baseline, SentinelPrefsDto prefs, HostNetworkContext ctx) {
        int minRank = NetworkSentinelFinding.severityRank(prefs.emailMinSeverity());
        long now = System.currentTimeMillis();
        List<NetworkSentinelFinding> toAlert = new ArrayList<>();
        for (NetworkSentinelFinding f : findings) {
            if (f.isAcknowledged() || NetworkSentinelFinding.severityRank(f.getSeverity()) < minRank) {
                continue;
            }
            Long last = baseline.getLastAlertedAt().get(f.getKey());
            if (last != null && now - last < ALERT_DEDUP_MS) {
                continue;
            }
            toAlert.add(f);
        }
        if (toAlert.isEmpty()) {
            return false;
        }
        try {
            String maxSev = toAlert.get(0).getSeverity();
            String subject = "[PatTool] Sentinelle réseau — " + toAlert.size() + " alerte(s) " + maxSev + " sur "
                    + ctx.hostName();
            mailController.sendMail(subject, buildAlertHtml(toAlert, sweep, ctx), true);
            for (NetworkSentinelFinding f : toAlert) {
                baseline.getLastAlertedAt().put(f.getKey(), now);
            }
            if (baseline.getLastAlertedAt().size() > ALERTED_KEYS_CAP) {
                List<String> oldest = baseline.getLastAlertedAt().entrySet().stream()
                        .sorted(Map.Entry.comparingByValue())
                        .limit(baseline.getLastAlertedAt().size() - ALERTED_KEYS_CAP)
                        .map(Map.Entry::getKey).collect(Collectors.toList());
                oldest.forEach(baseline.getLastAlertedAt()::remove);
            }
            log.info("Sentinel alert e-mail sent for {} finding(s)", toAlert.size());
            return true;
        } catch (Exception e) {
            log.warn("Sentinel alert e-mail failed: {}", e.toString());
            return false;
        }
    }

    private String buildAlertHtml(List<NetworkSentinelFinding> findings, NetworkSentinelSweep sweep,
            HostNetworkContext ctx) {
        StringBuilder b = new StringBuilder();
        b.append("<!DOCTYPE html><html><head><meta charset='UTF-8'><style>");
        b.append("body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:15px;line-height:1.7;color:#2c3e50;")
                .append("background:linear-gradient(135deg,#1f2937 0%,#7f1d1d 100%);margin:0;padding:20px}");
        b.append(".container{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.3);overflow:hidden}");
        b.append(".header{background:linear-gradient(135deg,#b91c1c 0%,#ef4444 100%);color:#fff;padding:25px;text-align:center;border-bottom:4px solid #7f1d1d}");
        b.append(".header h1{margin:0;font-size:22px;font-weight:700;letter-spacing:1px}.header-icon{font-size:32px;margin-bottom:8px}");
        b.append(".content{padding:26px;background:#fafafa}.message{background:#fff;padding:16px;border-radius:8px;margin-bottom:18px;border-left:4px solid #ef4444}");
        b.append(".finding{background:#fff;padding:16px;border-radius:8px;margin-bottom:14px;box-shadow:0 2px 4px rgba(0,0,0,.1)}");
        b.append(".finding h3{margin:0 0 8px 0;font-size:16px;color:#111}.badge{display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;font-size:12px;font-weight:700;margin-right:8px}");
        b.append(".CRITICAL{background:#7f1d1d}.HIGH{background:#dc2626}.MEDIUM{background:#f59e0b}.LOW{background:#2563eb}.INFO{background:#6b7280}");
        b.append(".detail{color:#374151}.evidence{margin-top:8px;font-size:13px;color:#4b5563;background:#f3f4f6;border-radius:6px;padding:8px}");
        b.append(".footer{background:#e9ecef;padding:16px;text-align:center;color:#6c757d;font-size:12px}");
        b.append("</style></head><body><div class='container'>");
        b.append("<div class='header'><div class='header-icon'>🛡️</div><h1>Sentinelle réseau — alerte</h1></div>");
        b.append("<div class='content'><div class='message'>");
        b.append("<p>Hôte PatTool&nbsp;: <strong>").append(esc(ctx.hostName())).append("</strong> (")
                .append(esc(ctx.osName())).append(")</p>");
        b.append("<p><strong>").append(findings.size()).append(" constat(s)</strong> de gravité élevée détecté(s) lors de "
                + "l'analyse du ").append(esc(LocalDateTime.now().format(DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm:ss"))))
                .append(".</p>");
        long intrusions = findings.stream().filter(NetworkSentinelFinding::isIntrusionSucceeded).count();
        if (intrusions > 0) {
            b.append("<p style='color:#b91c1c'><strong>").append(intrusions)
                    .append(" constat(s) indiquent un accès déjà établi</strong> (connexion, session, logon ou appareil présent)"
                            + " et non une simple tentative.</p>");
        }
        b.append("</div>");
        for (NetworkSentinelFinding f : findings) {
            b.append("<div class='finding'><h3><span class='badge ").append(esc(f.getSeverity())).append("'>")
                    .append(esc(f.getSeverity())).append("</span>").append(esc(f.getTitle())).append("</h3>");
            b.append("<div class='detail'>").append(esc(f.getDetail())).append("</div>");
            if (f.getEvidence() != null && !f.getEvidence().isEmpty()) {
                b.append("<div class='evidence'>");
                for (Map.Entry<String, Object> e : f.getEvidence().entrySet()) {
                    b.append("<div><strong>").append(esc(e.getKey())).append("</strong>&nbsp;: ")
                            .append(esc(String.valueOf(e.getValue()))).append("</div>");
                }
                b.append("</div>");
            }
            b.append("</div>");
        }
        b.append("</div><div class='footer'><p>Cet email a été envoyé automatiquement par PatTool — Maison › Sentinelle réseau.</p>");
        b.append("<p>Déclencheur&nbsp;: ").append(esc(sweep.getTrigger() != null ? sweep.getTrigger().toLowerCase(Locale.ROOT) : "manual"))
                .append("</p></div></div></body></html>");
        return b.toString();
    }

    private static String esc(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
                .replace("'", "&#39;");
    }
}
