package com.pattool.frontend;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.TransportInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.telephony.CellInfo;
import android.telephony.CellSignalStrength;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import androidx.core.content.ContextCompat;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Signal bars of the network that currently carries traffic on the phone,
 * with the network name when Android will share it. Wi-Fi uses the access-point
 * name. Mobile data uses the operator name. 0 is no signal, 4 is full.
 */
final class MobileReception {

    private static final int TEXT_LIMIT = 512;
    private static final int NAME_LIMIT = 24;
    /** Matches both {@code (3/4)} and {@code (Orange 3/4)} at the end of a station line. */
    private static final Pattern SUFFIX = Pattern.compile("\\s*\\((?:[^()]{1,32} )?[0-4]/4\\)\\s*$");

    private MobileReception() {}

    /**
     * Text inside the parentheses, such as {@code Orange 3/4} or {@code 3/4}.
     * Empty when the signal cannot be read.
     */
    static String mark(Context context) {
        try {
            return format(read(context));
        } catch (RuntimeException ex) {
            return "";
        }
    }

    /**
     * Appends {@code (Orange 3/4)} after the station text. A previous mark is replaced,
     * so a later reading can change the name or the bars without stacking them.
     */
    static String decorate(String text, String mark) {
        String base = strip(text);
        if (mark == null || mark.isEmpty()) {
            return base;
        }
        String suffix = " (" + mark + ")";
        base = trimEnd(base);
        int room = TEXT_LIMIT - suffix.length();
        if (room < 1) {
            return suffix.trim();
        }
        if (base.length() > room) {
            base = trimEnd(base.substring(0, room));
        }
        if (base.isEmpty()) {
            return suffix.trim();
        }
        return base + suffix;
    }

    private static String format(Reading reading) {
        if (reading.level < 0 || reading.level > 4) {
            return "";
        }
        String name = sanitize(reading.name);
        if (name.isEmpty()) {
            return reading.level + "/4";
        }
        return name + " " + reading.level + "/4";
    }

