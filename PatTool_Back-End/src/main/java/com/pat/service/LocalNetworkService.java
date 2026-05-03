package com.pat.service;

import com.pat.repo.NetworkDeviceMappingRepository;
import com.pat.repo.MacVendorMappingRepository;
import com.pat.repo.NewDeviceHistoryRepository;
import com.pat.repo.domain.NewDeviceHistory;
import com.pat.repo.domain.NetworkDeviceMapping;
import com.pat.repo.domain.MacVendorMapping;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.*;
import java.net.Socket;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.Date;
import java.util.function.Consumer;

@Service
public class LocalNetworkService {

    private static final Logger log = LoggerFactory.getLogger(LocalNetworkService.class);
    /** ICMP/TCP probe timeout; very low values cause flaky discovery under parallel load or on hosts that throttle ICMP */
    private static final int REACHABILITY_TIMEOUT_MS = 500;
    private static final int PORT_TIMEOUT = 120; // ms — slightly relaxed for sluggish IoT / Wi‑Fi stacks
    /** Pool size caps threads; Semaphore caps concurrent host probes to avoid drowning the LAN/router */
    private static final int THREAD_POOL_SIZE = 200;
    private static final int MAX_CONCURRENT_HOST_SCANS = 48;
    private static final List<Integer> COMMON_PORTS = Arrays.asList(22, 80, 443, 445, 3389, 8080);
    /** Extra TCP ports common on printers, IoT, and media devices (used with COMMON_PORTS for discovery) */
    private static final List<Integer> EXTRA_DISCOVERY_PORTS = Arrays.asList(
            21, 23, 135, 139, 554, 631, 1883, 5000, 5357, 8443, 9100, 5900, 6379, 9200, 27017, 62078);
    private static final List<Integer> FAST_SCAN_PORTS;

    static {
        LinkedHashSet<Integer> scanPortSet = new LinkedHashSet<>(COMMON_PORTS);
        scanPortSet.addAll(EXTRA_DISCOVERY_PORTS);
        FAST_SCAN_PORTS = Collections.unmodifiableList(new ArrayList<>(scanPortSet));
    }
    
    private final RestTemplate restTemplate;
    private final NetworkDeviceMappingRepository deviceMappingRepository;
    private final MacVendorMappingRepository macVendorMappingRepository;
    private final NewDeviceHistoryRepository newDeviceHistoryRepository;
    private Map<String, String> routerDeviceMap = null; // Cache for router device names
    private final Map<String, String> vendorCache = new ConcurrentHashMap<>(); // In-memory cache for vendor lookups (OUI -> Vendor) - deprecated, use MongoDB instead
    
    @Value("${app.router.ip:}")
    private String routerIp;
    
    @Value("${app.router.username:admin}")
    private String routerUsername;
    
    @Value("${app.router.password:}")
    private String routerPassword;
    
    @Value("${app.macvendor.api.url:https://api.macvendors.com}")
    private String macVendorApiUrl;
    
    
    @Autowired
    public LocalNetworkService(RestTemplate restTemplate, NetworkDeviceMappingRepository deviceMappingRepository, MacVendorMappingRepository macVendorMappingRepository, NewDeviceHistoryRepository newDeviceHistoryRepository) {
        this.restTemplate = restTemplate;
        this.deviceMappingRepository = deviceMappingRepository;
        this.macVendorMappingRepository = macVendorMappingRepository;
        this.newDeviceHistoryRepository = newDeviceHistoryRepository;
        log.debug("LocalNetworkService initialized. Device mapping repository: {}", deviceMappingRepository != null ? "OK" : "NULL");
        // Device mappings are now managed exclusively through MongoDB (CRUD operations via API)
    }

    /**
     * Functional interface for device callback during streaming scan
     */
    @FunctionalInterface
    public interface DeviceCallback {
        void onDeviceFound(Map<String, Object> device, int progress, int total);
    }

    /**
     * @see #scanLocalNetworkStreaming(boolean, DeviceCallback, Consumer)
     */
    public void scanLocalNetworkStreaming(boolean useExternalVendorAPI, DeviceCallback callback) {
        scanLocalNetworkStreaming(useExternalVendorAPI, callback, null);
    }

