import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from './api.service';
import { KeycloakService } from '../keycloak/keycloak.service';

/**
 * Persists the last visited Angular route per Keycloak user
 * (localStorage + backend {@code appParameters}), and restores it on cold start.
 */
@Injectable({ providedIn: 'root' })
export class LastRouteService {
  private static readonly STORAGE_PREFIX = 'pattool.last-route';
  private static readonly MAX_ROUTE_LEN = 500;
  private static readonly BLOCKED_PREFIXES = ['/tools/tv-popout', '/acces-refuse-evenement', '/profile'];
  private static readonly SAVE_DEBOUNCE_MS = 400;

  /** True when the browser opened with an empty / default hash (logout / bookmark-less). */
  private coldStart = false;
  /** True when localStorage already supplied a route during pre-bootstrap. */
  private restoredFromLocal = false;
  /** Block persist until cold-start server restore finishes (avoids saving default /photos too early). */
  private suppressPersist = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveSub?: Subscription;
  private serverRestoreDone = false;

  constructor(
    private keycloak: KeycloakService,
    private api: ApiService,
    private router: Router
  ) {}

  /**
   * Call from {@code main.ts} after Keycloak init, before Angular bootstrap.
   * Rewrites {@code location.hash} when the user lands on the app root.
   */
  static tryRestoreHashBeforeBootstrap(): void {
    if (typeof window === 'undefined') {
      return;
    }
    if (!LastRouteService.isBlankHash(window.location.hash)) {
      return;
    }
    const sub = LastRouteService.readSubjectStatic();
    if (!sub) {
      return;
    }
    const raw = LastRouteService.readLocalStatic(sub);
    const route = LastRouteService.normalizeRoute(raw);
    if (!route) {
      return;
    }
    window.location.hash = '#' + route;
    (window as Window & { __patLastRouteLocalRestored?: boolean }).__patLastRouteLocalRestored = true;
  }

  /** Capture cold-start flags once Angular DI is available. */
  beginSession(): void {
    this.restoredFromLocal = !!(
      typeof window !== 'undefined' &&
      (window as Window & { __patLastRouteLocalRestored?: boolean }).__patLastRouteLocalRestored
    );
    const hashBlank =
      typeof window !== 'undefined' && LastRouteService.isBlankHash(window.location.hash);
    this.coldStart = hashBlank || this.restoredFromLocal;
    // Wait for server restore before persisting the default photos redirect.
    this.suppressPersist = this.coldStart && !this.restoredFromLocal;
  }

  /** Persist current route (local immediately, API debounced). */
  remember(url: string): void {
    if (this.suppressPersist) {
      return;
    }
    const route = LastRouteService.normalizeRoute(url);
    if (!route) {
      return;
    }
    const sub = this.userKey();
    if (!sub) {
      return;
    }
    LastRouteService.writeLocalStatic(sub, route);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.flushToServer(route), LastRouteService.SAVE_DEBOUNCE_MS);
  }

  /**
   * On cold start without a local route, navigate to the server-stored page
   * once (cross-device / cleared storage).
   */
  restoreFromServerIfNeeded(): void {
    if (this.serverRestoreDone || this.restoredFromLocal || !this.coldStart) {
      this.suppressPersist = false;
      return;
    }
    if (!this.keycloak.getJwtSubject() && !KeycloakService.auth?.authz?.token) {
      this.suppressPersist = false;
      return;
    }
    this.serverRestoreDone = true;
    this.api.getAppLastRoute().subscribe({
      next: (route) => {
        const normalized = LastRouteService.normalizeRoute(route);
        this.suppressPersist = false;
        if (!normalized) {
          this.remember(this.router.url);
          return;
        }
        const current = LastRouteService.normalizeRoute(this.router.url) || '';
        if (current === normalized) {
          this.remember(current);
          return;
        }
        // Only override the default landing (photos / empty), not an intentional deep link.
        if (!LastRouteService.isDefaultLanding(current)) {
          this.remember(current);
          return;
        }
        const sub = this.userKey();
        if (sub) {
          LastRouteService.writeLocalStatic(sub, normalized);
        }
        void this.router.navigateByUrl(normalized);
      },
      error: () => {
        this.suppressPersist = false;
        this.remember(this.router.url);
      }
    });
  }

  private flushToServer(route: string): void {
    this.saveSub?.unsubscribe();
    this.saveSub = this.api.saveAppLastRoute(route).subscribe({
      next: () => undefined,
      error: () => undefined
    });
  }

  private userKey(): string | null {
    return (
      this.keycloak.getJwtSubject() ||
      LastRouteService.readSubjectStatic()
    );
  }

  static normalizeRoute(raw: string | null | undefined): string | null {
    if (raw == null || typeof raw !== 'string') {
      return null;
    }
    let route = raw.trim();
    if (!route) {
      return null;
    }
    if (route.startsWith('#')) {
      route = route.substring(1);
    }
    if (!route.startsWith('/')) {
      route = '/' + route;
    }
    if (route.length > LastRouteService.MAX_ROUTE_LEN) {
      route = route.substring(0, LastRouteService.MAX_ROUTE_LEN);
    }
    const lower = route.toLowerCase();
    if (lower.includes('://') || lower.includes('..') || /\/\//.test(route)) {
      return null;
    }
    for (const blocked of LastRouteService.BLOCKED_PREFIXES) {
      if (lower === blocked || lower.startsWith(blocked + '/') || lower.startsWith(blocked + '?')) {
        return null;
      }
    }
    const hash = route.indexOf('#');
    if (hash >= 0) {
      route = route.substring(0, hash);
    }
    if (!route || route === '/') {
      return null;
    }
    return route;
  }

  static isBlankHash(hash: string): boolean {
    const h = (hash || '').replace(/^#/, '').trim();
    return !h || h === '/';
  }

  static isDefaultLanding(route: string): boolean {
    const r = (route || '').split('?')[0].toLowerCase();
    return !r || r === '/' || r === '/photos';
  }

  private static readSubjectStatic(): string | null {
    const authz = KeycloakService.auth?.authz;
    const sub =
      (typeof authz?.subject === 'string' && authz.subject) ||
      (typeof authz?.tokenParsed?.sub === 'string' && authz.tokenParsed.sub) ||
      '';
    return sub.trim() || null;
  }

  private static storageKey(sub: string): string {
    return `${LastRouteService.STORAGE_PREFIX}:${sub}`;
  }

  private static readLocalStatic(sub: string): string | null {
    try {
      return localStorage.getItem(LastRouteService.storageKey(sub));
    } catch {
      return null;
    }
  }

  private static writeLocalStatic(sub: string, route: string): void {
    try {
      localStorage.setItem(LastRouteService.storageKey(sub), route);
    } catch {
      /* quota / private mode */
    }
  }
}
