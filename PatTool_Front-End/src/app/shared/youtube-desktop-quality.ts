/**
 * Desktop layouts ask the YouTube embed for its top rendition.
 * Phone and tablet layouts keep YouTube's automatic quality.
 * The viewport test matches the Deezer and YouTube pages.
 */

export interface YoutubePlayerCommand {
  func: string;
  args: unknown[];
}

const SPECIFIC_LEVELS = [
  'hd4320',
  'hd2880',
  'hd2160',
  'hd1440',
  'hd1080',
  'hd720',
  'large',
  'medium',
  'small',
  'tiny'
];

export function isYoutubeMobileLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  return coarse || (narrow && touch);
}

/** Embed query for 4K. YouTube steps down to the best rendition the video actually has. */
export function youtubeDesktopQualityQuery(): string {
  return isYoutubeMobileLayout() ? '' : '&vq=hd2160';
}

export function youtubeSuggestedQuality(): string | undefined {
  return isYoutubeMobileLayout() ? undefined : 'hd2160';
}

/** Highest rendition in a YouTube `availableQualityLevels` list. */
export function bestYoutubeQualityLevel(levels: unknown): string | null {
  if (!Array.isArray(levels)) {
    return null;
  }
  const known = levels.filter((level): level is string => typeof level === 'string' && !!level.trim());
  const lower = new Map(known.map((level) => [level.toLowerCase(), level]));
  for (const name of SPECIFIC_LEVELS) {
    if (name === 'hd1080' && lower.has('highres')) {
      return lower.get('highres') || 'highres';
    }
    const found = lower.get(name);
    if (found) {
      return found;
    }
  }
  return lower.get('highres') || known.find((level) => {
    const key = level.toLowerCase();
    return key !== 'auto' && key !== 'default';
  }) || null;
}

/**
 * Asks one embed for its top rendition. A new video, a new iframe, or the end
 * of the current video may ask again. Mobile layouts produce no commands.
 */
export class YoutubeQualityPin {
  private videoKey = '';
  private applied = '';
  private hinted = 0;
  private attempts = 0;
  private lastState = -2;

  /** A new iframe for the same video must ask for the top rendition again. */
  reset(): void {
    this.videoKey = '';
    this.applied = '';
    this.hinted = 0;
    this.attempts = 0;
    this.lastState = -2;
  }

  commands(
    videoKey: string,
    info?: Record<string, unknown> | null,
    playerState?: number
  ): YoutubePlayerCommand[] {
    if (isYoutubeMobileLayout() || !videoKey) {
      return [];
    }
    if (this.videoKey !== videoKey) {
      this.videoKey = videoKey;
      this.applied = '';
      this.hinted = 0;
      this.attempts = 0;
      this.lastState = -2;
    }
    if (playerState !== undefined && playerState !== this.lastState) {
      this.lastState = playerState;
      // A finished video (playlist advance) may pin again. Cued and unstarted
      // also fire when the quality change reloads the same video, so they must not reset.
      if (playerState === 0) {
        this.applied = '';
        this.hinted = 0;
        this.attempts = 0;
      }
    }
    // Playing or buffering: setPlaybackQuality reloads the clip. Ask only before it starts.
    if (playerState === 0 || playerState === 1 || playerState === 2 || playerState === 3) {
      return [];
    }
    const best = bestYoutubeQualityLevel(info?.['availableQualityLevels']);
    const current = typeof info?.['playbackQuality'] === 'string' ? info['playbackQuality'].toLowerCase() : '';
    if (best) {
      const bestKey = best.toLowerCase();
      if (current === bestKey) {
        this.applied = bestKey;
        return [];
      }
      if (!current && this.applied === bestKey) {
        return [];
      }
      if (this.applied === bestKey && this.attempts >= 2) {
        return [];
      }
      this.applied = bestKey;
      this.attempts += 1;
      return [{ func: 'setPlaybackQuality', args: [best] }];
    }
    if (this.applied) {
      return [];
    }
    const canHint = playerState === undefined || playerState === -1 || playerState === 5;
    if (!canHint || this.hinted >= 1) {
      return [];
    }
    this.hinted += 1;
    return [{ func: 'setPlaybackQuality', args: ['hd2160'] }];
  }
}