    /**
     * Scan the local network for devices with streaming callbacks.
     *
     * @param englishStatusReporter optional concise English phrases for UI (SSE); ignored if {@code null}
     */
    public void scanLocalNetworkStreaming(boolean useExternalVendorAPI, DeviceCallback callback,
            Consumer<String> englishStatusReporter) {
        long startTime = System.currentTimeMillis();
        String scanId = "SCAN-" + System.currentTimeMillis();
        log.debug("========== NETWORK SCAN STARTED [{}] ==========", scanId);
        log.debug("Starting local network scan (streaming mode) - Scan ID: {}", scanId);

        try {
            // Get local network IP range
            String localIp = getLocalIpAddress();
            if (localIp == null) {
                log.debug("Unable to determine local IP address");
                throw new RuntimeException("Unable to determine local IP address");
            }

            String networkBase = getNetworkBase(localIp);
            log.debug("Scanning network range: {}.* (254 IPs)", networkBase);
            log.debug("Thread pool size: {}", THREAD_POOL_SIZE);

            reportEnglishScanStatus(englishStatusReporter,
                    "Scanning subnet " + networkBase + ".0/24 — probing ICMP reachability, ping, "
                            + "and common TCP ports on each host in parallel.");

            final int totalIps = 254;
            final AtomicInteger completedCount = new AtomicInteger(0);
            final AtomicInteger deviceCount = new AtomicInteger(0);
            final Set<String> discoveredIps = ConcurrentHashMap.newKeySet();
            final Semaphore hostScanPermits = new Semaphore(MAX_CONCURRENT_HOST_SCANS);
            
            // Use large thread pool for maximum parallelism
            ExecutorService executor = Executors.newFixedThreadPool(THREAD_POOL_SIZE);
            CountDownLatch latch = new CountDownLatch(totalIps);

            log.debug("Submitting {} scan tasks to thread pool...", totalIps);

            // Submit all scan tasks
            for (int i = 1; i <= totalIps; i++) {
                final String ip = networkBase + "." + i;
                final boolean useExternalAPI = useExternalVendorAPI; // Capture for lambda
                executor.submit(() -> {
                    hostScanPermits.acquireUninterruptibly();
                    try {
                        Map<String, Object> device = scanDeviceFast(ip, useExternalAPI);
                        int completed = completedCount.incrementAndGet();
                        reportEnglishScanStatus(englishStatusReporter,
                                throttleHostSweepStatus(completed, totalIps, deviceCount));

                        if (device != null && !device.isEmpty()) {
                            discoveredIps.add(ip);
                            // Quick vulnerability analysis (simplified)
                            try {
                                List<Map<String, Object>> vulnerabilities = analyzeVulnerabilitiesFast(device);
                                device.put("vulnerabilities", vulnerabilities);
                            } catch (Exception e) {
                                device.put("vulnerabilities", Collections.emptyList());
                            }
                            
                            // Final check: Ensure macAddressSource is always set if macAddress exists
                            if (device.containsKey("macAddress") && device.get("macAddress") != null && 
                                !device.containsKey("macAddressSource")) {
                                log.debug("Device {} - FINAL FIX: MAC address exists but source is not set! MAC: {}", ip, device.get("macAddress"));
                                // Try to determine source by checking MongoDB
                                String existingMac = (String) device.get("macAddress");
                                Optional<NetworkDeviceMapping> finalMapping = deviceMappingRepository.findByIpAddress(ip);
                                if (finalMapping.isPresent() && finalMapping.get().getMacAddress() != null) {
                                    String mongoMac = finalMapping.get().getMacAddress().trim();
                                    if (mongoMac.equalsIgnoreCase(existingMac)) {
                                        device.put("macAddressSource", "mongodb");
                                        device.put("macAddressConflict", false);
                                        log.debug("Device {} - FINAL FIX: MAC address source set to MongoDB", ip);
                                    } else {
                                        // MAC doesn't match MongoDB, likely from ARP
                                        device.put("macAddressSource", "arp");
                                        device.put("macAddressConflict", false);
                                        log.debug("Device {} - FINAL FIX: MAC address source set to ARP (doesn't match MongoDB)", ip);
                                    }
                                } else {
                                    // No MongoDB mapping, likely from ARP
                                    device.put("macAddressSource", "arp");
                                    device.put("macAddressConflict", false);
                                    log.debug("Device {} - FINAL FIX: MAC address source set to ARP (no MongoDB mapping)", ip);
                                }
                            }
                            
                            int found = deviceCount.incrementAndGet();
                            log.debug("[SCAN] Device found #{}: {} (hostname: {})", 
                                    found, ip, device.get("hostname"));
                            
                            // Send device immediately via callback (non-blocking)
                            try {
                                log.debug("[SCAN] Calling callback for device: {}", ip);
                                callback.onDeviceFound(device, completed, totalIps);
                                log.debug("[SCAN] Callback completed for device: {}", ip);
                            } catch (Exception e) {
                                log.debug("[SCAN] Error in callback for device {}: {}", ip, e.getMessage(), e);
                            }
                        }
                        
                        // Log progress every 50 IPs
                        if (completed % 50 == 0) {
                            log.debug("Scan progress: {}/{} IPs completed ({} devices found)", 
                                    completed, totalIps, deviceCount.get());
                        }
                    } catch (Exception e) {
                        log.debug("Error scanning device {}: {}", ip, e.getMessage());
                    } finally {
                        hostScanPermits.release();
                        latch.countDown();
                    }
                });
            }

            log.debug("All {} scan tasks submitted. Waiting for completion...", totalIps);
            reportEnglishScanStatus(englishStatusReporter,
                    "Host sweep in progress — waiting for parallel probes to finish (up to "
                            + totalIps + " addresses)...");

            // Wait for all scans to complete (with timeout)
            boolean allCompleted = false;
            try {
                allCompleted = latch.await(120, TimeUnit.SECONDS);
                if (!allCompleted) {
                    log.debug("Scan timeout after 120 seconds. Completed: {}/{}", 
                            completedCount.get(), totalIps);
                } else {
                    log.debug("All scan tasks completed. Waiting for thread pool shutdown...");
                }
            } catch (InterruptedException e) {
                log.debug("Scan interrupted", e);
                Thread.currentThread().interrupt();
            }

            // Shutdown executor and wait for all threads
            executor.shutdown();
            try {
                if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                    log.debug("Thread pool did not terminate gracefully, forcing shutdown...");
                    executor.shutdownNow();
                    if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                        log.debug("Thread pool did not terminate");
                    }
                }
            } catch (InterruptedException e) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }

            reconcileDevicesFromArpTable(networkBase, discoveredIps, useExternalVendorAPI, callback, totalIps,
                    deviceCount, englishStatusReporter);

            long endTime = System.currentTimeMillis();
            long duration = endTime - startTime;
            
            log.debug("========== NETWORK SCAN COMPLETED [{}] ==========", scanId);
            log.debug("Total scan time: {} ms ({} seconds)", duration, duration / 1000.0);
            log.debug("IPs scanned: {}/{}", completedCount.get(), totalIps);
            log.debug("Devices found: {}", deviceCount.get());
            log.debug("Scan completed: {}", allCompleted ? "YES" : "NO (timeout)");

        } catch (Exception e) {
            log.debug("========== NETWORK SCAN FAILED ==========");
            log.debug("Error during network scan", e);
            throw new RuntimeException("Network scan failed", e);
        }
    }

    private static void reportEnglishScanStatus(Consumer<String> reporter, String message) {
        if (reporter != null && message != null && !message.isBlank()) {
            reporter.accept(message);
        }
    }

    /** @return English status or {@code null} to skip this completion tick */
    private static String throttleHostSweepStatus(int completed, int totalIps, AtomicInteger deviceCount) {
        if (!(completed % 38 == 0 || completed == 10 || completed == totalIps)) {
            return null;
        }
        int n = deviceCount.get();
        return String.format(Locale.ROOT,
                "Host sweep: examined %d of %d LAN addresses (%d responding host%s so far).",
                completed, totalIps, n, n == 1 ? "" : "s");
    }

    /**
     * Scan the local network for devices and vulnerabilities
     */
    public Map<String, Object> scanLocalNetwork() {
        log.debug("Starting local network scan");

        Map<String, Object> result = new HashMap<>();
        List<Map<String, Object>> devices = new ArrayList<>();

        try {
            // Get local network IP range
            String localIp = getLocalIpAddress();
            if (localIp == null) {
                throw new RuntimeException("Unable to determine local IP address");
            }

            String networkBase = getNetworkBase(localIp);
            log.debug("Scanning network: {}", networkBase + ".*");

            // Scan IP range (typically 192.168.1.0-255 or 10.0.0.0-255)
            ExecutorService executor = Executors.newFixedThreadPool(THREAD_POOL_SIZE);
            List<Future<Map<String, Object>>> futures = new ArrayList<>();

            for (int i = 1; i <= 254; i++) {
                final String ip = networkBase + "." + i;
                Future<Map<String, Object>> future = executor.submit(() -> scanDevice(ip));
                futures.add(future);
            }

            // Collect results with shorter timeout
            for (Future<Map<String, Object>> future : futures) {
                try {
                    Map<String, Object> device = future.get(2, TimeUnit.SECONDS);
                    if (device != null && !device.isEmpty()) {
                        devices.add(device);
                    }
                } catch (TimeoutException e) {
                    // Cancel future to free resources
                    future.cancel(true);
                    log.debug("Device scan timeout");
                } catch (Exception e) {
                    log.debug("Error scanning device: {}", e.getMessage());
                }
            }

            executor.shutdown();
            try {
                if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                    executor.shutdownNow();
                }
            } catch (InterruptedException e) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }

            // Analyze vulnerabilities
            for (Map<String, Object> device : devices) {
                List<Map<String, Object>> vulnerabilities = analyzeVulnerabilities(device);
                device.put("vulnerabilities", vulnerabilities);
            }

            result.put("devices", devices);
            result.put("totalDevices", devices.size());
            result.put("scanTime", new Date().toString());

            log.debug("Network scan completed. Found {} devices", devices.size());

        } catch (Exception e) {
            log.debug("Error during network scan", e);
            throw new RuntimeException("Network scan failed: " + e.getMessage(), e);
        }

        return result;
    }

    /**
     * Get local IP address
     */
    private String getLocalIpAddress() {
        try {
            // Try to connect to a remote address to determine local IP
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("8.8.8.8", 80), 1000);
                String localIp = socket.getLocalAddress().getHostAddress();
                        log.debug("Local IP address: {}", localIp);
                return localIp;
            }
        } catch (Exception e) {
            log.debug("Unable to determine local IP via socket, trying network interfaces");
        }

        // Fallback: iterate through network interfaces
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                if (networkInterface.isLoopback() || !networkInterface.isUp()) {
                    continue;
                }

                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                        String ip = address.getHostAddress();
                        log.debug("Local IP address (from interface): {}", ip);
                        return ip;
                    }
                }
            }
        } catch (SocketException e) {
            log.debug("Error getting network interfaces", e);
        }

        return null;
    }

    /**
     * Get network base (e.g., "192.168.1" from "192.168.1.100")
     */
    private String getNetworkBase(String ip) {
        int lastDot = ip.lastIndexOf('.');
        return lastDot > 0 ? ip.substring(0, lastDot) : ip;
    }

    /**
     * Fast scan of a single device (optimized for streaming)
     * Skips expensive operations for speed
     * @param useExternalVendorAPI If true, use external API for vendor detection
     */
    private Map<String, Object> scanDeviceFast(String ip, boolean useExternalVendorAPI) {
        Map<String, Object> device = new HashMap<>();

        try {
            // Quick reachability check (ICMP or echo probe; often fails while host is still up)
            InetAddress address = InetAddress.getByName(ip);
            boolean isReachable = address.isReachable(REACHABILITY_TIMEOUT_MS);
            if (!isReachable && !probeResponsiveHost(ip)) {
                if (!pingReachableQuick(ip)) {
                    return null;
                }
            }

            device.put("ipAddress", ip);
            device.put("status", "online");

            // Priority 1: Get device name from MongoDB if available
            String macAddressMongoDB = null;
            Optional<NetworkDeviceMapping> mapping = deviceMappingRepository.findByIpAddress(ip);
            if (mapping.isPresent()) {
                NetworkDeviceMapping deviceMapping = mapping.get();
                
                // Get device name
                String deviceName = deviceMapping.getDeviceName();
                if (deviceName != null && !deviceName.trim().isEmpty()) {
                    device.put("hostname", deviceName.trim());
                    log.debug("Device {} - Using name from MongoDB: {}", ip, deviceName.trim());
                }
                
                // Get MAC address from mapping (for comparison, but ARP has priority)
                String macAddress = deviceMapping.getMacAddress();
                log.debug("Device {} - MongoDB mapping found. MAC address in mapping: {}", ip, macAddress != null ? macAddress : "NULL");
                if (macAddress != null && !macAddress.trim().isEmpty()) {
                    macAddressMongoDB = macAddress.trim();
                    log.debug("Device {} - Found MAC address from MongoDB: {}", ip, macAddressMongoDB);
                } else {
                    log.debug("Device {} - MongoDB mapping exists but MAC address is empty or null", ip);
                }
            } else {
                log.debug("Device {} - No MongoDB mapping found", ip);
            }
            
            // Priority 2: Quick hostname lookup (only DNS, no router queries) - only if MongoDB mapping didn't provide a name
            if (!device.containsKey("hostname") || device.get("hostname").equals(ip)) {
                try {
                    String hostname = address.getHostName();
                    if (hostname != null && !hostname.equals(ip) && !hostname.isEmpty()) {
                        device.put("hostname", hostname);
                        log.debug("Device {} - Using DNS hostname: {}", ip, hostname);
                    }
                } catch (Exception e) {
                    // Skip hostname if slow
                }
            }

            // Very quick port scan (only most common ports)
            List<Integer> openPorts = quickPortScanFast(ip);
            if (openPorts == null) {
                openPorts = new ArrayList<>();
            }
            device.put("openPorts", openPorts);
            
            // Skip detailed service scanning for speed
            // Only basic service names based on ports
            if (!openPorts.isEmpty()) {
                Map<Integer, Map<String, Object>> portServices = new HashMap<>();
                for (Integer port : openPorts) {
                    Map<String, Object> service = new HashMap<>();
                    service.put("port", port);
                    service.put("service", getServiceName(port));
                    service.put("status", "open");
                    portServices.put(port, service);
                }
                device.put("services", portServices);
            }
            
            // Quick device info (based on ports only)
            // Always set device type, even if no ports are open
            collectDeviceInfoFast(ip, device, openPorts);
            
            // Log device type for debugging
            log.debug("Device {} - Type: {}, Open ports: {}", ip, device.get("deviceType"), openPorts.size());
            
            // Quick OS detection (only if ports are open)
            if (!openPorts.isEmpty()) {
                String os = identifyOperatingSystem(openPorts);
                if (os != null) {
                    device.put("os", os);
                }
            }

            // Priority 1: Try ARP first to get real MAC address from the network device
            String macAddressARP = null;
            try {
                log.debug("Device {} - Starting ARP lookup process", ip);
                
                // Force a socket connection to trigger ARP resolution
                forceARPResolution(ip);
                
                // Ping the device first to populate ARP table (required for ARP to work)
                pingDeviceSync(ip);
                log.debug("Device {} - Ping completed, waiting for ARP table update", ip);
                
                // Longer delay to ensure ARP table is updated (especially on Windows)
                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                
                // Try ARP lookup multiple times
                for (int retry = 0; retry < 3; retry++) {
                    if (retry > 0) {
                        log.debug("Device {} - ARP lookup retry {} of 3", ip, retry);
                        Thread.sleep(100);
                    }
                    macAddressARP = getMacAddressFromARP(ip);
                    if (macAddressARP != null && !macAddressARP.isEmpty()) {
                        log.debug("Device {} - Found MAC address from ARP (network device): {}", ip, macAddressARP);
                        break;
                    } else {
                        log.debug("Device {} - ARP lookup attempt {} returned null or empty", ip, retry + 1);
                    }
                }
                
                if (macAddressARP == null || macAddressARP.isEmpty()) {
                    log.debug("Device {} - ARP lookup failed after all attempts, device may not be in ARP table", ip);
                }
            } catch (Exception e) {
                log.debug("Could not get MAC address from ARP for {} in fast scan: {}", ip, e.getMessage(), e);
            }
            
            // Compare MAC addresses and set them with sources (ARP has priority)
            if (macAddressARP != null && macAddressMongoDB != null) {
                // Both sources have MAC addresses - compare them
                if (!macAddressARP.equalsIgnoreCase(macAddressMongoDB)) {
                    // Different MAC addresses - store ARP as primary (real device MAC), MongoDB as conflict
                    device.put("macAddress", macAddressARP);
                    device.put("macAddressSource", "arp");
                    device.put("macAddressMongoDB", macAddressMongoDB);
                    device.put("macAddressConflict", true);
                    log.debug("Device {} - MAC address conflict: ARP (real)={}, MongoDB={}", ip, macAddressARP, macAddressMongoDB);
                } else {
                    // Same MAC address - use ARP as primary source (real device MAC)
                    device.put("macAddress", macAddressARP);
                    device.put("macAddressSource", "arp");
                    device.put("macAddressConflict", false);
                    log.debug("Device {} - MAC address from ARP (confirmed by MongoDB): {}", ip, macAddressARP);
                }
            } else if (macAddressARP != null) {
                // Only ARP has MAC address (real device MAC)
                device.put("macAddress", macAddressARP);
                device.put("macAddressSource", "arp");
                device.put("macAddressConflict", false);
                log.debug("Device {} - MAC address from ARP only (real device MAC): {}", ip, macAddressARP);
            } else if (macAddressMongoDB != null) {
                // Only MongoDB has MAC address (fallback)
                device.put("macAddress", macAddressMongoDB);
                device.put("macAddressSource", "mongodb");
                device.put("macAddressConflict", false);
                log.debug("Device {} - MAC address from MongoDB only (fallback): {}", ip, macAddressMongoDB);
            } else {
                // No MAC address found from any source
                log.debug("Device {} - No MAC address found from ARP or MongoDB", ip);
            }
            
                // Set vendor from the primary MAC address - ALWAYS try to find vendor (tries both API and local DB)
                String primaryMac = (String) device.get("macAddress");
                if (primaryMac != null) {
                    log.debug("Device {} - Attempting to identify vendor for MAC: {} (preferExternalAPI: {})", ip, primaryMac, useExternalVendorAPI);
                    // identifyVendor now tries both methods automatically (API first if useExternalVendorAPI=true, then local DB as fallback)
                    String vendor = identifyVendor(primaryMac, useExternalVendorAPI);
                    if (vendor != null && !vendor.trim().isEmpty()) {
                        device.put("vendor", vendor);
                        log.debug("Device {} - Vendor identified: {}", ip, vendor);
                    } else {
                        log.debug("Device {} - No vendor found for MAC: {} with any method", ip, primaryMac);
                    }
                } else {
                    log.debug("Device {} - No MAC address available for vendor identification", ip);
                }

            // FINAL CHECK: Ensure macAddressSource is ALWAYS set if macAddress exists (before returning)
            if (device.containsKey("macAddress") && device.get("macAddress") != null) {
                if (!device.containsKey("macAddressSource") || device.get("macAddressSource") == null) {
                    log.debug("Device {} - CRITICAL FIX: MAC address exists but source is not set! MAC: {}", ip, device.get("macAddress"));
                    // Try to determine source by checking MongoDB
                    String existingMac = (String) device.get("macAddress");
                    Optional<NetworkDeviceMapping> finalMapping = deviceMappingRepository.findByIpAddress(ip);
                    if (finalMapping.isPresent() && finalMapping.get().getMacAddress() != null) {
                        String mongoMac = finalMapping.get().getMacAddress().trim();
                        if (mongoMac.equalsIgnoreCase(existingMac)) {
                            device.put("macAddressSource", "mongodb");
                            device.put("macAddressConflict", false);
                            log.debug("Device {} - CRITICAL FIX: MAC address source set to MongoDB", ip);
                        } else {
                            // MAC doesn't match MongoDB, likely from ARP
                            device.put("macAddressSource", "arp");
                            device.put("macAddressConflict", false);
                            log.debug("Device {} - CRITICAL FIX: MAC address source set to ARP (doesn't match MongoDB)", ip);
                        }
                    } else {
                        // No MongoDB mapping, likely from ARP
                        device.put("macAddressSource", "arp");
                        device.put("macAddressConflict", false);
                        log.debug("Device {} - CRITICAL FIX: MAC address source set to ARP (no MongoDB mapping)", ip);
                    }
                }
            }

            device.put("lastSeen", new Date());
            return device;

        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Scan a single device (full scan with all details)
     */
    private Map<String, Object> scanDevice(String ip) {
        Map<String, Object> device = new HashMap<>();

        try {
            // Check if host is reachable
            InetAddress address = InetAddress.getByName(ip);
            boolean isReachable = address.isReachable(REACHABILITY_TIMEOUT_MS);
            if (!isReachable && !probeResponsiveHost(ip)) {
                if (!pingReachableQuick(ip)) {
                    return null; // Device not online
                }
            }

            device.put("ipAddress", ip);
            device.put("status", "online");

            // Try multiple methods to get hostname
            String hostname = getDeviceHostname(ip);
            if (hostname != null && !hostname.isEmpty() && !hostname.equals(ip)) {
                device.put("hostname", hostname);
                log.debug("Hostname found for {}: {}", ip, hostname);
            }

            // Quick port scan first (fast scan without service details)
            List<Integer> openPorts = quickPortScan(ip);
            device.put("openPorts", openPorts);
            
            // Only scan services for devices with open ports (optimization)
            if (!openPorts.isEmpty()) {
                Map<Integer, Map<String, Object>> portServices = scanPortsWithServices(ip, openPorts);
                device.put("services", portServices);
            }
            
            // Collect additional device information
            collectDeviceInfo(ip, device, openPorts);

            // Try to get MAC address - multiple sources (ARP has priority - real device MAC)
            try {
                String macAddressMongoDB = null;
                String macAddressARP = null;
                
                // Priority 1: Try ARP table first (real MAC address from network device)
                // Ping the device first to populate ARP table
                pingDeviceSync(ip);
                
                // Try ARP lookup
                macAddressARP = getMacAddressFromARP(ip);
                if (macAddressARP != null && !macAddressARP.isEmpty()) {
                    log.debug("Found MAC address from ARP table (real device MAC) for {}: {}", ip, macAddressARP);
                }
                
                // Priority 2: Check MongoDB mappings (for comparison/fallback)
                Optional<NetworkDeviceMapping> mapping = deviceMappingRepository.findByIpAddress(ip);
                if (mapping.isPresent() && mapping.get().getMacAddress() != null && !mapping.get().getMacAddress().trim().isEmpty()) {
                    macAddressMongoDB = mapping.get().getMacAddress().trim();
                    log.debug("Found MAC address from MongoDB mapping for {}: {}", ip, macAddressMongoDB);
                }
                
                // Priority 3: Try local interface method (only works for local machine) - only if both ARP and MongoDB failed
                String macAddressLocal = null;
                if ((macAddressARP == null || macAddressARP.isEmpty()) && (macAddressMongoDB == null || macAddressMongoDB.isEmpty())) {
                    macAddressLocal = getMacAddress(ip);
                    if (macAddressLocal != null && !macAddressLocal.isEmpty()) {
                        log.debug("Found MAC address from local interface for {}: {}", ip, macAddressLocal);
                    }
                }
                
                // Compare MAC addresses and set them with sources (ARP has priority)
                if (macAddressARP != null && macAddressMongoDB != null) {
                    // Both sources have MAC addresses - compare them
                    if (!macAddressARP.equalsIgnoreCase(macAddressMongoDB)) {
                        // Different MAC addresses - store ARP as primary (real device MAC), MongoDB as conflict
                        device.put("macAddress", macAddressARP);
                        device.put("macAddressSource", "arp");
                        device.put("macAddressMongoDB", macAddressMongoDB);
                        device.put("macAddressConflict", true);
                        log.debug("Device {} - MAC address conflict: ARP (real)={}, MongoDB={}", ip, macAddressARP, macAddressMongoDB);
                    } else {
                        // Same MAC address - use ARP as primary source (real device MAC)
                        device.put("macAddress", macAddressARP);
                        device.put("macAddressSource", "arp");
                        device.put("macAddressConflict", false);
                        log.debug("Device {} - MAC address from ARP (confirmed by MongoDB): {}", ip, macAddressARP);
                    }
                } else if (macAddressARP != null) {
                    // Only ARP has MAC address (real device MAC)
                    device.put("macAddress", macAddressARP);
                    device.put("macAddressSource", "arp");
                    device.put("macAddressConflict", false);
                    log.debug("Device {} - MAC address from ARP only (real device MAC): {}", ip, macAddressARP);
                } else if (macAddressMongoDB != null) {
                    // Only MongoDB has MAC address (fallback)
                    device.put("macAddress", macAddressMongoDB);
                    device.put("macAddressSource", "mongodb");
                    device.put("macAddressConflict", false);
                    log.debug("Device {} - MAC address from MongoDB only (fallback): {}", ip, macAddressMongoDB);
                } else if (macAddressLocal != null) {
                    // Only local interface has MAC address
                    device.put("macAddress", macAddressLocal);
                    device.put("macAddressSource", "local");
                    device.put("macAddressConflict", false);
                    log.debug("Device {} - MAC address from local interface only: {}", ip, macAddressLocal);
                } else {
                    log.debug("MAC address not found for {} from any source", ip);
                }
                
                // Ensure macAddressSource is always set if macAddress exists (for scanDevice method)
                if (device.containsKey("macAddress") && device.get("macAddress") != null && 
                    !device.containsKey("macAddressSource")) {
                    log.debug("Device {} - WARNING: MAC address exists but source is not set! MAC: {}", ip, device.get("macAddress"));
                    // Try to determine source by checking if it matches any known source
                    String existingMac = (String) device.get("macAddress");
                    // Re-check MongoDB mapping
                    Optional<NetworkDeviceMapping> recheckMapping = deviceMappingRepository.findByIpAddress(ip);
                    if (recheckMapping.isPresent() && recheckMapping.get().getMacAddress() != null) {
                        String mongoMac = recheckMapping.get().getMacAddress().trim();
                        if (mongoMac.equalsIgnoreCase(existingMac)) {
                            device.put("macAddressSource", "mongodb");
                            device.put("macAddressConflict", false);
                            log.debug("Device {} - Fixed: MAC address source set to MongoDB", ip);
                        } else {
                            // MAC doesn't match MongoDB, might be from ARP but ARP lookup failed
                            // Set as MongoDB anyway as fallback since we have it
                            device.put("macAddressSource", "mongodb");
                            device.put("macAddressConflict", false);
                            log.debug("Device {} - Fixed: MAC address source set to MongoDB (fallback, MAC doesn't match)", ip);
                        }
                    } else {
                        // No MongoDB mapping, but MAC exists - likely from ARP but source wasn't set
                        // Set as ARP as best guess
                        device.put("macAddressSource", "arp");
                        device.put("macAddressConflict", false);
                        log.debug("Device {} - Fixed: MAC address source set to ARP (best guess, no MongoDB mapping)", ip);
                    }
                }
                
                // Set vendor from the primary MAC address
                String primaryMac = (String) device.get("macAddress");
                if (primaryMac != null) {
                    // Note: scanDevice doesn't have useExternalVendorAPI parameter, use local database
                    String vendor = identifyVendor(primaryMac, false);
                    if (vendor != null) {
                        device.put("vendor", vendor);
                    }
                }
                } catch (Exception e) {
                log.debug("Could not get MAC address for {}: {}", ip, e.getMessage());
            }

            // Try to identify OS based on open ports
            String os = identifyOperatingSystem(openPorts);
            if (os != null) {
                device.put("os", os);
            }

            device.put("lastSeen", new Date());

            return device;

        } catch (UnknownHostException e) {
            log.debug("Unknown host: {}", ip);
            return null;
        } catch (IOException e) {
            log.debug("IO error scanning {}: {}", ip, e.getMessage());
            return null;
        } catch (Exception e) {
            log.debug("Error scanning device {}: {}", ip, e.getMessage());
            return null;
        }
    }

    /**
     * Scan common ports on a device
     */
    private List<Integer> scanPorts(String ip) {
        List<Integer> openPorts = new ArrayList<>();
        int pool = Math.min(20, FAST_SCAN_PORTS.size());
        ExecutorService executor = Executors.newFixedThreadPool(pool);

        List<Future<Boolean>> futures = new ArrayList<>();
        for (int port : FAST_SCAN_PORTS) {
            final int portNum = port;
            Future<Boolean> future = executor.submit(() -> isPortOpen(ip, portNum));
            futures.add(future);
        }

        for (int i = 0; i < FAST_SCAN_PORTS.size(); i++) {
            try {
                if (futures.get(i).get(500, TimeUnit.MILLISECONDS)) {
                    openPorts.add(FAST_SCAN_PORTS.get(i));
                }
            } catch (Exception e) {
                // Port is closed or timeout
            }
        }

        executor.shutdown();
        return openPorts;
    }

    /**
     * Ultra-fast port scan (sequential for speed, no thread pool overhead)
     */
    private List<Integer> quickPortScanFast(String ip) {
        List<Integer> openPorts = new ArrayList<>();
        for (int port : FAST_SCAN_PORTS) {
            if (isPortOpen(ip, port)) {
                openPorts.add(port);
            }
        }
        return openPorts;
    }

    /**
     * Quick port scan without service details (faster)
     */
    private List<Integer> quickPortScan(String ip) {
        List<Integer> openPorts = new ArrayList<>();
        int pool = Math.min(20, FAST_SCAN_PORTS.size());
        ExecutorService executor = Executors.newFixedThreadPool(pool);

        List<Future<Boolean>> futures = new ArrayList<>();
        for (int port : FAST_SCAN_PORTS) {
            final int portNum = port;
            Future<Boolean> future = executor.submit(() -> isPortOpen(ip, portNum));
            futures.add(future);
        }

        for (int i = 0; i < FAST_SCAN_PORTS.size(); i++) {
            try {
                if (futures.get(i).get(PORT_TIMEOUT, TimeUnit.MILLISECONDS)) {
                    openPorts.add(FAST_SCAN_PORTS.get(i));
                }
            } catch (Exception e) {
                // Port is closed or timeout
            }
        }

        executor.shutdown();
        try {
            if (!executor.awaitTermination(1, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
        return openPorts;
    }

    /**
     * Scan ports and detect services with versions (only for open ports)
     */
    private Map<Integer, Map<String, Object>> scanPortsWithServices(String ip, List<Integer> openPorts) {
        Map<Integer, Map<String, Object>> portServices = new HashMap<>();
        if (openPorts.isEmpty()) {
            return portServices;
        }

        ExecutorService executor = Executors.newFixedThreadPool(Math.min(openPorts.size(), 10));

        List<Future<Map<String, Object>>> futures = new ArrayList<>();
        for (int port : openPorts) {
            final int portNum = port;
            Future<Map<String, Object>> future = executor.submit(() -> scanPortForService(ip, portNum));
            futures.add(future);
        }

        for (int i = 0; i < openPorts.size(); i++) {
            try {
                Map<String, Object> serviceInfo = futures.get(i).get(500, TimeUnit.MILLISECONDS);
                if (serviceInfo != null && !serviceInfo.isEmpty()) {
                    portServices.put(openPorts.get(i), serviceInfo);
                }
            } catch (Exception e) {
                // Port scan failed or timeout
            }
        }

        executor.shutdown();
        try {
            if (!executor.awaitTermination(1, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
        return portServices;
    }

    /**
     * Scan a specific port and detect service information
     */
    private Map<String, Object> scanPortForService(String ip, int port) {
        Map<String, Object> serviceInfo = new HashMap<>();
        
        // Port is already known to be open, skip check
        // if (!isPortOpen(ip, port)) {
        //     return serviceInfo; // Empty if port closed
        // }

        serviceInfo.put("port", port);
        serviceInfo.put("status", "open");
        
        // Detect service based on port
        String serviceName = getServiceName(port);
        serviceInfo.put("service", serviceName);
        
        // Try to get service banner/version
        try {
            String banner = getServiceBanner(ip, port, serviceName);
            if (banner != null && !banner.isEmpty()) {
                serviceInfo.put("banner", banner);
                serviceInfo.put("version", extractVersion(banner));
            }
        } catch (Exception e) {
            log.debug("Could not get banner for {}:{} - {}", ip, port, e.getMessage());
        }
        
        // Additional info based on service type
        if ("HTTP".equals(serviceName) || "HTTPS".equals(serviceName)) {
            try {
                Map<String, String> httpInfo = getHttpInfo(ip, port);
                serviceInfo.putAll(httpInfo);
            } catch (Exception e) {
                log.debug("Could not get HTTP info for {}:{}", ip, port);
            }
        }

        return serviceInfo;
    }

    /**
     * Get service name from port number
     */
    private String getServiceName(int port) {
        switch (port) {
            case 22: return "SSH";
            case 23: return "Telnet";
            case 80: return "HTTP";
            case 135: return "RPC";
            case 139: return "NetBIOS";
            case 443: return "HTTPS";
            case 445: return "SMB";
            case 3306: return "MySQL";
            case 3389: return "RDP";
            case 5432: return "PostgreSQL";
            case 554: return "RTSP";
            case 631: return "IPP";
            case 1883: return "MQTT";
            case 5000: return "UPnP";
            case 5357: return "WSD";
            case 8080: return "HTTP-Proxy";
            case 8443: return "HTTPS-Alt";
            case 9100: return "Raw-Print";
            case 62078: return "AirPlay";
            case 21: return "FTP";
            case 5900: return "VNC";
            case 6379: return "Redis";
            case 9200: return "Elasticsearch";
            case 27017: return "MongoDB";
            default: return "Unknown";
        }
    }

    /**
     * Get service banner
     */
    private String getServiceBanner(String ip, int port, String serviceName) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(ip, port), PORT_TIMEOUT);
            socket.setSoTimeout(PORT_TIMEOUT);
            
            // Send probe based on service type
            if ("SSH".equals(serviceName)) {
                // SSH sends banner on connection
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream()));
                return reader.readLine();
            } else if ("HTTP".equals(serviceName) || "HTTPS".equals(serviceName)) {
                // HTTP - get server header
                PrintWriter writer = new PrintWriter(socket.getOutputStream(), true);
                writer.println("HEAD / HTTP/1.1");
                writer.println("Host: " + ip);
                writer.println();
                
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream()));
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("server:")) {
                        return line.substring(7).trim();
                    }
                }
            } else if ("Telnet".equals(serviceName)) {
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream()));
                return reader.readLine();
            }
        } catch (Exception e) {
            log.debug("Banner grab failed for {}:{} - {}", ip, port, e.getMessage());
        }
        return null;
    }

    /**
     * Extract version from banner
     */
    private String extractVersion(String banner) {
        if (banner == null) return null;
        
        // Try to extract version numbers (e.g., "Apache/2.4.41")
        Pattern pattern = Pattern.compile("(\\d+\\.\\d+(?:\\.\\d+)?)");
        Matcher matcher = pattern.matcher(banner);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return null;
    }

    /**
     * Get HTTP server information
     * Note: Currently disabled for performance - HTTP requests are slow
     * Uncomment code below to enable HTTP info collection
     */
    private Map<String, String> getHttpInfo(String ip, int port) {
        Map<String, String> httpInfo = new HashMap<>();
        
        // Skip HTTP info collection for performance - HTTP requests are slow
        // This significantly speeds up the scan
        // Uncomment below to enable HTTP info collection:
        /*
        try {
            String protocol = (port == 443 || port == 8443) ? "https" : "http";
            String url = protocol + "://" + ip + ":" + port;
            
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", "Mozilla/5.0");
            HttpEntity<String> entity = new HttpEntity<>(headers);
            
            ResponseEntity<String> response = restTemplate.exchange(
                url, HttpMethod.HEAD, entity, String.class
            );
            
            HttpHeaders responseHeaders = response.getHeaders();
            
            // Server header
            if (responseHeaders.containsKey("Server")) {
                httpInfo.put("server", responseHeaders.getFirst("Server"));
            }
            
            // X-Powered-By header
            if (responseHeaders.containsKey("X-Powered-By")) {
                httpInfo.put("poweredBy", responseHeaders.getFirst("X-Powered-By"));
            }
            
            // Content-Type
            if (responseHeaders.containsKey("Content-Type")) {
                httpInfo.put("contentType", responseHeaders.getFirst("Content-Type"));
            }
        } catch (Exception e) {
            log.debug("HTTP info collection failed for {}:{}", ip, port);
        }
        */
        
        return httpInfo;
    }

    /**
     * Fast collection of device information (simplified)
     */
    private void collectDeviceInfoFast(String ip, Map<String, Object> device, List<Integer> openPorts) {
        // Device type detection (always set a type)
        String deviceType = detectDeviceType(openPorts, device);
        String finalDeviceType = deviceType != null ? deviceType : "Unknown Device";
        device.put("deviceType", finalDeviceType);
        log.debug("Device {} - Setting deviceType to: {} (openPorts: {})", ip, finalDeviceType, openPorts);
        
        // Web interface detection
        if (openPorts.contains(80) || openPorts.contains(443) || openPorts.contains(8080)) {
            device.put("webInterface", true);
            String webUrl = openPorts.contains(443) ? "https://" + ip : 
                          openPorts.contains(8080) ? "http://" + ip + ":8080" : 
                          "http://" + ip;
            device.put("webUrl", webUrl);
        }
        
        // Database server detection
        if (openPorts.contains(3306)) {
            device.put("databaseServer", "MySQL");
        } else if (openPorts.contains(5432)) {
            device.put("databaseServer", "PostgreSQL");
        }
        
        // File sharing detection
        if (openPorts.contains(445) || openPorts.contains(139)) {
            device.put("fileSharing", true);
        }
        
        // Remote access detection
        if (openPorts.contains(3389)) {
            device.put("remoteAccess", "RDP");
        } else if (openPorts.contains(22)) {
            device.put("remoteAccess", "SSH");
        }
    }

    /**
     * Collect additional device information
     */
    private void collectDeviceInfo(String ip, Map<String, Object> device, List<Integer> openPorts) {
        // Device type detection (always set a type)
        String deviceType = detectDeviceType(openPorts, device);
        device.put("deviceType", deviceType != null ? deviceType : "Unknown Device");
        
        // Uptime estimation (if SSH available)
        if (openPorts.contains(22)) {
            // Could try to get uptime via SSH, but requires credentials
            device.put("sshAvailable", true);
        }
        
        // Web interface detection
        if (openPorts.contains(80) || openPorts.contains(443) || openPorts.contains(8080)) {
            device.put("webInterface", true);
            String webUrl = openPorts.contains(443) ? "https://" + ip : 
                          openPorts.contains(8080) ? "http://" + ip + ":8080" : 
                          "http://" + ip;
            device.put("webUrl", webUrl);
        }
        
        // Database server detection
        if (openPorts.contains(3306)) {
            device.put("databaseServer", "MySQL");
        } else if (openPorts.contains(5432)) {
            device.put("databaseServer", "PostgreSQL");
        }
        
        // File sharing detection
        if (openPorts.contains(445) || openPorts.contains(139)) {
            device.put("fileSharing", true);
        }
        
        // Remote access detection
        if (openPorts.contains(3389)) {
            device.put("remoteAccess", "RDP");
        } else if (openPorts.contains(22)) {
            device.put("remoteAccess", "SSH");
        }
    }

    /**
     * Detect device type based on open ports and other info
     */
    /**
     * Detect device type based on vendor (MAC address) and open ports
     * This provides more accurate device type detection by combining vendor information with port analysis
     */
    private String detectDeviceType(List<Integer> openPorts, Map<String, Object> device) {
        String vendor = (String) device.get("vendor");
        boolean hasOpenPorts = openPorts != null && !openPorts.isEmpty();
        
        // First, try to detect based on vendor + ports combination
        if (vendor != null && hasOpenPorts) {
            String vendorBasedType = detectDeviceTypeFromVendor(vendor, openPorts);
            if (vendorBasedType != null) {
                return vendorBasedType;
            }
        }
        
        // If vendor-based detection didn't work, fall back to port-based detection
        if (!hasOpenPorts) {
            // No open ports - try to infer from vendor only
            if (vendor != null) {
                return inferDeviceTypeFromVendor(vendor);
            }
            return "Unknown Device";
        }
        
        // Router/Gateway detection
        if ((openPorts.contains(80) || openPorts.contains(443)) && !openPorts.contains(22) && !openPorts.contains(3389)) {
            if (openPorts.contains(80) && openPorts.contains(443)) {
                return "Router/Gateway";
            }
            if (openPorts.contains(80) && openPorts.size() <= 3) {
                return "Router/Gateway";
            }
        }
        
        // Server detection
        if (openPorts.contains(22) && (openPorts.contains(3306) || openPorts.contains(5432))) {
            return "Server";
        }
        if (openPorts.contains(22) && openPorts.contains(80)) {
            return "Server";
        }
        
        // NAS/Storage detection
        if (openPorts.contains(445) || openPorts.contains(139)) {
            if (openPorts.contains(80) || openPorts.contains(443)) {
                return "NAS/Storage";
            }
            return "Windows PC";
        }
        
        // Windows PC detection
        if (openPorts.contains(3389)) {
            return "Windows PC";
        }
        if (openPorts.contains(135) && openPorts.contains(445)) {
            return "Windows PC";
        }
        
        // IoT device detection
        if (openPorts.contains(80) && openPorts.size() <= 2) {
            return "IoT Device";
        }
        
        // Printer detection (common printer ports)
        if (openPorts.contains(9100) || openPorts.contains(515)) {
            return "Printer";
        }
        
        // Web server detection
        if (openPorts.contains(80) || openPorts.contains(443) || openPorts.contains(8080)) {
            return "Web Server";
        }
        
        // Linux/Unix server
        if (openPorts.contains(22)) {
            return "Linux/Unix Server";
        }
        
        // Default: try to infer from ports
        if (openPorts.size() == 1) {
            int port = openPorts.get(0);
            if (port == 80 || port == 443) {
                return "Web Device";
            }
        }
        
        return "Network Device";
    }
    
    /**
     * Detect device type from vendor and open ports combination
     * This provides more specific device type identification
     */
    private String detectDeviceTypeFromVendor(String vendor, List<Integer> openPorts) {
        if (vendor == null || openPorts == null || openPorts.isEmpty()) {
            return null;
        }
        
        vendor = vendor.toLowerCase();
        
        // Apple devices
        if (vendor.contains("apple")) {
            if (openPorts.contains(22)) {
                return "Mac (SSH enabled)";
            }
            if (openPorts.contains(80) || openPorts.contains(443)) {
                if (openPorts.size() <= 2) {
                    return "iPhone/iPad";
                }
                return "Mac";
            }
            return "Apple Device";
        }
        
        // Samsung devices
        if (vendor.contains("samsung")) {
            if (openPorts.contains(80) || openPorts.contains(443)) {
                if (openPorts.size() <= 3) {
                    return "Samsung Smart TV/Phone";
                }
                return "Samsung Device";
            }
            return "Samsung Device";
        }
        
        // Cisco devices (routers, switches)
        if (vendor.contains("cisco")) {
            if (openPorts.contains(80) || openPorts.contains(443) || openPorts.contains(22)) {
                return "Cisco Router/Switch";
            }
            return "Cisco Network Device";
        }
        
        // TP-Link devices (routers, access points)
        if (vendor.contains("tp-link")) {
            if (openPorts.contains(80) || openPorts.contains(443)) {
                return "TP-Link Router/Access Point";
            }
            return "TP-Link Network Device";
        }
        
        // Huawei devices (routers, phones)
        if (vendor.contains("huawei")) {
            if (openPorts.contains(80) || openPorts.contains(443)) {
                if (openPorts.size() <= 3) {
                    return "Huawei Router/Phone";
                }
                return "Huawei Network Device";
            }
            return "Huawei Device";
        }
        
        // Intel devices (usually computers/servers)
        if (vendor.contains("intel")) {
            if (openPorts.contains(22)) {
                return "Linux Server (Intel)";
            }
            if (openPorts.contains(3389)) {
                return "Windows PC (Intel)";
            }
            if (openPorts.contains(80) || openPorts.contains(443)) {
                return "Server/PC (Intel)";
            }
            return "Intel Device";
        }
        
        // Microsoft devices (usually virtual machines or Windows devices)
        if (vendor.contains("microsoft")) {
            if (openPorts.contains(3389)) {
                return "Windows PC/Server";
            }
            if (openPorts.contains(445) || openPorts.contains(139)) {
                return "Windows PC";
            }
            return "Microsoft Device";
        }
        
        // VMware virtual machines
        if (vendor.contains("vmware")) {
            if (openPorts.contains(22)) {
                return "Linux VM (VMware)";
            }
            if (openPorts.contains(3389)) {
                return "Windows VM (VMware)";
            }
            return "VMware Virtual Machine";
        }
        
        // VirtualBox virtual machines
        if (vendor.contains("virtualbox")) {
            if (openPorts.contains(22)) {
                return "Linux VM (VirtualBox)";
            }
            if (openPorts.contains(3389)) {
                return "Windows VM (VirtualBox)";
            }
            return "VirtualBox Virtual Machine";
        }
        
        return null; // No specific vendor-based detection
    }
    
    /**
     * Infer device type from vendor only (when no ports are open)
     */
    private String inferDeviceTypeFromVendor(String vendor) {
        if (vendor == null) {
            return "Unknown Device";
        }
        
        vendor = vendor.toLowerCase();
        
        if (vendor.contains("apple")) {
            return "Apple Device";
        }
        if (vendor.contains("samsung")) {
            return "Samsung Device";
        }
        if (vendor.contains("cisco")) {
            return "Cisco Network Device";
        }
        if (vendor.contains("tp-link")) {
            return "TP-Link Network Device";
        }
        if (vendor.contains("huawei")) {
            return "Huawei Device";
        }
        if (vendor.contains("intel")) {
            return "Intel Device";
        }
        if (vendor.contains("microsoft")) {
            return "Microsoft Device";
        }
        if (vendor.contains("vmware")) {
            return "VMware Virtual Machine";
        }
        if (vendor.contains("virtualbox")) {
            return "VirtualBox Virtual Machine";
        }
        
        return "Network Device";
    }

    /**
     * Check if a port is open
     */
    private boolean isPortOpen(String ip, int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(ip, port), PORT_TIMEOUT);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** True when any common LAN service answers TCP — catches hosts that ignore {@link InetAddress#isReachable(int)} probes. */
    private boolean probeResponsiveHost(String ip) {
        for (int port : FAST_SCAN_PORTS) {
            if (isPortOpen(ip, port)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Force ARP resolution by attempting a socket connection
     * This helps populate the ARP table before querying it
     * @param ip IP address to resolve
     */
    private void forceARPResolution(String ip) {
        try {
            // Try to connect to a common port to force ARP resolution
            // This doesn't need to succeed, just trigger ARP
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(ip, 80), 100);
                socket.close();
            } catch (Exception e) {
                // Connection failure is OK, we just want to trigger ARP
                log.debug("Socket connection to {}:80 failed (expected), but ARP may have been triggered", ip);
            }
            
            // Also try port 443
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(ip, 443), 100);
                socket.close();
            } catch (Exception e) {
                // Connection failure is OK
            }
        } catch (Exception e) {
            log.debug("Force ARP resolution failed for {}: {}", ip, e.getMessage());
        }
    }

    /**
     * Ping a device synchronously to ensure it's in ARP table
     * @param ip IP address to ping
     */
    private void pingDeviceSync(String ip) {
        try {
            String os = System.getProperty("os.name").toLowerCase();
            ProcessBuilder pb;
            
            if (os.contains("win")) {
                // Windows: ping -n 2 -w 500 ip (2 packets, 500ms timeout per packet)
                // More packets and longer timeout to ensure ARP table is populated
                pb = new ProcessBuilder("ping", "-n", "2", "-w", "500", ip);
            } else {
                // Linux/Unix: ping -c 2 -W 2 ip (2 packets, 2 second timeout)
                pb = new ProcessBuilder("ping", "-c", "2", "-W", "2", ip);
            }
            
            // Redirect error stream to avoid cluttering logs
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            Process process = pb.start();
            
            // Wait for ping to complete (with timeout - longer for better ARP population)
            boolean finished = process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
            }
        } catch (Exception e) {
            // Silently fail - ping is just to populate ARP, not critical
            log.debug("Ping failed for {}: {}", ip, e.getMessage());
        }
    }

    /**
     * Quick ICMP ping (one packet); often succeeds when Java {@link InetAddress#isReachable(int)} does not on Windows/non-admin setups.
     */
    private boolean pingReachableQuick(String ip) {
        try {
            String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
            ProcessBuilder pb;
            if (os.contains("win")) {
                pb = new ProcessBuilder("ping", "-n", "1", "-w", "650", ip);
            } else {
                pb = new ProcessBuilder("ping", "-c", "1", "-W", "2", ip);
            }
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            Process process = pb.start();
            boolean finished = process.waitFor(3000, TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }
            return process.exitValue() == 0;
        } catch (Exception e) {
            log.debug("pingReachableQuick failed for {}: {}", ip, e.getMessage());
            return false;
        }
    }

    private boolean isDiscardArpIp(String ip) {
        if (ip == null || ip.isEmpty()) {
            return true;
        }
        if (ip.startsWith("224.") || ip.startsWith("239.")) {
            return true;
        }
        return "255.255.255.255".equals(ip);
    }

    /** Skip incomplete / multicast / null hardware addresses from ARP output. */
    private boolean isDiscardArpMac(String normalizedMacColonUpper) {
        if (normalizedMacColonUpper == null || normalizedMacColonUpper.contains("INCOMPLETE")) {
            return true;
        }
        if ("00:00:00:00:00:00".equals(normalizedMacColonUpper) || "FF:FF:FF:FF:FF:FF".equals(normalizedMacColonUpper)) {
            return true;
        }
        try {
            int firstOctet = Integer.parseInt(normalizedMacColonUpper.substring(0, 2), 16);
            return (firstOctet & 0x01) != 0;
        } catch (Exception e) {
            return true;
        }
    }

    /**
     * Parses the OS ARP table once and returns IP → MAC for hosts on {@code networkBase.*}.
     */
    private Map<String, String> parseSubnetArpEntries(String networkBase) {
        Map<String, String> entries = new LinkedHashMap<>();
        try {
            ProcessBuilder pb = new ProcessBuilder("arp", "-a");
            pb.redirectErrorStream(true);
            Process process = pb.start();
            Pattern macPattern = Pattern.compile("(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}");
            Pattern ipv4 = Pattern.compile(
                    "(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)");

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    if (trimmed.startsWith("Interface:") || trimmed.isEmpty()) {
                        continue;
                    }
                    if (trimmed.toLowerCase(Locale.ROOT).contains("incomplete")) {
                        continue;
                    }
                    Matcher macMatcher = macPattern.matcher(line);
                    if (!macMatcher.find()) {
                        continue;
                    }
                    String rawMac = macMatcher.group().replace('-', ':').toUpperCase(Locale.ROOT);
                    if (isDiscardArpMac(rawMac)) {
                        continue;
                    }
                    Matcher ipMatcher = ipv4.matcher(line);
                    while (ipMatcher.find()) {
                        String cand = ipMatcher.group();
                        if (!cand.startsWith(networkBase + ".")) {
                            continue;
                        }
                        if (isDiscardArpIp(cand)) {
                            continue;
                        }
                        entries.putIfAbsent(cand, rawMac);
                    }
                }
            }
            process.waitFor(5, TimeUnit.SECONDS);
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        } catch (Exception e) {
            log.debug("parseSubnetArpEntries failed: {}", e.getMessage());
        }
        log.debug("ARP reconciliation: {} entries on subnet {}", entries.size(), networkBase);
        return entries;
    }

    private void reconcileDevicesFromArpTable(String networkBase, Set<String> discoveredIps,
            boolean useExternalVendorAPI, DeviceCallback callback, int totalIps, AtomicInteger deviceCount,
            Consumer<String> englishStatusReporter) {
        try {
            Thread.sleep(400);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        Map<String, String> arpOnSubnet = parseSubnetArpEntries(networkBase);
        List<Map.Entry<String, String>> pending = arpOnSubnet.entrySet().stream()
                .filter(en -> !discoveredIps.contains(en.getKey()))
                .collect(Collectors.toList());
        if (pending.isEmpty()) {
            reportEnglishScanStatus(englishStatusReporter,
                    "ARP cross-check complete — no extra hosts to verify in the OS ARP cache.");
            return;
        }
        reportEnglishScanStatus(englishStatusReporter,
                String.format(Locale.ROOT,
                        "ARP cross-check: %d host%s in the OS ARP cache were not reported yet — "
                                + "enriching them (open ports, vendor, MAC).",
                        pending.size(), pending.size() == 1 ? "" : "s"));
        int workers = Math.min(24, Math.max(4, pending.size()));
        ExecutorService reconcileExecutor = Executors.newFixedThreadPool(workers);
        CountDownLatch done = new CountDownLatch(pending.size());
        for (Map.Entry<String, String> e : pending) {
            reconcileExecutor.submit(() -> {
                String ip = e.getKey();
                try {
                    if (discoveredIps.contains(ip)) {
                        return;
                    }
                    Map<String, Object> device = enrichDeviceFromArpEntry(ip, e.getValue(), useExternalVendorAPI);
                    if (device == null || device.isEmpty()) {
                        return;
                    }
                    try {
                        List<Map<String, Object>> vulnerabilities = analyzeVulnerabilitiesFast(device);
                        device.put("vulnerabilities", vulnerabilities);
                    } catch (Exception ex) {
                        device.put("vulnerabilities", Collections.emptyList());
                    }
                    if (!discoveredIps.add(ip)) {
                        return;
                    }
                    int found = deviceCount.incrementAndGet();
                    log.debug("[SCAN-ARP] Additional device #{}: {} MAC {}", found, ip, e.getValue());
                    callback.onDeviceFound(device, totalIps, totalIps);
                } catch (Exception ex) {
                    log.debug("ARP reconcile failed for {}: {}", ip, ex.getMessage());
                } finally {
                    done.countDown();
                }
            });
        }
        reconcileExecutor.shutdown();
        try {
            if (!done.await(90, TimeUnit.SECONDS)) {
                log.debug("ARP reconcile latch timeout — {} entries", pending.size());
            }
            if (!reconcileExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                reconcileExecutor.shutdownNow();
            }
        } catch (InterruptedException ie) {
            reconcileExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
        if (!pending.isEmpty()) {
            reportEnglishScanStatus(englishStatusReporter,
                    "ARP cross-check finished — consolidating results.");
        }
    }

    /**
     * Build device map from an ARP row we skipped during active probing — avoids extra ping/process churn for MAC/vendor.
     */
    private Map<String, Object> enrichDeviceFromArpEntry(String ip, String macFromArp, boolean useExternalVendorAPI) {
        Map<String, Object> device = new HashMap<>();
        try {
            String macNorm = macFromArp.replace('-', ':').trim().toUpperCase(Locale.ROOT);
            if (isDiscardArpMac(macNorm)) {
                return null;
            }
            InetAddress address = InetAddress.getByName(ip);

            device.put("ipAddress", ip);
            device.put("status", "online");

            String macAddressMongoDB = null;
            Optional<NetworkDeviceMapping> mappingOpt = deviceMappingRepository.findByIpAddress(ip);
            if (mappingOpt.isPresent()) {
                NetworkDeviceMapping deviceMapping = mappingOpt.get();
                String deviceName = deviceMapping.getDeviceName();
                if (deviceName != null && !deviceName.trim().isEmpty()) {
                    device.put("hostname", deviceName.trim());
                    log.debug("ARP-reconcile {} - Using name from MongoDB: {}", ip, deviceName.trim());
                }
                if (deviceMapping.getMacAddress() != null && !deviceMapping.getMacAddress().trim().isEmpty()) {
                    macAddressMongoDB = deviceMapping.getMacAddress().trim();
                    log.debug("ARP-reconcile {} - Mongo MAC on record {}", ip, macAddressMongoDB);
                }
            }
            if (!device.containsKey("hostname")) {
                try {
                    String hostname = address.getHostName();
                    if (hostname != null && !hostname.equals(ip) && !hostname.isEmpty()) {
                        device.put("hostname", hostname);
                    }
                } catch (Exception ignored) {
                    // omit reverse DNS failures
                }
            }

            List<Integer> openPorts = quickPortScanFast(ip);
            if (openPorts == null) {
                openPorts = new ArrayList<>();
            }
            device.put("openPorts", openPorts);

            if (!openPorts.isEmpty()) {
                Map<Integer, Map<String, Object>> portServices = new HashMap<>();
                for (Integer port : openPorts) {
                    Map<String, Object> service = new HashMap<>();
                    service.put("port", port);
                    service.put("service", getServiceName(port));
                    service.put("status", "open");
                    portServices.put(port, service);
                }
                device.put("services", portServices);
            }

            collectDeviceInfoFast(ip, device, openPorts);
            log.debug("ARP-reconcile {} - Type {}, openPorts {}", ip, device.get("deviceType"), openPorts.size());

            if (!openPorts.isEmpty()) {
                String osGuess = identifyOperatingSystem(openPorts);
                if (osGuess != null) {
                    device.put("os", osGuess);
                }
            }

            if (macAddressMongoDB != null) {
                if (!macNorm.equalsIgnoreCase(macAddressMongoDB)) {
                    device.put("macAddress", macNorm);
                    device.put("macAddressSource", "arp");
                    device.put("macAddressMongoDB", macAddressMongoDB);
                    device.put("macAddressConflict", true);
                } else {
                    device.put("macAddress", macNorm);
                    device.put("macAddressSource", "arp");
                    device.put("macAddressConflict", false);
                }
            } else {
                device.put("macAddress", macNorm);
                device.put("macAddressSource", "arp");
                device.put("macAddressConflict", false);
            }

            String primaryMac = (String) device.get("macAddress");
            if (primaryMac != null) {
                String vendor = identifyVendor(primaryMac, useExternalVendorAPI);
                if (vendor != null && !vendor.trim().isEmpty()) {
                    device.put("vendor", vendor);
                }
            }

            if (device.containsKey("macAddress") && device.get("macAddress") != null
                    && (!device.containsKey("macAddressSource") || device.get("macAddressSource") == null)) {
                device.put("macAddressSource", "arp");
                device.put("macAddressConflict", false);
            }

            device.put("lastSeen", new Date());
            device.put("discoverySource", "arp-reconcile");

            return device;
        } catch (Exception ex) {
            log.debug("enrichDeviceFromArpEntry exception for {}: {}", ip, ex.getMessage());
            return null;
        }
    }

    /**
     * Get MAC address from ARP table (works for remote devices on local network)
     * This is the primary method for getting MAC addresses of network devices
     */
    private String getMacAddressFromARP(String ip) {
        // Try multiple times with small delays to ensure ARP table is populated
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                if (attempt > 0) {
                    // Wait a bit before retrying
                    Thread.sleep(100);
                }
                
                // On Windows, arp -a without IP is more reliable
                // On Linux, try specific IP first, then fallback to full table
                String os = System.getProperty("os.name").toLowerCase();
                
                if (os.contains("win")) {
                    // Windows: Use full ARP table (more reliable)
                    String mac = getMacAddressFromFullARP(ip);
                    if (mac != null && !mac.isEmpty()) {
                        return mac;
                    }
                } else {
                    // Linux/Unix: Try specific IP first
                    ProcessBuilder pb = new ProcessBuilder("arp", "-n", ip);
                    Process process = pb.start();
                    Pattern macPattern = Pattern.compile("([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})");
                    
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream()))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            if (line.contains(ip)) {
                                // Linux format: "192.168.1.1 (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0"
                                Matcher matcher = macPattern.matcher(line);
                                if (matcher.find()) {
                                    String mac = matcher.group();
                                    mac = mac.replace("-", ":");
                                    process.waitFor();
                                    return mac.toUpperCase();
                                }
                            }
                        }
                    }
                    
                    int exitCode = process.waitFor();
                    if (exitCode != 0) {
                        log.debug("ARP lookup for specific IP {} failed (exit code {}), trying full ARP table", ip, exitCode);
                        String mac = getMacAddressFromFullARP(ip);
                        if (mac != null && !mac.isEmpty()) {
                            return mac;
                        }
                    }
                }
            } catch (Exception e) {
                log.debug("ARP lookup attempt {} failed for {}: {}", attempt + 1, ip, e.getMessage());
                if (attempt == 2) {
                    // Last attempt, try full ARP table
                    try {
                        return getMacAddressFromFullARP(ip);
                    } catch (Exception ex) {
                        log.debug("Final ARP lookup failed for {}: {}", ip, ex.getMessage());
                    }
                }
            }
        }
        return null;
    }

    /**
     * Get MAC address from full ARP table (works for both Windows and Linux)
     */
    private String getMacAddressFromFullARP(String ip) {
        try {
            ProcessBuilder pb;
            String os = System.getProperty("os.name").toLowerCase();
            
            if (os.contains("win")) {
                // Windows: Try arp -a with specific IP first (more reliable)
                try {
                    pb = new ProcessBuilder("arp", "-a", ip);
                    Process process = pb.start();
                    Pattern macPattern = Pattern.compile("([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})");
                    
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            // Skip interface header lines (Windows format: "Interface: 192.168.1.33 --- 0xc")
                            if (line.trim().startsWith("Interface:") || line.trim().isEmpty()) {
                                continue;
                            }
                            log.debug("ARP line for {}: {}", ip, line);
                            if (line.contains(ip)) {
                                Matcher matcher = macPattern.matcher(line);
                                if (matcher.find()) {
                                    String mac = matcher.group();
                                    mac = mac.replace("-", ":");
                                    process.waitFor();
                                    log.debug("Found MAC address for {} using arp -a {}: {}", ip, ip, mac);
                                    return mac.toUpperCase();
                                }
                            }
                        }
                    }
                    process.waitFor();
                } catch (Exception e) {
                    log.debug("arp -a {} failed, trying arp -a (all entries): {}", ip, e.getMessage());
                }
                
                // Fallback: arp -a shows all entries
                // Format: "  192.168.1.1          00-11-22-33-44-55     dynamic"
                pb = new ProcessBuilder("arp", "-a");
            } else {
                // Linux/Unix: arp -a shows all entries
                // Format: "192.168.1.1 (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0"
                pb = new ProcessBuilder("arp", "-a");
            }
            
            Process process = pb.start();
            // Pattern to match MAC address: XX-XX-XX-XX-XX-XX or XX:XX:XX:XX:XX:XX
            Pattern macPattern = Pattern.compile("([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})");
            
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    // Skip interface header lines (Windows format: "Interface: 192.168.1.33 --- 0xc")
                    if (line.trim().startsWith("Interface:") || line.trim().isEmpty()) {
                        continue;
                    }
                    
                    // Check if line contains the IP address
                    // Windows: IP can be at start or after interface name
                    // Linux: IP is usually at the start
                    if (line.contains(ip)) {
                        log.debug("Found IP {} in ARP line: {}", ip, line);
                        
                        // Extract MAC address from line
                        Matcher matcher = macPattern.matcher(line);
                        if (matcher.find()) {
                            String mac = matcher.group();
                            // Normalize to colon format (XX:XX:XX:XX:XX:XX)
                            mac = mac.replace("-", ":");
                            log.debug("Extracted MAC address for {}: {}", ip, mac);
                            process.waitFor();
                            return mac.toUpperCase();
                        } else {
                            log.debug("No MAC address pattern found in ARP line for {} (may be header line): {}", ip, line);
                        }
                    }
                }
            }
            
            int exitCode = process.waitFor();
            log.debug("ARP table lookup completed for {} with exit code: {}", ip, exitCode);
        } catch (Exception e) {
            log.debug("Full ARP table lookup failed for {}: {}", ip, e.getMessage());
        }
        return null;
    }

    /**
     * Get MAC address from local network interface (only works for local machine)
     * This is a fallback method
     */
    private String getMacAddress(String ip) {
        try {
            InetAddress address = InetAddress.getByName(ip);
            NetworkInterface networkInterface = NetworkInterface.getByInetAddress(address);
            if (networkInterface != null) {
                byte[] mac = networkInterface.getHardwareAddress();
                if (mac != null) {
                    StringBuilder sb = new StringBuilder();
                    for (int i = 0; i < mac.length; i++) {
                        sb.append(String.format("%02X%s", mac[i], (i < mac.length - 1) ? ":" : ""));
                    }
                    return sb.toString();
                }
            }
        } catch (Exception e) {
            // MAC address not available (common on remote devices)
        }
        return null;
    }

    /**
     * Identify vendor from MAC address (OUI - Organizationally Unique Identifier)
     * Uses the first 3 octets (6 hex digits) of the MAC address
     * @param macAddress MAC address to identify
     * @param useExternalAPI If true, use external API (macvendors.com) instead of local database
     * @return Vendor name or null if not found
     */
    /**
     * Identify vendor from MAC address - ALWAYS tries both methods if needed
     * @param macAddress MAC address to identify
     * @param useExternalAPI If true, prefer external API, otherwise prefer local database
     * @return Vendor name or null if not found
     */
    private String identifyVendor(String macAddress, boolean useExternalAPI) {
        if (macAddress == null || macAddress.trim().isEmpty()) {
            return null;
        }
        
        // Always try the preferred method first
        String vendor = useExternalAPI 
            ? identifyVendorFromExternalAPI(macAddress) 
            : identifyVendorFromLocalDatabase(macAddress);
        
        // If not found with preferred method, try the alternative
        if (vendor == null || vendor.trim().isEmpty()) {
            log.debug("Vendor not found with preferred method for MAC: {}, trying alternative method", macAddress);
            vendor = useExternalAPI 
                ? identifyVendorFromLocalDatabase(macAddress) 
                : identifyVendorFromExternalAPI(macAddress);
        }
        
        return vendor;
    }
    
    /**
     * Identify vendor from MAC address using external API (macvendors.com)
     * This provides a comprehensive database but requires internet connection
     */
    private String identifyVendorFromExternalAPI(String macAddress) {
        if (macAddress == null || macAddress.trim().isEmpty()) {
            return null;
        }
        
        try {
            // Normalize MAC address: remove separators and convert to uppercase
            String normalized = macAddress.replaceAll("[:-]", "").toUpperCase().trim();
            if (normalized.length() < 6) {
                return null;
            }
            
            // Extract OUI (first 6 hex characters)
            String oui = normalized.substring(0, 6);
            String ouiFormatted = formatOui(oui);
            
            // FIRST: Check MongoDB for existing vendor mapping
            if (ouiFormatted != null) {
                Optional<MacVendorMapping> existingMapping = macVendorMappingRepository.findByOui(ouiFormatted);
                if (existingMapping.isPresent() && existingMapping.get().getVendor() != null) {
                    String vendor = existingMapping.get().getVendor();
                    log.debug("Vendor found in MongoDB for OUI {}: {}", ouiFormatted, vendor);
                    return vendor;
                }
            }
            
            // SECOND: Check in-memory cache (deprecated, but keep for backward compatibility)
            if (vendorCache.containsKey(oui)) {
                String cachedVendor = vendorCache.get(oui);
                if (cachedVendor != null) {
                    log.debug("Vendor found in cache for OUI {}: {}", oui, cachedVendor);
                    // Also save to MongoDB for future use
                    if (ouiFormatted != null) {
                        saveVendorToMongoDB(ouiFormatted, cachedVendor);
                    }
                    return cachedVendor;
                }
            }
            
            // THIRD: Use macvendors.com API (free, no API key required)
            // Format: {apiUrl}/{oui} - API accepts OUI (6 hex chars) or full MAC
            String apiUrl = macVendorApiUrl + "/" + oui;
            
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.set("User-Agent", "PatTool/1.0");
                HttpEntity<String> entity = new HttpEntity<>(headers);
                
                ResponseEntity<String> response = restTemplate.exchange(
                    apiUrl,
                    HttpMethod.GET,
                    entity,
                    String.class
                );
                
                if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                    String vendor = response.getBody().trim();
                    // API returns "Not Found" if vendor not found
                    if (!vendor.isEmpty() && !vendor.equalsIgnoreCase("Not Found") && !vendor.equalsIgnoreCase("not found")) {
                        // Save to MongoDB for future use
                        if (ouiFormatted != null) {
                            saveVendorToMongoDB(ouiFormatted, vendor);
                        }
                        // Also cache in memory (deprecated)
                        vendorCache.put(oui, vendor);
                        log.debug("Vendor found via external API for MAC {} (OUI: {}): {}", macAddress, ouiFormatted, vendor);
                        return vendor;
                    } else {
                        // API returned "Not Found" - try local database and cache result
                        log.debug("External API returned 'Not Found' for MAC {} (OUI: {}), trying local database", macAddress, ouiFormatted);
                        String localVendor = identifyVendorFromLocalDatabase(macAddress);
                        // Cache the result (even if null) to avoid repeated API calls
                        vendorCache.put(oui, localVendor);
                        return localVendor;
                    }
                } else {
                    // API returned non-success status - fallback to local database
                    log.debug("External API returned non-success status for MAC {} (OUI: {}), using local database", macAddress, ouiFormatted);
                    String localVendor = identifyVendorFromLocalDatabase(macAddress);
                    // Cache the result to avoid repeated API calls
                    vendorCache.put(oui, localVendor);
                    return localVendor;
                }
            } catch (org.springframework.web.client.ResourceAccessException e) {
                // Timeout or connection error - fall back to local database quickly
                log.debug("External API timeout/connection error for MAC {} (OUI: {}): {}, using local database", macAddress, ouiFormatted, e.getMessage());
                String localVendor = identifyVendorFromLocalDatabase(macAddress);
                // Cache the result to avoid repeated failed API calls
                vendorCache.put(oui, localVendor);
                return localVendor;
            } catch (Exception e) {
                // Check if it's a rate limit error
                String errorMessage = e.getMessage();
                if (errorMessage != null && (errorMessage.contains("Too Many Requests") || errorMessage.contains("429"))) {
                    log.debug("API rate limit exceeded for MAC {} (OUI: {}), using local database", macAddress, ouiFormatted);
                } else {
                    log.debug("External API call failed for MAC {} (OUI: {}): {}, using local database", macAddress, ouiFormatted, e.getMessage());
                }
                // API call failed, fall back to local database
                String localVendor = identifyVendorFromLocalDatabase(macAddress);
                // Cache the result to avoid repeated failed API calls
                vendorCache.put(oui, localVendor);
                return localVendor;
            }
            } catch (Exception e) {
                log.debug("Error identifying vendor from external API for MAC {}: {}, falling back to local database", macAddress, e.getMessage());
                // Fallback to local database on error
                return identifyVendorFromLocalDatabase(macAddress);
            }
    }
    
    /**
     * Get vendor information from external API for a MAC address
     * Returns detailed information from macvendors.com API
     */
    public Map<String, Object> getVendorInfoFromAPI(String macAddress) {
        Map<String, Object> result = new HashMap<>();
        
        if (macAddress == null || macAddress.trim().isEmpty()) {
            result.put("error", "MAC address is required");
            return result;
        }
        
        try {
            // Normalize MAC address: remove separators and convert to uppercase
            String normalized = macAddress.replaceAll("[:-]", "").toUpperCase().trim();
            if (normalized.length() < 6) {
                result.put("error", "Invalid MAC address format");
                return result;
            }
            
            // Extract OUI (first 6 hex characters)
            String oui = normalized.substring(0, 6);
            String ouiFormatted = formatOui(oui);
            
            // Build API URL
            String apiUrl = macVendorApiUrl + "/" + oui;
            
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.set("User-Agent", "PatTool/1.0");
                HttpEntity<String> entity = new HttpEntity<>(headers);
                
                ResponseEntity<String> response = restTemplate.exchange(
                    apiUrl,
                    HttpMethod.GET,
                    entity,
                    String.class
                );
                
                if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                    String vendor = response.getBody().trim();
                    if (!vendor.isEmpty() && !vendor.equalsIgnoreCase("Not Found")) {
                        // Save to MongoDB for future use
                        if (ouiFormatted != null) {
                            saveVendorToMongoDB(ouiFormatted, vendor);
                        }
                        result.put("success", true);
                        result.put("macAddress", macAddress);
                        result.put("oui", ouiFormatted);
                        result.put("vendor", vendor);
                        result.put("apiUrl", apiUrl);
                        log.debug("Vendor info retrieved from API for MAC {}: {}", macAddress, vendor);
                    } else {
                        result.put("success", false);
                        result.put("error", "Vendor not found in database");
                        result.put("macAddress", macAddress);
                        result.put("oui", ouiFormatted);
                        result.put("apiUrl", apiUrl);
                    }
                } else {
                    result.put("success", false);
                    result.put("error", "API returned non-success status: " + response.getStatusCode());
                    result.put("macAddress", macAddress);
                    result.put("apiUrl", apiUrl);
                }
            } catch (Exception e) {
                result.put("success", false);
                result.put("error", "API call failed: " + e.getMessage());
                result.put("macAddress", macAddress);
                result.put("apiUrl", apiUrl);
                log.debug("Error calling vendor API for MAC {}: {}", macAddress, e.getMessage());
            }
        } catch (Exception e) {
            result.put("success", false);
            result.put("error", "Error processing MAC address: " + e.getMessage());
            result.put("macAddress", macAddress);
            log.debug("Error processing MAC address {}: {}", macAddress, e.getMessage());
        }
        
        return result;
    }
    
    /**
     * Normalize OUI to format XX:XX:XX (from 6 hex characters)
     * @param oui OUI in format XXXXXX (6 hex characters)
     * @return OUI in format XX:XX:XX
     */
    private String formatOui(String oui) {
        if (oui == null || oui.length() < 6) {
            return null;
        }
        return oui.substring(0, 2) + ":" + oui.substring(2, 4) + ":" + oui.substring(4, 6);
    }
    
    /**
     * Save vendor mapping to MongoDB
     * @param oui OUI in format XX:XX:XX
     * @param vendor Vendor name
     */
    private void saveVendorToMongoDB(String oui, String vendor) {
        if (oui == null || vendor == null || vendor.trim().isEmpty()) {
            return;
        }
        try {
            macVendorMappingRepository.findByOui(oui).ifPresentOrElse(
                existing -> {
                    // Update existing
                    existing.setVendor(vendor);
                    existing.setDateModification(new Date());
                    macVendorMappingRepository.save(existing);
                    log.debug("Updated vendor mapping in MongoDB for OUI {}: {}", oui, vendor);
                },
                () -> {
                    // Create new
                    MacVendorMapping mapping = new MacVendorMapping(oui, vendor);
                    macVendorMappingRepository.save(mapping);
                    log.debug("Saved vendor mapping to MongoDB for OUI {}: {}", oui, vendor);
                }
            );
        } catch (Exception e) {
            log.warn("Error saving vendor mapping to MongoDB for OUI {}: {}", oui, e.getMessage());
        }
    }
    
    /**
     * Identify vendor from MAC address using local database (OUI)
     * Uses the first 3 octets (6 hex digits) of the MAC address
     */
    private String identifyVendorFromLocalDatabase(String macAddress) {
        if (macAddress == null || macAddress.trim().isEmpty()) {
            return null;
        }
        
        // Normalize MAC address: remove separators and convert to uppercase
        String normalized = macAddress.replaceAll("[:-]", "").toUpperCase().trim();
        if (normalized.length() < 6) {
            return null;
        }
        
        // Extract OUI (first 6 hex characters)
        String oui = normalized.substring(0, 6);
        
        // Format as XX:XX:XX for lookup
        String prefix = oui.substring(0, 2) + ":" + oui.substring(2, 4) + ":" + oui.substring(4, 6);
        
        // Extended vendor database (OUI prefixes)
        // This is a subset of common vendors - in production, use a full OUI database
        Map<String, String> vendors = new HashMap<>();
        
        // Apple Inc.
        vendors.put("00:25:00", "Apple");
        vendors.put("00:26:BB", "Apple");
        vendors.put("00:23:DF", "Apple");
        vendors.put("00:1E:C2", "Apple");
        vendors.put("00:1E:52", "Apple");
        vendors.put("00:1F:5B", "Apple");
        vendors.put("00:21:E9", "Apple");
        vendors.put("00:22:41", "Apple");
        vendors.put("00:24:36", "Apple");
        vendors.put("00:25:4B", "Apple");
        vendors.put("00:26:4A", "Apple");
        vendors.put("00:26:08", "Apple");
        vendors.put("00:26:4B", "Apple");
        vendors.put("00:50:E4", "Apple");
        vendors.put("00:56:CD", "Apple");
        vendors.put("00:61:71", "Apple");
        vendors.put("00:6D:52", "Apple");
        vendors.put("00:7C:2D", "Apple");
        vendors.put("00:88:65", "Apple");
        vendors.put("00:9E:C8", "Apple");
        vendors.put("00:A0:40", "Apple");
        vendors.put("00:C6:10", "Apple");
        vendors.put("00:CD:FE", "Apple");
        vendors.put("00:DB:DF", "Apple");
        vendors.put("00:E0:18", "Apple");
        vendors.put("00:F4:B9", "Apple");
        vendors.put("04:0C:CE", "Apple");
        vendors.put("04:15:52", "Apple");
        vendors.put("04:1E:64", "Apple");
        vendors.put("04:26:65", "Apple");
        vendors.put("04:4C:59", "Apple");
        vendors.put("04:52:C7", "Apple");
        vendors.put("04:54:53", "Apple");
        vendors.put("04:69:F8", "Apple");
        vendors.put("04:D3:CF", "Apple");
        vendors.put("04:DB:56", "Apple");
        vendors.put("04:E5:36", "Apple");
        vendors.put("08:00:07", "Apple");
        vendors.put("08:66:98", "Apple");
        vendors.put("08:70:45", "Apple");
        vendors.put("08:74:02", "Apple");
        vendors.put("0C:15:AF", "Apple");
        vendors.put("0C:3E:9F", "Apple");
        vendors.put("0C:4D:E9", "Apple");
        vendors.put("0C:74:C2", "Apple");
        vendors.put("0C:77:1A", "Apple");
        vendors.put("0C:84:DC", "Apple");
        vendors.put("0C:BC:9F", "Apple");
        vendors.put("0C:D7:46", "Apple");
        vendors.put("10:1C:0C", "Apple");
        vendors.put("10:93:E9", "Apple");
        vendors.put("10:9A:DD", "Apple");
        vendors.put("10:DD:B1", "Apple");
        vendors.put("14:10:9F", "Apple");
        vendors.put("14:7D:DA", "Apple");
        vendors.put("14:99:E2", "Apple");
        vendors.put("14:CC:20", "Apple");
        vendors.put("18:20:32", "Apple");
        vendors.put("18:65:90", "Apple");
        vendors.put("18:9E:FC", "Apple");
        vendors.put("18:AF:61", "Apple");
        vendors.put("1C:1A:C0", "Apple");
        vendors.put("1C:AB:A7", "Apple");
        vendors.put("1C:E6:2B", "Apple");
        vendors.put("20:78:F0", "Apple");
        vendors.put("20:AB:37", "Apple");
        vendors.put("20:C9:D0", "Apple");
        vendors.put("24:1E:EB", "Apple");
        vendors.put("24:AB:81", "Apple");
        vendors.put("24:E3:14", "Apple");
        vendors.put("28:37:37", "Apple");
        vendors.put("28:6A:B8", "Apple");
        vendors.put("28:CF:DA", "Apple");
        vendors.put("28:CF:E9", "Apple");
        vendors.put("2C:1F:23", "Apple");
        vendors.put("2C:33:7A", "Apple");
        vendors.put("2C:BE:08", "Apple");
        vendors.put("30:90:AB", "Apple");
        vendors.put("34:15:9E", "Apple");
        vendors.put("34:A3:95", "Apple");
        vendors.put("34:C0:59", "Apple");
        vendors.put("38:CA:DA", "Apple");
        vendors.put("3C:07:54", "Apple");
        vendors.put("3C:15:C2", "Apple");
        vendors.put("3C:AB:8E", "Apple");
        vendors.put("40:33:1A", "Apple");
        vendors.put("40:6C:8F", "Apple");
        vendors.put("40:CB:C0", "Apple");
        vendors.put("44:4C:0C", "Apple");
        vendors.put("44:FB:42", "Apple");
        vendors.put("48:43:7C", "Apple");
        vendors.put("48:A1:95", "Apple");
        vendors.put("4C:7C:5F", "Apple");
        vendors.put("4C:8D:79", "Apple");
        vendors.put("50:EA:D6", "Apple");
        vendors.put("54:26:96", "Apple");
        vendors.put("54:72:4F", "Apple");
        vendors.put("58:55:CA", "Apple");
        vendors.put("5C:59:48", "Apple");
        vendors.put("5C:95:AE", "Apple");
        vendors.put("60:33:4B", "Apple");
        vendors.put("60:92:17", "Apple");
        vendors.put("64:E6:82", "Apple");
        vendors.put("68:5B:35", "Apple");
        vendors.put("68:AB:1E", "Apple");
        vendors.put("6C:40:08", "Apple");
        vendors.put("6C:72:20", "Apple");
        vendors.put("6C:8D:C1", "Apple");
        vendors.put("70:48:0F", "Apple");
        vendors.put("70:56:81", "Apple");
        vendors.put("74:E2:F5", "Apple");
        vendors.put("78:31:C1", "Apple");
        vendors.put("78:4F:43", "Apple");
        vendors.put("78:A3:E4", "Apple");
        vendors.put("7C:6D:62", "Apple");
        vendors.put("7C:D1:C3", "Apple");
        vendors.put("80:BE:05", "Apple");
        vendors.put("80:E6:50", "Apple");
        vendors.put("84:38:35", "Apple");
        vendors.put("84:FC:FE", "Apple");
        vendors.put("88:63:DF", "Apple");
        vendors.put("8C:85:90", "Apple");
        vendors.put("8C:7C:92", "Apple");
        vendors.put("90:72:40", "Apple");
        vendors.put("94:E9:6A", "Apple");
        vendors.put("98:01:A7", "Apple");
        vendors.put("98:5F:D3", "Apple");
        vendors.put("9C:20:7B", "Apple");
        vendors.put("9C:84:BF", "Apple");
        vendors.put("A0:99:9B", "Apple");
        vendors.put("A4:5E:60", "Apple");
        vendors.put("A4:C3:61", "Apple");
        vendors.put("A8:60:B6", "Apple");
        vendors.put("A8:96:8A", "Apple");
        vendors.put("AC:1F:74", "Apple");
        vendors.put("AC:BC:32", "Apple");
        vendors.put("B0:65:BD", "Apple");
        vendors.put("B4:F0:AB", "Apple");
        vendors.put("B8:09:8A", "Apple");
        vendors.put("B8:53:AC", "Apple");
        vendors.put("BC:3B:AF", "Apple");
        vendors.put("BC:52:B7", "Apple");
        vendors.put("C0:25:E9", "Apple");
        vendors.put("C4:2C:03", "Apple");
        vendors.put("C8:1E:8E", "Apple");
        vendors.put("C8:33:4B", "Apple");
        vendors.put("CC:08:E0", "Apple");
        vendors.put("CC:29:F5", "Apple");
        vendors.put("D0:03:4B", "Apple");
        vendors.put("D4:9A:20", "Apple");
        vendors.put("D8:30:62", "Apple");
        vendors.put("D8:A2:5E", "Apple");
        vendors.put("DC:2B:61", "Apple");
        vendors.put("DC:A9:04", "Apple");
        vendors.put("E0:AC:CB", "Apple");
        vendors.put("E4:CE:8F", "Apple");
        vendors.put("E8:40:40", "Apple");
        vendors.put("E8:80:2E", "Apple");
        vendors.put("EC:35:86", "Apple");
        vendors.put("F0:18:98", "Apple");
        vendors.put("F0:DB:E2", "Apple");
        vendors.put("F4:0F:24", "Apple");
        vendors.put("F4:F1:5A", "Apple");
        vendors.put("F8:1E:DF", "Apple");
        vendors.put("FC:25:3F", "Apple");
        vendors.put("FC:C2:DE", "Apple");
        
        // Samsung Electronics
        vendors.put("00:12:FB", "Samsung");
        vendors.put("00:15:99", "Samsung");
        vendors.put("00:16:6B", "Samsung");
        vendors.put("00:1E:7D", "Samsung");
        vendors.put("00:23:39", "Samsung");
        vendors.put("00:24:54", "Samsung");
        vendors.put("00:25:66", "Samsung");
        vendors.put("00:26:5D", "Samsung");
        vendors.put("00:50:F1", "Samsung");
        vendors.put("04:52:F7", "Samsung");
        vendors.put("04:FE:31", "Samsung");
        vendors.put("08:00:28", "Samsung");
        vendors.put("0C:14:20", "Samsung");
        vendors.put("10:30:47", "Samsung");
        vendors.put("14:7D:C5", "Samsung");
        vendors.put("18:16:D9", "Samsung");
        vendors.put("1C:66:AA", "Samsung");
        vendors.put("20:2D:F7", "Samsung");
        vendors.put("24:4B:03", "Samsung");
        vendors.put("28:39:5E", "Samsung");
        vendors.put("2C:44:FD", "Samsung");
        vendors.put("30:63:6B", "Samsung");
        vendors.put("34:23:87", "Samsung");
        vendors.put("38:16:D1", "Samsung");
        vendors.put("3C:5A:B4", "Samsung");
        vendors.put("40:B0:34", "Samsung");
        vendors.put("44:80:EB", "Samsung");
        vendors.put("48:13:7E", "Samsung");
        vendors.put("4C:66:41", "Samsung");
        vendors.put("50:CC:F8", "Samsung");
        vendors.put("54:92:49", "Samsung");
        vendors.put("58:55:CA", "Samsung");
        vendors.put("5C:0A:5B", "Samsung");
        vendors.put("60:21:C0", "Samsung");
        vendors.put("64:16:66", "Samsung");
        vendors.put("68:27:37", "Samsung");
        vendors.put("6C:2E:33", "Samsung");
        vendors.put("70:48:0F", "Samsung");
        vendors.put("74:45:CE", "Samsung");
        vendors.put("78:25:AD", "Samsung");
        vendors.put("7C:1E:52", "Samsung");
        vendors.put("80:57:19", "Samsung");
        vendors.put("84:25:DB", "Samsung");
        vendors.put("88:83:22", "Samsung");
        vendors.put("8C:3A:E3", "Samsung");
        vendors.put("90:48:9A", "Samsung");
        vendors.put("94:B8:C5", "Samsung");
        vendors.put("98:0C:82", "Samsung");
        vendors.put("9C:65:F9", "Samsung");
        vendors.put("A0:07:98", "Samsung");
        vendors.put("A4:50:46", "Samsung");
        vendors.put("A8:81:95", "Samsung");
        vendors.put("AC:5A:14", "Samsung");
        vendors.put("B0:47:BF", "Samsung");
        vendors.put("B4:79:A7", "Samsung");
        vendors.put("B8:57:D8", "Samsung");
        vendors.put("BC:14:85", "Samsung");
        vendors.put("C0:BD:D1", "Samsung");
        vendors.put("C4:50:06", "Samsung");
        vendors.put("C8:14:79", "Samsung");
        vendors.put("CC:F9:57", "Samsung");
        vendors.put("D0:22:BE", "Samsung");
        vendors.put("D4:6E:5C", "Samsung");
        vendors.put("D8:57:EF", "Samsung");
        vendors.put("DC:66:72", "Samsung");
        vendors.put("E0:50:8B", "Samsung");
        vendors.put("E4:CE:8F", "Samsung");
        vendors.put("E8:50:8B", "Samsung");
        vendors.put("EC:1A:59", "Samsung");
        vendors.put("F0:25:B7", "Samsung");
        vendors.put("F4:09:D8", "Samsung");
        vendors.put("F8:4F:57", "Samsung");
        vendors.put("FC:19:10", "Samsung");
        
        // Intel Corporation
        vendors.put("00:1B:21", "Intel");
        vendors.put("00:1E:67", "Intel");
        vendors.put("00:1E:C7", "Intel");
        vendors.put("00:21:6A", "Intel");
        vendors.put("00:25:00", "Intel");
        vendors.put("00:AA:01", "Intel");
        vendors.put("00:AA:02", "Intel");
        vendors.put("00:CB:BD", "Intel");
        vendors.put("04:7D:7B", "Intel");
        vendors.put("08:00:28", "Intel");
        vendors.put("0C:54:15", "Intel");
        vendors.put("10:BF:48", "Intel");
        vendors.put("14:CC:20", "Intel");
        vendors.put("18:03:73", "Intel");
        vendors.put("1C:1B:0D", "Intel");
        vendors.put("20:4E:7F", "Intel");
        vendors.put("24:77:03", "Intel");
        vendors.put("28:D2:44", "Intel");
        vendors.put("2C:44:FD", "Intel");
        vendors.put("30:E1:71", "Intel");
        vendors.put("34:E6:AD", "Intel");
        vendors.put("38:00:25", "Intel");
        vendors.put("3C:A9:F4", "Intel");
        vendors.put("40:8D:5C", "Intel");
        vendors.put("44:4C:0C", "Intel");
        vendors.put("48:45:20", "Intel");
        vendors.put("4C:34:88", "Intel");
        vendors.put("50:46:5D", "Intel");
        vendors.put("54:E1:AD", "Intel");
        vendors.put("58:91:CF", "Intel");
        vendors.put("5C:51:4F", "Intel");
        vendors.put("60:57:18", "Intel");
        vendors.put("64:16:66", "Intel");
        vendors.put("68:05:CA", "Intel");
        vendors.put("6C:88:14", "Intel");
        vendors.put("70:85:C2", "Intel");
        vendors.put("74:E5:0B", "Intel");
        vendors.put("78:44:76", "Intel");
        vendors.put("7C:7A:91", "Intel");
        vendors.put("80:86:F2", "Intel");
        vendors.put("84:47:65", "Intel");
        vendors.put("88:53:D4", "Intel");
        vendors.put("8C:4C:DC", "Intel");
        vendors.put("90:4C:E5", "Intel");
        vendors.put("94:57:A5", "Intel");
        vendors.put("98:4B:E1", "Intel");
        vendors.put("9C:B6:D0", "Intel");
        vendors.put("A0:88:B4", "Intel");
        vendors.put("A4:4C:C8", "Intel");
        vendors.put("A8:60:B6", "Intel");
        vendors.put("AC:9E:17", "Intel");
        vendors.put("B0:7F:B9", "Intel");
        vendors.put("B4:AE:2B", "Intel");
        vendors.put("B8:81:98", "Intel");
        vendors.put("BC:77:37", "Intel");
        vendors.put("C0:25:06", "Intel");
        vendors.put("C4:34:6B", "Intel");
        vendors.put("C8:60:00", "Intel");
        vendors.put("CC:46:D6", "Intel");
        vendors.put("D0:27:88", "Intel");
        vendors.put("D4:6E:5C", "Intel");
        vendors.put("D8:96:95", "Intel");
        vendors.put("DC:A9:71", "Intel");
        vendors.put("E0:2F:6D", "Intel");
        vendors.put("E4:CE:8F", "Intel");
        vendors.put("E8:94:F6", "Intel");
        vendors.put("EC:9A:74", "Intel");
        vendors.put("F0:DB:E2", "Intel");
        vendors.put("F4:6D:04", "Intel");
        vendors.put("F8:75:A4", "Intel");
        vendors.put("FC:AA:14", "Intel");
        
        // Microsoft Corporation
        vendors.put("00:15:5D", "Microsoft");
        vendors.put("00:50:F2", "Microsoft");
        vendors.put("00:03:FF", "Microsoft");
        vendors.put("00:0D:3A", "Microsoft");
        vendors.put("00:1D:D8", "Microsoft");
        vendors.put("00:22:48", "Microsoft");
        vendors.put("00:50:56", "Microsoft");
        vendors.put("08:00:27", "Microsoft");
        vendors.put("0C:29:55", "Microsoft");
        vendors.put("28:18:78", "Microsoft");
        vendors.put("40:61:86", "Microsoft");
        vendors.put("50:F5:DA", "Microsoft");
        vendors.put("60:45:BD", "Microsoft");
        vendors.put("70:85:C2", "Microsoft");
        vendors.put("80:EE:73", "Microsoft");
        vendors.put("90:2B:34", "Microsoft");
        vendors.put("A0:36:9F", "Microsoft");
        vendors.put("B0:83:FE", "Microsoft");
        vendors.put("C0:25:E9", "Microsoft");
        vendors.put("D0:17:6A", "Microsoft");
        vendors.put("E0:3E:44", "Microsoft");
        vendors.put("F0:6E:0B", "Microsoft");
        
        // VMware
        vendors.put("00:0C:29", "VMware");
        vendors.put("00:50:56", "VMware");
        vendors.put("00:1C:14", "VMware");
        vendors.put("00:05:69", "VMware");
        
        // VirtualBox
        vendors.put("08:00:27", "VirtualBox");
        
        // TP-Link Technologies
        vendors.put("00:27:19", "TP-Link");
        vendors.put("00:50:43", "TP-Link");
        vendors.put("1C:FA:68", "TP-Link");
        vendors.put("50:C7:BF", "TP-Link");
        vendors.put("64:70:02", "TP-Link");
        vendors.put("84:C9:B2", "TP-Link");
        vendors.put("A0:F3:C1", "TP-Link");
        vendors.put("CC:5D:4E", "TP-Link");
        vendors.put("E0:05:C5", "TP-Link");
        vendors.put("F4:EC:38", "TP-Link");
        
        // Cisco Systems
        vendors.put("00:00:0C", "Cisco");
        vendors.put("00:01:42", "Cisco");
        vendors.put("00:01:43", "Cisco");
        vendors.put("00:01:63", "Cisco");
        vendors.put("00:01:64", "Cisco");
        vendors.put("00:01:96", "Cisco");
        vendors.put("00:01:97", "Cisco");
        vendors.put("00:01:C7", "Cisco");
        vendors.put("00:01:C9", "Cisco");
        vendors.put("00:02:16", "Cisco");
        vendors.put("00:02:3D", "Cisco");
        vendors.put("00:02:4A", "Cisco");
        vendors.put("00:02:7D", "Cisco");
        vendors.put("00:02:7E", "Cisco");
        vendors.put("00:02:93", "Cisco");
        vendors.put("00:02:A5", "Cisco");
        vendors.put("00:02:B9", "Cisco");
        vendors.put("00:02:BA", "Cisco");
        vendors.put("00:02:FC", "Cisco");
        vendors.put("00:03:31", "Cisco");
        vendors.put("00:03:32", "Cisco");
        vendors.put("00:03:47", "Cisco");
        vendors.put("00:03:6B", "Cisco");
        vendors.put("00:03:6C", "Cisco");
        vendors.put("00:03:6D", "Cisco");
        vendors.put("00:03:6E", "Cisco");
        vendors.put("00:03:6F", "Cisco");
        vendors.put("00:03:70", "Cisco");
        vendors.put("00:03:71", "Cisco");
        vendors.put("00:03:72", "Cisco");
        vendors.put("00:03:73", "Cisco");
        vendors.put("00:03:74", "Cisco");
        vendors.put("00:03:75", "Cisco");
        vendors.put("00:03:76", "Cisco");
        vendors.put("00:03:77", "Cisco");
        vendors.put("00:03:78", "Cisco");
        vendors.put("00:03:79", "Cisco");
        vendors.put("00:03:7A", "Cisco");
        vendors.put("00:03:7B", "Cisco");
        vendors.put("00:03:7C", "Cisco");
        vendors.put("00:03:7D", "Cisco");
        vendors.put("00:03:7E", "Cisco");
        vendors.put("00:03:7F", "Cisco");
        vendors.put("00:03:80", "Cisco");
        vendors.put("00:03:81", "Cisco");
        vendors.put("00:03:82", "Cisco");
        vendors.put("00:03:83", "Cisco");
        vendors.put("00:03:84", "Cisco");
        vendors.put("00:03:85", "Cisco");
        vendors.put("00:03:86", "Cisco");
        vendors.put("00:03:87", "Cisco");
        vendors.put("00:03:88", "Cisco");
        vendors.put("00:03:89", "Cisco");
        vendors.put("00:03:8A", "Cisco");
        vendors.put("00:03:8B", "Cisco");
        vendors.put("00:03:8C", "Cisco");
        vendors.put("00:03:8D", "Cisco");
        vendors.put("00:03:8E", "Cisco");
        vendors.put("00:03:8F", "Cisco");
        vendors.put("00:03:90", "Cisco");
        vendors.put("00:03:91", "Cisco");
        vendors.put("00:03:92", "Cisco");
        vendors.put("00:03:93", "Cisco");
        vendors.put("00:03:94", "Cisco");
        vendors.put("00:03:95", "Cisco");
        vendors.put("00:03:96", "Cisco");
        vendors.put("00:03:97", "Cisco");
        vendors.put("00:03:98", "Cisco");
        vendors.put("00:03:99", "Cisco");
        vendors.put("00:03:9A", "Cisco");
        vendors.put("00:03:9B", "Cisco");
        vendors.put("00:03:9C", "Cisco");
        vendors.put("00:03:9D", "Cisco");
        vendors.put("00:03:9E", "Cisco");
        vendors.put("00:03:9F", "Cisco");
        vendors.put("00:03:A0", "Cisco");
        vendors.put("00:03:A1", "Cisco");
        vendors.put("00:03:A2", "Cisco");
        vendors.put("00:03:A3", "Cisco");
        vendors.put("00:03:A4", "Cisco");
        vendors.put("00:03:A5", "Cisco");
        vendors.put("00:03:A6", "Cisco");
        vendors.put("00:03:A7", "Cisco");
        vendors.put("00:03:A8", "Cisco");
        vendors.put("00:03:A9", "Cisco");
        vendors.put("00:03:AA", "Cisco");
        vendors.put("00:03:AB", "Cisco");
        vendors.put("00:03:AC", "Cisco");
        vendors.put("00:03:AD", "Cisco");
        vendors.put("00:03:AE", "Cisco");
        vendors.put("00:03:AF", "Cisco");
        vendors.put("00:03:B0", "Cisco");
        vendors.put("00:03:B1", "Cisco");
        vendors.put("00:03:B2", "Cisco");
        vendors.put("00:03:B3", "Cisco");
        vendors.put("00:03:B4", "Cisco");
        vendors.put("00:03:B5", "Cisco");
        vendors.put("00:03:B6", "Cisco");
        vendors.put("00:03:B7", "Cisco");
        vendors.put("00:03:B8", "Cisco");
        vendors.put("00:03:B9", "Cisco");
        vendors.put("00:03:BA", "Cisco");
        vendors.put("00:03:BB", "Cisco");
        vendors.put("00:03:BC", "Cisco");
        vendors.put("00:03:BD", "Cisco");
        vendors.put("00:03:BE", "Cisco");
        vendors.put("00:03:BF", "Cisco");
        vendors.put("00:03:C0", "Cisco");
        vendors.put("00:03:C1", "Cisco");
        vendors.put("00:03:C2", "Cisco");
        vendors.put("00:03:C3", "Cisco");
        vendors.put("00:03:C4", "Cisco");
        vendors.put("00:03:C5", "Cisco");
        vendors.put("00:03:C6", "Cisco");
        vendors.put("00:03:C7", "Cisco");
        vendors.put("00:03:C8", "Cisco");
        vendors.put("00:03:C9", "Cisco");
        vendors.put("00:03:CA", "Cisco");
        vendors.put("00:03:CB", "Cisco");
        vendors.put("00:03:CC", "Cisco");
        vendors.put("00:03:CD", "Cisco");
        vendors.put("00:03:CE", "Cisco");
        vendors.put("00:03:CF", "Cisco");
        vendors.put("00:03:D0", "Cisco");
        vendors.put("00:03:D1", "Cisco");
        vendors.put("00:03:D2", "Cisco");
        vendors.put("00:03:D3", "Cisco");
        vendors.put("00:03:D4", "Cisco");
        vendors.put("00:03:D5", "Cisco");
        vendors.put("00:03:D6", "Cisco");
        vendors.put("00:03:D7", "Cisco");
        vendors.put("00:03:D8", "Cisco");
        vendors.put("00:03:D9", "Cisco");
        vendors.put("00:03:DA", "Cisco");
        vendors.put("00:03:DB", "Cisco");
        vendors.put("00:03:DC", "Cisco");
        vendors.put("00:03:DD", "Cisco");
        vendors.put("00:03:DE", "Cisco");
        vendors.put("00:03:DF", "Cisco");
        vendors.put("00:03:E0", "Cisco");
        vendors.put("00:03:E1", "Cisco");
        vendors.put("00:03:E2", "Cisco");
        vendors.put("00:03:E3", "Cisco");
        vendors.put("00:03:E4", "Cisco");
        vendors.put("00:03:E5", "Cisco");
        vendors.put("00:03:E6", "Cisco");
        vendors.put("00:03:E7", "Cisco");
        vendors.put("00:03:E8", "Cisco");
        vendors.put("00:03:E9", "Cisco");
        vendors.put("00:03:EA", "Cisco");
        vendors.put("00:03:EB", "Cisco");
        vendors.put("00:03:EC", "Cisco");
        vendors.put("00:03:ED", "Cisco");
        vendors.put("00:03:EE", "Cisco");
        vendors.put("00:03:EF", "Cisco");
        vendors.put("00:03:F0", "Cisco");
        vendors.put("00:03:F1", "Cisco");
        vendors.put("00:03:F2", "Cisco");
        vendors.put("00:03:F3", "Cisco");
        vendors.put("00:03:F4", "Cisco");
        vendors.put("00:03:F5", "Cisco");
        vendors.put("00:03:F6", "Cisco");
        vendors.put("00:03:F7", "Cisco");
        vendors.put("00:03:F8", "Cisco");
        vendors.put("00:03:F9", "Cisco");
        vendors.put("00:03:FA", "Cisco");
        vendors.put("00:03:FB", "Cisco");
        vendors.put("00:03:FC", "Cisco");
        vendors.put("00:03:FD", "Cisco");
        vendors.put("00:03:FE", "Cisco");
        vendors.put("00:03:FF", "Cisco");
        vendors.put("00:04:00", "Cisco");
        vendors.put("00:04:01", "Cisco");
        vendors.put("00:04:02", "Cisco");
        vendors.put("00:04:03", "Cisco");
        vendors.put("00:04:04", "Cisco");
        vendors.put("00:04:05", "Cisco");
        vendors.put("00:04:06", "Cisco");
        vendors.put("00:04:07", "Cisco");
        vendors.put("00:04:08", "Cisco");
        vendors.put("00:04:09", "Cisco");
        vendors.put("00:04:0A", "Cisco");
        vendors.put("00:04:0B", "Cisco");
        vendors.put("00:04:0C", "Cisco");
        vendors.put("00:04:0D", "Cisco");
        vendors.put("00:04:0E", "Cisco");
        vendors.put("00:04:0F", "Cisco");
        vendors.put("00:04:10", "Cisco");
        vendors.put("00:04:11", "Cisco");
        vendors.put("00:04:12", "Cisco");
        vendors.put("00:04:13", "Cisco");
        vendors.put("00:04:14", "Cisco");
        vendors.put("00:04:15", "Cisco");
        vendors.put("00:04:16", "Cisco");
        vendors.put("00:04:17", "Cisco");
        vendors.put("00:04:18", "Cisco");
        vendors.put("00:04:19", "Cisco");
        vendors.put("00:04:1A", "Cisco");
        vendors.put("00:04:1B", "Cisco");
        vendors.put("00:04:1C", "Cisco");
        vendors.put("00:04:1D", "Cisco");
        vendors.put("00:04:1E", "Cisco");
        vendors.put("00:04:1F", "Cisco");
        vendors.put("00:04:20", "Cisco");
        vendors.put("00:04:21", "Cisco");
        vendors.put("00:04:22", "Cisco");
        vendors.put("00:04:23", "Cisco");
        vendors.put("00:04:24", "Cisco");
        vendors.put("00:04:25", "Cisco");
        vendors.put("00:04:26", "Cisco");
        vendors.put("00:04:27", "Cisco");
        vendors.put("00:04:28", "Cisco");
        vendors.put("00:04:29", "Cisco");
        vendors.put("00:04:2A", "Cisco");
        vendors.put("00:04:2B", "Cisco");
        vendors.put("00:04:2C", "Cisco");
        vendors.put("00:04:2D", "Cisco");
        vendors.put("00:04:2E", "Cisco");
        vendors.put("00:04:2F", "Cisco");
        vendors.put("00:04:30", "Cisco");
        vendors.put("00:04:31", "Cisco");
        vendors.put("00:04:32", "Cisco");
        vendors.put("00:04:33", "Cisco");
        vendors.put("00:04:34", "Cisco");
        vendors.put("00:04:35", "Cisco");
        vendors.put("00:04:36", "Cisco");
        vendors.put("00:04:37", "Cisco");
        vendors.put("00:04:38", "Cisco");
        vendors.put("00:04:39", "Cisco");
        vendors.put("00:04:3A", "Cisco");
        vendors.put("00:04:3B", "Cisco");
        vendors.put("00:04:3C", "Cisco");
        vendors.put("00:04:3D", "Cisco");
        vendors.put("00:04:3E", "Cisco");
        vendors.put("00:04:3F", "Cisco");
        vendors.put("00:04:40", "Cisco");
        vendors.put("00:04:41", "Cisco");
        vendors.put("00:04:42", "Cisco");
        vendors.put("00:04:43", "Cisco");
        vendors.put("00:04:44", "Cisco");
        vendors.put("00:04:45", "Cisco");
        vendors.put("00:04:46", "Cisco");
        vendors.put("00:04:47", "Cisco");
        vendors.put("00:04:48", "Cisco");
        vendors.put("00:04:49", "Cisco");
        vendors.put("00:04:4A", "Cisco");
        vendors.put("00:04:4B", "Cisco");
        vendors.put("00:04:4C", "Cisco");
        vendors.put("00:04:4D", "Cisco");
        vendors.put("00:04:4E", "Cisco");
        vendors.put("00:04:4F", "Cisco");
        vendors.put("00:04:50", "Cisco");
        vendors.put("00:04:51", "Cisco");
        vendors.put("00:04:52", "Cisco");
        vendors.put("00:04:53", "Cisco");
        vendors.put("00:04:54", "Cisco");
        vendors.put("00:04:55", "Cisco");
        vendors.put("00:04:56", "Cisco");
        vendors.put("00:04:57", "Cisco");
        vendors.put("00:04:58", "Cisco");
        vendors.put("00:04:59", "Cisco");
        vendors.put("00:04:5A", "Cisco");
        vendors.put("00:04:5B", "Cisco");
        vendors.put("00:04:5C", "Cisco");
        vendors.put("00:04:5D", "Cisco");
        vendors.put("00:04:5E", "Cisco");
        vendors.put("00:04:5F", "Cisco");
        vendors.put("00:04:60", "Cisco");
        vendors.put("00:04:61", "Cisco");
        vendors.put("00:04:62", "Cisco");
        vendors.put("00:04:63", "Cisco");
        vendors.put("00:04:64", "Cisco");
        vendors.put("00:04:65", "Cisco");
        vendors.put("00:04:66", "Cisco");
        vendors.put("00:04:67", "Cisco");
        vendors.put("00:04:68", "Cisco");
        vendors.put("00:04:69", "Cisco");
        vendors.put("00:04:6A", "Cisco");
        vendors.put("00:04:6B", "Cisco");
        vendors.put("00:04:6C", "Cisco");
        vendors.put("00:04:6D", "Cisco");
        vendors.put("00:04:6E", "Cisco");
        vendors.put("00:04:6F", "Cisco");
        vendors.put("00:04:70", "Cisco");
        vendors.put("00:04:71", "Cisco");
        vendors.put("00:04:72", "Cisco");
        vendors.put("00:04:73", "Cisco");
        vendors.put("00:04:74", "Cisco");
        vendors.put("00:04:75", "Cisco");
        vendors.put("00:04:76", "Cisco");
        vendors.put("00:04:77", "Cisco");
        vendors.put("00:04:78", "Cisco");
        vendors.put("00:04:79", "Cisco");
        vendors.put("00:04:7A", "Cisco");
        vendors.put("00:04:7B", "Cisco");
        vendors.put("00:04:7C", "Cisco");
        vendors.put("00:04:7D", "Cisco");
        vendors.put("00:04:7E", "Cisco");
        vendors.put("00:04:7F", "Cisco");
        vendors.put("00:04:80", "Cisco");
        vendors.put("00:04:81", "Cisco");
        vendors.put("00:04:82", "Cisco");
        vendors.put("00:04:83", "Cisco");
        vendors.put("00:04:84", "Cisco");
        vendors.put("00:04:85", "Cisco");
        vendors.put("00:04:86", "Cisco");
        vendors.put("00:04:87", "Cisco");
        vendors.put("00:04:88", "Cisco");
        vendors.put("00:04:89", "Cisco");
        vendors.put("00:04:8A", "Cisco");
        vendors.put("00:04:8B", "Cisco");
        vendors.put("00:04:8C", "Cisco");
        vendors.put("00:04:8D", "Cisco");
        vendors.put("00:04:8E", "Cisco");
        vendors.put("00:04:8F", "Cisco");
        vendors.put("00:04:90", "Cisco");
        vendors.put("00:04:91", "Cisco");
        vendors.put("00:04:92", "Cisco");
        vendors.put("00:04:93", "Cisco");
        vendors.put("00:04:94", "Cisco");
        vendors.put("00:04:95", "Cisco");
        vendors.put("00:04:96", "Cisco");
        vendors.put("00:04:97", "Cisco");
        vendors.put("00:04:98", "Cisco");
        vendors.put("00:04:99", "Cisco");
        vendors.put("00:04:9A", "Cisco");
        vendors.put("00:04:9B", "Cisco");
        vendors.put("00:04:9C", "Cisco");
        vendors.put("00:04:9D", "Cisco");
        vendors.put("00:04:9E", "Cisco");
        vendors.put("00:04:9F", "Cisco");
        vendors.put("00:04:A0", "Cisco");
        vendors.put("00:04:A1", "Cisco");
        vendors.put("00:04:A2", "Cisco");
        vendors.put("00:04:A3", "Cisco");
        vendors.put("00:04:A4", "Cisco");
        vendors.put("00:04:A5", "Cisco");
        vendors.put("00:04:A6", "Cisco");
        vendors.put("00:04:A7", "Cisco");
        vendors.put("00:04:A8", "Cisco");
        vendors.put("00:04:A9", "Cisco");
        vendors.put("00:04:AA", "Cisco");
        vendors.put("00:04:AB", "Cisco");
        vendors.put("00:04:AC", "Cisco");
        vendors.put("00:04:AD", "Cisco");
        vendors.put("00:04:AE", "Cisco");
        vendors.put("00:04:AF", "Cisco");
        vendors.put("00:04:B0", "Cisco");
        vendors.put("00:04:B1", "Cisco");
        vendors.put("00:04:B2", "Cisco");
        vendors.put("00:04:B3", "Cisco");
        vendors.put("00:04:B4", "Cisco");
        vendors.put("00:04:B5", "Cisco");
        vendors.put("00:04:B6", "Cisco");
        vendors.put("00:04:B7", "Cisco");
        vendors.put("00:04:B8", "Cisco");
        vendors.put("00:04:B9", "Cisco");
        vendors.put("00:04:BA", "Cisco");
        vendors.put("00:04:BB", "Cisco");
        vendors.put("00:04:BC", "Cisco");
        vendors.put("00:04:BD", "Cisco");
        vendors.put("00:04:BE", "Cisco");
        vendors.put("00:04:BF", "Cisco");
        vendors.put("00:04:C0", "Cisco");
        vendors.put("00:04:C1", "Cisco");
        vendors.put("00:04:C2", "Cisco");
        vendors.put("00:04:C3", "Cisco");
        vendors.put("00:04:C4", "Cisco");
        vendors.put("00:04:C5", "Cisco");
        vendors.put("00:04:C6", "Cisco");
        vendors.put("00:04:C7", "Cisco");
        vendors.put("00:04:C8", "Cisco");
        vendors.put("00:04:C9", "Cisco");
        vendors.put("00:04:CA", "Cisco");
        vendors.put("00:04:CB", "Cisco");
        vendors.put("00:04:CC", "Cisco");
        vendors.put("00:04:CD", "Cisco");
        vendors.put("00:04:CE", "Cisco");
        vendors.put("00:04:CF", "Cisco");
        vendors.put("00:04:D0", "Cisco");
        vendors.put("00:04:D1", "Cisco");
        vendors.put("00:04:D2", "Cisco");
        vendors.put("00:04:D3", "Cisco");
        vendors.put("00:04:D4", "Cisco");
        vendors.put("00:04:D5", "Cisco");
        vendors.put("00:04:D6", "Cisco");
        vendors.put("00:04:D7", "Cisco");
        vendors.put("00:04:D8", "Cisco");
        vendors.put("00:04:D9", "Cisco");
        vendors.put("00:04:DA", "Cisco");
        vendors.put("00:04:DB", "Cisco");
        vendors.put("00:04:DC", "Cisco");
        vendors.put("00:04:DD", "Cisco");
        vendors.put("00:04:DE", "Cisco");
        vendors.put("00:04:DF", "Cisco");
        vendors.put("00:04:E0", "Cisco");
        vendors.put("00:04:E1", "Cisco");
        vendors.put("00:04:E2", "Cisco");
        vendors.put("00:04:E3", "Cisco");
        vendors.put("00:04:E4", "Cisco");
        vendors.put("00:04:E5", "Cisco");
        vendors.put("00:04:E6", "Cisco");
        vendors.put("00:04:E7", "Cisco");
        vendors.put("00:04:E8", "Cisco");
        vendors.put("00:04:E9", "Cisco");
        vendors.put("00:04:EA", "Cisco");
        vendors.put("00:04:EB", "Cisco");
        vendors.put("00:04:EC", "Cisco");
        vendors.put("00:04:ED", "Cisco");
        vendors.put("00:04:EE", "Cisco");
        vendors.put("00:04:EF", "Cisco");
        vendors.put("00:04:F0", "Cisco");
        vendors.put("00:04:F1", "Cisco");
        vendors.put("00:04:F2", "Cisco");
        vendors.put("00:04:F3", "Cisco");
        vendors.put("00:04:F4", "Cisco");
        vendors.put("00:04:F5", "Cisco");
        vendors.put("00:04:F6", "Cisco");
        vendors.put("00:04:F7", "Cisco");
        vendors.put("00:04:F8", "Cisco");
        vendors.put("00:04:F9", "Cisco");
        vendors.put("00:04:FA", "Cisco");
        vendors.put("00:04:FB", "Cisco");
        vendors.put("00:04:FC", "Cisco");
        vendors.put("00:04:FD", "Cisco");
        vendors.put("00:04:FE", "Cisco");
        vendors.put("00:04:FF", "Cisco");
        vendors.put("00:05:00", "Cisco");
        vendors.put("00:05:01", "Cisco");
        vendors.put("00:05:02", "Cisco");
        vendors.put("00:05:03", "Cisco");
        vendors.put("00:05:04", "Cisco");
        vendors.put("00:05:05", "Cisco");
        vendors.put("00:05:06", "Cisco");
        vendors.put("00:05:07", "Cisco");
        vendors.put("00:05:08", "Cisco");
        vendors.put("00:05:09", "Cisco");
        vendors.put("00:05:0A", "Cisco");
        vendors.put("00:05:0B", "Cisco");
        vendors.put("00:05:0C", "Cisco");
        vendors.put("00:05:0D", "Cisco");
        vendors.put("00:05:0E", "Cisco");
        vendors.put("00:05:0F", "Cisco");
        vendors.put("00:05:10", "Cisco");
        vendors.put("00:05:11", "Cisco");
        vendors.put("00:05:12", "Cisco");
        vendors.put("00:05:13", "Cisco");
        vendors.put("00:05:14", "Cisco");
        vendors.put("00:05:15", "Cisco");
        vendors.put("00:05:16", "Cisco");
        vendors.put("00:05:17", "Cisco");
        vendors.put("00:05:18", "Cisco");
        vendors.put("00:05:19", "Cisco");
        vendors.put("00:05:1A", "Cisco");
        vendors.put("00:05:1B", "Cisco");
        vendors.put("00:05:1C", "Cisco");
        vendors.put("00:05:1D", "Cisco");
        vendors.put("00:05:1E", "Cisco");
        vendors.put("00:05:1F", "Cisco");
        vendors.put("00:05:20", "Cisco");
        vendors.put("00:05:21", "Cisco");
        vendors.put("00:05:22", "Cisco");
        vendors.put("00:05:23", "Cisco");
        vendors.put("00:05:24", "Cisco");
        vendors.put("00:05:25", "Cisco");
        vendors.put("00:05:26", "Cisco");
        vendors.put("00:05:27", "Cisco");
        vendors.put("00:05:28", "Cisco");
        vendors.put("00:05:29", "Cisco");
        vendors.put("00:05:2A", "Cisco");
        vendors.put("00:05:2B", "Cisco");
        vendors.put("00:05:2C", "Cisco");
        vendors.put("00:05:2D", "Cisco");
        vendors.put("00:05:2E", "Cisco");
        vendors.put("00:05:2F", "Cisco");
        vendors.put("00:05:30", "Cisco");
        vendors.put("00:05:31", "Cisco");
        vendors.put("00:05:32", "Cisco");
        vendors.put("00:05:33", "Cisco");
        
        // Huawei Technologies
        vendors.put("00:E0:FC", "Huawei");
        vendors.put("00:1E:10", "Huawei");
        vendors.put("00:46:4B", "Huawei");
        vendors.put("00:46:4C", "Huawei");
        vendors.put("00:46:4D", "Huawei");
        vendors.put("00:46:4E", "Huawei");
        vendors.put("00:46:4F", "Huawei");
        vendors.put("00:46:50", "Huawei");
        vendors.put("00:46:51", "Huawei");
        vendors.put("00:46:52", "Huawei");
        vendors.put("00:46:53", "Huawei");
        vendors.put("00:46:54", "Huawei");
        vendors.put("00:46:55", "Huawei");
        vendors.put("00:46:56", "Huawei");
        vendors.put("00:46:57", "Huawei");
        vendors.put("00:46:58", "Huawei");
        vendors.put("00:46:59", "Huawei");
        vendors.put("00:46:5A", "Huawei");
        vendors.put("00:46:5B", "Huawei");
        vendors.put("00:46:5C", "Huawei");
        vendors.put("00:46:5D", "Huawei");
        vendors.put("00:46:5E", "Huawei");
        vendors.put("00:46:5F", "Huawei");
        vendors.put("00:46:60", "Huawei");
        vendors.put("00:46:61", "Huawei");
        vendors.put("00:46:62", "Huawei");
        vendors.put("00:46:63", "Huawei");
        vendors.put("00:46:64", "Huawei");
        vendors.put("00:46:65", "Huawei");
        vendors.put("00:46:66", "Huawei");
        vendors.put("00:46:67", "Huawei");
        vendors.put("00:46:68", "Huawei");
        vendors.put("00:46:69", "Huawei");
        vendors.put("00:46:6A", "Huawei");
        vendors.put("00:46:6B", "Huawei");
        vendors.put("00:46:6C", "Huawei");
        vendors.put("00:46:6D", "Huawei");
        vendors.put("00:46:6E", "Huawei");
        vendors.put("00:46:6F", "Huawei");
        vendors.put("00:46:70", "Huawei");
        vendors.put("00:46:71", "Huawei");
        vendors.put("00:46:72", "Huawei");
        vendors.put("00:46:73", "Huawei");
        vendors.put("00:46:74", "Huawei");
        vendors.put("00:46:75", "Huawei");
        vendors.put("00:46:76", "Huawei");
        vendors.put("00:46:77", "Huawei");
        vendors.put("00:46:78", "Huawei");
        vendors.put("00:46:79", "Huawei");
        vendors.put("00:46:7A", "Huawei");
        vendors.put("00:46:7B", "Huawei");
        vendors.put("00:46:7C", "Huawei");
        vendors.put("00:46:7D", "Huawei");
        vendors.put("00:46:7E", "Huawei");
        vendors.put("00:46:7F", "Huawei");
        vendors.put("00:46:80", "Huawei");
        vendors.put("00:46:81", "Huawei");
        vendors.put("00:46:82", "Huawei");
        vendors.put("00:46:83", "Huawei");
        vendors.put("00:46:84", "Huawei");
        vendors.put("00:46:85", "Huawei");
        vendors.put("00:46:86", "Huawei");
        vendors.put("00:46:87", "Huawei");
        vendors.put("00:46:88", "Huawei");
        vendors.put("00:46:89", "Huawei");
        vendors.put("00:46:8A", "Huawei");
        vendors.put("00:46:8B", "Huawei");
        vendors.put("00:46:8C", "Huawei");
        vendors.put("00:46:8D", "Huawei");
        vendors.put("00:46:8E", "Huawei");
        vendors.put("00:46:8F", "Huawei");
        vendors.put("00:46:90", "Huawei");
        vendors.put("00:46:91", "Huawei");
        vendors.put("00:46:92", "Huawei");
        vendors.put("00:46:93", "Huawei");
        vendors.put("00:46:94", "Huawei");
        vendors.put("00:46:95", "Huawei");
        vendors.put("00:46:96", "Huawei");
        vendors.put("00:46:97", "Huawei");
        vendors.put("00:46:98", "Huawei");
        vendors.put("00:46:99", "Huawei");
        vendors.put("00:46:9A", "Huawei");
        vendors.put("00:46:9B", "Huawei");
        vendors.put("00:46:9C", "Huawei");
        vendors.put("00:46:9D", "Huawei");
        vendors.put("00:46:9E", "Huawei");
        vendors.put("00:46:9F", "Huawei");
        vendors.put("00:46:A0", "Huawei");
        vendors.put("00:46:A1", "Huawei");
        vendors.put("00:46:A2", "Huawei");
        vendors.put("00:46:A3", "Huawei");
        vendors.put("00:46:A4", "Huawei");
        vendors.put("00:46:A5", "Huawei");
        vendors.put("00:46:A6", "Huawei");
        vendors.put("00:46:A7", "Huawei");
        vendors.put("00:46:A8", "Huawei");
        vendors.put("00:46:A9", "Huawei");
        vendors.put("00:46:AA", "Huawei");
        vendors.put("00:46:AB", "Huawei");
        vendors.put("00:46:AC", "Huawei");
        vendors.put("00:46:AD", "Huawei");
        vendors.put("00:46:AE", "Huawei");
        vendors.put("00:46:AF", "Huawei");
        vendors.put("00:46:B0", "Huawei");
        vendors.put("00:46:B1", "Huawei");
        vendors.put("00:46:B2", "Huawei");
        vendors.put("00:46:B3", "Huawei");
        vendors.put("00:46:B4", "Huawei");
        vendors.put("00:46:B5", "Huawei");
        vendors.put("00:46:B6", "Huawei");
        vendors.put("00:46:B7", "Huawei");
        vendors.put("00:46:B8", "Huawei");
        vendors.put("00:46:B9", "Huawei");
        vendors.put("00:46:BA", "Huawei");
        vendors.put("00:46:BB", "Huawei");
        vendors.put("00:46:BC", "Huawei");
        vendors.put("00:46:BD", "Huawei");
        vendors.put("00:46:BE", "Huawei");
        vendors.put("00:46:BF", "Huawei");
        vendors.put("00:46:C0", "Huawei");
        vendors.put("00:46:C1", "Huawei");
        vendors.put("00:46:C2", "Huawei");
        vendors.put("00:46:C3", "Huawei");
        vendors.put("00:46:C4", "Huawei");
        vendors.put("00:46:C5", "Huawei");
        vendors.put("00:46:C6", "Huawei");
        vendors.put("00:46:C7", "Huawei");
        vendors.put("00:46:C8", "Huawei");
        vendors.put("00:46:C9", "Huawei");
        vendors.put("00:46:CA", "Huawei");
        vendors.put("00:46:CB", "Huawei");
        vendors.put("00:46:CC", "Huawei");
        vendors.put("00:46:CD", "Huawei");
        vendors.put("00:46:CE", "Huawei");
        vendors.put("00:46:CF", "Huawei");
        vendors.put("00:46:D0", "Huawei");
        vendors.put("00:46:D1", "Huawei");
        vendors.put("00:46:D2", "Huawei");
        vendors.put("00:46:D3", "Huawei");
        vendors.put("00:46:D4", "Huawei");
        vendors.put("00:46:D5", "Huawei");
        vendors.put("00:46:D6", "Huawei");
        vendors.put("00:46:D7", "Huawei");
        vendors.put("00:46:D8", "Huawei");
        vendors.put("00:46:D9", "Huawei");
        vendors.put("00:46:DA", "Huawei");
        vendors.put("00:46:DB", "Huawei");
        vendors.put("00:46:DC", "Huawei");
        vendors.put("00:46:DD", "Huawei");
        vendors.put("00:46:DE", "Huawei");
        vendors.put("00:46:DF", "Huawei");
        vendors.put("00:46:E0", "Huawei");
        vendors.put("00:46:E1", "Huawei");
        vendors.put("00:46:E2", "Huawei");
        vendors.put("00:46:E3", "Huawei");
        vendors.put("00:46:E4", "Huawei");
        vendors.put("00:46:E5", "Huawei");
        vendors.put("00:46:E6", "Huawei");
        vendors.put("00:46:E7", "Huawei");
        vendors.put("00:46:E8", "Huawei");
        vendors.put("00:46:E9", "Huawei");
        vendors.put("00:46:EA", "Huawei");
        vendors.put("00:46:EB", "Huawei");
        vendors.put("00:46:EC", "Huawei");
        vendors.put("00:46:ED", "Huawei");
        vendors.put("00:46:EE", "Huawei");
        vendors.put("00:46:EF", "Huawei");
        vendors.put("00:46:F0", "Huawei");
        vendors.put("00:46:F1", "Huawei");
        vendors.put("00:46:F2", "Huawei");
        vendors.put("00:46:F3", "Huawei");
        vendors.put("00:46:F4", "Huawei");
        vendors.put("00:46:F5", "Huawei");
        vendors.put("00:46:F6", "Huawei");
        vendors.put("00:46:F7", "Huawei");
        vendors.put("00:46:F8", "Huawei");
        vendors.put("00:46:F9", "Huawei");
        vendors.put("00:46:FA", "Huawei");
        vendors.put("00:46:FB", "Huawei");
        vendors.put("00:46:FC", "Huawei");
        vendors.put("00:46:FD", "Huawei");
        vendors.put("00:46:FE", "Huawei");
        vendors.put("00:46:FF", "Huawei");
        
        // Return vendor or null if not found
        String vendor = vendors.get(prefix);
        if (vendor != null && !vendor.equals("Unknown")) {
            return vendor;
        }
        
        // If not found in local database, return null
        return null;
    }

    /**
     * Identify operating system based on open ports
     */
    private String identifyOperatingSystem(List<Integer> openPorts) {
        if (openPorts.contains(3389)) {
            return "Windows (RDP detected)";
        }
        if (openPorts.contains(22) && !openPorts.contains(445)) {
            return "Linux/Unix (SSH detected)";
        }
        if (openPorts.contains(445) || openPorts.contains(139)) {
            return "Windows (SMB detected)";
        }
        if (openPorts.contains(22) && openPorts.contains(80)) {
            return "Linux/Unix";
        }
        return null;
    }

    private static Map<String, Object> vulnFinding(String type, String severity, String description, Integer port,
            String service) {
        Map<String, Object> vuln = new HashMap<>(6);
        vuln.put("type", type);
        vuln.put("severity", severity);
        vuln.put("description", description);
        if (port != null) {
            vuln.put("port", port.intValue());
        }
        if (service != null) {
            vuln.put("service", service);
        }
        return vuln;
    }

    /**
     * Add finding if dedupe key (type + optional port) is new.
     */
    private static void addDistinctFinding(List<Map<String, Object>> out, Set<String> seenKeys, Map<String, Object> finding) {
        if (finding == null || finding.isEmpty()) {
            return;
        }
        Object rawType = finding.get("type");
        Object rawPort = finding.get("port");
        String key = String.valueOf(rawType) + '|' + String.valueOf(rawPort);
        if (seenKeys.add(key)) {
            out.add(finding);
        }
    }

    /**
     * Fast vulnerability analysis — delegated to {@link #analyzeVulnerabilities(Map)} (purely rule-based on open ports).
     */
    private List<Map<String, Object>> analyzeVulnerabilitiesFast(Map<String, Object> device) {
        return analyzeVulnerabilities(device);
    }

    /**
     * Analyze vulnerabilities based on open ports / services surfaced by the LAN scan.
     */
    private List<Map<String, Object>> analyzeVulnerabilities(Map<String, Object> device) {
        List<Map<String, Object>> vulnerabilities = new ArrayList<>();
        Set<String> dedupeKeys = new LinkedHashSet<>();

        @SuppressWarnings("unchecked")
        List<Integer> openPortsRaw = (List<Integer>) device.getOrDefault("openPorts", Collections.emptyList());
        final List<Integer> openPorts = openPortsRaw == null ? Collections.emptyList() : openPortsRaw;

        for (Integer pObj : openPorts) {
            if (pObj == null) {
                continue;
            }
            int p = pObj;
            /* SMB analysed as a single finding (combined 139/445) */
            if (p == 139 || p == 445) {
                continue;
            }
            addDistinctFinding(vulnerabilities, dedupeKeys, checkPortVulnerability(p));
        }

        /* Cleartext web */
        boolean hasHttps = openPorts.contains(443) || openPorts.contains(8443);
        if (openPorts.contains(80) && !hasHttps) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("Unencrypted HTTP", "medium",
                            "Plain HTTP reachable without TLS on port 443/8443. Credentials and payloads traverse the LAN in cleartext.",
                            80, "HTTP"));
        }
        boolean hasMgmtTls = openPorts.contains(8443);
        if (openPorts.contains(8080) && !hasHttps && !hasMgmtTls) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("Cleartext management endpoint", "medium",
                            "Port 8080 often exposes appliance or app administration without HTTPS alongside. Prefer reverse proxy TLS or bind to trusted interfaces only.",
                            8080, "HTTP-Proxy"));
        }

        /* RDP: dedicated finding (skipped in per-port pass to avoid duplication) */
        if (openPorts.contains(3389)) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("Remote Desktop exposure", "high",
                            "RDP is reachable. Enforce Network Level Authentication (NLA), patched OS builds (BlueKeep / similar), MFA via gateway, rate limiting, and allow-lists.",
                            3389, "RDP"));
        }

        /* Databases & datastores */
        if (openPorts.contains(3306)) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("MySQL exposed", "critical",
                            "MySQL listens on the LAN. Restrict with firewall/bind-address, TLS, strong auth, least privilege.", 3306, "MySQL"));
        }
        if (openPorts.contains(5432)) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("PostgreSQL exposed", "critical",
                            "PostgreSQL reachable on network. Restrict to application subnets, enforce pg_hba and TLS.", 5432, "PostgreSQL"));
        }
        if (openPorts.contains(27017)) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("MongoDB exposed", "critical",
                            "MongoDB often deployed without authentication. Isolate; enable authentication, TLS/scram, and bind to trusted hosts.", 27017, "MongoDB"));
        }
        if (openPorts.contains(6379)) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("Redis exposed", "critical",
                            "Unauthenticated Redis is frequently compromised for data theft and remote code execution payloads. Bind to localhost or protect with ACL/TLS/IP allow lists.",
                            6379, "Redis"));
        }
        if (openPorts.contains(9200)) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("Elasticsearch exposed", "critical",
                            "Elasticsearch HTTP API can leak indices and permit cluster abuse. Restrict network access, enable auth (Elastic Security/X-Pack), TLS.",
                            9200, "Elasticsearch"));
        }

        /* SMB lumped finding + recommendations */
        if (openPorts.contains(445) || openPorts.contains(139)) {
            int smbPort = openPorts.contains(445) ? 445 : 139;
            Map<String, Object> vuln = vulnFinding("SMB Exposed", "high",
                    "SMB is reachable on LAN — malware lateral movement (EternalBlue, SMBGhost clusters) and insider abuse remain relevant. Harden SMB version, signing and share ACLs.",
                    smbPort,
                    openPorts.contains(445) ? "SMB" : "NetBIOS");
            List<String> recommendations = Arrays.asList(
                    "Apply current OS patches for SMB stack (including MS17-010 / SMBGhost-era fixes)",
                    "Disable SMBv1 where possible",
                    "Require SMB signing; prefer SMB encryption (SMB v3)",
                    "Firewall SMB to authorised hosts only",
                    "Audit shares and remove anonymous guest access");
            vuln.put("recommendations", recommendations);
            addDistinctFinding(vulnerabilities, dedupeKeys, vuln);
        }

        /* Broad LAN attack surface heuristic */
        long riskyRemote = openPorts.stream().filter(p -> p != null && (
                p == 22 || p == 23 || p == 3389 || p == 5900)).distinct().count();
        if (riskyRemote >= 2) {
            addDistinctFinding(vulnerabilities, dedupeKeys,
                    vulnFinding("Multiple remote consoles", "high",
                            String.format(Locale.ROOT,
                                    "%d distinct remote-management ports are open simultaneously (e.g., SSH/VNC/RDP/Telnet). Reduces containment if one credential leaks.",
                                    riskyRemote),
                            null, null));
        }

        return vulnerabilities;
    }

    /**
     * Port-specific exposures — omit 139/445 (handled in composite SMB rule).
     */
    private Map<String, Object> checkPortVulnerability(int port) {
        switch (port) {
            case 21:
                return vulnFinding("FTP Service", "high",
                        "FTP sends credentials and files unencrypted. Disable anonymous FTP, prefer SFTP/FTPS, or retire the service.",
                        21, "FTP");
            case 22:
                return vulnFinding("SSH Service", "medium",
                        "SSH is exposed to the LAN. Disable password root logins, prefer keys, deploy fail2ban / rate limits, keep OpenSSH current.",
                        22, "SSH");
            case 23:
                return vulnFinding("Telnet Service", "critical",
                        "Telnet is cleartext and obsolete. Expect credential sniffing and trivial takeover — replace with SSH.",
                        23, "Telnet");
            case 135:
                return vulnFinding("MS RPC endpoint mapper", "high",
                        "RPC endpoint mapper can assist reconnaissance toward Windows services over the LAN. Firewall from untrusted subnets.",
                        135, "RPC");
            case 3389:
                /* Dedicated composite messaging */
                return null;
            case 554:
                return vulnFinding("RTSP / video stream", "high",
                        "RTSP feeds are often weakly authenticated and unencrypted, enabling interception or camera hijinks. Isolate cameras; prefer VPN or TLS gateways.",
                        554, "RTSP");
            case 631:
                return vulnFinding("Internet Printing Protocol (IPP)", "medium",
                        "Printers historically ship with defaults and accept jobs over LAN. Restrict to trusted hosts and patch firmware.", 631, "IPP");
            case 1883:
                return vulnFinding("MQTT broker", "high",
                        "MQTT commonly lacks TLS/auth exposing smart-home or industrial telemetry. Require username/password/TLS ACLs.", 1883, "MQTT");
            case 5000:
                return vulnFinding("Potential UPnP / control port", "medium",
                        "TCP/5000 is used by UPnP, Plex, Flask dev servers, etc. Many implementations had historic RCE or unintended exposure — verify purpose and firewall.",
                        5000, "UPnP");
            case 5357:
                return vulnFinding("Web Services for Devices", "medium",
                        "Microsoft WSD (5357) can leak device metadata across LAN segments. Restrict or disable if printers already managed elsewhere.", 5357, "WSD");
            case 8080:
                return null; /* handled with composite cleartext rule */
            case 8443:
                return vulnFinding("HTTPS alternate management", "low",
                        "TLS management plane detected. Still ensure modern ciphers, patch cadence, and avoid default vendor credentials.", 8443, "HTTPS-Alt");
            case 9100:
                return vulnFinding("Raw printing (JetDirect)", "medium",
                        "Port 9100 accepts raw print jobs without application-level auth and is a known pivot point on printers. Restrict by IP or disable remote printing.",
                        9100, "Raw-Print");
            case 5900:
                return vulnFinding("VNC remote desktop", "high",
                        "VNC historically used weak or no encryption. Prefer SSH tunnel, modern VNC with TLS, or replace with RDP/SSH with MFA.",
                        5900, "VNC");
            case 6379:
            case 9200:
            case 27017:
            case 3306:
            case 5432:
                return null; /* handled in database composite section */
            case 62078:
                return vulnFinding("AirPlay / discovery channel", "low",
                        "Apple AirPlay discovery may leak device presence. Ensure guest isolation on Wi-Fi and firmware updates.", 62078, "AirPlay");
            default:
                return null;
        }
    }

    /**
     * Get device hostname using multiple methods
     */
    private String getDeviceHostname(String ip) {
        // Method 1: Standard DNS lookup
        try {
            InetAddress address = InetAddress.getByName(ip);
            String hostname = address.getHostName();
            if (hostname != null && !hostname.equals(ip) && !hostname.isEmpty()) {
                return hostname;
            }
            
            // Try canonical hostname
            String canonicalHost = address.getCanonicalHostName();
            if (canonicalHost != null && !canonicalHost.equals(ip) && !canonicalHost.isEmpty()) {
                return canonicalHost;
            }
        } catch (Exception e) {
            log.debug("Standard DNS lookup failed for {}", ip);
        }

        // Method 2: Check router device list (Netgear, etc.) - DISABLED for performance
        // String routerName = getHostnameFromRouter(ip);
        // if (routerName != null && !routerName.isEmpty()) {
        //     return routerName;
        // }

        // Method 3: Try NetBIOS name (Windows devices)
        String netbiosName = getNetBIOSName(ip);
        if (netbiosName != null && !netbiosName.isEmpty()) {
            return netbiosName;
        }

        // Method 4: Try ARP table (Linux/Unix)
        String arpName = getHostnameFromARP(ip);
        if (arpName != null && !arpName.isEmpty()) {
            return arpName;
        }

        return null;
    }

    /**
     * Get hostname from router (Netgear, etc.)
     * DISABLED for performance - router queries are slow
     */
    private String getHostnameFromRouter(String ip) {
        // DISABLED for performance
        return null;
        /*
        try {
            // Load router device map if not already loaded
            if (routerDeviceMap == null) {
                routerDeviceMap = loadRouterDeviceMap();
            }
            
            if (routerDeviceMap != null && routerDeviceMap.containsKey(ip)) {
                return routerDeviceMap.get(ip);
            }
        } catch (Exception e) {
            log.debug("Error getting hostname from router for {}: {}", ip, e.getMessage());
        }
        return null;
        */
    }

    /**
     * Load device names from router
     * DISABLED for performance - router queries are slow
     */
    private Map<String, String> loadRouterDeviceMap() {
        // DISABLED for performance
        return new HashMap<>();
        /*
        Map<String, String> deviceMap = new HashMap<>();
        
        try {
            // Try to detect router IP
            String router = routerIp;
            if (router == null || router.isEmpty()) {
                String localIp = getLocalIpAddress();
                if (localIp != null) {
                    String networkBase = getNetworkBase(localIp);
                    router = networkBase + ".1"; // Common router IP
                }
            }
            
            if (router == null || router.isEmpty()) {
                return deviceMap;
            }

            log.debug("Attempting to load device names from router: {}", router);

            // Method 1: Try Netgear Genie API (if available)
            try {
                loadFromNetgearGenie(router, deviceMap);
            } catch (Exception e) {
                log.debug("Netgear Genie API failed: {}", e.getMessage());
            }

            // Method 2: Try HTTP page scraping (if credentials available)
            if (deviceMap.isEmpty() && routerPassword != null && !routerPassword.isEmpty()) {
                try {
                    loadFromRouterHTTP(router, deviceMap);
                } catch (Exception e) {
                    log.debug("Router HTTP scraping failed: {}", e.getMessage());
                }
            }

        } catch (Exception e) {
            log.debug("Error loading router device map: {}", e.getMessage());
        }

        log.debug("Loaded {} device names from router", deviceMap.size());
        return deviceMap;
        */
    }

    /**
     * Load device names from Netgear Genie API
     */
    private void loadFromNetgearGenie(String routerIp, Map<String, String> deviceMap) {
        try {
            String url = "http://" + routerIp + "/genie_connected_devices.json";
            HttpHeaders headers = new HttpHeaders();
            headers.setAccept(Collections.singletonList(MediaType.APPLICATION_JSON));
            
            HttpEntity<String> entity = new HttpEntity<>(headers);
            ResponseEntity<String> response = restTemplate.exchange(
                url, HttpMethod.GET, entity, String.class
            );

            if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
                String body = response.getBody();
                // Parse JSON response (simplified - would need proper JSON parsing)
                Pattern pattern = Pattern.compile("\"hostname\"\\s*:\\s*\"([^\"]+)\".*?\"ip\"\\s*:\\s*\"([^\"]+)\"");
                Matcher matcher = pattern.matcher(body);
                while (matcher.find()) {
                    String hostname = matcher.group(1);
                    String ip = matcher.group(2);
                    if (hostname != null && ip != null) {
                        deviceMap.put(ip, hostname);
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Netgear Genie API error: {}", e.getMessage());
        }
    }

    /**
     * Load device names from router HTTP page (requires authentication)
     */
    private void loadFromRouterHTTP(String routerIp, Map<String, String> deviceMap) {
        try {
            // This is a simplified version - actual implementation would need to:
            // 1. Login to router
            // 2. Get session cookie
            // 3. Parse the connected devices page
            // This varies by router model
            
            String loginUrl = "http://" + routerIp + "/login.cgi";
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
            
            String loginData = "username=" + URLEncoder.encode(routerUsername, StandardCharsets.UTF_8) +
                             "&password=" + URLEncoder.encode(routerPassword, StandardCharsets.UTF_8);
            
            HttpEntity<String> entity = new HttpEntity<>(loginData, headers);
            ResponseEntity<String> response = restTemplate.exchange(
                loginUrl, HttpMethod.POST, entity, String.class
            );

            // If login successful, get device list page
            // This would need to be customized per router model
            if (response.getStatusCode() == HttpStatus.OK) {
                log.debug("Router HTTP login successful, attempting to parse device list");
                // TODO: Parse response body to extract device names
                // This requires router-specific parsing logic
            }
            
        } catch (Exception e) {
            log.debug("Router HTTP login failed: {}", e.getMessage());
        }
    }

    /**
     * Get NetBIOS name (Windows devices)
     */
    private String getNetBIOSName(String ip) {
        try {
            // Try to resolve NetBIOS name
            // This requires NBT (NetBIOS over TCP/IP) which may not be available
            ProcessBuilder pb = new ProcessBuilder("nbtstat", "-A", ip);
            Process process = pb.start();
            
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.contains("<00>") && line.contains("UNIQUE")) {
                        String[] parts = line.trim().split("\\s+");
                        if (parts.length > 0) {
                            String name = parts[0].trim();
                            if (!name.isEmpty() && !name.equals(ip)) {
                                return name;
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            // NetBIOS not available or command failed
            log.debug("NetBIOS lookup failed for {}: {}", ip, e.getMessage());
        }
        return null;
    }

    /**
     * Get hostname from ARP table (Linux/Unix)
     */
    private String getHostnameFromARP(String ip) {
        try {
            ProcessBuilder pb;
            String os = System.getProperty("os.name").toLowerCase();
            
            if (os.contains("win")) {
                pb = new ProcessBuilder("arp", "-a", ip);
            } else {
                pb = new ProcessBuilder("arp", "-n", ip);
            }
            
            Process process = pb.start();
            
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.contains(ip)) {
                        // Parse ARP output to find hostname
                        // Format varies by OS
                        String[] parts = line.split("\\s+");
                        for (String part : parts) {
                            if (!part.equals(ip) && !part.matches("^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")) {
                                // Might be a hostname
                                if (part.contains(".") || part.matches("^[a-zA-Z].*")) {
                                    return part;
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.debug("ARP lookup failed for {}: {}", ip, e.getMessage());
        }
        return null;
    }

    /**
     * Detect and save new devices to history in MongoDB
     * Compares found devices with known devices in MongoDB and saves new ones to history
     * @param foundDevices List of devices found during scan
     */
    public void detectAndSaveNewDevicesToHistory(List<Map<String, Object>> foundDevices) {
        if (foundDevices == null || foundDevices.isEmpty()) {
            log.debug("No devices found, skipping new device detection");
            return;
        }

        try {
            // Load all existing device mappings from MongoDB
            List<NetworkDeviceMapping> existingMappings = deviceMappingRepository.findAll();
            Set<String> knownMacAddresses = existingMappings.stream()
                    .map(NetworkDeviceMapping::getMacAddress)
                    .filter(mac -> mac != null && !mac.trim().isEmpty())
                    .map(this::normalizeMacAddress)
                    .collect(Collectors.toSet());

            log.debug("Loaded {} existing device mappings from MongoDB", existingMappings.size());
            log.debug("Known MAC addresses: {}", knownMacAddresses.size());

            // Find new devices (by MAC address)
            List<Map<String, Object>> newDevices = new ArrayList<>();
            for (Map<String, Object> device : foundDevices) {
                String macAddress = (String) device.get("macAddress");
                if (macAddress != null && !macAddress.trim().isEmpty()) {
                    String normalizedMac = normalizeMacAddress(macAddress);
                    if (!knownMacAddresses.contains(normalizedMac)) {
                        // This is a new device
                        newDevices.add(device);
                        log.debug("New device detected: IP={}, MAC={}, Hostname={}", 
                                device.get("ipAddress"), macAddress, device.get("hostname"));
                    }
                }
            }

            if (!newDevices.isEmpty()) {
                log.debug("Saving {} new device(s) to history in MongoDB", newDevices.size());
                saveNewDevicesToHistory(newDevices);
            } else {
                log.debug("No new devices found - history update skipped");
            }
        } catch (Exception e) {
            log.error("Error detecting and saving new devices to history: {}", e.getMessage(), e);
        }
    }

    /**
     * Save new devices to history in MongoDB
     * @param newDevices List of new devices to save
     */
    private void saveNewDevicesToHistory(List<Map<String, Object>> newDevices) {
        try {
            for (Map<String, Object> device : newDevices) {
                String macAddress = (String) device.get("macAddress");
                
                // Skip if no MAC address
                if (macAddress == null || macAddress.trim().isEmpty()) {
                    continue;
                }
                
                // Always add a new entry to history, even if device already exists (to track detection times)
                // Save MAC address with ":" format (e.g., AA:BB:CC:DD:EE:FF) for better readability in MongoDB
                String formattedMac = formatMacAddressWithColons(macAddress);
                
                NewDeviceHistory historyEntry = new NewDeviceHistory();
                historyEntry.setIpAddress((String) device.get("ipAddress"));
                historyEntry.setHostname((String) device.get("hostname"));
                historyEntry.setMacAddress(formattedMac);
                historyEntry.setVendor((String) device.get("vendor"));
                historyEntry.setDeviceType((String) device.get("deviceType"));
                historyEntry.setOs((String) device.get("os"));
                
                // Convert open ports list to comma-separated string
                @SuppressWarnings("unchecked")
                List<Integer> openPorts = (List<Integer>) device.get("openPorts");
                if (openPorts != null && !openPorts.isEmpty()) {
                    String portsStr = openPorts.stream()
                            .map(String::valueOf)
                            .collect(Collectors.joining(", "));
                    historyEntry.setOpenPorts(portsStr);
                }
                
                historyEntry.setDetectionDate(new Date());
                
                newDeviceHistoryRepository.save(historyEntry);
                log.debug("Saved new device detection to history: IP={}, MAC={}, DetectionDate={}", 
                        historyEntry.getIpAddress(), historyEntry.getMacAddress(), historyEntry.getDetectionDate());
            }
        } catch (Exception e) {
            log.error("Error saving new devices to history: {}", e.getMessage(), e);
        }
    }

    /**
     * Normalize MAC address for comparison (uppercase, remove separators)
     */
    private String normalizeMacAddress(String macAddress) {
        if (macAddress == null || macAddress.trim().isEmpty()) {
            return "";
        }
        return macAddress.trim().toUpperCase().replaceAll("[:-]", "").replaceAll("\\s", "");
    }
    
    /**
     * Format MAC address with colons (e.g., AA:BB:CC:DD:EE:FF)
     * Normalizes first, then adds colons every 2 characters
     */
    private String formatMacAddressWithColons(String macAddress) {
        if (macAddress == null || macAddress.trim().isEmpty()) {
            return "";
        }
        
        // First normalize (remove separators and convert to uppercase)
        String normalized = normalizeMacAddress(macAddress);
        
        // If normalized MAC is not exactly 12 characters, return as-is
        if (normalized.length() != 12) {
            return normalized;
        }
        
        // Add colons every 2 characters: AA:BB:CC:DD:EE:FF
        return normalized.substring(0, 2) + ":" +
               normalized.substring(2, 4) + ":" +
               normalized.substring(4, 6) + ":" +
               normalized.substring(6, 8) + ":" +
               normalized.substring(8, 10) + ":" +
               normalized.substring(10, 12);
    }

}

