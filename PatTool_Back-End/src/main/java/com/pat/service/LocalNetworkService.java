package com.pat.service;

import com.pat.repo.NetworkDeviceMappingRepository;
import com.pat.repo.domain.NetworkDeviceMapping;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class LocalNetworkService {

    private static final Logger log = LoggerFactory.getLogger(LocalNetworkService.class);
    private static final int TIMEOUT = 150; // 150ms timeout for very fast scanning
    private static final int PORT_TIMEOUT = 100; // 100ms timeout for port scanning
    private static final int THREAD_POOL_SIZE = 200; // Large thread pool for maximum parallelism
    private static final List<Integer> COMMON_PORTS = Arrays.asList(22, 80, 443, 445, 3389, 8080); // Reduced port list for speed
    
    private final RestTemplate restTemplate;
    private final NetworkDeviceMappingRepository deviceMappingRepository;
    private Map<String, String> routerDeviceMap = null; // Cache for router device names
    
    @Value("${app.router.ip:}")
    private String routerIp;
    
    @Value("${app.router.username:admin}")
    private String routerUsername;
    
    @Value("${app.router.password:}")
    private String routerPassword;
    
    @Value("${app.router.devices.file:s:\\patrick\\Save_prg_OFFICIAL\\router_config\\attached-devices.txt}")
    private String devicesFilePath;
    
    @Autowired
    public LocalNetworkService(RestTemplate restTemplate, NetworkDeviceMappingRepository deviceMappingRepository) {
        this.restTemplate = restTemplate;
        this.deviceMappingRepository = deviceMappingRepository;
        log.info("LocalNetworkService initialized. Device mapping repository: {}", deviceMappingRepository != null ? "OK" : "NULL");
        // Load device names from CSV file into MongoDB on service initialization (if not already loaded)
        try {
            initializeDeviceMappingsFromFile();
        } catch (Exception e) {
            log.error("Error during device mappings initialization", e);
        }
    }

    /**
     * Functional interface for device callback during streaming scan
     */
    @FunctionalInterface
    public interface DeviceCallback {
        void onDeviceFound(Map<String, Object> device, int progress, int total);
    }

    /**
     * Scan the local network for devices and vulnerabilities with streaming callback
     * Optimized for speed and real-time display
     */
    public void scanLocalNetworkStreaming(DeviceCallback callback) {
        long startTime = System.currentTimeMillis();
        String scanId = "SCAN-" + System.currentTimeMillis();
        log.info("========== NETWORK SCAN STARTED [{}] ==========", scanId);
        log.info("Starting local network scan (streaming mode) - Scan ID: {}", scanId);

        try {
            // Get local network IP range
            String localIp = getLocalIpAddress();
            if (localIp == null) {
                log.error("Unable to determine local IP address");
                throw new RuntimeException("Unable to determine local IP address");
            }

            String networkBase = getNetworkBase(localIp);
            log.info("Scanning network range: {}.* (254 IPs)", networkBase);
            log.info("Thread pool size: {}", THREAD_POOL_SIZE);

            final int totalIps = 254;
            final AtomicInteger completedCount = new AtomicInteger(0);
            final AtomicInteger deviceCount = new AtomicInteger(0);
            
            // Use large thread pool for maximum parallelism
            ExecutorService executor = Executors.newFixedThreadPool(THREAD_POOL_SIZE);
            CountDownLatch latch = new CountDownLatch(totalIps);

            log.info("Submitting {} scan tasks to thread pool...", totalIps);

            // Submit all scan tasks
            for (int i = 1; i <= totalIps; i++) {
                final String ip = networkBase + "." + i;
                executor.submit(() -> {
                    try {
                        Map<String, Object> device = scanDeviceFast(ip);
                        int completed = completedCount.incrementAndGet();
                        
                        if (device != null && !device.isEmpty()) {
                            // Quick vulnerability analysis (simplified)
                            try {
                                List<Map<String, Object>> vulnerabilities = analyzeVulnerabilitiesFast(device);
                                device.put("vulnerabilities", vulnerabilities);
                            } catch (Exception e) {
                                device.put("vulnerabilities", Collections.emptyList());
                            }
                            
                            int found = deviceCount.incrementAndGet();
                            log.info("[SCAN] Device found #{}: {} (hostname: {})", 
                                    found, ip, device.get("hostname"));
                            
                            // Send device immediately via callback (non-blocking)
                            try {
                                log.debug("[SCAN] Calling callback for device: {}", ip);
                                callback.onDeviceFound(device, completed, totalIps);
                                log.debug("[SCAN] Callback completed for device: {}", ip);
                            } catch (Exception e) {
                                log.error("[SCAN] Error in callback for device {}: {}", ip, e.getMessage(), e);
                            }
                        }
                        
                        // Log progress every 50 IPs
                        if (completed % 50 == 0) {
                            log.info("Scan progress: {}/{} IPs completed ({} devices found)", 
                                    completed, totalIps, deviceCount.get());
                        }
                    } catch (Exception e) {
                        log.debug("Error scanning device {}: {}", ip, e.getMessage());
                    } finally {
                        latch.countDown();
                    }
                });
            }

            log.info("All {} scan tasks submitted. Waiting for completion...", totalIps);

            // Wait for all scans to complete (with timeout)
            boolean allCompleted = false;
            try {
                allCompleted = latch.await(60, TimeUnit.SECONDS); // Increased to 60 seconds
                if (!allCompleted) {
                    log.warn("Scan timeout after 60 seconds. Completed: {}/{}", 
                            completedCount.get(), totalIps);
                } else {
                    log.info("All scan tasks completed. Waiting for thread pool shutdown...");
                }
            } catch (InterruptedException e) {
                log.error("Scan interrupted", e);
                Thread.currentThread().interrupt();
            }

            // Shutdown executor and wait for all threads
            executor.shutdown();
            try {
                if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                    log.warn("Thread pool did not terminate gracefully, forcing shutdown...");
                    executor.shutdownNow();
                    if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                        log.error("Thread pool did not terminate");
                    }
                }
            } catch (InterruptedException e) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }

            long endTime = System.currentTimeMillis();
            long duration = endTime - startTime;
            
            log.info("========== NETWORK SCAN COMPLETED [{}] ==========", scanId);
            log.info("Total scan time: {} ms ({} seconds)", duration, duration / 1000.0);
            log.info("IPs scanned: {}/{}", completedCount.get(), totalIps);
            log.info("Devices found: {}", deviceCount.get());
            log.info("Scan completed: {}", allCompleted ? "YES" : "NO (timeout)");

        } catch (Exception e) {
            log.error("========== NETWORK SCAN FAILED ==========");
            log.error("Error during network scan", e);
            throw new RuntimeException("Network scan failed", e);
        }
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
            log.error("Error during network scan", e);
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
            log.error("Error getting network interfaces", e);
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
     */
    private Map<String, Object> scanDeviceFast(String ip) {
        Map<String, Object> device = new HashMap<>();

        try {
            // Quick reachability check
            InetAddress address = InetAddress.getByName(ip);
            boolean isReachable = address.isReachable(TIMEOUT);

            if (!isReachable) {
                return null; // Device not online
            }

            device.put("ipAddress", ip);
            device.put("status", "online");

            // Priority 1: Use device name from MongoDB if available (most reliable)
            Optional<NetworkDeviceMapping> mapping = deviceMappingRepository.findByIpAddress(ip);
            if (mapping.isPresent()) {
                String deviceName = mapping.get().getDeviceName();
                if (deviceName != null && !deviceName.trim().isEmpty()) {
                    device.put("hostname", deviceName.trim());
                    log.debug("Device {} - Using name from MongoDB: {}", ip, deviceName.trim());
                }
            }
            
            // Priority 2: Quick hostname lookup (only DNS, no router queries) - only if CSV didn't provide a name
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
            boolean isReachable = address.isReachable(TIMEOUT);

            if (!isReachable) {
                return null; // Device not online
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

            // Try to get MAC address (Linux/Unix only) - only if device has open ports
            if (!openPorts.isEmpty()) {
                try {
                    String macAddress = getMacAddress(ip);
                    if (macAddress != null) {
                        device.put("macAddress", macAddress);
                        // Try to identify vendor from MAC
                        String vendor = identifyVendor(macAddress);
                        if (vendor != null) {
                            device.put("vendor", vendor);
                        }
                    }
                } catch (Exception e) {
                    log.debug("Could not get MAC address for {}", ip);
                }
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
        ExecutorService executor = Executors.newFixedThreadPool(20);

        List<Future<Boolean>> futures = new ArrayList<>();
        for (int port : COMMON_PORTS) {
            final int portNum = port;
            Future<Boolean> future = executor.submit(() -> isPortOpen(ip, portNum));
            futures.add(future);
        }

        for (int i = 0; i < COMMON_PORTS.size(); i++) {
            try {
                if (futures.get(i).get(500, TimeUnit.MILLISECONDS)) {
                    openPorts.add(COMMON_PORTS.get(i));
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
        for (int port : COMMON_PORTS) {
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
        ExecutorService executor = Executors.newFixedThreadPool(COMMON_PORTS.size());

        List<Future<Boolean>> futures = new ArrayList<>();
        for (int port : COMMON_PORTS) {
            final int portNum = port;
            Future<Boolean> future = executor.submit(() -> isPortOpen(ip, portNum));
            futures.add(future);
        }

        for (int i = 0; i < COMMON_PORTS.size(); i++) {
            try {
                if (futures.get(i).get(PORT_TIMEOUT, TimeUnit.MILLISECONDS)) {
                    openPorts.add(COMMON_PORTS.get(i));
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
            case 8080: return "HTTP-Proxy";
            case 8443: return "HTTPS-Alt";
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
    private String detectDeviceType(List<Integer> openPorts, Map<String, Object> device) {
        if (openPorts == null || openPorts.isEmpty()) {
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

    /**
     * Get MAC address (Linux/Unix only)
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
     * Identify vendor from MAC address (simplified - first 3 octets)
     */
    private String identifyVendor(String macAddress) {
        // This is a simplified vendor identification
        // In a real implementation, you would use a MAC vendor database
        String prefix = macAddress.substring(0, 8).toUpperCase();
        
        // Common vendor prefixes (simplified list)
        Map<String, String> vendors = new HashMap<>();
        vendors.put("00:50:56", "VMware");
        vendors.put("00:0C:29", "VMware");
        vendors.put("00:1B:21", "Intel");
        vendors.put("00:1E:67", "Intel");
        vendors.put("00:25:00", "Apple");
        vendors.put("00:26:BB", "Apple");
        vendors.put("00:23:DF", "Apple");
        vendors.put("00:1E:C2", "Apple");
        vendors.put("00:50:56", "VMware");
        vendors.put("08:00:27", "VirtualBox");
        
        return vendors.getOrDefault(prefix, "Unknown");
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

    /**
     * Fast vulnerability analysis (simplified for speed)
     */
    private List<Map<String, Object>> analyzeVulnerabilitiesFast(Map<String, Object> device) {
        List<Map<String, Object>> vulnerabilities = new ArrayList<>();
        @SuppressWarnings("unchecked")
        List<Integer> openPorts = (List<Integer>) device.getOrDefault("openPorts", Collections.emptyList());

        // Quick checks only - no detailed port scanning
        if (openPorts.contains(23)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "Telnet Service");
            vuln.put("severity", "critical");
            vuln.put("description", "Telnet transmits data in plaintext");
            vuln.put("port", 23);
            vulnerabilities.add(vuln);
        }

        if (openPorts.contains(80) && !openPorts.contains(443)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "Unencrypted HTTP");
            vuln.put("severity", "medium");
            vuln.put("description", "HTTP without HTTPS");
            vuln.put("port", 80);
            vulnerabilities.add(vuln);
        }

        if (openPorts.contains(3306) || openPorts.contains(5432)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "Database Exposed");
            vuln.put("severity", "critical");
            vuln.put("description", "Database service on network");
            vuln.put("port", openPorts.contains(3306) ? 3306 : 5432);
            vulnerabilities.add(vuln);
        }

        if (openPorts.contains(445) || openPorts.contains(139)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "SMB Exposed");
            vuln.put("severity", "high");
            vuln.put("description", "SMB service detected");
            vuln.put("port", openPorts.contains(445) ? 445 : 139);
            vulnerabilities.add(vuln);
        }

        return vulnerabilities;
    }

    /**
     * Analyze vulnerabilities based on open ports and services
     */
    private List<Map<String, Object>> analyzeVulnerabilities(Map<String, Object> device) {
        List<Map<String, Object>> vulnerabilities = new ArrayList<>();
        @SuppressWarnings("unchecked")
        List<Integer> openPorts = (List<Integer>) device.getOrDefault("openPorts", Collections.emptyList());

        // Check for common vulnerabilities
        for (Integer port : openPorts) {
            Map<String, Object> vuln = checkPortVulnerability(port);
            if (vuln != null) {
                vulnerabilities.add(vuln);
            }
        }

        // Check for default credentials risk
        if (openPorts.contains(22) || openPorts.contains(23) || openPorts.contains(3389)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "Default Credentials Risk");
            vuln.put("severity", "high");
            vuln.put("description", "Remote access service detected. Ensure strong passwords are configured.");
            vulnerabilities.add(vuln);
        }

        // Check for unencrypted services
        if (openPorts.contains(80) && !openPorts.contains(443)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "Unencrypted HTTP");
            vuln.put("severity", "medium");
            vuln.put("description", "HTTP service detected without HTTPS. Data transmission is unencrypted.");
            vuln.put("port", 80);
            vuln.put("service", "HTTP");
            vulnerabilities.add(vuln);
        }

        // Check for database exposure
        if (openPorts.contains(3306) || openPorts.contains(5432)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "Database Service Exposed");
            vuln.put("severity", "critical");
            vuln.put("description", "Database service detected on network. Ensure proper firewall rules and authentication.");
            vuln.put("port", openPorts.contains(3306) ? 3306 : 5432);
            vuln.put("service", openPorts.contains(3306) ? "MySQL" : "PostgreSQL");
            vulnerabilities.add(vuln);
        }

        // Check for SMB exposure
        if (openPorts.contains(445) || openPorts.contains(139)) {
            Map<String, Object> vuln = new HashMap<>();
            vuln.put("type", "SMB Service Exposed");
            vuln.put("severity", "high");
            vuln.put("description", "SMB service detected. Vulnerable to EternalBlue and similar exploits if not patched.");
            vuln.put("port", openPorts.contains(445) ? 445 : 139);
            vuln.put("service", "SMB");
            vulnerabilities.add(vuln);
        }

        return vulnerabilities;
    }

    /**
     * Check for known vulnerabilities on a specific port
     */
    private Map<String, Object> checkPortVulnerability(int port) {
        Map<String, Object> vuln = null;

        switch (port) {
            case 23:
                vuln = new HashMap<>();
                vuln.put("type", "Telnet Service");
                vuln.put("severity", "critical");
                vuln.put("description", "Telnet service detected. Telnet transmits data in plaintext and is highly insecure.");
                vuln.put("port", port);
                vuln.put("service", "Telnet");
                break;
            case 135:
                vuln = new HashMap<>();
                vuln.put("type", "RPC Endpoint Mapper");
                vuln.put("severity", "high");
                vuln.put("description", "RPC endpoint mapper detected. Can be used for enumeration attacks.");
                vuln.put("port", port);
                vuln.put("service", "RPC");
                break;
            case 3389:
                vuln = new HashMap<>();
                vuln.put("type", "Remote Desktop Protocol");
                vuln.put("severity", "high");
                vuln.put("description", "RDP service detected. Ensure strong authentication and consider restricting access.");
                vuln.put("port", port);
                vuln.put("service", "RDP");
                break;
        }

        return vuln;
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
     * Initialize device mappings from CSV file into MongoDB
     * This method loads the CSV file and persists the data to MongoDB
     * It only loads if MongoDB is empty (to avoid duplicates)
     */
    public void initializeDeviceMappingsFromFile() {
        // Check if MongoDB already has data
        long existingCount = deviceMappingRepository.count();
        if (existingCount > 0) {
            log.info("Device mappings already exist in MongoDB ({} entries). Skipping file load.", existingCount);
            return;
        }
        
        if (devicesFilePath == null || devicesFilePath.isEmpty()) {
            log.warn("Device names file path not configured. Skipping initialization.");
            return;
        }
        
        File file = new File(devicesFilePath);
        if (!file.exists()) {
            log.warn("Device names file not found: {}. Skipping initialization.", devicesFilePath);
            return;
        }
        
        log.info("Loading device mappings from file into MongoDB: {}", devicesFilePath);
        int loadedCount = 0;
        int skippedCount = 0;
        
        try (BufferedReader reader = new BufferedReader(new FileReader(file, StandardCharsets.UTF_8))) {
            String line;
            boolean isFirstLine = true;
            
            while ((line = reader.readLine()) != null) {
                // Skip header line
                if (isFirstLine) {
                    isFirstLine = false;
                    continue;
                }
                
                // Skip empty lines
                if (line.trim().isEmpty()) {
                    continue;
                }
                
                // Parse line: #;IP Address;Device Name;MAC Address
                // Example: 33;192.168.1.21;HUB-BLUESOUND;90:56:82:BE:26:B9
                String[] parts = line.split(";");
                if (parts.length >= 4) {
                    try {
                        Integer deviceNumber = Integer.parseInt(parts[0].trim());
                        String ipAddress = parts[1].trim();
                        String deviceName = parts[2].trim();
                        String macAddress = parts[3].trim();
                        
                        if (!ipAddress.isEmpty() && !deviceName.isEmpty()) {
                            // Check if mapping already exists
                            Optional<NetworkDeviceMapping> existing = deviceMappingRepository.findByIpAddress(ipAddress);
                            if (existing.isPresent()) {
                                // Update existing
                                NetworkDeviceMapping mapping = existing.get();
                                mapping.setDeviceName(deviceName);
                                mapping.setMacAddress(macAddress);
                                mapping.setDeviceNumber(deviceNumber);
                                deviceMappingRepository.save(mapping);
                            } else {
                                // Create new
                                NetworkDeviceMapping mapping = new NetworkDeviceMapping(ipAddress, deviceName, macAddress, deviceNumber);
                                deviceMappingRepository.save(mapping);
                            }
                            loadedCount++;
                            log.debug("Loaded device mapping into MongoDB: {} -> {}", ipAddress, deviceName);
                        } else {
                            skippedCount++;
                            log.debug("Skipping line (empty IP or name): {}", line);
                        }
                    } catch (NumberFormatException e) {
                        skippedCount++;
                        log.debug("Skipping line (invalid device number): {}", line);
                    }
                } else {
                    skippedCount++;
                    log.debug("Skipping line (not enough parts, expected 4, got {}): {}", parts.length, line);
                }
            }
            
            log.info("Initialized {} device mappings in MongoDB from file ({} skipped)", loadedCount, skippedCount);
            if (loadedCount > 0) {
                log.info("Sample device mappings (first 5):");
                int count = 0;
                for (NetworkDeviceMapping mapping : deviceMappingRepository.findAll()) {
                    if (count++ < 5) {
                        log.info("  {} -> {}", mapping.getIpAddress(), mapping.getDeviceName());
                    }
                }
            }
        } catch (IOException e) {
            log.error("Error loading device names from file into MongoDB: {}", devicesFilePath, e);
        } catch (Exception e) {
            log.error("Unexpected error loading device names from file into MongoDB: {}", devicesFilePath, e);
        }
    }
}

