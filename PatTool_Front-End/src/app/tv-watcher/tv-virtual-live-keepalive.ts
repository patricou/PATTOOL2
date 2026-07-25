import { firstValueFrom } from 'rxjs';
import { ApiService } from '../services/api.service';
import { FranceTvResolveMeta } from './tv-francetv-refresh';
import {
  franceTvSlugFromVirtualUrl,
  isKeepAliveVirtualLive,
  m6GroupSlugFromVirtual,
  tf1SlugFromVirtual
} from './tv-stream.util';

export type VirtualLiveResolveFn = (fresh: boolean) => Promise<FranceTvResolveMeta | null>;

/**
 * Build resolveMeta + slug for france.tv / TF1 / M6 virtual live keep-alive.
 */
export function virtualLiveKeepAliveFromUrl(
  streamUrl: string,
  api: ApiService
): { slug: string; resolveMeta: VirtualLiveResolveFn } | null {
  if (!isKeepAliveVirtualLive(streamUrl)) {
    return null;
  }
  const franceSlug = franceTvSlugFromVirtualUrl(streamUrl);
  if (franceSlug) {
    return {
      slug: franceSlug,
      resolveMeta: async (fresh) => {
        try {
          return await firstValueFrom(api.resolveFranceTvLive(franceSlug, fresh));
        } catch {
          return null;
        }
      }
    };
  }
  const tf1Slug = tf1SlugFromVirtual(streamUrl);
  if (tf1Slug) {
    return {
      slug: tf1Slug,
      resolveMeta: async (fresh) => {
        try {
          return await firstValueFrom(api.resolveTf1Live(tf1Slug, fresh));
        } catch {
          return null;
        }
      }
    };
  }
  const m6Slug = m6GroupSlugFromVirtual(streamUrl);
  if (m6Slug) {
    return {
      slug: m6Slug,
      resolveMeta: async (fresh) => {
        try {
          return await firstValueFrom(api.resolveM6GroupLive(m6Slug, fresh));
        } catch {
          return null;
        }
      }
    };
  }
  return null;
}

/** Bust backend stream cache before a hard replay of a virtual live. */
export async function bustVirtualLiveCache(
  streamUrl: string,
  api: ApiService
): Promise<void> {
  const keep = virtualLiveKeepAliveFromUrl(streamUrl, api);
  if (!keep) {
    return;
  }
  try {
    await keep.resolveMeta(true);
  } catch {
    /* ignore — replay will still hit proxy invalidate path */
  }
}

/**
 * Warm / verify TF1·M6·france.tv resolve before attaching HLS.
 * Retries once with {@code fresh=true} when the first resolve fails.
 */
export async function preflightVirtualLive(
  streamUrl: string,
  api: ApiService
): Promise<{ ok: boolean; detail?: string }> {
  const keep = virtualLiveKeepAliveFromUrl(streamUrl, api);
  if (!keep) {
    return { ok: true };
  }
  try {
    let meta = await keep.resolveMeta(false);
    if (!meta?.streamUrl) {
      meta = await keep.resolveMeta(true);
    }
    if (meta?.streamUrl) {
      return { ok: true };
    }
  } catch {
    /* fall through */
  }
  return {
    ok: false,
    detail:
      'Aucun miroir IPTV joignable pour cette chaîne (souvent temporaire). Réessayez dans quelques secondes.'
  };
}
