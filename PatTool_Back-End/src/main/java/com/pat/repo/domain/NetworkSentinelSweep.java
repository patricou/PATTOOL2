package com.pat.repo.domain;

import com.pat.dto.SentinelCaptureResult;
import com.pat.dto.SentinelFlowDto;
import com.pat.dto.SentinelLogonDto;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One full sentinel sweep (device scan + connection table + optional packet capture + logons) with its findings.
 */
@Document(collection = "network_sentinel_sweeps")
public class NetworkSentinelSweep {

    @Id
    private String id;

    @Indexed
    private Date startedAt;
    private Date finishedAt;
    private long durationMs;
    private String trigger; // MANUAL | SCHEDULED
    private String hostName;
    private String os;

    private boolean deviceScanIncluded;
    private int deviceCount;
    private int unknownDeviceCount;
    private List<Map<String, Object>> unknownDevices = new ArrayList<>();

    private int flowCount;
    private int listenerCount;
    private int inboundPublicCount;
    private int outboundPublicCount;
    /** Capped list, most relevant first (public inbound, then outbound public, then LAN, then listeners). */
    private List<SentinelFlowDto> flows = new ArrayList<>();

    private boolean captureIncluded;
    private SentinelCaptureResult capture;

    private List<SentinelLogonDto> logons = new ArrayList<>();
    private List<SentinelLogonDto> sessions = new ArrayList<>();

    private List<NetworkSentinelFinding> findings = new ArrayList<>();
    private Map<String, Integer> severityCounts = new LinkedHashMap<>();
    private int intrusionSucceededCount;
    private String maxSeverity;
    private boolean emailSent;
    private List<String> warnings = new ArrayList<>();
    private boolean baselineLearning;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public Date getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(Date startedAt) {
        this.startedAt = startedAt;
    }

    public Date getFinishedAt() {
        return finishedAt;
    }

    public void setFinishedAt(Date finishedAt) {
        this.finishedAt = finishedAt;
    }

    public long getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(long durationMs) {
        this.durationMs = durationMs;
    }

    public String getTrigger() {
        return trigger;
    }

    public void setTrigger(String trigger) {
        this.trigger = trigger;
    }

    public String getHostName() {
        return hostName;
    }

    public void setHostName(String hostName) {
        this.hostName = hostName;
    }

    public String getOs() {
        return os;
    }

    public void setOs(String os) {
        this.os = os;
    }

    public boolean isDeviceScanIncluded() {
        return deviceScanIncluded;
    }

    public void setDeviceScanIncluded(boolean deviceScanIncluded) {
        this.deviceScanIncluded = deviceScanIncluded;
    }

    public int getDeviceCount() {
        return deviceCount;
    }

    public void setDeviceCount(int deviceCount) {
        this.deviceCount = deviceCount;
    }

    public int getUnknownDeviceCount() {
        return unknownDeviceCount;
    }

    public void setUnknownDeviceCount(int unknownDeviceCount) {
        this.unknownDeviceCount = unknownDeviceCount;
    }

    public List<Map<String, Object>> getUnknownDevices() {
        return unknownDevices;
    }

    public void setUnknownDevices(List<Map<String, Object>> unknownDevices) {
        this.unknownDevices = unknownDevices != null ? unknownDevices : new ArrayList<>();
    }

    public int getFlowCount() {
        return flowCount;
    }

    public void setFlowCount(int flowCount) {
        this.flowCount = flowCount;
    }

    public int getListenerCount() {
        return listenerCount;
    }

    public void setListenerCount(int listenerCount) {
        this.listenerCount = listenerCount;
    }

    public int getInboundPublicCount() {
        return inboundPublicCount;
    }

    public void setInboundPublicCount(int inboundPublicCount) {
        this.inboundPublicCount = inboundPublicCount;
    }

    public int getOutboundPublicCount() {
        return outboundPublicCount;
    }

    public void setOutboundPublicCount(int outboundPublicCount) {
        this.outboundPublicCount = outboundPublicCount;
    }

    public List<SentinelFlowDto> getFlows() {
        return flows;
    }

    public void setFlows(List<SentinelFlowDto> flows) {
        this.flows = flows != null ? flows : new ArrayList<>();
    }

    public boolean isCaptureIncluded() {
        return captureIncluded;
    }

    public void setCaptureIncluded(boolean captureIncluded) {
        this.captureIncluded = captureIncluded;
    }

    public SentinelCaptureResult getCapture() {
        return capture;
    }

    public void setCapture(SentinelCaptureResult capture) {
        this.capture = capture;
    }

    public List<SentinelLogonDto> getLogons() {
        return logons;
    }

    public void setLogons(List<SentinelLogonDto> logons) {
        this.logons = logons != null ? logons : new ArrayList<>();
    }

    public List<SentinelLogonDto> getSessions() {
        return sessions;
    }

    public void setSessions(List<SentinelLogonDto> sessions) {
        this.sessions = sessions != null ? sessions : new ArrayList<>();
    }

    public List<NetworkSentinelFinding> getFindings() {
        return findings;
    }

    public void setFindings(List<NetworkSentinelFinding> findings) {
        this.findings = findings != null ? findings : new ArrayList<>();
    }

    public Map<String, Integer> getSeverityCounts() {
        return severityCounts;
    }

    public void setSeverityCounts(Map<String, Integer> severityCounts) {
        this.severityCounts = severityCounts != null ? severityCounts : new LinkedHashMap<>();
    }

    public int getIntrusionSucceededCount() {
        return intrusionSucceededCount;
    }

    public void setIntrusionSucceededCount(int intrusionSucceededCount) {
        this.intrusionSucceededCount = intrusionSucceededCount;
    }

    public String getMaxSeverity() {
        return maxSeverity;
    }

    public void setMaxSeverity(String maxSeverity) {
        this.maxSeverity = maxSeverity;
    }

    public boolean isEmailSent() {
        return emailSent;
    }

    public void setEmailSent(boolean emailSent) {
        this.emailSent = emailSent;
    }

    public List<String> getWarnings() {
        return warnings;
    }

    public void setWarnings(List<String> warnings) {
        this.warnings = warnings != null ? warnings : new ArrayList<>();
    }

    public boolean isBaselineLearning() {
        return baselineLearning;
    }

    public void setBaselineLearning(boolean baselineLearning) {
        this.baselineLearning = baselineLearning;
    }
}
