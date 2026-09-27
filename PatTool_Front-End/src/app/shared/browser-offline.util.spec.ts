import { isBrowserOffline, isNetworkHttpFailure, isSessionExpiredHttp } from './browser-offline.util';

describe('browser offline helpers', () => {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');

  afterEach(() => {
    if (original) {
      Object.defineProperty(navigator, 'onLine', original);
    }
  });

  function setOnline(value: boolean): void {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
  }

  it('detects navigator.onLine === false', () => {
    setOnline(false);
    expect(isBrowserOffline()).toBe(true);
    setOnline(true);
    expect(isBrowserOffline()).toBe(false);
  });

  it('treats HTTP status 0 as a network failure', () => {
    setOnline(true);
    expect(isNetworkHttpFailure({ status: 0 })).toBe(true);
    expect(isNetworkHttpFailure({ status: 401 })).toBe(false);
    expect(isNetworkHttpFailure(undefined)).toBe(false);
  });

  it('treats any HTTP error as a network failure when offline', () => {
    setOnline(false);
    expect(isNetworkHttpFailure({ status: 401 })).toBe(true);
  });

  it('treats HTTP 401 as an expired session only when the browser is online', () => {
    setOnline(true);
    expect(isSessionExpiredHttp({ status: 401 })).toBe(true);
    expect(isSessionExpiredHttp({ status: 0 })).toBe(false);
    expect(isSessionExpiredHttp({ status: 500 })).toBe(false);
    setOnline(false);
    expect(isSessionExpiredHttp({ status: 401 })).toBe(false);
  });
});
