import { bestYoutubeQualityLevel, YoutubeQualityPin } from './youtube-desktop-quality';

describe('youtube desktop quality', () => {
  const originalMatchMedia = window.matchMedia;
  const originalTouch = Object.getOwnPropertyDescriptor(Navigator.prototype, 'maxTouchPoints');

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    if (originalTouch) {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', originalTouch);
    }
  });

  function setLayout(mobile: boolean): void {
    window.matchMedia = ((query: string) => ({
      matches: mobile && (query.includes('hover: none') || query.includes('max-width')),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      }
    })) as typeof window.matchMedia;
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
      configurable: true,
      get: () => (mobile ? 1 : 0)
    });
  }

  it('picks the highest specific rendition', () => {
    expect(bestYoutubeQualityLevel(['hd720', 'hd2160', 'hd1080'])).toBe('hd2160');
    expect(bestYoutubeQualityLevel(['medium', 'hd720'])).toBe('hd720');
  });

  it('prefers highres when nothing above 1080 is listed', () => {
    expect(bestYoutubeQualityLevel(['hd1080', 'highres', 'hd720'])).toBe('highres');
    expect(bestYoutubeQualityLevel(['auto', 'default'])).toBeNull();
  });

  it('asks a desktop player for the top rendition once', () => {
    setLayout(false);
    const pin = new YoutubeQualityPin();
    expect(pin.commands('abc', null, 5)).toEqual([
      { func: 'setPlaybackQuality', args: ['hd2160'] }
    ]);
    expect(pin.commands('abc', null, 5)).toEqual([]);
    expect(pin.commands('abc', {
      availableQualityLevels: ['hd1080', 'hd720'],
      playbackQuality: 'medium'
    }, 5)).toEqual([
      { func: 'setPlaybackQuality', args: ['hd1080'] }
    ]);
    expect(pin.commands('abc', {
      availableQualityLevels: ['hd1080', 'hd720'],
      playbackQuality: 'hd1080'
    }, 5)).toEqual([]);
    expect(pin.commands('abc', null, 1)).toEqual([]);
    expect(pin.commands('abc', null, undefined)).toEqual([]);
  });

  it('leaves mobile playback on automatic quality', () => {
    setLayout(true);
    const pin = new YoutubeQualityPin();
    expect(pin.commands('abc', {
      availableQualityLevels: ['hd2160', 'hd1080'],
      playbackQuality: 'medium'
    }, 1)).toEqual([]);
  });
});
