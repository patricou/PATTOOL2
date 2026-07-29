import { environment } from '../../environments/environment';

/**
 * Build WhatsApp / messenger-safe PatTool deep links via static {@code *-link.html}
 * pages (no {@code #} in the shared URL). Optional {@code publicLink} swaps
 * localhost for {@link environment.sharePublicOrigin}.
 */

export function resolveShareOrigin(opts?: { publicLink?: boolean }): {
  origin: string;
  basePath: string;
} {
  const u = new URL(typeof window !== 'undefined' ? window.location.href : 'http://localhost');
  const host = (u.hostname || '').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const publicOrigin = ((environment as { sharePublicOrigin?: string }).sharePublicOrigin || '').replace(
    /\/$/,
    ''
  );
  const usePublic = !!opts?.publicLink && !!publicOrigin;
  const origin = usePublic ? publicOrigin : u.origin;

  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  const assetMarker = '/assets/';
  const atAsset = path.indexOf(assetMarker);
  let basePath: string;
  if (atAsset >= 0) {
    basePath = path.substring(0, atAsset);
  } else if (path === '/') {
    basePath = '';
  } else if (path.endsWith('/index.html')) {
    basePath = path.slice(0, -'/index.html'.length);
    if (basePath === '/') {
      basePath = '';
    }
  } else if (isLocal && usePublic) {
    basePath = '';
  } else {
    // Hash-routed SPA: pathname is the deploy base (e.g. /pattool), not the Angular route.
    basePath = path;
  }

  return { origin, basePath };
}

/** Prefer %20 over + — some messengers stop linkifying at +. */
function qsPreferPercent20(params: URLSearchParams): string {
  return params.toString().replace(/\+/g, '%20');
}

export function buildAssetShareLink(
  assetFile: string,
  query: Record<string, string | undefined | null>,
  opts?: { publicLink?: boolean }
): string {
  const { origin, basePath } = resolveShareOrigin(opts);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    const t = (v ?? '').trim();
    if (t) {
      params.set(k, t);
    }
  }
  const qs = qsPreferPercent20(params);
  const file = assetFile.replace(/^\//, '');
  return qs
    ? `${origin}${basePath}/assets/${file}?${qs}`
    : `${origin}${basePath}/assets/${file}`;
}

export function buildTodolistShareLink(listId: string, opts?: { publicLink?: boolean }): string {
  return buildAssetShareLink('todolist-link.html', { list: listId }, opts);
}

export function buildPhotosShareLink(eventId: string, opts?: { publicLink?: boolean }): string {
  return buildAssetShareLink('photos-link.html', { eventId }, opts);
}

export function buildTvShareLink(
  query: Record<string, string | undefined | null>,
  opts?: { publicLink?: boolean }
): string {
  return buildAssetShareLink('tv-link.html', query, opts);
}

export function buildRadioShareLink(
  query: Record<string, string | undefined | null>,
  opts?: { publicLink?: boolean }
): string {
  return buildAssetShareLink('radio-link.html', query, opts);
}
