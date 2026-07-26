import { TvChannel } from '../services/api.service';

/**
 * Map known FTA channels to backend virtual live URLs
 * (france.tv / TF1 / Canal / Radio France / M6 group mirrors).
 */
export function resolveTvStreamUrl(channel: TvChannel | null | undefined): string {
  // Share links use scheme~id (WhatsApp-safe); always restore scheme: before play/proxy.
  const existing = decodeShareStreamToken(channel?.streamUrl || '');
  const lower = existing.toLowerCase();
  if (lower.startsWith('francetv:') || lower.startsWith('tf1:')
      || lower.startsWith('canalgroup:') || lower.startsWith('radiofrance:')
      || lower.startsWith('m6group:') || lower.startsWith('arte:')
      || lower.startsWith('ia:')) {
    return existing;
  }
  const id = (channel?.id || '').toLowerCase();
  const name = (channel?.name || '').toLowerCase();
  if (id.startsWith('france2.fr') || /^france\s*2\b/.test(name)) {
    return 'francetv:france-2';
  }
  if ((id.startsWith('france3.fr') && !id.includes('24'))
      || (/^france\s*3\b/.test(name) && !name.includes('24'))) {
    return 'francetv:france-3';
  }
  if (id.startsWith('france4.fr') || /^france\s*4\b/.test(name)) {
    return 'francetv:france-4';
  }
  if (id.startsWith('france5.fr') || /^france\s*5\b/.test(name)) {
    return 'francetv:france-5';
  }
  if (id.startsWith('franceinfo.fr') || id.includes('franceinfo')
      || /france\s*info\b/.test(name) || name.includes('franceinfo')) {
    return 'francetv:franceinfo';
  }
  if (id.startsWith('franceinter.fr') || id.includes('franceinter')
      || /france\s*inter\b/.test(name) || name.includes('franceinter')) {
    return 'radiofrance:franceinter';
  }
  if (id.startsWith('tf1.fr') || (/^tf1\b/.test(name) && !name.includes('series') && !name.includes('info'))) {
    return 'tf1:tf1';
  }
  if (id.startsWith('tmc.fr') || /^tmc\b/.test(name)) {
    return 'tf1:tmc';
  }
  if (id.startsWith('tfx.fr') || /^tfx\b/.test(name)) {
    return 'tf1:tfx';
  }
  if (id.startsWith('lci.fr') || /^lci\b/.test(name) || name.includes('tf1 info')) {
    return 'tf1:lci';
  }
  if (id.startsWith('cnews.fr') || /^c\s*news\b/.test(name) || name === 'cnews') {
    return 'canalgroup:cnews';
  }
  if (id.startsWith('cstar.fr') || /^c\s*star\b/.test(name) || name === 'cstar') {
    return 'canalgroup:cstar';
  }
  if (id.startsWith('m6music.fr') || name.includes('m6 music')) {
    return existing;
  }
  if (id.startsWith('m6.fr') || (/^m6\b/.test(name) && !name.includes('music'))) {
    return 'm6group:m6';
  }
  if (id.startsWith('w9.fr') || /^w9\b/.test(name)) {
    return 'm6group:w9';
  }
  if (id.startsWith('6ter.fr') || /^6\s*ter\b/.test(name) || name === '6ter') {
    return 'm6group:6ter';
  }
  if (id.startsWith('gulli.fr') || /^gulli\b/.test(name)) {
    return 'm6group:gulli';
  }
  return existing;
}

export function isFranceTvVirtual(url: string): boolean {
  return (url || '').toLowerCase().startsWith('francetv:');
}

export function isTf1Virtual(url: string): boolean {
  return (url || '').toLowerCase().startsWith('tf1:');
}

export function isCanalGroupVirtual(url: string): boolean {
  return (url || '').toLowerCase().startsWith('canalgroup:');
}

export function isRadioFranceVirtual(url: string): boolean {
  return (url || '').toLowerCase().startsWith('radiofrance:');
}

export function isM6GroupVirtual(url: string): boolean {
  return (url || '').toLowerCase().startsWith('m6group:');
}

export function isArteVirtual(url: string): boolean {
  return decodeShareStreamToken(url || '').toLowerCase().startsWith('arte:');
}

export function isInternetArchiveVirtual(url: string): boolean {
  return decodeShareStreamToken(url || '').toLowerCase().startsWith('ia:');
}

export function isArteLiveVirtual(url: string): boolean {
  const id = arteProgramIdFromVirtualUrl(url);
  return !!id && id.toUpperCase() === 'LIVE';
}

/** Finite ARTE replay (not the live channel) — use VOD HLS config, no live-edge seek. */
export function isArteReplayVod(url: string): boolean {
  return isArteVirtual(url) && !isArteLiveVirtual(url);
}

/** Progressive MP4/WebM VOD (Internet Archive) — use video.src, not hls.js. */
export function isProgressiveVod(url: string): boolean {
  if (isInternetArchiveVirtual(url)) {
    return true;
  }
  const lower = (url || '').toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }
  if (lower.includes('.m3u8') || lower.includes('/manifest') || lower.includes('.mpd')) {
    return false;
  }
  return lower.includes('.mp4') || lower.includes('.webm') || lower.includes('.ogv')
    || lower.includes('archive.org/download/');
}

