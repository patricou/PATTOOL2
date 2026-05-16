/** Rows shown in Wi‑Fi modals — backend BSSIDs or native-phone scan mappings. */
export interface VisibleWifiPayload {
  ssid: string;
  bssid?: string | null;
  signalPercent?: number | null;
  authentication?: string | null;
  signalDbm?: number | null;
}
