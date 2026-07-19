import { TvChannel } from '../services/api.service';

/**
 * Map known FTA channels to backend virtual live URLs (france.tv / TF1 / Canal / Radio France).
 */
export function resolveTvStreamUrl(channel: TvChannel | null | undefined): string {
  const existing = channel?.streamUrl || '';
  const lower = existing.toLowerCase();
  if (lower.startsWith('francetv:') || lower.startsWith('tf1:')
      || lower.startsWith('canalgroup:') || lower.startsWith('radiofrance:')) {
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
