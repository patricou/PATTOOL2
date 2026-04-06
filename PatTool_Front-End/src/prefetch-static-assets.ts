import { environment } from './environments/environment';

export const PAT_HOME_VIDEO_DESKTOP = 'assets/video/auroreboreale.mp4';
export const PAT_HOME_VIDEO_MOBILE =
  'assets/video/240_F_554249302_yxUSqtMZs3HPEjrGEHLGCU5rMXgtPOHD_ST.mp4';

/**
 * Déjà présents en {@code <link rel="preload">} dans index.html : on ne recrée pas le tag, mais on garde le fetch() pour le cache.
 */
const INDEX_HTML_PRELOAD_URLS = new Set<string>([
  PAT_HOME_VIDEO_DESKTOP,
  PAT_HOME_VIDEO_MOBILE,
  'assets/images/pat.png',
  'manifest.webmanifest',
]);

function i18nJsonUrls(): string[] {
  return environment.langs.map((lang) => `assets/i18n/${lang}.json`);
}

/**
 * Ressources statiques servies sans JWT (hors /api). À garder aligné avec ce qui existe sous {@code src/assets}.
 */
export function buildPatPrefetchUrlList(): readonly string[] {
  return [
    PAT_HOME_VIDEO_DESKTOP,
    PAT_HOME_VIDEO_MOBILE,
    ...i18nJsonUrls(),
    'assets/images/pat.png',
    'manifest.webmanifest',
    'assets/leaflet/leaflet.css',
    'assets/ffmpeg-worker.js',
    'assets/ffmpeg-errors.js',
    'assets/ffmpeg-const.js',
    'robots.txt',
    '.well-known/security.txt',
  ];
}

function preloadAs(url: string): 'video' | 'image' | 'script' | 'style' | 'fetch' {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.ogv')) {
    return 'video';
  }
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(path)) {
    return 'image';
  }
  if (path.endsWith('.js')) {
    return 'script';
  }
  if (path.endsWith('.css')) {
    return 'style';
  }
  return 'fetch';
}

let prefetchPatStaticAssetsDone = false;

/**
 * Pour chaque URL : {@code <link rel="preload">} (sauf doublons index.html) + {@code fetch()} pour remplir le cache HTTP.
 */
export function prefetchPatStaticAssets(): void {
  if (prefetchPatStaticAssetsDone || typeof document === 'undefined' || typeof fetch === 'undefined') {
    return;
  }
  prefetchPatStaticAssetsDone = true;

  for (const url of buildPatPrefetchUrlList()) {
    const as = preloadAs(url);
    if (!INDEX_HTML_PRELOAD_URLS.has(url)) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.href = url;
      link.as = as;
      if (as === 'video' && url.toLowerCase().endsWith('.mp4')) {
        link.type = 'video/mp4';
      }
      if (as === 'fetch') {
        link.crossOrigin = 'anonymous';
      }
      document.head.appendChild(link);
    }

    void fetch(url, {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'default',
    }).catch(() => {});
  }
}
