package com.pat.cli.command.localnetwork

import com.pat.cli.Console
import com.pat.cli.output.CliJson
import com.pat.cli.output.CliTable
import picocli.CommandLine.Command
import picocli.CommandLine.Option
import picocli.CommandLine.Parameters
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@Command(
    name = "localnetwork",
    description = ["Local network scan, ARP devices, subnet info, and IP lookup"],
    subcommands = [
        LocalNetworkScanCommand::class,
        LocalNetworkDevicesCommand::class,
        LocalNetworkWhoisCommand::class,
        LocalNetworkSubnetCommand::class
    ]
)
class LocalNetworkCommand : Callable<Int> {
    override fun call(): Int {
        Console.out.println("Usage: pat localnetwork <scan|devices|whois|subnet> [options]")
        Console.out.println("  scan     Ping sweep on the LAN (/24 by default)")
        Console.out.println("  devices  List hosts from the ARP cache (fast)")
        Console.out.println("  whois    Public IP geolocation / WHOIS-style lookup")
        Console.out.println("  subnet   Show subnet details for a CIDR or auto-detected LAN")
        return 0
    }
}

@Command(name = "scan", description = ["Ping sweep on the local network"])
class LocalNetworkScanCommand : Callable<Int> {

    @Option(names = ["--cidr"], description = ["CIDR to scan (default: auto-detected /24)"])
    var cidr: String? = null

    @Option(names = ["--timeout"], description = ["Per-host timeout in ms (default: 1000)"])
    var timeoutMs: Int = 1000

    @Option(names = ["--threads"], description = ["Parallel probes (default: 32)"])
    var threads: Int = 32

    @Option(names = ["--ports"], description = ["Probe common ports on responding hosts"])
    var probePorts: Boolean = false

    @Option(names = ["--json"], description = ["JSON output"])
    var json: Boolean = false

    override fun call(): Int {
        val resolvedCidr = cidr?.trim()?.takeIf { it.isNotEmpty() }
            ?: NetworkScanUtil.detectLocalCidr24()
            ?: run {
                Console.err.println("[!] Could not detect local network. Use --cidr 192.168.1.0/24")
                return 1
            }

        val hosts = NetworkScanUtil.hostsInCidr(resolvedCidr)
        if (hosts.isEmpty()) {
            Console.err.println("[!] Invalid or empty CIDR: $resolvedCidr")
            return 1
        }

        if (!json) {
            Console.out.println("Scanning $resolvedCidr (${hosts.size} addresses, ${threads} threads)...")
        }

        val pool = Executors.newFixedThreadPool(threads.coerceIn(1, 128))
        val found = java.util.Collections.synchronizedList(mutableListOf<Map<String, Any?>>())
        val done = AtomicInteger(0)

        try {
            hosts.forEach { ip ->
                pool.submit {
                    try {
                        if (NetworkScanUtil.isHostReachable(ip, timeoutMs)) {
                            val device = linkedMapOf<String, Any?>(
                                "ip" to ip,
                                "status" to "online",
                                "hostname" to NetworkScanUtil.resolveHostname(ip),
                                "mac" to NetworkScanUtil.macFromArp(ip)
                            )
                            if (probePorts) {
                                device["openPorts"] = NetworkScanUtil.scanCommonPorts(ip, timeoutMs / 2)
                                device["vulnerabilities"] = NetworkScanUtil.simpleVulnerabilities(device)
                            }
                            found.add(device)
                        }
                    } finally {
                        val n = done.incrementAndGet()
                        if (!json && (n % 50 == 0 || n == hosts.size)) {
                            Console.out.print("\rProgress: $n/${hosts.size}  found: ${found.size}   ")
                        }
                    }
                }
            }
            pool.shutdown()
            pool.awaitTermination(5, TimeUnit.MINUTES)
        } finally {
            pool.shutdownNow()
        }

        if (!json) {
            Console.out.println()
        }

        val sorted = found.sortedBy { it["ip"]?.toString() ?: "" }
        if (json) {
            CliJson.print(mapOf("cidr" to resolvedCidr, "devices" to sorted, "count" to sorted.size))
        } else {
            if (sorted.isEmpty()) {
                Console.out.println("No responding hosts.")
            } else {
                CliTable.print(
                    listOf("IP", "HOSTNAME", "MAC", if (probePorts) "OPEN PORTS" else "STATUS"),
                    sorted.map { d ->
                        listOf(
                            d["ip"]?.toString() ?: "",
                            d["hostname"]?.toString()?.takeIf { it.isNotBlank() } ?: "-",
                            d["mac"]?.toString()?.takeIf { it.isNotBlank() } ?: "-",
                            if (probePorts) {
                                @Suppress("UNCHECKED_CAST")
                                (d["openPorts"] as? List<*>)?.joinToString(",") ?: "-"
                            } else {
                                d["status"]?.toString() ?: "online"
                            }
                        )
                    }
                )
                Console.out.println("${sorted.size} device(s) responding.")
            }
        }
        return 0
    }
}

