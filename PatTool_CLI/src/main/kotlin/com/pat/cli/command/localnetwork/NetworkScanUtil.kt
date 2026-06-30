package com.pat.cli.command.localnetwork

import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.regex.Pattern

object NetworkScanUtil {

    private val IPV4 = Pattern.compile(
        "^((25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(25[0-5]|2[0-4]\\d|[01]?\\d\\d?)$"
    )
    private val MAC = Pattern.compile("([0-9A-Fa-f]{2}([-:])){5}[0-9A-Fa-f]{2}")

    fun isValidIpv4(ip: String): Boolean = IPV4.matcher(ip).matches()

    fun isPrivateIp(ip: String): Boolean {
        val p = ip.split(".").mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return when {
            p[0] == 10 -> true
            p[0] == 172 && p[1] in 16..31 -> true
            p[0] == 192 && p[1] == 168 -> true
            p[0] == 127 -> true
            else -> false
        }
    }

    fun detectLocalIp(): String? {
        try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress("8.8.8.8", 80), 1500)
                return socket.localAddress.hostAddress
            }
        } catch (_: Exception) {
        }
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return null
            while (ifaces.hasMoreElements()) {
                val ni = ifaces.nextElement()
                if (!ni.isUp || ni.isLoopback) continue
                val addrs = ni.inetAddresses
                while (addrs.hasMoreElements()) {
                    val a = addrs.nextElement()
                    if (a is Inet4Address && !a.isLoopbackAddress) {
                        return a.hostAddress
                    }
                }
            }
        } catch (_: Exception) {
        }
        return null
    }

    fun detectLocalCidr24(): String? {
        val ip = detectLocalIp() ?: return null
        val base = ip.substringBeforeLast('.')
        return "$base.0/24"
    }

    fun ipToInt(ip: String): Int {
        val p = ip.split(".").map { it.toInt() }
        return (p[0] shl 24) or (p[1] shl 16) or (p[2] shl 8) or p[3]
    }

    fun intToIp(v: Int): String {
        return "${v ushr 24 and 0xff}.${v ushr 16 and 0xff}.${v ushr 8 and 0xff}.${v and 0xff}"
    }

    fun hostsInCidr(cidr: String): List<String> {
        val parts = cidr.split("/")
        if (parts.size != 2) return emptyList()
        val prefix = parts[1].toIntOrNull() ?: return emptyList()
        if (prefix !in 8..30) return emptyList()
        val baseIp = parts[0]
        if (!isValidIpv4(baseIp)) return emptyList()
        val mask = -1 shl (32 - prefix)
        val network = ipToInt(baseIp) and mask
        val broadcast = network or mask.inv()
        val start = network + 1
        val end = broadcast - 1
        if (end - start > 4096) {
            return emptyList()
        }
        return (start..end).map { intToIp(it) }
    }

    fun describeCidr(cidr: String): Map<String, Any?> {
        val parts = cidr.split("/")
        val prefix = parts.getOrNull(1)?.toIntOrNull()
        val base = parts.getOrNull(0) ?: cidr
        if (prefix == null || !isValidIpv4(base)) {
            return mapOf("error" to "invalid CIDR")
        }
        val mask = -1 shl (32 - prefix)
        val network = ipToInt(base) and mask
        val broadcast = network or mask.inv()
        val hostCount = (broadcast - network - 1).coerceAtLeast(0)
        return linkedMapOf(
            "cidr" to cidr,
            "network" to intToIp(network),
            "broadcast" to intToIp(broadcast),
            "prefix" to prefix,
            "usableHosts" to hostCount,
            "localIp" to detectLocalIp()
        )
    }

    fun isHostReachable(ip: String, timeoutMs: Int): Boolean {
        if (pingReachable(ip, timeoutMs)) return true
        return try {
            InetAddress.getByName(ip).isReachable(timeoutMs.coerceAtLeast(500))
        } catch (_: Exception) {
            false
        }
    }

    fun pingReachable(ip: String, timeoutMs: Int): Boolean {
        return try {
            val os = System.getProperty("os.name").lowercase(Locale.ROOT)
            val pb = if (os.contains("win")) {
                ProcessBuilder("ping", "-n", "1", "-w", timeoutMs.toString(), ip)
            } else {
                ProcessBuilder("ping", "-c", "1", "-W", (timeoutMs / 1000).coerceAtLeast(1).toString(), ip)
            }
            pb.redirectErrorStream(true)
            val p = pb.start()
            val ok = p.waitFor(timeoutMs + 2000L, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!ok) {
                p.destroyForcibly()
                false
            } else {
                p.exitValue() == 0
            }
        } catch (_: Exception) {
            false
        }
    }

    fun resolveHostname(ip: String): String {
        return try {
            InetAddress.getByName(ip).hostName?.takeIf { it != ip } ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    fun macFromArp(ip: String): String {
        parseArpTable().firstOrNull { it["ip"] == ip }?.get("mac")?.toString() ?: run {
            pingReachable(ip, 800)
            parseArpTable().firstOrNull { it["ip"] == ip }?.get("mac")?.toString() ?: ""
        }
    }

    fun parseArpTable(): List<Map<String, Any?>> {
        return try {
            val pb = ProcessBuilder("arp", "-a")
            pb.redirectErrorStream(true)
            val p = pb.start()
            val text = p.inputStream.bufferedReader(StandardCharsets.UTF_8).readText()
            p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            parseArpOutput(text)
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun parseArpOutput(text: String): List<Map<String, Any?>> {
        val list = mutableListOf<Map<String, Any?>>()
        for (line in text.lines()) {
            val ipMatch = Regex("(\\d{1,3}(?:\\.\\d{1,3}){3})").find(line) ?: continue
            val ip = ipMatch.groupValues[1]
            if (!isValidIpv4(ip)) continue
            val macMatch = MAC.matcher(line)
            if (!macMatch.find()) continue
            val mac = macMatch.group().replace('-', ':').uppercase(Locale.ROOT)
            val type = when {
                line.contains("dynamic", true) -> "dynamic"
                line.contains("static", true) -> "static"
                else -> "unknown"
            }
            list.add(mapOf("ip" to ip, "mac" to mac, "type" to type))
        }
        return list.distinctBy { it["ip"] }
    }

    private val COMMON_PORTS = intArrayOf(21, 22, 23, 80, 443, 445, 3389, 8080)

    fun scanCommonPorts(ip: String, timeoutMs: Int): List<Int> {
        val open = mutableListOf<Int>()
        for (port in COMMON_PORTS) {
            try {
                Socket().use { s ->
                    s.connect(InetSocketAddress(ip, port), timeoutMs.coerceIn(100, 3000))
                    open.add(port)
                }
            } catch (_: Exception) {
            }
        }
        return open
    }

    fun simpleVulnerabilities(device: Map<String, Any?>): List<Map<String, String>> {
        @Suppress("UNCHECKED_CAST")
        val ports = device["openPorts"] as? List<Int> ?: return emptyList()
        val vulns = mutableListOf<Map<String, String>>()
        if (23 in ports) {
            vulns.add(mapOf("severity" to "high", "issue" to "Telnet (23) open — unencrypted remote access"))
        }
        if (21 in ports) {
            vulns.add(mapOf("severity" to "medium", "issue" to "FTP (21) open — prefer SFTP/FTPS"))
        }
        if (445 in ports) {
            vulns.add(mapOf("severity" to "info", "issue" to "SMB (445) open — ensure patched and firewalled"))
        }
        if (80 in ports && 443 !in ports) {
            vulns.add(mapOf("severity" to "low", "issue" to "HTTP without HTTPS on same host"))
        }
        return vulns
    }

    fun lookupPublicIp(ip: String): Map<String, Any?> {
        val url = URL("https://ipwho.is/$ip")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.requestMethod = "GET"
        conn.setRequestProperty("User-Agent", "PatTool-CLI/1.0")
        return try {
            conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { reader ->
                parseSimpleJson(reader.readText())
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun parseSimpleJson(json: String): Map<String, Any?> {
        fun field(key: String): String? {
            val re = Regex("\"$key\"\\s*:\\s*\"([^\"]*?)\"")
            return re.find(json)?.groupValues?.getOrNull(1)
                ?: Regex("\"$key\"\\s*:\\s*(true|false|null|-?\\d+(?:\\.\\d+)?)").find(json)?.groupValues?.getOrNull(1)
        }
        return linkedMapOf(
            "ip" to field("ip"),
            "success" to field("success"),
            "type" to field("type"),
            "continent" to field("continent"),
            "country" to field("country"),
            "region" to field("region"),
            "city" to field("city"),
            "isp" to field("isp"),
            "org" to field("org"),
            "asn" to field("asn")
        )
    }
}