    private static Reading read(Context context) {
        ConnectivityManager connectivity =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivity == null) {
            return Reading.UNKNOWN;
        }
        Network network = connectivity.getActiveNetwork();
        if (network == null) {
            return new Reading(0, "");
        }
        NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
        if (caps == null) {
            return Reading.UNKNOWN;
        }
        boolean wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        boolean cell = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
        if (wifi && !cell) {
            int rssi = wifiRssi(caps, context);
            if (rssi == Reading.UNKNOWN_LEVEL) {
                return Reading.UNKNOWN;
            }
            return new Reading(wifiBars(rssi), wifiName(caps, context));
        }
        if (cell) {
            int level = cellLevel(caps, context);
            if (level == Reading.UNKNOWN_LEVEL) {
                return Reading.UNKNOWN;
            }
            return new Reading(level, operatorName(context));
        }
        int dbm = signalDbm(caps, -140);
        if (dbm != Reading.UNKNOWN_LEVEL) {
            String name = operatorName(context);
            if (name.isEmpty()) {
                name = wifiName(caps, context);
            }
            return new Reading(cellBars(dbm), name);
        }
        int rssi = wifiRssi(caps, context);
        if (rssi != Reading.UNKNOWN_LEVEL) {
            return new Reading(wifiBars(rssi), wifiName(caps, context));
        }
        int bars = registeredCellLevel(context);
        if (bars == Reading.UNKNOWN_LEVEL) {
            return Reading.UNKNOWN;
        }
        return new Reading(bars, operatorName(context));
    }

    /** Same steps as the Wi-Fi status icon: -100 dBm is empty, -55 dBm is full. */
    private static int wifiBars(int rssi) {
        if (rssi <= -100) {
            return 0;
        }
        if (rssi >= -55) {
            return 4;
        }
        return (int) ((rssi + 100) * 4f / 45f);
    }

    /** LTE-style bars. Used when the status-bar level itself cannot be read. */
    private static int cellBars(int dbm) {
        if (dbm >= -85) {
            return 4;
        }
        if (dbm >= -95) {
            return 3;
        }
        if (dbm >= -105) {
            return 2;
        }
        if (dbm >= -115) {
            return 1;
        }
        return 0;
    }

    private static int cellLevel(NetworkCapabilities caps, Context context) {
        int dbm = signalDbm(caps, -140);
        if (dbm != Reading.UNKNOWN_LEVEL) {
            return cellBars(dbm);
        }
        return registeredCellLevel(context);
    }

    private static int wifiRssi(NetworkCapabilities caps, Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && caps != null) {
            TransportInfo info = caps.getTransportInfo();
            if (info instanceof WifiInfo) {
                int rssi = ((WifiInfo) info).getRssi();
                if (plausible(rssi)) {
                    return rssi;
                }
            }
        }
        int fromCaps = signalDbm(caps, -126);
        if (fromCaps != Reading.UNKNOWN_LEVEL) {
            return fromCaps;
        }
        return legacyWifiRssi(context);
    }

    @SuppressWarnings("deprecation")
    private static int legacyWifiRssi(Context context) {
        WifiInfo info = legacyWifiInfo(context);
        if (info == null) {
            return Reading.UNKNOWN_LEVEL;
        }
        int rssi = info.getRssi();
        return plausible(rssi) ? rssi : Reading.UNKNOWN_LEVEL;
    }

    private static String wifiName(NetworkCapabilities caps, Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && caps != null) {
            TransportInfo info = caps.getTransportInfo();
            if (info instanceof WifiInfo) {
                String ssid = cleanSsid(((WifiInfo) info).getSSID());
                if (!ssid.isEmpty()) {
                    return ssid;
                }
            }
        }
        WifiInfo info = legacyWifiInfo(context);
        return info == null ? "" : cleanSsid(info.getSSID());
    }

    @SuppressWarnings("deprecation")
    private static WifiInfo legacyWifiInfo(Context context) {
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi == null) {
            return null;
        }
        try {
            return wifi.getConnectionInfo();
        } catch (SecurityException ex) {
            return null;
        }
    }

    private static String cleanSsid(String raw) {
        if (raw == null) {
            return "";
        }
        String ssid = raw.trim();
        if (ssid.length() >= 2 && ssid.charAt(0) == '"' && ssid.charAt(ssid.length() - 1) == '"') {
            ssid = ssid.substring(1, ssid.length() - 1).trim();
        }
        if (ssid.isEmpty()
                || "<unknown ssid>".equalsIgnoreCase(ssid)
                || "0x".equalsIgnoreCase(ssid)) {
            return "";
        }
        return sanitize(ssid);
    }

    private static String operatorName(Context context) {
        TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
        if (telephony == null) {
            return "";
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                int subId = SubscriptionManager.getDefaultDataSubscriptionId();
                if (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
                    TelephonyManager data = telephony.createForSubscriptionId(subId);
                    if (data != null) {
                        telephony = data;
                    }
                }
            }
            String name = telephony.getNetworkOperatorName();
            if (name == null || name.trim().isEmpty()) {
                name = telephony.getSimOperatorName();
            }
            return sanitize(name);
        } catch (SecurityException ex) {
            return "";
        }
    }

    private static int signalDbm(NetworkCapabilities caps, int floor) {
        if (caps == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return Reading.UNKNOWN_LEVEL;
        }
        int dbm = caps.getSignalStrength();
        if (dbm == NetworkCapabilities.SIGNAL_STRENGTH_UNSPECIFIED || dbm > -30 || dbm < floor) {
            return Reading.UNKNOWN_LEVEL;
        }
        return dbm;
    }

    /** -127 dBm is the Wi-Fi marker for an unknown reading, not an empty bar. */
    private static boolean plausible(int dbm) {
        return dbm <= -30 && dbm >= -126;
    }

    private static int registeredCellLevel(Context context) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            return Reading.UNKNOWN_LEVEL;
        }
        TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
        if (telephony == null) {
            return Reading.UNKNOWN_LEVEL;
        }
        List<CellInfo> cells;
        try {
            cells = telephony.getAllCellInfo();
        } catch (SecurityException ex) {
            return Reading.UNKNOWN_LEVEL;
        }
        if (cells == null) {
            return Reading.UNKNOWN_LEVEL;
        }
        int best = Reading.UNKNOWN_LEVEL;
        for (CellInfo info : cells) {
            if (info == null || !info.isRegistered()) {
                continue;
            }
            CellSignalStrength strength = info.getCellSignalStrength();
            if (strength == null) {
                continue;
            }
            int level = strength.getLevel();
            if (level >= 0 && level <= 4 && level > best) {
                best = level;
            }
        }
        return best;
    }

    /** Drops parentheses so the station suffix can be recognized later, and keeps the name short. */
    private static String sanitize(String raw) {
        if (raw == null || raw.isEmpty()) {
            return "";
        }
        StringBuilder out = new StringBuilder(Math.min(raw.length(), NAME_LIMIT));
        boolean pendingSpace = false;
        for (int i = 0; i < raw.length() && out.length() < NAME_LIMIT; i++) {
            char c = raw.charAt(i);
            if (c == '(' || c == ')' || c == '"' || c < 0x20) {
                c = ' ';
            }
            if (c == ' ') {
                pendingSpace = out.length() > 0;
                continue;
            }
            if (pendingSpace) {
                if (out.length() >= NAME_LIMIT - 1) {
                    break;
                }
                out.append(' ');
                pendingSpace = false;
            }
            out.append(c);
        }
        if (out.length() > 0 && Character.isHighSurrogate(out.charAt(out.length() - 1))) {
            out.setLength(out.length() - 1);
        }
        return out.toString();
    }

    private static String strip(String text) {
        if (text == null || text.isEmpty()) {
            return "";
        }
        return SUFFIX.matcher(text).replaceFirst("");
    }

    private static String trimEnd(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == ' ') {
            end--;
        }
        return end == value.length() ? value : value.substring(0, end);
    }

    private static final class Reading {
        static final int UNKNOWN_LEVEL = -1;
        static final Reading UNKNOWN = new Reading(UNKNOWN_LEVEL, "");

        final int level;
        final String name;

        Reading(int level, String name) {
            this.level = level;
            this.name = name == null ? "" : name;
        }
    }
}