@Command(name = "devices", description = ["List devices from the ARP cache (no ping sweep)"])
class LocalNetworkDevicesCommand : Callable<Int> {

    @Option(names = ["--json"], description = ["JSON output"])
    var json: Boolean = false

    override fun call(): Int {
        val entries = NetworkScanUtil.parseArpTable()
        if (entries.isEmpty()) {
            Console.err.println("[!] No ARP entries (or arp command unavailable).")
            return 1
        }
        if (json) {
            CliJson.print(mapOf("devices" to entries, "count" to entries.size))
        } else {
            CliTable.print(
                listOf("IP", "MAC", "TYPE"),
                entries.map { listOf(it["ip"]?.toString() ?: "", it["mac"]?.toString() ?: "", it["type"]?.toString() ?: "") }
            )
            Console.out.println("${entries.size} ARP entry(ies).")
        }
        return 0
    }
}

@Command(name = "whois", description = ["Lookup public IP information (private IPs are identified as RFC1918)"])
class LocalNetworkWhoisCommand : Callable<Int> {

    @Parameters(index = "0", description = ["IPv4 address"])
    lateinit var ip: String

    @Option(names = ["--json"], description = ["JSON output"])
    var json: Boolean = false

    override fun call(): Int {
        val trimmed = ip.trim()
        if (!NetworkScanUtil.isValidIpv4(trimmed)) {
            Console.err.println("[!] Invalid IPv4: $trimmed")
            return 1
        }
        if (NetworkScanUtil.isPrivateIp(trimmed)) {
            val msg = mapOf(
                "ip" to trimmed,
                "private" to true,
                "message" to "RFC1918 private address — no public WHOIS"
            )
            if (json) CliJson.print(msg) else Console.out.println("${msg["ip"]}: private LAN address (RFC1918)")
            return 0
        }
        return try {
            val info = NetworkScanUtil.lookupPublicIp(trimmed)
            if (json) {
                CliJson.print(info)
            } else {
                info.forEach { (k, v) -> if (v != null && v.toString().isNotBlank()) Console.out.println("$k: $v") }
            }
            0
        } catch (e: Exception) {
            Console.err.println("[!] Lookup failed: ${e.message}")
            1
        }
    }
}

@Command(name = "subnet", description = ["Show subnet information"])
class LocalNetworkSubnetCommand : Callable<Int> {

    @Parameters(index = "0", arity = "0..1", description = ["CIDR (default: auto-detected /24)"])
    var cidr: String? = null

    @Option(names = ["--json"], description = ["JSON output"])
    var json: Boolean = false

    override fun call(): Int {
        val resolved = cidr?.trim()?.takeIf { it.isNotEmpty() }
            ?: NetworkScanUtil.detectLocalCidr24()
            ?: run {
                Console.err.println("[!] Could not detect local network. Pass a CIDR, e.g. 192.168.1.0/24")
                return 1
            }
        val info = NetworkScanUtil.describeCidr(resolved)
        if (json) {
            CliJson.print(info)
        } else {
            info.forEach { (k, v) -> Console.out.println("$k: $v") }
        }
        return 0
    }
}
