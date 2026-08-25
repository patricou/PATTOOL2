/** YouTube watch / shorts / embed / youtu.be video id (11 chars). */
const YOUTUBE_VIDEO_ID_RE =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?.*?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

export function parseYoutubeVideoId(url: string | null | undefined): string | null {
  const raw = (url || '').trim();
  if (!raw) {
    return null;
  }
  const match = YOUTUBE_VIDEO_ID_RE.exec(raw);
  return match?.[1] || null;
}

export function isYoutubeVideoId(id: string | null | undefined): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test((id || '').trim());
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * If the URL is a YouTube video and the current type is empty / generic video,
 * use the dedicated {@code YOUTUBE} urlEvent type so labels do not collide with
 * the i18n {@code YOUTUBE} object (which would render as {@code [object Object]}).
 */
export function resolveUrlEventTypeForLink(
  typeUrl: string | null | undefined,
  link: string | null | undefined
): string {
  const current = (typeUrl || '').trim();
  if (!parseYoutubeVideoId(link)) {
    return current;
  }
  const normalized = current.toUpperCase();
  if (
    !normalized ||
    normalized === 'VIDEO' ||
    normalized === 'VIDÉO' ||
    normalized === 'YOUTUBE' ||
    normalized === 'VIMEO'
  ) {
    return 'YOUTUBE';
  }
  return current;
}
