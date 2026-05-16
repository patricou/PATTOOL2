import { Injectable } from '@angular/core';

import type { VisibleWifiPayload } from '../model/wifi-visible.types';
import type { Network } from '@capgo/capacitor-wifi';

export type PhoneWifiFrontendMode = 'web_network_info' | 'capacitor_android' | 'capacitor_ios_single';

/** Outcome when not using backend PatTool — native shell vs plain browser NI API */
export interface PhoneWifiScanOutcome {
  mode: PhoneWifiFrontendMode;
  networks: VisibleWifiPayload[];
  message?: string;
}

@Injectable({
  providedIn: 'root',
})
export class CapacitorWifiScanService {
  private static rssiApproxPercent(rssiDbm: number): number | null {
    const p = Math.round(((rssiDbm + 100) / 70) * 100);
    return Math.max(0, Math.min(100, p));
  }

  /**
   * When running inside a Capacitor native wrapper, enumerate Wi‑Fi (Android scan) or approximate (iOS current AP).
   * Otherwise `{ mode:'web_network_info' }` with empty arrays so UI can fall back to Network Information API.
   */
  async scanFromNativeShellIfApplicable(): Promise<PhoneWifiScanOutcome> {
    const { Capacitor } = await import('@capacitor/core');

    if (!Capacitor.isNativePlatform()) {
      return { mode: 'web_network_info', networks: [], message: 'not_native' };
    }

    const platform = Capacitor.getPlatform();

    if (platform === 'android') {
      return await this.scanAndroid();
    }

    if (platform === 'ios') {
      return await this.scanIosApproximate();
    }

    return { mode: 'web_network_info', networks: [], message: 'unsupported_native_platform' };
  }

  private async scanIosApproximate(): Promise<PhoneWifiScanOutcome> {
    const { CapacitorWifi } = await import('@capgo/capacitor-wifi');
    try {
      const status = await CapacitorWifi.requestPermissions({ permissions: ['location'] });
      if (status.location !== 'granted') {
        return {
          mode: 'capacitor_ios_single',
          networks: [],
          message: 'permission_denied',
        };
      }
      const info = await CapacitorWifi.getWifiInfo();
      const row: VisibleWifiPayload = {
        ssid: info.ssid?.trim()?.length ? info.ssid : '(current)',
        bssid: info.bssid ?? null,
        signalPercent: info.signalStrength != null ? Math.round(Number(info.signalStrength)) : null,
        signalDbm: null,
        authentication: null,
      };
      const hasUseful = row.ssid !== '(current)' || !!row.bssid || row.signalPercent != null;
      return {
        mode: 'capacitor_ios_single',
        networks: hasUseful ? [row] : [],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { mode: 'capacitor_ios_single', networks: [], message: msg };
    }
  }

  private async scanAndroid(): Promise<PhoneWifiScanOutcome> {
    const { CapacitorWifi, NetworkSecurityType } = await import('@capgo/capacitor-wifi');

    try {
      const perm = await CapacitorWifi.requestPermissions({ permissions: ['location'] });
      if (perm.location !== 'granted') {
        return {
          mode: 'capacitor_android',
          networks: [],
          message: 'permission_denied',
        };
      }

      await CapacitorWifi.removeAllListeners();
      await CapacitorWifi.startScan();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { mode: 'capacitor_android', networks: [], message: msg };
    }

    const rawNetworks = await this.pollAndroidNetworks();
    const mapped = rawNetworks.map((n) => CapacitorWifiScanService.networkToPayload(n, NetworkSecurityType));

    try {
      const { CapacitorWifi } = await import('@capgo/capacitor-wifi');
      await CapacitorWifi.removeAllListeners();
    } catch {
      // ignore
    }

    return {
      mode: 'capacitor_android',
      networks: mapped,
      message: mapped.length === 0 ? 'scan_empty_or_throttled' : undefined,
    };
  }

  private async pollAndroidNetworks(): Promise<Network[]> {
    const { CapacitorWifi } = await import('@capgo/capacitor-wifi');
    let best: Network[] = [];

    for (let i = 0; i < 28; i++) {
      await CapacitorWifiScanService.sleep(250);
      try {
        const { networks } = await CapacitorWifi.getAvailableNetworks();
        if (networks.length > best.length) {
          best = networks;
        }
        if (networks.length > 0 && i >= 5) {
          break;
        }
      } catch {
        /* Android may throttle successive scans */
      }
    }

    const bySsid = new Map<string, Network>();
    for (const net of best) {
      const key = (net.ssid || '').trim() || `(hidden:${bySsid.size})`;
      const prev = bySsid.get(key);
      if (!prev || net.rssi > prev.rssi) {
        bySsid.set(key, net);
      }
    }
    const dedup = [...bySsid.values()].sort((a, b) => b.rssi - a.rssi);
    return dedup;
  }

  private static async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private static networkToPayload(
    n: Network,
    NetSec: typeof import('@capgo/capacitor-wifi').NetworkSecurityType,
  ): VisibleWifiPayload {
    const ssidRaw = n.ssid;
    const ssid = ssidRaw?.trim()?.length ? ssidRaw : '(hidden)';
    const rssiDbm = Number(n.rssi);
    const pct = CapacitorWifiScanService.rssiApproxPercent(rssiDbm);
    const secMap = NetSec as unknown as Record<number, string>;

    const authentication =
      n.securityTypes && n.securityTypes.length > 0
        ? n.securityTypes
            .map((v) => (typeof v === 'number' && secMap[v] ? secMap[v] : String(v)))
            .join(', ')
        : null;

    return {
      ssid,
      bssid: null,
      signalPercent: pct,
      signalDbm: Number.isFinite(rssiDbm) ? Math.round(rssiDbm) : null,
      authentication,
    };
  }
}
