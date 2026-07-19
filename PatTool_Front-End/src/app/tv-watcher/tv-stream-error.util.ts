/**
 * Parse TV stream proxy / live API error payloads ({@code {error, message}}) so the UI
 * can show a specific backend / HLS cause instead of always falling back to TV.ERR_STREAM.
 */

export interface TvStreamApiError {
  error?: string;
  message?: string;
}

/** True when {@code value} is an ngx-translate key under {@code TV.*}. */
export function isTvI18nErrorKey(value: string | null | undefined): boolean {
  return !!value && /^TV\.[A-Z0-9_]+$/i.test(value.trim());
}

export function parseTvStreamErrorBody(body: string | null | undefined): string | null {
  if (!body) {
    return null;
  }
  const text = body.trim();
  if (!text) {
    return null;
  }
  try {
    const json = JSON.parse(text) as TvStreamApiError;
    const message = (json.message || '').trim();
    if (message) {
      return message;
    }
    const code = (json.error || '').trim();
    if (code) {
      return code;
    }
  } catch {
    /* not JSON */
  }
  // Avoid dumping large playlists / HTML into the banner.
  if (text.length <= 280 && !text.includes('#EXTM3U') && !text.includes('<html')) {
    return text;
  }
  return null;
}

function decodeResponseBody(raw: unknown): string {
  if (raw == null) {
    return '';
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    try {
      return new TextDecoder().decode(raw);
    } catch {
      return '';
    }
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw)) {
    try {
      return new TextDecoder().decode(raw as ArrayBufferView);
    } catch {
      return '';
    }
  }
  return '';
}

export type TvHlsErrorData = {
  response?: { code?: number; text?: string; data?: unknown; url?: string };
  details?: string;
  type?: string;
  error?: unknown;
  /** hls.js often puts the XHR here on network errors. */
  networkDetails?: { responseText?: string; status?: number; statusText?: string } | null;
} | null | undefined;

function bodyFromHlsData(data: TvHlsErrorData): string {
  const fromResp = decodeResponseBody(data?.response?.data);
  if (fromResp.trim()) {
    return fromResp;
  }
  const nd = data?.networkDetails;
  if (nd && typeof nd.responseText === 'string' && nd.responseText.trim()) {
    return nd.responseText;
  }
  return '';
}

function httpCodeFromHlsData(data: TvHlsErrorData): number | null {
  const code = data?.response?.code;
  if (typeof code === 'number' && code > 0) {
    return code;
  }
  const status = data?.networkDetails?.status;
  if (typeof status === 'number' && status > 0) {
    return status;
  }
  return null;
}

/**
 * Prefer JSON {@code message} from the HLS XHR / response body.
 */
export function extractTvStreamErrorFromHlsData(data: TvHlsErrorData): string | null {
  const fromBody = parseTvStreamErrorBody(bodyFromHlsData(data));
  if (fromBody) {
    return fromBody;
  }

  const err = data?.error;
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = String((err as { message?: unknown }).message || '').trim();
    // Skip noisy browser internals like "Failed to fetch" alone — classified below.
    if (msg && !/^failed to fetch$/i.test(msg) && !/^load failed$/i.test(msg)
        && !/^networkerror/i.test(msg)) {
      return msg;
    }
  }
  return null;
}

/**
 * Human-readable cause when the proxy returned a playlist (200) but HLS still failed,
 * or when only status / details are available.
 */
export function describeHlsFailure(data: TvHlsErrorData): string | null {
  if (!data) {
    return null;
  }
  const details = (data.details || '').toLowerCase();
  const type = (data.type || '').toLowerCase();
  const code = httpCodeFromHlsData(data);
  const statusText = (data.response?.text || data.networkDetails?.statusText || '').trim();

  const httpSuffix =
    typeof code === 'number' && code >= 400
      ? statusText
        ? ` (HTTP ${code} — ${statusText})`
        : ` (HTTP ${code})`
      : '';

  if (details.includes('manifest') || details.includes('levelLoad'.toLowerCase())
      || details.includes('multivariant')) {
    return typeof code === 'number' && code >= 400
      ? `Impossible de charger le manifeste HLS${httpSuffix}`
      : 'TV.ERR_MANIFEST';
  }
  if (details.includes('frag') || details.includes('segment') || details.includes('partLoad')) {
    return typeof code === 'number' && code >= 400
      ? `Segment vidéo inaccessible${httpSuffix}`
      : 'TV.ERR_SEGMENT';
  }
  if (details.includes('keyLoad') || details.includes('key')) {
    return 'TV.ERR_KEY';
  }
  if (details.includes('timeout')) {
    return 'TV.ERR_TIMEOUT';
  }
  if (type.includes('media') || details.includes('buffer') || details.includes('codec')
      || details.includes('demux') || details.includes('remux')) {
    return 'TV.ERR_MEDIA';
  }
  if (type.includes('network') || details.includes('load')) {
    return typeof code === 'number' && code >= 400
      ? `Flux inaccessible${httpSuffix}`
      : 'TV.ERR_NETWORK';
  }
  if (typeof code === 'number' && code >= 400) {
    return `Flux inaccessible${httpSuffix}`;
  }
  if (details && details.length <= 80) {
    return `Échec de lecture (${data.details})`;
  }
  return null;
}

/**
 * 1) Backend JSON message (re-fetch or HLS body)
 * 2) Specific HLS cause (manifest / segment / media / HTTP code)
 * 3) Generic offline key only as last resort
 */
export async function resolveTvStreamErrorMessage(
  proxyUrl: string,
  hlsData?: TvHlsErrorData
): Promise<string> {
  const fromHlsBody = extractTvStreamErrorFromHlsData(hlsData);
  if (fromHlsBody) {
    return fromHlsBody;
  }

  const fromFetch = await fetchTvStreamErrorMessage(proxyUrl);
  if (fromFetch) {
    return fromFetch;
  }

  const described = describeHlsFailure(hlsData);
  if (described) {
    return described;
  }

  return 'TV.ERR_STREAM';
}

/** Re-fetch the proxy URL to read a JSON error body (when HLS did not expose it). */
export async function fetchTvStreamErrorMessage(proxyUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(proxyUrl, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json, */*' }
    });
    const text = await resp.text();
    const trimmed = text.trim();
    // Successful playlist — not an API error message.
    if (resp.ok && (trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXTINF'))) {
      return null;
    }
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json') || trimmed.startsWith('{')) {
      const fromJson = parseTvStreamErrorBody(text);
      if (fromJson) {
        return fromJson;
      }
    }
    const fromBody = parseTvStreamErrorBody(text);
    if (fromBody) {
      return fromBody;
    }
    if (!resp.ok) {
      return `Flux inaccessible (HTTP ${resp.status}${resp.statusText ? ' — ' + resp.statusText : ''})`;
    }
  } catch {
    /* ignore — HLS details may still describe the failure */
  }
  return null;
}
