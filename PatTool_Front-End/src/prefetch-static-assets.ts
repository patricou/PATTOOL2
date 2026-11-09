import { environment } from './environments/environment';

function i18nJsonUrls(): string[] {
  return environment.langs.map((lang) => `assets/i18n/${lang}.json`);
}

/**
 * Ressources statiques servies sans JWT (hors /api). À garder aligné avec ce qui existe sous {@code src/assets}.
 */
export function buildPatPrefetchUrlList(): readonly string[] {
  return [
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

let prefetchPatStaticAssetsDone = false;

/**
 * Remplit le cache HTTP via {@code fetch()} uniquement — pas de {@code <link rel="preload">} ici :
 * {@code as="video"} est mal supporté ; {@code as="fetch"} + {@code crossorigin} doit coller exactement
 * au mode du consommateur (ex. HttpClient), sinon Chrome avertit que le preload n’est pas utilisé.
 */
export function prefetchPatStaticAssets(): void {
  if (prefetchPatStaticAssetsDone || typeof fetch === 'undefined') {
    return;
  }
  prefetchPatStaticAssetsDone = true;

  for (const url of buildPatPrefetchUrlList()) {
    void fetch(url, {
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'default',
    }).catch(() => {});
  }
}
