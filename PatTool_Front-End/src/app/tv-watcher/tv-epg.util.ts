import { TvChannel } from '../services/api.service';

const VIRTUAL_EPG_IDS: Record<string, string> = {
  'francetv:france-2': 'France2.fr',
  'francetv:france-3': 'France3.fr',
  'francetv:france-4': 'France4.fr',
  'francetv:france-5': 'France5.fr',
  'francetv:franceinfo': 'franceinfo:.fr',
  'tf1:tf1': 'TF1.fr',
  'tf1:tmc': 'TMC.fr',
  'tf1:tfx': 'TFX.fr',
  'tf1:lci': 'LCI.fr',
  'canalgroup:cnews': 'CNews.fr',
  'canalgroup:cstar': 'CStar.fr',
  'radiofrance:franceinter': 'FranceInter.fr',
  'm6group:m6': 'M6.fr',
  'm6group:w9': 'W9.fr',
  'm6group:6ter': '6ter.fr',
  'm6group:gulli': 'Gulli.fr'
};

/** Map a catalog channel to its XMLTV / iptv-epg.org channel id. */
export function resolveEpgChannelId(channel: TvChannel | null | undefined): string | null {
  if (!channel) {
    return null;
  }
  const stream = (channel.streamUrl || '').trim().toLowerCase();
  if (VIRTUAL_EPG_IDS[stream]) {
    return VIRTUAL_EPG_IDS[stream];
  }
  const id = (channel.id || '').trim();
  const lower = id.toLowerCase();
  const prefixes: Array<[string, string]> = [
    ['francetv-', 'francetv:'],
    ['tf1-', 'tf1:'],
    ['canalgroup-', 'canalgroup:'],
    ['radiofrance-', 'radiofrance:'],
    ['m6group-', 'm6group:']
  ];
  for (const [prefix, scheme] of prefixes) {
    if (lower.startsWith(prefix)) {
      const mapped = VIRTUAL_EPG_IDS[scheme + lower.slice(prefix.length)];
      if (mapped) {
        return mapped;
      }
    }
  }
  let base = id.includes('#') ? id.slice(0, id.indexOf('#')) : id;
  const at = base.indexOf('@');
  if (at > 0) {
    base = base.slice(0, at);
  }
  if (base.includes('.') && base.length >= 3) {
    return base;
  }
  return null;
}

export function epgLookupKey(epgId: string | null | undefined): string {
  return (epgId || '').trim().toLowerCase();
}