/** True when playback uses a backend virtual live URL that needs periodic re-resolve. */
export function isKeepAliveVirtualLive(url: string): boolean {
  return isFranceTvVirtual(url) || isTf1Virtual(url) || isM6GroupVirtual(url);
}

export function arteProgramIdFromVirtualUrl(url: string): string | null {
  const raw = decodeShareStreamToken(url || '').trim();
  if (!raw.toLowerCase().startsWith('arte:')) {
    return null;
  }
  const id = raw.slice('arte:'.length).trim();
  return id || null;
}

export function internetArchiveIdFromVirtualUrl(url: string): string | null {
  const raw = (url || '').trim();
  if (!raw.toLowerCase().startsWith('ia:')) {
    return null;
  }
  const id = raw.slice('ia:'.length).trim();
  return id || null;
}

export function franceTvSlugFromVirtualUrl(url: string): string | null {
  const lower = (url || '').trim().toLowerCase();
  if (!lower.startsWith('francetv:')) {
    return null;
  }
  const slug = lower.slice('francetv:'.length).trim();
  return slug || null;
}

export function tf1SlugFromVirtual(url: string): string | null {
  const lower = (url || '').trim().toLowerCase();
  if (!lower.startsWith('tf1:')) {
    return null;
  }
  const slug = lower.slice('tf1:'.length).trim();
  return slug || null;
}

export function m6GroupSlugFromVirtual(url: string): string | null {
  const lower = (url || '').trim().toLowerCase();
  if (!lower.startsWith('m6group:')) {
    return null;
  }
  const slug = lower.slice('m6group:'.length).trim();
  return slug || null;
}

/** Virtual live / VOD schemes used in PatTool stream tokens. */
const VIRTUAL_STREAM_SCHEMES =
  'francetv|tf1|canalgroup|radiofrance|m6group|arte|ia';

/**
 * WhatsApp (and some messengers) truncate auto-linked URLs when a bare
 * {@code scheme:} appears inside the query (e.g. {@code ?s=arte:123}). Replace the
 * first colon with {@code ~} for share links.
 */
export function encodeShareStreamToken(stream: string): string {
  const s = (stream || '').trim();
  if (!s) {
    return '';
  }
  const re = new RegExp(`^(${VIRTUAL_STREAM_SCHEMES}):`, 'i');
  return s.replace(re, '$1~');
}

/** Inverse of {@link encodeShareStreamToken}; also accepts already-raw {@code arte:…} tokens. */
export function decodeShareStreamToken(stream: string): string {
  let s = (stream || '').trim();
  if (!s) {
    return '';
  }
  try {
    // Some messengers leave a once-encoded tilde (%7E) in the value.
    if (/%7e/i.test(s) || /%3a/i.test(s)) {
      s = decodeURIComponent(s);
    }
  } catch {
    /* keep raw */
  }
  const re = new RegExp(`^(${VIRTUAL_STREAM_SCHEMES})[~:](.+)$`, 'i');
  const m = s.match(re);
  if (m) {
    return `${m[1].toLowerCase()}:${m[2]}`;
  }
  return s;
}

/**
 * Rebuild a virtual stream URL from a share channel id when {@code s=} was truncated
 * (e.g. {@code arte-134388-000-A} → {@code arte:134388-000-A}).
 */
export function virtualStreamFromShareChannelId(channelId: string): string {
  const id = (channelId || '').trim();
  if (!id) {
    return '';
  }
  const m = id.match(/^(arte|ia)[-_~:](.+)$/i);
  if (!m) {
    return '';
  }
  return decodeShareStreamToken(`${m[1].toLowerCase()}:${m[2]}`);
}

/** True when the token is a short non-http virtual stream safe for share query params. */
export function isShareSafeStreamToken(stream: string, maxLen = 160): boolean {
  const s = (stream || '').trim();
  if (!s || s.length > maxLen) {
    return false;
  }
  if (/^https?:\/\//i.test(s) || /:\/\//.test(s)) {
    return false;
  }
  if (/%3A%2F%2F/i.test(s) || /https?%3A/i.test(s)) {
    return false;
  }
  return true;
}

/**
 * Encode channel id / name for share query params.
 * Messengers often decode {@code %23} back to {@code #} and then truncate the URL
 * (iptv-org ids like {@code arte.fr@SD#13}). Map {@code #}/{@code @} to safe tokens.
 */
export function encodeShareQueryValue(value: string): string {
  return (value || '')
    .replace(/~/g, '~~')
    .replace(/#/g, '~h~')
    .replace(/@/g, '~a~');
}

/** Inverse of {@link encodeShareQueryValue}. */
export function decodeShareQueryValue(value: string): string {
  const s = value || '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('~h~', i)) {
      out += '#';
      i += 2;
    } else if (s.startsWith('~a~', i)) {
      out += '@';
      i += 2;
    } else if (s.startsWith('~~', i)) {
      out += '~';
      i += 1;
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}
